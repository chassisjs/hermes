import { describe, expect, test } from '@jest/globals'
import { projectionTable } from './projectionTables.js'

describe('projectionTable', () => {
  test('a name of lowercase letters, digits and _ is used as it is, without a prefix', () => {
    expect(projectionTable({ name: 'open_occurrences' })).toBe('open_occurrences')
    expect(projectionTable({ name: 'orders_20261106' })).toBe('orders_20261106')
  })

  test('any other name is turned into one and gets a hash, so that two projections never share a table', () => {
    const camel = projectionTable({ name: 'openOccurrences' })
    const colon = projectionTable({ name: 'billing:open-occurrences' })

    expect(camel).toMatch(/^open_occurrences__[0-9a-f]{8}$/)
    expect(colon).toMatch(/^billing_open_occurrences__[0-9a-f]{8}$/)
    expect(new Set([camel, colon, 'open_occurrences']).size).toBe(3)
    expect(projectionTable({ name: 'Open_Occurrences' })).not.toBe(projectionTable({ name: 'open_occurrences' }))
  })

  test('a name never takes a table of Hermes', () => {
    expect(projectionTable({ name: 'hermes_events' })).toMatch(/^hermes_events__[0-9a-f]{8}$/)
    expect(projectionTable({ name: 'hermes_subscriptions' })).not.toBe('hermes_subscriptions')
  })

  test('the names fit the 64 characters of a MySQL identifier', () => {
    const table = projectionTable({ name: 'a'.repeat(250) })

    expect(projectionTable({ name: 'a'.repeat(64) })).toBe('a'.repeat(64))
    expect(table.length).toBeLessThanOrEqual(64)
    expect(table).toMatch(/^a+__[0-9a-f]{8}$/)
    expect(projectionTable({ name: `${'a'.repeat(249)}b` })).not.toBe(table)
  })

  test('a plain name never looks like a hashed one', () => {
    const hashed = projectionTable({ name: 'Orders' })

    expect(projectionTable({ name: hashed })).not.toBe(hashed)
  })

  test('the same name always gives the same table', () => {
    expect(projectionTable({ name: 'x:y' })).toBe(projectionTable({ name: 'x:y' }))
  })
})

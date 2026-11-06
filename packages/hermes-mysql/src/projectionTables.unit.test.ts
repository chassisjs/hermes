import { describe, expect, test } from '@jest/globals'
import { projectionTables } from './projectionTables.js'

describe('projectionTables', () => {
  test('a name of lowercase letters, digits and _ is used as it is', () => {
    expect(projectionTables({ name: 'open_occurrences', isSingleStream: false })).toEqual({
      documents: 'hermes_projection_open_occurrences',
      versions: 'hermes_projection_open_occurrences_versions',
    })
  })

  test('any other name is turned into one and gets a hash, so that two projections never share a table', () => {
    const camel = projectionTables({ name: 'openOccurrences', isSingleStream: false })
    const colon = projectionTables({ name: 'billing:open-occurrences', isSingleStream: false })

    expect(camel.documents).toMatch(/^hermes_projection_open_occurrences__[0-9a-f]{8}$/)
    expect(colon.documents).toMatch(/^hermes_projection_billing_open_occurrences__[0-9a-f]{8}$/)
    expect(camel.versions).toBe(`${camel.documents}_versions`)
    expect(new Set([camel.documents, colon.documents, 'hermes_projection_open_occurrences']).size).toBe(3)
    expect(projectionTables({ name: 'Open_Occurrences', isSingleStream: true }).documents).not.toBe(
      projectionTables({ name: 'open_occurrences', isSingleStream: true }).documents,
    )
  })

  test('the names fit the 64 characters of a MySQL identifier', () => {
    const name = 'a'.repeat(250)
    const { documents, versions } = projectionTables({ name, isSingleStream: false })

    expect(versions?.length).toBeLessThanOrEqual(64)
    expect(documents).toMatch(/^hermes_projection_a+__[0-9a-f]{8}$/)
    expect(projectionTables({ name: `${'a'.repeat(249)}b`, isSingleStream: false }).documents).not.toBe(documents)
  })

  test('a single-stream projection keeps the versions in its documents, so it has no versions table', () => {
    expect(projectionTables({ name: 'open_occurrences', isSingleStream: true })).toEqual({
      documents: 'hermes_projection_open_occurrences',
      versions: null,
    })
  })

  test('the documents of a projection never take the versions table of another one', () => {
    const orders = projectionTables({ name: 'orders', isSingleStream: false })
    const ordersVersions = projectionTables({ name: 'orders_versions', isSingleStream: true })

    expect(ordersVersions.documents).not.toBe(orders.versions)
    expect(ordersVersions.documents).toMatch(/^hermes_projection_orders_versions__[0-9a-f]{8}$/)
  })

  test('a name ending in a date or a number stays plain', () => {
    expect(projectionTables({ name: 'orders_20261106', isSingleStream: true }).documents).toBe(
      'hermes_projection_orders_20261106',
    )
  })

  test('a plain name never looks like a hashed one', () => {
    const hashed = projectionTables({ name: 'Orders', isSingleStream: true }).documents
    const plain = hashed.slice('hermes_projection_'.length)

    expect(projectionTables({ name: plain, isSingleStream: true }).documents).not.toBe(hashed)
  })

  test('the same name always gives the same tables', () => {
    expect(projectionTables({ name: 'x:y', isSingleStream: false })).toEqual(
      projectionTables({ name: 'x:y', isSingleStream: false }),
    )
  })
})

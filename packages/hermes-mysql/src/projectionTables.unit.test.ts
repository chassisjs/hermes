import { describe, expect, test } from '@jest/globals'
import { projectionTables } from './projectionTables.js'

describe('projectionTables', () => {
  test('a name of lowercase letters, digits and _ is used as it is', () => {
    expect(projectionTables({ name: 'open_occurrences' })).toEqual({
      documents: 'hermes_projection_open_occurrences',
      versions: 'hermes_projection_open_occurrences_versions',
    })
  })

  test('any other name is turned into one and gets a hash, so that two projections never share a table', () => {
    const camel = projectionTables({ name: 'openOccurrences' })
    const colon = projectionTables({ name: 'billing:open-occurrences' })

    expect(camel.documents).toMatch(/^hermes_projection_open_occurrences_[0-9a-f]{8}$/)
    expect(colon.documents).toMatch(/^hermes_projection_billing_open_occurrences_[0-9a-f]{8}$/)
    expect(camel.versions).toBe(`${camel.documents}_versions`)
    expect(new Set([camel.documents, colon.documents, 'hermes_projection_open_occurrences']).size).toBe(3)
    expect(projectionTables({ name: 'Open_Occurrences' }).documents).not.toBe(
      projectionTables({ name: 'open_occurrences' }).documents,
    )
  })

  test('the names fit the 64 characters of a MySQL identifier', () => {
    const name = 'a'.repeat(250)
    const { documents, versions } = projectionTables({ name })

    expect(versions.length).toBeLessThanOrEqual(64)
    expect(documents).toMatch(/^hermes_projection_a+_[0-9a-f]{8}$/)
    expect(projectionTables({ name: `${'a'.repeat(249)}b` }).documents).not.toBe(documents)
  })

  test('the same name always gives the same tables', () => {
    expect(projectionTables({ name: 'x:y' })).toEqual(projectionTables({ name: 'x:y' }))
  })
})

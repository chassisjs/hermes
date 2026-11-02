import { describe, expect, test } from '@jest/globals'
import { getSlotName } from './consts.js'

describe('getSlotName', () => {
  test('keeps the names that PostgreSQL accepts as they are', () => {
    expect(getSlotName('app', 'default')).toBe('hermes_slot_app_default')
    expect(getSlotName('app', 'tenant_1')).toBe('hermes_slot_app_tenant_1')
  })

  test.each([
    ['app', 'tenant-1'],
    ['App', 'Tenant.1'],
    ['a'.repeat(30), 'b'.repeat(30)],
  ])('turns (%s, %s) into a valid slot name', (consumerName, partitionKey) => {
    const slotName = getSlotName(consumerName, partitionKey)

    expect(slotName).toMatch(/^hermes_slot_[a-z0-9_]+$/)
    expect(slotName.length).toBeLessThanOrEqual(63)
    expect(getSlotName(consumerName, partitionKey)).toBe(slotName)
  })

  test('different partitions that look the same after the clean-up get different slots', () => {
    expect(getSlotName('app', 'tenant-1')).not.toBe(getSlotName('app', 'tenant.1'))
    expect(getSlotName('app', 'tenant-1')).not.toBe(getSlotName('app', 'tenant_1'))
  })
})

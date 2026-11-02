import { Duration } from '@chassisjs/hermes'
import { describe, expect, jest, test } from '@jest/globals'
import { AsyncOutboxConsumer } from './AsyncOutboxConsumer.js'

const createMockSql = () => {
  const sql = jest.fn().mockReturnValue(Promise.resolve([]))

  return Object.assign(sql, {
    unsafe: jest.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>().mockResolvedValue([]),
  })
}

const createConsumer = (getSql: () => unknown) =>
  new AsyncOutboxConsumer({
    getSql: getSql as never,
    publish: async () => {},
    consumerName: 'test-consumer',
    checkInterval: Duration.ofSeconds(1),
  })

const message = {
  messageId: 'test-id',
  messageType: 'test-type',
  message: { data: 'test-data' },
}

describe('AsyncOutboxConsumer', () => {
  describe('send', () => {
    test('inserts the message into the default partition', async () => {
      const sql = createMockSql()

      await createConsumer(() => sql).send(message)

      expect(sql.unsafe).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "asyncOutbox"'), [
        'test-consumer',
        'default',
        message.messageId,
        message.messageType,
        JSON.stringify(message.message),
      ])
    })

    test('inserts the message into the given partition', async () => {
      const sql = createMockSql()

      await createConsumer(() => sql).send(message, { partitionKey: 'tenant-1' })

      expect(sql.unsafe).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['tenant-1']))
    })

    test('throws when there is no connection', async () => {
      await expect(createConsumer(() => undefined).send(message)).rejects.toThrow('Database connection not established')
    })
  })

  describe('start/stop', () => {
    test('cannot be started twice, and can be started again after stop', async () => {
      const consumer = createConsumer(() => createMockSql())
      const stop = consumer.start()

      expect(() => consumer.start()).toThrow(/already started/)

      await stop()
      await consumer.stop()
      await consumer.start()()
    })

    test('the stop function of an earlier start does not stop a later one', async () => {
      const consumer = createConsumer(() => createMockSql())
      const stopFirst = consumer.start()

      await stopFirst()

      const stopSecond = consumer.start()

      await stopFirst()

      expect(() => consumer.start()).toThrow(/already started/)

      await stopSecond()
    })
  })
})

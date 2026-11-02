import { Duration } from '@chassisjs/hermes'
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { describe, expect, jest, test } from '@jest/globals'
import { setTimeout } from 'node:timers/promises'
import { createOutboxConsumer, HermesMessageEnvelope } from '../src/index.js'
import { generateEvent, MedicineEvent } from './events.js'
import { postgres } from './postgresql.js'

jest.setTimeout(Duration.ofMinutes(5).ms)

const getOptions = (container: StartedPostgreSqlContainer) => () => ({
  host: container.getHost(),
  port: container.getPort(),
  username: container.getUsername(),
  password: container.getPassword(),
  database: container.getDatabase(),
})

describe.each([true, false])('Partitions', (serialization) => {
  test(`a consumer publishes only the messages of its partition when serialization is ${serialization ? 'on' : 'off'}`, async () => {
    await postgres(async (sql, container, onDispose) => {
      const published: Record<string, string[]> = { 'tenant-1': [], 'tenant-2': [] }
      const createConsumer = (partitionKey: string) =>
        createOutboxConsumer<MedicineEvent>({
          getOptions: getOptions(container),
          publish: async (messages: HermesMessageEnvelope<MedicineEvent> | HermesMessageEnvelope<MedicineEvent>[]) => {
            for (const { messageId } of Array.isArray(messages) ? messages : [messages]) {
              published[partitionKey].push(messageId)
            }
          },
          consumerName: 'app',
          partitionKey,
          serialization,
        })
      const outbox1 = createConsumer('tenant-1')
      const outbox2 = createConsumer('tenant-2')
      const event = generateEvent('med1')

      const stop1 = await outbox1.start()
      onDispose(stop1)
      const stop2 = await outbox2.start()
      onDispose(stop2)

      await outbox1.queue(
        { message: event, messageId: 'only-1', messageType: event.name },
        { partitionKey: 'tenant-1' },
      )
      await outbox1.queue(
        { message: event, messageId: 'only-2', messageType: event.name },
        { partitionKey: 'tenant-2' },
      )
      await sql.begin(async (tx) => {
        await outbox1.queue(
          { message: event, messageId: 'mixed-1', messageType: event.name },
          { partitionKey: 'tenant-1', tx },
        )
        await outbox1.queue(
          { message: event, messageId: 'mixed-2', messageType: event.name },
          { partitionKey: 'tenant-2', tx },
        )
      })
      await outbox1.queue(
        { message: event, messageId: 'last-1', messageType: event.name },
        { partitionKey: 'tenant-1' },
      )

      await setTimeout(Duration.ofSeconds(1).ms)

      expect(published['tenant-1']).toEqual(['only-1', 'mixed-1', 'last-1'])
      expect(published['tenant-2']).toEqual(['only-2', 'mixed-2'])

      const consumers = await sql<{ partitionKey: string; lastProcessedLsn: string }[]>`
        SELECT "partitionKey", "lastProcessedLsn" FROM "outboxConsumer" ORDER BY "partitionKey"
      `

      // every consumer moves past all transactions, including the ones without its messages.
      expect(consumers[0].lastProcessedLsn).toBe(consumers[1].lastProcessedLsn)

      await stop1()
      await stop2()
    })
  })
})

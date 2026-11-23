import { Duration, type PollingOutboxPoll } from '@chassisjs/hermes'
import { describe, expect, jest, test } from '@jest/globals'
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { setTimeout } from 'node:timers/promises'
import { Sql } from 'postgres'
import { MeterProvider, MetricReader, type MetricData } from '@opentelemetry/sdk-metrics'
import {
  createAsyncOutboxConsumer,
  createOutboxConsumer,
  createOutboxMetrics,
  useBasicAsyncOutboxConsumerPolicy,
} from '../src/index.js'
import { migrate } from '../src/outbox/migrate.js'
import { generateEvent, MedicineEvent } from './events.js'
import { postgres } from './postgresql.js'

jest.setTimeout(Duration.ofMinutes(5).ms)

const getOptions = (container: StartedPostgreSqlContainer) => ({
  host: container.getHost(),
  port: container.getPort(),
  username: container.getUsername(),
  password: container.getPassword(),
  database: container.getDatabase(),
})

const waitUntil = async (condition: () => boolean, timeout = Duration.ofSeconds(20)) => {
  const deadline = Date.now() + timeout.ms

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out.')
    }

    await setTimeout(20)
  }
}

class TestReader extends MetricReader {
  protected async onShutdown() {}
  protected async onForceFlush() {}
}

const event = generateEvent('med1')
const envelope = (messageId: string) => ({ message: event, messageId, messageType: event.name })
const checkInterval = Duration.ofMiliseconds(50)

const createAsyncOutbox = (sql: Sql, params?: { partitionKey?: string; consumerName?: string }) =>
  createAsyncOutboxConsumer<MedicineEvent>({
    getSql: () => sql as never,
    consumerName: params?.consumerName ?? 'app',
    partitionKey: params?.partitionKey,
    checkInterval,
    publish: () => {},
  })

describe('Lag', () => {
  test('getLag of the async outbox reads the oldest undelivered message, the counts and the partitions', async () => {
    await postgres(async (sql) => {
      await migrate(sql, 'hermes_slot_app_default')

      const outbox = createAsyncOutbox(sql)

      expect(await outbox.getLag()).toEqual({
        oldestPendingAge: null,
        pending: 0,
        isPendingExact: true,
        failing: 0,
        partitions: 0,
      })

      await outbox.send([envelope('a1'), envelope('a2')], { partitionKey: 'a' })
      await outbox.send(envelope('b1'), { partitionKey: 'b' })
      await outbox.send(envelope('delivered'), { partitionKey: 'c' })
      await createAsyncOutbox(sql, { consumerName: 'other' }).send(envelope('other'), {})
      await sql`UPDATE "asyncOutbox" SET "delivered" = true WHERE "messageId" = 'delivered'`
      await sql`UPDATE "asyncOutbox" SET "failsCount" = 2 WHERE "messageId" = 'a2'`
      await sql`UPDATE "asyncOutbox" SET "addedAt" = now() - interval '90 seconds' WHERE "messageId" IN ('b1', 'other')`

      const lag = await outbox.getLag()

      expect(lag).toEqual({
        oldestPendingAge: expect.any(Duration),
        pending: 3,
        isPendingExact: true,
        failing: 1,
        partitions: 2,
      })
      expect(lag.oldestPendingAge!.ms).toBeGreaterThanOrEqual(90_000)
      expect(lag.oldestPendingAge!.ms).toBeLessThan(120_000)
      expect(await outbox.getLag({ countLimit: 2 })).toMatchObject({ pending: 2, isPendingExact: false })
      expect(await createAsyncOutbox(sql, { partitionKey: 'a' }).getLag()).toMatchObject({
        pending: 2,
        failing: 1,
        partitions: 1,
      })
      await expect(outbox.getLag({ countLimit: 0 })).rejects.toThrow('countLimit')
    })
  })

  test('getLag of the consumer reads the replication slot, the unpublished transactions and the async outbox', async () => {
    await postgres(async (sql, container, onDispose) => {
      const polls: PollingOutboxPoll[] = []
      let release = () => {}
      let publishing = 0
      const outbox = createOutboxConsumer<MedicineEvent>({
        getOptions: () => getOptions(container),
        publish: async () => {
          publishing++
          await new Promise<void>((resolve) => (release = resolve))
        },
        consumerName: 'app',
        asyncOutbox: useBasicAsyncOutboxConsumerPolicy(checkInterval, { onPoll: (poll) => polls.push(poll) }),
      })

      await expect(outbox.getLag()).rejects.toThrow()

      const stop = await outbox.start()
      onDispose(stop)

      await waitUntil(() => polls.length > 0)

      expect(await outbox.getLag()).toEqual({
        replication: {
          walBytes: expect.any(Number),
          isSlotActive: true,
          oldestPendingAge: null,
          pendingTransactions: 0,
          redeliveryCount: 0,
        },
        asyncOutbox: { oldestPendingAge: null, pending: 0, isPendingExact: true, failing: 0, partitions: 0 },
      })

      await outbox.queue(envelope('blocked'))
      await waitUntil(() => publishing === 1)
      await setTimeout(100)

      const lag = await outbox.getLag()

      expect(lag.replication).toMatchObject({ pendingTransactions: 1, isSlotActive: true })
      expect(lag.replication.oldestPendingAge!.ms).toBeGreaterThanOrEqual(50)

      release()
      await waitUntil(() => publishing === 1 && polls.length > 0)
      await setTimeout(300)

      expect((await outbox.getLag()).replication).toMatchObject({ pendingTransactions: 0, oldestPendingAge: null })

      await outbox.send(envelope('async'))
      await waitUntil(() => publishing === 2)
      release()
      await waitUntil(() => polls.some(({ published }) => published === 1))

      expect(polls.every(({ failed }) => failed === 0)).toBe(true)

      await stop()
    })
  })

  test('createOutboxMetrics observes the replication and the async outbox with OpenTelemetry', async () => {
    await postgres(async (sql, container, onDispose) => {
      const reader = new TestReader()
      const meter = new MeterProvider({ readers: [reader] }).getMeter('test')
      const outbox = createOutboxConsumer<MedicineEvent>({
        getOptions: () => getOptions(container),
        publish: () => {},
        consumerName: 'app',
        asyncOutbox: useBasicAsyncOutboxConsumerPolicy(checkInterval),
      })
      const stop = await outbox.start()
      onDispose(stop)

      const errors: unknown[] = []
      const metrics = createOutboxMetrics({
        meter,
        outbox,
        attributes: { 'hermes.consumer.name': 'app' },
        onError: (error) => errors.push(error),
      })
      const { resourceMetrics } = await reader.collect()
      const collected = new Map<string, MetricData>(
        resourceMetrics.scopeMetrics.flatMap(({ metrics }) =>
          metrics.map((metric) => [metric.descriptor.name, metric]),
        ),
      )
      const valueOf = (name: string) => collected.get(name)?.dataPoints[0]?.value

      expect(errors).toEqual([])
      expect(valueOf('hermes.outbox.replication.wal')).toEqual(expect.any(Number))
      expect(valueOf('hermes.outbox.replication.slot.active')).toBe(1)
      expect(valueOf('hermes.outbox.replication.pending_transactions')).toBe(0)
      expect(valueOf('hermes.outbox.replication.oldest_pending_transaction.age')).toBe(0)
      expect(valueOf('hermes.outbox.pending_messages')).toBe(0)
      expect(collected.get('hermes.outbox.replication.wal')?.dataPoints[0].attributes).toEqual({
        'hermes.consumer.name': 'app',
      })

      metrics.dispose()
      await stop()
    })
  })
})

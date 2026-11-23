import {
  createPollingOutboxMetrics,
  noop,
  type BatchObserverLike,
  type MeterLike,
  type MetricAttributes,
  type PollingOutboxMetrics,
} from '@chassisjs/hermes'
import { type IOutboxConsumer, type JSONValue, type OutboxLag } from '../common/types.js'

type OutboxMetricsParams<Message extends JSONValue> = {
  /** The meter of OpenTelemetry, e.g. `metrics.getMeter('orders')`. */
  meter: MeterLike
  /** The started consumer. */
  outbox: IOutboxConsumer<Message>
  /** The attributes of every measurement, e.g. `{ 'hermes.consumer.name': 'orders' }`. */
  attributes?: MetricAttributes
  /** Count at most this many undelivered messages of the async outbox (default: `10000`). */
  countLimit?: number
  /** Called when reading the lag fails. Nothing is observed then. An error it throws is ignored. */
  onError?: (error: unknown) => void
}

/**
 * How long one read of the lag serves the observable gauges after it ends, so that one collection reads it once. A
 * read in progress is shared too.
 */
const LagReuseMs = 1000

/**
 * Records the metrics of an {@link IOutboxConsumer} with OpenTelemetry. Create it after `start()` of the consumer, and
 * call `dispose()` before `stop()`: `getLag()` of a stopped consumer fails, which is reported through `onError` on every
 * collection.
 *
 * Observable gauges of the main outbox (logical replication):
 * - `hermes.outbox.replication.wal` (`By`): the WAL that the replication slot did not confirm yet
 * - `hermes.outbox.replication.slot.active` (`1`): 1 when a process consumes the slot, 0 otherwise
 * - `hermes.outbox.replication.oldest_pending_transaction.age` (`s`): the age of the oldest transaction that this
 *   instance received and did not publish yet, 0 when there is none
 * - `hermes.outbox.replication.pending_transactions` (`{transaction}`): the transactions that this instance received
 *   and did not publish yet
 * - `hermes.outbox.replication.redelivery_count` (`{attempt}`): the failed attempts of the transaction that is being
 *   published again
 *
 * The metrics of the async outbox are the ones of `createPollingOutboxMetrics` of `@chassisjs/hermes`. Give
 * {@link PollingOutboxMetrics.onPoll} to the async outbox as `onPoll`.
 *
 * @example
 * ```typescript
 * let outboxMetrics: PollingOutboxMetrics | undefined
 * const outbox = createOutboxConsumer({
 *   ...,
 *   asyncOutbox: useBasicAsyncOutboxConsumerPolicy(Duration.ofSeconds(15), {
 *     onPoll: (poll) => outboxMetrics?.onPoll(poll),
 *   }),
 * })
 * const stop = await outbox.start()
 *
 * outboxMetrics = createOutboxMetrics({ meter: metrics.getMeter('orders'), outbox })
 * ```
 */
const createOutboxMetrics = <Message extends JSONValue>(params: OutboxMetricsParams<Message>): PollingOutboxMetrics => {
  const { meter, outbox, attributes, countLimit } = params
  const onError = (error: unknown) =>
    Promise.resolve()
      .then(() => params.onError?.(error))
      .catch(noop)
  let lastRead: { settledAt: number | null; lag: Promise<OutboxLag> } | null = null
  const readLag = () => {
    if (!lastRead || (lastRead.settledAt !== null && Date.now() - lastRead.settledAt > LagReuseMs)) {
      const read: { settledAt: number | null; lag: Promise<OutboxLag> } = {
        settledAt: null,
        lag: outbox.getLag({ countLimit }),
      }

      read.lag
        .finally(() => {
          read.settledAt = Date.now()
        })
        .catch(noop)
      lastRead = read
    }

    return lastRead.lag
  }
  const asyncOutbox = createPollingOutboxMetrics({
    meter,
    attributes,
    getLag: () => readLag().then(({ asyncOutbox }) => asyncOutbox),
    onError: noop,
  })
  const wal = meter.createObservableGauge('hermes.outbox.replication.wal', {
    description: 'The WAL that the replication slot of the outbox did not confirm yet.',
    unit: 'By',
  })
  const isSlotActive = meter.createObservableGauge('hermes.outbox.replication.slot.active', {
    description: '1 when a process consumes the replication slot of the outbox, 0 otherwise.',
    unit: '1',
  })
  const oldestAge = meter.createObservableGauge('hermes.outbox.replication.oldest_pending_transaction.age', {
    description: 'The age of the oldest transaction that this instance received and did not publish yet.',
    unit: 's',
  })
  const pendingTransactions = meter.createObservableGauge('hermes.outbox.replication.pending_transactions', {
    description: 'The transactions that this instance received and did not publish yet.',
    unit: '{transaction}',
  })
  const redeliveryCount = meter.createObservableGauge('hermes.outbox.replication.redelivery_count', {
    description: 'The failed attempts of the transaction that is being published again.',
    unit: '{attempt}',
  })
  const gauges = [wal, isSlotActive, oldestAge, pendingTransactions, redeliveryCount]
  const observeReplication = async (observer: BatchObserverLike) => {
    let lag: OutboxLag

    try {
      lag = await readLag()
    } catch (error) {
      onError(error)

      return
    }

    const { replication } = lag

    if (replication.walBytes !== null) {
      observer.observe(wal, replication.walBytes, attributes)
    }

    observer.observe(isSlotActive, replication.isSlotActive ? 1 : 0, attributes)
    observer.observe(oldestAge, (replication.oldestPendingAge?.ms ?? 0) / 1000, attributes)
    observer.observe(pendingTransactions, replication.pendingTransactions, attributes)
    observer.observe(redeliveryCount, replication.redeliveryCount, attributes)
  }

  meter.addBatchObservableCallback(observeReplication, gauges)

  return {
    onPoll: asyncOutbox.onPoll,
    dispose() {
      meter.removeBatchObservableCallback(observeReplication, gauges)
      asyncOutbox.dispose()
    },
  }
}

export { createOutboxMetrics, type OutboxMetricsParams }

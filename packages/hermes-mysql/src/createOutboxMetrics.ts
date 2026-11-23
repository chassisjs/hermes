import {
  createPollingOutboxMetrics,
  type MeterLike,
  type MetricAttributes,
  type PollingOutboxMetrics,
} from '@chassisjs/hermes'
import { type JSONValue, type OutboxConsumer } from './types.js'

type OutboxMetricsParams<Message extends JSONValue> = {
  /** The meter of OpenTelemetry, e.g. `metrics.getMeter('orders')`. */
  meter: MeterLike
  /** The consumer. It does not have to be started: its `getLag()` reads the database with the pool of the application. */
  outbox: OutboxConsumer<Message>
  /** The attributes of every measurement, e.g. `{ 'hermes.consumer.name': 'orders' }`. */
  attributes?: MetricAttributes
  /** Count at most this many undelivered messages (default: `10000`). */
  countLimit?: number
  /** Called when reading the lag fails. Nothing is observed then. An error it throws is ignored. */
  onError?: (error: unknown) => void
}

/**
 * Records the metrics of an {@link OutboxConsumer} with OpenTelemetry: the lag of the consumer (read with
 * `outbox.getLag()` once per collection of the metrics) and the polls (give {@link PollingOutboxMetrics.onPoll} to the
 * consumer as `onPoll`). The metrics are the ones of `createPollingOutboxMetrics` of `@chassisjs/hermes`.
 *
 * Call `dispose()` when the application shuts down, before it closes the pool of `getDbConnection()`.
 *
 * @example
 * ```typescript
 * import { metrics } from '@opentelemetry/api'
 *
 * const outbox = createOutboxConsumer({
 *   ...,
 *   consumerName: 'orders',
 *   onPoll: (poll) => outboxMetrics.onPoll(poll),
 * })
 * const outboxMetrics = createOutboxMetrics({
 *   meter: metrics.getMeter('orders'),
 *   outbox,
 *   attributes: { 'hermes.consumer.name': 'orders' },
 * })
 * const stop = await outbox.start()
 * ```
 */
const createOutboxMetrics = <Message extends JSONValue>(params: OutboxMetricsParams<Message>): PollingOutboxMetrics => {
  const { meter, outbox, attributes, countLimit, onError } = params

  return createPollingOutboxMetrics({
    meter,
    attributes,
    getLag: () => outbox.getLag({ countLimit }),
    onError,
  })
}

export { createOutboxMetrics, type OutboxMetricsParams }

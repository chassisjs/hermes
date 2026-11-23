import { noop } from '../utils/utils.js'
import { type PollingOutboxLag, type PollingOutboxPoll } from './types.js'

/**
 * The attributes of a metric, e.g. `{ 'hermes.consumer.name': 'orders' }`.
 */
type MetricAttributes = Record<string, string | number | boolean>

type MetricOptions = { description?: string; unit?: string; advice?: { explicitBucketBoundaries?: number[] } }

/**
 * The bucket boundaries of the duration histograms, in seconds. The default boundaries of the SDK of OpenTelemetry
 * suit milliseconds, so almost every claim would fall into one bucket.
 */
const DurationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]

/**
 * An observable instrument of a {@link MeterLike}.
 */
type ObservableLike = object

/**
 * Observes the values of observable instruments in a batch callback.
 */
type BatchObserverLike = {
  observe(observable: ObservableLike, value: number, attributes?: MetricAttributes): void
}

type BatchCallbackLike = (observer: BatchObserverLike) => Promise<void> | void

/**
 * The part of `Meter` of `@opentelemetry/api` that Hermes uses, so that Hermes does not depend on it. Pass
 * `metrics.getMeter('...')` of your application.
 */
type MeterLike = {
  createObservableGauge(name: string, options?: MetricOptions): ObservableLike
  createHistogram(name: string, options?: MetricOptions): { record(value: number, attributes?: MetricAttributes): void }
  createCounter(name: string, options?: MetricOptions): { add(value: number, attributes?: MetricAttributes): void }
  addBatchObservableCallback(callback: BatchCallbackLike, observables: ObservableLike[]): void
  removeBatchObservableCallback(callback: BatchCallbackLike, observables: ObservableLike[]): void
}

type PollingOutboxMetricsParams = {
  /** The meter of OpenTelemetry, e.g. `metrics.getMeter('orders')`. */
  meter: MeterLike
  /** The attributes of every measurement, e.g. `{ 'hermes.consumer.name': 'orders' }`. */
  attributes?: MetricAttributes
  /**
   * Reads the lag of the consumer, e.g. `() => outbox.getLag()`. Called once per collection of the metrics. Without it,
   * only the metrics of {@link PollingOutboxMetrics.onPoll} are recorded. Return `null` to observe nothing.
   */
  getLag?: () => Promise<PollingOutboxLag | null>
  /** Called when `getLag` fails. Nothing is observed then. An error it throws is ignored. */
  onError?: (error: unknown) => void
}

type PollingOutboxMetrics = {
  /** Records a poll. Pass it as `onPoll` of the consumer. */
  onPoll: (poll: PollingOutboxPoll) => void
  /** Stops observing the lag. */
  dispose: () => void
}

/**
 * Records the metrics of a polling outbox with OpenTelemetry. The durations are in seconds.
 *
 * Observable gauges, from `getLag` (the same for every instance of the consumer, so aggregate them with `max`):
 * - `hermes.outbox.oldest_pending_message.age` (`s`): the age of the oldest undelivered message, 0 when there is none
 * - `hermes.outbox.pending_messages` (`{message}`): undelivered messages, counted up to the limit of `getLag`
 * - `hermes.outbox.failing_messages` (`{message}`): counted undelivered messages that failed at least once
 * - `hermes.outbox.pending_partitions` (`{partition}`): partitions with undelivered messages
 *
 * From `onPoll`, of this instance:
 * - `hermes.outbox.claim.duration` (`s`, histogram): how long a claim took, reading the messages included
 * - `hermes.outbox.publish.duration` (`s`, histogram): how long publishing the claimed messages took
 * - `hermes.outbox.polls` (`{poll}`, counter), `hermes.outbox.messages.published` and `hermes.outbox.messages.failed`
 *   (`{message}`, counters), `hermes.outbox.claims.lost` (`{claim}`, counter)
 *
 * @example
 * ```typescript
 * import { metrics } from '@opentelemetry/api'
 *
 * const outboxMetrics = createPollingOutboxMetrics({
 *   meter: metrics.getMeter('orders'),
 *   attributes: { 'hermes.consumer.name': 'orders' },
 *   getLag: () => outbox.getLag(),
 * })
 * const outbox = createOutboxConsumer({ ..., consumerName: 'orders', onPoll: outboxMetrics.onPoll })
 * ```
 */
const createPollingOutboxMetrics = (params: PollingOutboxMetricsParams): PollingOutboxMetrics => {
  const { meter, attributes, getLag } = params
  const oldestAge = meter.createObservableGauge('hermes.outbox.oldest_pending_message.age', {
    description: 'The age of the oldest undelivered message of the outbox.',
    unit: 's',
  })
  const pending = meter.createObservableGauge('hermes.outbox.pending_messages', {
    description: 'The undelivered messages of the outbox, counted up to a limit.',
    unit: '{message}',
  })
  const failing = meter.createObservableGauge('hermes.outbox.failing_messages', {
    description: 'The counted undelivered messages of the outbox that failed at least once.',
    unit: '{message}',
  })
  const partitions = meter.createObservableGauge('hermes.outbox.pending_partitions', {
    description: 'The partitions of the outbox with undelivered messages.',
    unit: '{partition}',
  })
  const claimDuration = meter.createHistogram('hermes.outbox.claim.duration', {
    description: 'How long a claim of the outbox took, reading the claimed messages included.',
    unit: 's',
    advice: { explicitBucketBoundaries: DurationBuckets },
  })
  const publishDuration = meter.createHistogram('hermes.outbox.publish.duration', {
    description: 'How long publishing the claimed messages of a poll took.',
    unit: 's',
    advice: { explicitBucketBoundaries: DurationBuckets },
  })
  const polls = meter.createCounter('hermes.outbox.polls', { description: 'The polls of the outbox.', unit: '{poll}' })
  const published = meter.createCounter('hermes.outbox.messages.published', {
    description: 'The published messages of the outbox.',
    unit: '{message}',
  })
  const failed = meter.createCounter('hermes.outbox.messages.failed', {
    description: 'The messages of the outbox that could not be published.',
    unit: '{message}',
  })
  const claimsLost = meter.createCounter('hermes.outbox.claims.lost', {
    description: 'The polls that lost a claim to another instance.',
    unit: '{claim}',
  })
  const gauges = [oldestAge, pending, failing, partitions]
  const observeLag: BatchCallbackLike = async (observer) => {
    let lag: PollingOutboxLag | null

    try {
      lag = await getLag!()
    } catch (error) {
      Promise.resolve()
        .then(() => params.onError?.(error))
        .catch(noop)

      return
    }

    if (lag) {
      observer.observe(oldestAge, (lag.oldestPendingAge?.ms ?? 0) / 1000, attributes)
      observer.observe(pending, lag.pending, attributes)
      observer.observe(failing, lag.failing, attributes)
      observer.observe(partitions, lag.partitions, attributes)
    }
  }

  if (getLag) {
    meter.addBatchObservableCallback(observeLag, gauges)
  }

  return {
    onPoll(poll) {
      claimDuration.record(poll.claimDuration.ms / 1000, attributes)
      publishDuration.record(poll.publishDuration.ms / 1000, attributes)
      polls.add(1, attributes)
      published.add(poll.published, attributes)
      failed.add(poll.failed, attributes)

      if (poll.isClaimLost) {
        claimsLost.add(1, attributes)
      }
    },

    dispose() {
      if (getLag) {
        meter.removeBatchObservableCallback(observeLag, gauges)
      }
    },
  }
}

export {
  createPollingOutboxMetrics,
  type BatchObserverLike,
  type MeterLike,
  type MetricAttributes,
  type ObservableLike,
  type PollingOutboxMetrics,
  type PollingOutboxMetricsParams,
}

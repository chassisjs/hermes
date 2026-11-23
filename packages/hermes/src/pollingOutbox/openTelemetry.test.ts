import { describe, expect, test } from '@jest/globals'
import { type Meter } from '@opentelemetry/api'
import { DataPointType, MeterProvider, MetricReader, type MetricData } from '@opentelemetry/sdk-metrics'
import { Duration } from '../duration.js'
import { createPollingOutboxMetrics, type MeterLike } from './openTelemetry.js'
import { type PollingOutboxLag } from './types.js'

class TestReader extends MetricReader {
  protected async onShutdown() {}
  protected async onForceFlush() {}
}

const setUp = () => {
  const reader = new TestReader()
  const provider = new MeterProvider({ readers: [reader] })
  const meter: Meter = provider.getMeter('test')
  const collect = async () => {
    const { resourceMetrics, errors } = await reader.collect()

    expect(errors).toEqual([])

    return new Map<string, MetricData>(
      resourceMetrics.scopeMetrics.flatMap(({ metrics }) => metrics.map((metric) => [metric.descriptor.name, metric])),
    )
  }

  return { meter, collect }
}

const valueOf = (metrics: Map<string, MetricData>, name: string) => metrics.get(name)?.dataPoints[0]?.value

const lag: PollingOutboxLag = {
  oldestPendingAge: Duration.ofSeconds(90),
  pending: 120,
  isPendingExact: true,
  failing: 3,
  partitions: 7,
}

describe('createPollingOutboxMetrics', () => {
  test('a Meter of @opentelemetry/api is a MeterLike', () => {
    const meter: MeterLike = setUp().meter

    expect(meter).toBeDefined()
  })

  test('observes the lag once per collection, with the attributes, and stops after dispose', async () => {
    const { meter, collect } = setUp()
    let reads = 0
    const metrics = createPollingOutboxMetrics({
      meter,
      attributes: { 'hermes.consumer.name': 'orders' },
      getLag: async () => {
        reads++
        return lag
      },
    })
    const collected = await collect()

    expect(reads).toBe(1)
    expect(valueOf(collected, 'hermes.outbox.oldest_pending_message.age')).toBe(90)
    expect(valueOf(collected, 'hermes.outbox.pending_messages')).toBe(120)
    expect(valueOf(collected, 'hermes.outbox.failing_messages')).toBe(3)
    expect(valueOf(collected, 'hermes.outbox.pending_partitions')).toBe(7)
    expect(collected.get('hermes.outbox.oldest_pending_message.age')?.descriptor.unit).toBe('s')
    expect(collected.get('hermes.outbox.pending_messages')?.dataPoints[0].attributes).toEqual({
      'hermes.consumer.name': 'orders',
    })

    metrics.dispose()
    await collect()

    expect(reads).toBe(1)
  })

  test('observes 0 as the age when there is no undelivered message', async () => {
    const { meter, collect } = setUp()

    createPollingOutboxMetrics({ meter, getLag: async () => ({ ...lag, oldestPendingAge: null, pending: 0 }) })

    expect(valueOf(await collect(), 'hermes.outbox.oldest_pending_message.age')).toBe(0)
  })

  test('a failing getLag is reported and does not break the collection of the other metrics', async () => {
    const { meter, collect } = setUp()
    const errors: unknown[] = []
    const metrics = createPollingOutboxMetrics({
      meter,
      getLag: async () => {
        throw new Error('database is down')
      },
      onError: (error) => {
        errors.push(error)
        throw new Error('the handler fails too')
      },
    })

    metrics.onPoll({
      claimDuration: Duration.ofMiliseconds(1500),
      publishDuration: Duration.ofMiliseconds(250),
      lanes: 2,
      messages: 5,
      published: 4,
      failed: 1,
      isClaimLost: true,
    })

    const collected = await collect()

    expect(errors).toEqual([new Error('database is down')])
    expect(collected.has('hermes.outbox.pending_messages')).toBe(false)
    expect(valueOf(collected, 'hermes.outbox.polls')).toBe(1)
    expect(valueOf(collected, 'hermes.outbox.messages.published')).toBe(4)
    expect(valueOf(collected, 'hermes.outbox.messages.failed')).toBe(1)
    expect(valueOf(collected, 'hermes.outbox.claims.lost')).toBe(1)

    const claimDuration = collected.get('hermes.outbox.claim.duration')!

    expect(claimDuration.dataPointType).toBe(DataPointType.HISTOGRAM)
    expect(claimDuration.dataPoints[0].value).toMatchObject({ count: 1, sum: 1.5 })
  })
})

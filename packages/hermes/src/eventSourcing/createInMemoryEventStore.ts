import { randomUUID } from 'node:crypto'
import { type Event } from '../core/typing/event.js'
import { assert } from '../utils/assert.js'
import { assertExpectedVersion } from './expectedVersion.js'
import { type EventStore, type RecordedEvent } from './types.js'

/**
 * An event store in memory, e.g. for the tests of deciders and projections.
 *
 * Every append runs without awaiting anything, so concurrent appends to the same stream are atomic. The events are
 * copied when they are stored and when they are read.
 */
const createInMemoryEventStore = (): EventStore => {
  const streams = new Map<string, RecordedEvent[]>()

  return {
    async readStream<E extends Event>(streamId: string, options?: { after?: bigint }) {
      const events = streams.get(streamId) ?? []
      const after = options?.after ?? 0n

      return {
        events: events
          .filter(({ streamPosition }) => streamPosition > after)
          .map(
            (event) =>
              ({
                ...event,
                data: structuredClone(event.data),
                metadata: structuredClone(event.metadata),
                recordedAt: new Date(event.recordedAt.getTime()),
              }) as RecordedEvent<E>,
          ),
        currentVersion: BigInt(events.length),
        streamExists: events.length > 0,
      }
    },

    async appendToStream(streamId, events, options) {
      assert(events.length > 0, 'There are no events to append.')

      const stream = streams.get(streamId) ?? []
      const currentVersion = BigInt(stream.length)

      assertExpectedVersion(streamId, options?.expectedVersion ?? 'any', currentVersion)

      const recordedAt = new Date()
      const recorded = events.map(
        (event, i) =>
          ({
            type: event.type,
            data: structuredClone(event.data),
            metadata: structuredClone((event as { metadata?: unknown }).metadata ?? {}),
            streamId,
            streamPosition: currentVersion + BigInt(i + 1),
            eventId: randomUUID(),
            recordedAt,
          }) as RecordedEvent,
      )

      streams.set(streamId, [...stream, ...recorded])

      return { nextVersion: currentVersion + BigInt(events.length), createdNewStream: currentVersion === 0n }
    },
  }
}

export { createInMemoryEventStore }

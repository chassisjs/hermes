import { describe, expect, test } from '@jest/globals'
import { createInMemoryEventStore, VersionConflictError } from '../index.js'
import { completed, FUTURE, note, scheduled, type SchedulingEvent } from './scheduling.fixture.js'

/*
  The contract of an event store, on the in-memory implementation:

  1. appending facts to the end of a stream
  2. reading all the events of a stream
  3. the order of the events in a stream
  4. reading your own writes at once
  5. atomic appends with optimistic concurrency
  6. storing data and metadata
*/

describe('createInMemoryEventStore', () => {
  describe('appending and reading', () => {
    test('the first append creates the stream and numbers its events from 1', async () => {
      const store = createInMemoryEventStore()

      const result = await store.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', FUTURE), note('a')])
      const { events, currentVersion, streamExists } = await store.readStream<SchedulingEvent>('task-1')

      expect(result).toEqual({ nextVersion: 2n, createdNewStream: true })
      expect(streamExists).toBe(true)
      expect(currentVersion).toBe(2n)
      expect(events.map(({ streamId, streamPosition, type }) => ({ streamId, streamPosition, type }))).toEqual([
        { streamId: 'task-1', streamPosition: 1n, type: 'OccurrenceScheduled' },
        { streamId: 'task-1', streamPosition: 2n, type: 'NoteAdded' },
      ])
    })

    test('the version of a stream is the number of its events', async () => {
      const store = createInMemoryEventStore()

      await store.appendToStream<SchedulingEvent>('task-1', [note('a')])
      await store.appendToStream<SchedulingEvent>('task-1', [note('b'), note('c')])
      const result = await store.appendToStream<SchedulingEvent>('task-1', [note('d')])

      expect(result).toEqual({ nextVersion: 4n, createdNewStream: false })
      expect((await store.readStream('task-1')).currentVersion).toBe(4n)
    })

    test('reads the events in the order they were appended', async () => {
      const store = createInMemoryEventStore()

      for (const text of ['a', 'b', 'c', 'd', 'e']) {
        await store.appendToStream<SchedulingEvent>('task-1', [note(text)])
      }

      const { events } = await store.readStream<SchedulingEvent>('task-1')

      expect(events.map(({ data }) => data)).toEqual(['a', 'b', 'c', 'd', 'e'].map((text) => ({ text })))
      expect(events.map(({ streamPosition }) => streamPosition)).toEqual([1n, 2n, 3n, 4n, 5n])
    })

    test('reads the events after a position', async () => {
      const store = createInMemoryEventStore()

      await store.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b'), note('c')])

      const { events, currentVersion } = await store.readStream<SchedulingEvent>('task-1', { after: 1n })

      expect(events.map(({ streamPosition }) => streamPosition)).toEqual([2n, 3n])
      expect(currentVersion).toBe(3n)
    })

    test('a stream that does not exist is empty at version 0', async () => {
      const store = createInMemoryEventStore()

      expect(await store.readStream('task-404')).toEqual({ events: [], currentVersion: 0n, streamExists: false })
    })

    test('reads its own writes at once', async () => {
      const store = createInMemoryEventStore()

      const { nextVersion } = await store.appendToStream<SchedulingEvent>('task-1', [note('a')])

      expect((await store.readStream('task-1')).currentVersion).toBe(nextVersion)
    })

    test('streams are independent', async () => {
      const store = createInMemoryEventStore()

      await store.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b')])
      await store.appendToStream<SchedulingEvent>('task-2', [note('c')])

      expect((await store.readStream('task-1')).currentVersion).toBe(2n)
      expect((await store.readStream('task-2')).events.map(({ streamPosition }) => streamPosition)).toEqual([1n])
    })
  })

  describe('data and metadata', () => {
    test('keeps the data and the metadata of the events', async () => {
      const store = createInMemoryEventStore()

      await store.appendToStream('task-1', [
        { type: 'NoteAdded', data: { text: 'a' }, metadata: { correlationId: 'c-1', userId: 'u-1' } },
      ])

      const [event] = (await store.readStream('task-1')).events

      expect(event).toMatchObject({
        type: 'NoteAdded',
        data: { text: 'a' },
        metadata: { correlationId: 'c-1', userId: 'u-1' },
      })
    })

    test('gives every event a unique id and the time it was recorded', async () => {
      const store = createInMemoryEventStore()

      await store.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b')])
      await store.appendToStream<SchedulingEvent>('task-2', [note('c')])

      const events = [...(await store.readStream('task-1')).events, ...(await store.readStream('task-2')).events]

      expect(new Set(events.map(({ eventId }) => eventId)).size).toBe(3)
      events.forEach(({ eventId, recordedAt }) => {
        expect(typeof eventId).toBe('string')
        expect(recordedAt).toBeInstanceOf(Date)
      })
    })

    test('changing a read event does not change the stream', async () => {
      const store = createInMemoryEventStore()

      await store.appendToStream<SchedulingEvent>('task-1', [note('a')])

      const [event] = (await store.readStream<SchedulingEvent>('task-1')).events
      ;(event.data as { text: string }).text = 'changed'

      expect((await store.readStream<SchedulingEvent>('task-1')).events[0].data).toEqual({ text: 'a' })
    })
  })

  describe('optimistic concurrency', () => {
    test('appends when the expected version is the current one', async () => {
      const store = createInMemoryEventStore()

      await store.appendToStream<SchedulingEvent>('task-1', [note('a')])

      await expect(
        store.appendToStream<SchedulingEvent>('task-1', [note('b')], { expectedVersion: 1n }),
      ).resolves.toEqual({
        nextVersion: 2n,
        createdNewStream: false,
      })
    })

    test('rejects an append when the stream moved on, and appends nothing', async () => {
      const store = createInMemoryEventStore()

      await store.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b')])

      const error = await store
        .appendToStream<SchedulingEvent>('task-1', [note('c'), note('d')], { expectedVersion: 1n })
        .catch((error: unknown) => error)

      expect(error).toBeInstanceOf(VersionConflictError)
      expect(error).toMatchObject({ details: { streamId: 'task-1', expectedVersion: 1n, currentVersion: 2n } })
      expect((await store.readStream('task-1')).currentVersion).toBe(2n)
    })

    test('`no_stream` appends only to a stream that does not exist', async () => {
      const store = createInMemoryEventStore()

      await store.appendToStream<SchedulingEvent>('task-1', [note('a')], { expectedVersion: 'no_stream' })

      await expect(
        store.appendToStream<SchedulingEvent>('task-1', [note('b')], { expectedVersion: 'no_stream' }),
      ).rejects.toBeInstanceOf(VersionConflictError)
    })

    test('version 0 means that the stream does not exist', async () => {
      const store = createInMemoryEventStore()

      await store.appendToStream<SchedulingEvent>('task-1', [note('a')], { expectedVersion: 0n })

      await expect(
        store.appendToStream<SchedulingEvent>('task-1', [note('b')], { expectedVersion: 0n }),
      ).rejects.toBeInstanceOf(VersionConflictError)
    })

    test('`stream_exists` appends only to a stream that exists', async () => {
      const store = createInMemoryEventStore()

      await expect(
        store.appendToStream<SchedulingEvent>('task-1', [note('a')], { expectedVersion: 'stream_exists' }),
      ).rejects.toBeInstanceOf(VersionConflictError)

      await store.appendToStream<SchedulingEvent>('task-1', [note('a')])

      await expect(
        store.appendToStream<SchedulingEvent>('task-1', [note('b')], { expectedVersion: 'stream_exists' }),
      ).resolves.toMatchObject({ nextVersion: 2n })
    })

    test('`any` appends without a check, also by default', async () => {
      const store = createInMemoryEventStore()

      await store.appendToStream<SchedulingEvent>('task-1', [note('a')], { expectedVersion: 'any' })
      await store.appendToStream<SchedulingEvent>('task-1', [completed('o-1')])

      expect((await store.readStream('task-1')).currentVersion).toBe(2n)
    })

    test('of concurrent appends with the same expected version, only one succeeds', async () => {
      const store = createInMemoryEventStore()

      await store.appendToStream<SchedulingEvent>('task-1', [note('a')])

      const results = await Promise.allSettled(
        ['b', 'c', 'd', 'e'].map((text) =>
          store.appendToStream<SchedulingEvent>('task-1', [note(text)], { expectedVersion: 1n }),
        ),
      )

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .forEach(({ reason }) => expect(reason).toBeInstanceOf(VersionConflictError))
      expect((await store.readStream('task-1')).currentVersion).toBe(2n)
    })

    // Unlike Emmett, which treats an empty append as a no-op: an empty append is a bug of the caller.
    test('appending no events is rejected', async () => {
      const store = createInMemoryEventStore()

      await expect(store.appendToStream('task-1', [])).rejects.toThrow()
    })

    test.each([
      { name: 'the current version + 1', expectedVersion: 3n },
      { name: 'an older version', expectedVersion: 1n },
      { name: '`no_stream`', expectedVersion: 'no_stream' as const },
    ])('a rejected append to an existing stream changes nothing ($name)', async ({ expectedVersion }) => {
      const store = createInMemoryEventStore()
      await store.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b')])
      const before = await store.readStream('task-1')

      await expect(
        store.appendToStream<SchedulingEvent>('task-1', [note('c')], { expectedVersion }),
      ).rejects.toBeInstanceOf(VersionConflictError)

      expect(await store.readStream('task-1')).toEqual(before)
    })

    test.each([
      { name: 'a version above 0', expectedVersion: 1n },
      { name: '`stream_exists`', expectedVersion: 'stream_exists' as const },
    ])('a rejected append to a missing stream does not create it ($name)', async ({ expectedVersion }) => {
      const store = createInMemoryEventStore()

      await expect(
        store.appendToStream<SchedulingEvent>('task-1', [note('a')], { expectedVersion }),
      ).rejects.toBeInstanceOf(VersionConflictError)

      expect(await store.readStream('task-1')).toEqual({ events: [], currentVersion: 0n, streamExists: false })
    })

    test.each([
      { name: '`any`', expectedVersion: 'any' as const },
      { name: '`stream_exists`', expectedVersion: 'stream_exists' as const },
    ])('concurrent appends with $name all succeed, with positions without gaps', async ({ expectedVersion }) => {
      const store = createInMemoryEventStore()
      await store.appendToStream<SchedulingEvent>('task-1', [note('first')])

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          store.appendToStream<SchedulingEvent>('task-1', [note(`${i}`)], { expectedVersion }),
        ),
      )

      expect(results.every(({ status }) => status === 'fulfilled')).toBe(true)
      expect((await store.readStream('task-1')).events.map(({ streamPosition }) => streamPosition)).toEqual(
        Array.from({ length: 11 }, (_, i) => BigInt(i + 1)),
      )
    })
  })

  test('other streams do not make a missing stream exist', async () => {
    const store = createInMemoryEventStore()

    await store.appendToStream<SchedulingEvent>('task-1', [note('a')])

    expect((await store.readStream('task-2')).streamExists).toBe(false)
  })
})

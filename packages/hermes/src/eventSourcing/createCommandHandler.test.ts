import { describe, expect, jest, test } from '@jest/globals'
import { createCommandHandler, createInMemoryEventStore, VersionConflictError, type EventStore } from '../index.js'
import {
  complete,
  completed,
  FUTURE,
  NoOpenOccurrenceError,
  note,
  NOW,
  PAST,
  schedule,
  scheduled,
  scheduling,
  tick,
  type SchedulingEvent,
} from './scheduling.fixture.js'

const typesOf = async (store: EventStore, streamId: string) =>
  (await store.readStream<SchedulingEvent>(streamId)).events.map(({ type }) => type)

/** Appends `competing` once, between reading the state and appending, as if another instance had been faster. */
const withCompetingAppend = (store: EventStore, competing: SchedulingEvent, times = 1): EventStore => {
  let left = times

  return {
    ...store,
    async appendToStream(streamId, events, options) {
      if (left > 0) {
        left--
        await store.appendToStream(streamId, [competing])
      }

      return store.appendToStream(streamId, events, options)
    },
  }
}

describe('createCommandHandler', () => {
  describe('deciding', () => {
    test('the first command creates the stream', async () => {
      const eventStore = createInMemoryEventStore()
      const handle = createCommandHandler({ decider: scheduling, eventStore })

      const result = await handle('task-1', schedule('o-1', FUTURE))

      expect(result).toEqual({
        newEvents: [scheduled('o-1', FUTURE)],
        newState: { status: 'scheduled', occurrenceId: 'o-1', dueAt: FUTURE },
        nextVersion: 1n,
        createdNewStream: true,
      })
      expect(await typesOf(eventStore, 'task-1')).toEqual(['OccurrenceScheduled'])
    })

    test('decide can return many events, and they are appended together', async () => {
      const eventStore = createInMemoryEventStore()
      const handle = createCommandHandler({ decider: scheduling, eventStore })

      const { newEvents, newState, nextVersion } = await handle('task-1', schedule('o-1', PAST))

      expect(newEvents.map(({ type }) => type)).toEqual(['OccurrenceScheduled', 'OccurrenceBecameDueNow'])
      expect(newState.status).toBe('dueNow')
      expect(nextVersion).toBe(2n)
      expect(await typesOf(eventStore, 'task-1')).toEqual(['OccurrenceScheduled', 'OccurrenceBecameDueNow'])
    })

    test('by default the state is folded from the events of the stream', async () => {
      const eventStore = createInMemoryEventStore()
      const handle = createCommandHandler({ decider: scheduling, eventStore })

      await eventStore.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', PAST), note('a')])

      const { newEvents, nextVersion } = await handle('task-1', tick(NOW))

      expect(newEvents).toEqual([{ type: 'OccurrenceBecameDueNow', data: { occurrenceId: 'o-1', dueAt: PAST } }])
      expect(nextVersion).toBe(3n)
    })

    test('a decision without events appends nothing', async () => {
      const eventStore = createInMemoryEventStore()
      const handle = createCommandHandler({ decider: scheduling, eventStore })

      await eventStore.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', FUTURE)])

      const result = await handle('task-1', tick(NOW))

      expect(result).toEqual({
        newEvents: [],
        newState: { status: 'scheduled', occurrenceId: 'o-1', dueAt: FUTURE },
        nextVersion: 1n,
        createdNewStream: false,
      })
      expect((await eventStore.readStream('task-1')).currentVersion).toBe(1n)
    })

    test('a rejected command appends nothing', async () => {
      const eventStore = createInMemoryEventStore()
      const handle = createCommandHandler({ decider: scheduling, eventStore })

      await expect(handle('task-1', complete('o-1'))).rejects.toBeInstanceOf(NoOpenOccurrenceError)
      expect((await eventStore.readStream('task-1')).streamExists).toBe(false)
    })

    test('a first command without events does not create the stream', async () => {
      const eventStore = createInMemoryEventStore()
      const handle = createCommandHandler({ decider: scheduling, eventStore })

      const result = await handle('task-1', tick(NOW))

      expect(result).toEqual({
        newEvents: [],
        newState: scheduling.initialState(),
        nextVersion: 0n,
        createdNewStream: false,
      })
      expect((await eventStore.readStream('task-1')).streamExists).toBe(false)
    })

    test('decide can return a single event, not an array', async () => {
      const eventStore = createInMemoryEventStore()
      const handle = createCommandHandler({ decider: scheduling, eventStore })
      await handle('task-1', schedule('o-1', FUTURE))

      const { newEvents, newState, nextVersion } = await handle('task-1', complete('o-1'))

      expect(newEvents).toEqual([completed('o-1')])
      expect(newState.status).toBe('completed')
      expect(nextVersion).toBe(2n)
    })
  })

  describe('concurrency', () => {
    test('decides again on the new state when another instance appended first', async () => {
      // A tick and a user complete the same occurrence at the same time. The user wins.
      const store = createInMemoryEventStore()
      await store.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', PAST)])
      const decide = jest.fn(scheduling.decide)
      const handle = createCommandHandler({
        decider: { ...scheduling, decide },
        eventStore: withCompetingAppend(store, completed('o-1')),
        retry: { attempts: 1 },
      })

      const result = await handle('task-1', tick(NOW))

      expect(decide).toHaveBeenCalledTimes(2)
      expect(result.newEvents).toEqual([])
      expect(result.newState.status).toBe('completed')
      expect(await typesOf(store, 'task-1')).toEqual(['OccurrenceScheduled', 'TaskCompleted'])
    })

    test('gives up with a version conflict after the retries', async () => {
      const store = createInMemoryEventStore()
      await store.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', PAST)])
      const decide = jest.fn(scheduling.decide)
      const handle = createCommandHandler({
        decider: { ...scheduling, decide },
        eventStore: withCompetingAppend(store, note('faster'), 10),
        retry: { attempts: 2 },
      })

      await expect(handle('task-1', tick(NOW))).rejects.toBeInstanceOf(VersionConflictError)
      expect(decide).toHaveBeenCalledTimes(3)
      expect(await typesOf(store, 'task-1')).not.toContain('OccurrenceBecameDueNow')
    })

    test('does not retry an error other than a version conflict', async () => {
      const eventStore = createInMemoryEventStore()
      const decide = jest.fn(scheduling.decide)
      const handle = createCommandHandler({ decider: { ...scheduling, decide }, eventStore, retry: { attempts: 5 } })

      await expect(handle('task-1', complete('o-1'))).rejects.toBeInstanceOf(NoOpenOccurrenceError)
      expect(decide).toHaveBeenCalledTimes(1)
    })

    test('does not retry without a retry policy', async () => {
      const store = createInMemoryEventStore()
      await store.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', PAST)])
      const handle = createCommandHandler({
        decider: scheduling,
        eventStore: withCompetingAppend(store, note('faster')),
      })

      await expect(handle('task-1', tick(NOW))).rejects.toBeInstanceOf(VersionConflictError)
    })

    test('an expected version given by the caller is checked and never retried', async () => {
      const eventStore = createInMemoryEventStore()
      await eventStore.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', PAST), note('a')])
      const decide = jest.fn(scheduling.decide)
      const handle = createCommandHandler({ decider: { ...scheduling, decide }, eventStore, retry: { attempts: 5 } })

      const error = await handle('task-1', complete('o-1'), { expectedVersion: 1n }).catch((error: unknown) => error)

      expect(error).toBeInstanceOf(VersionConflictError)
      expect(error).toMatchObject({ details: { streamId: 'task-1', expectedVersion: 1n, currentVersion: 2n } })
      expect(decide).toHaveBeenCalledTimes(1)
    })

    test('`no_stream` rejects a command for a stream that exists', async () => {
      const eventStore = createInMemoryEventStore()
      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a')])
      const handle = createCommandHandler({ decider: scheduling, eventStore })

      await expect(handle('task-1', schedule('o-1', FUTURE), { expectedVersion: 'no_stream' })).rejects.toBeInstanceOf(
        VersionConflictError,
      )
    })
  })

  describe('state-stored', () => {
    test('takes the state and the version from `loadState` instead of the events', async () => {
      const eventStore = createInMemoryEventStore()
      const readStream = jest.spyOn(eventStore, 'readStream')
      const loadState = jest.fn(async (_params: { streamId: string }) => ({
        state: { status: 'scheduled' as const, occurrenceId: 'o-9', dueAt: PAST },
        version: 0n,
      }))
      const handle = createCommandHandler({ decider: scheduling, eventStore, loadState })

      const { newEvents, nextVersion, createdNewStream } = await handle('task-1', tick(NOW))

      expect(loadState).toHaveBeenCalledWith(expect.objectContaining({ streamId: 'task-1' }))
      expect(readStream).not.toHaveBeenCalled()
      expect(newEvents).toEqual([{ type: 'OccurrenceBecameDueNow', data: { occurrenceId: 'o-9', dueAt: PAST } }])
      expect(nextVersion).toBe(1n)
      expect(createdNewStream).toBe(true)
    })

    test('appends with the version from `loadState`, so a stale state is a conflict', async () => {
      const eventStore = createInMemoryEventStore()
      await eventStore.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', PAST), completed('o-1')])
      const handle = createCommandHandler({
        decider: scheduling,
        eventStore,
        // the stored state is one event behind the stream
        loadState: async () => ({ state: { status: 'scheduled', occurrenceId: 'o-1', dueAt: PAST }, version: 1n }),
      })

      await expect(handle('task-1', tick(NOW))).rejects.toBeInstanceOf(VersionConflictError)
      expect(await typesOf(eventStore, 'task-1')).toEqual(['OccurrenceScheduled', 'TaskCompleted'])
    })
  })
})

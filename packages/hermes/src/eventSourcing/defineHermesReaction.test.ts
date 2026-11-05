import { describe, expect, jest, test } from '@jest/globals'
import { defineHermesReaction, reactOn, type RecordedEvent } from '../index.js'
import { type SchedulingEvent } from './scheduling.fixture.js'

const recorded = (event: SchedulingEvent, streamPosition = 1n): RecordedEvent<SchedulingEvent> =>
  ({
    ...event,
    metadata: {},
    streamId: 'task-1',
    streamPosition,
    eventId: `task-1:${streamPosition}`,
    recordedAt: new Date(),
  }) as unknown as RecordedEvent<SchedulingEvent>

describe('defineHermesReaction', () => {
  test('done() returns what the builder was given', () => {
    const handle = jest.fn<() => void>()
    const reaction = defineHermesReaction<SchedulingEvent>()
      .ofName('billing:charge')
      .ofEvents('TaskCompleted', 'TaskCompleted')
      .ofHandler(handle)
      .done()

    expect(reaction).toMatchObject({ name: 'billing:charge', kind: 'reaction', eventTypes: ['TaskCompleted'] })
    expect(Object.isFrozen(reaction)).toBe(true)
    expect(Object.isFrozen(reaction.eventTypes)).toBe(true)
  })

  test('handles only the events listed in ofEvents', () => {
    const reaction = defineHermesReaction<SchedulingEvent>()
      .ofName('billing:charge')
      .ofEvents('TaskCompleted')
      .ofHandler(() => {})
      .done()

    expect(reaction.canHandle({ type: 'TaskCompleted' })).toBe(true)
    expect(reaction.canHandle({ type: 'NoteAdded' })).toBe(false)
  })

  test('the handler gets the event and the transaction', async () => {
    const calls: { type: 'TaskCompleted'; occurrenceId: string; tx: string }[] = []
    const reaction = defineHermesReaction<SchedulingEvent, string>()
      .ofName('billing:charge')
      .ofEvents('TaskCompleted')
      .ofHandler((event, { tx }) => {
        // the event is narrowed to the events of ofEvents
        calls.push({ type: event.type, occurrenceId: event.data.occurrenceId, tx })
      })
      .done()

    await reaction.handle(
      recorded({ type: 'TaskCompleted', data: { occurrenceId: 'o-1', completedAt: '2026-11-04T10:00:00.000Z' } }),
      { tx: 'tx-1' },
    )

    expect(calls).toEqual([{ type: 'TaskCompleted', occurrenceId: 'o-1', tx: 'tx-1' }])
  })

  test('needs a name and at least one event type', () => {
    expect(() => defineHermesReaction<SchedulingEvent>().ofName(' ')).toThrow('A reaction needs a name.')
    expect(() => defineHermesReaction<SchedulingEvent>().ofName('billing:charge').ofEvents()).toThrow(
      'Reaction billing:charge needs at least one event type.',
    )
  })

  test('reactOn is an alias', () => {
    expect(reactOn).toBe(defineHermesReaction)
  })
})

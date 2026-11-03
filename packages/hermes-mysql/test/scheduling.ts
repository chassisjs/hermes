import { assertNever, type Command, type Decider, type Event } from '@chassisjs/hermes'

/*
  A small scheduling domain used by the tests of the event store, the command handler and the projections.

  An occurrence of a maintenance task is scheduled, becomes Due Now when its time comes, and is completed.
  ISO dates in UTC compare as strings.
*/

type OccurrenceScheduled = Event<'OccurrenceScheduled', { occurrenceId: string; dueAt: string }>
type OccurrenceBecameDueNow = Event<'OccurrenceBecameDueNow', { occurrenceId: string; dueAt: string }>
type TaskCompleted = Event<'TaskCompleted', { occurrenceId: string; completedAt: string }>
/** An event that does not change the state of the decider. */
type NoteAdded = Event<'NoteAdded', { text: string }>
type SchedulingEvent = OccurrenceScheduled | OccurrenceBecameDueNow | TaskCompleted | NoteAdded

type ScheduleOccurrence = Command<'ScheduleOccurrence', { occurrenceId: string; dueAt: string; now: string }>
type Tick = Command<'Tick', { now: string }>
type CompleteTask = Command<'CompleteTask', { occurrenceId: string; now: string }>
type SchedulingCommand = ScheduleOccurrence | Tick | CompleteTask

type Occurrence = {
  status: 'none' | 'scheduled' | 'dueNow' | 'completed'
  occurrenceId: string | null
  dueAt: string | null
}

class OccurrenceAlreadyOpenError extends Error {}
class NoOpenOccurrenceError extends Error {}

const scheduling: Decider<Occurrence, SchedulingCommand, SchedulingEvent> = {
  initialState: () => ({ status: 'none', occurrenceId: null, dueAt: null }),

  decide(command, state) {
    switch (command.type) {
      case 'ScheduleOccurrence': {
        if (state.status === 'scheduled' || state.status === 'dueNow') {
          throw new OccurrenceAlreadyOpenError(`Occurrence ${state.occurrenceId} is still open.`)
        }

        const { occurrenceId, dueAt, now } = command.data
        const scheduled: OccurrenceScheduled = { type: 'OccurrenceScheduled', data: { occurrenceId, dueAt } }

        // The decider emits the threshold that has already passed together with the scheduling.
        return dueAt <= now
          ? [scheduled, { type: 'OccurrenceBecameDueNow', data: { occurrenceId, dueAt } }]
          : [scheduled]
      }
      case 'Tick':
        return state.status === 'scheduled' && state.dueAt! <= command.data.now
          ? [{ type: 'OccurrenceBecameDueNow', data: { occurrenceId: state.occurrenceId!, dueAt: state.dueAt! } }]
          : []
      case 'CompleteTask':
        if (state.status !== 'scheduled' && state.status !== 'dueNow') {
          throw new NoOpenOccurrenceError('There is no open occurrence to complete.')
        }

        return {
          type: 'TaskCompleted',
          data: { occurrenceId: command.data.occurrenceId, completedAt: command.data.now },
        }
      default:
        return assertNever(command)
    }
  },

  evolve(state, event) {
    switch (event.type) {
      case 'OccurrenceScheduled':
        return { status: 'scheduled', occurrenceId: event.data.occurrenceId, dueAt: event.data.dueAt }
      case 'OccurrenceBecameDueNow':
        return { ...state, status: 'dueNow' }
      case 'TaskCompleted':
        return { ...state, status: 'completed' }
      case 'NoteAdded':
        return state
      default:
        return assertNever(event)
    }
  },
}

const PAST = '2026-11-03T08:00:00.000Z'
const NOW = '2026-11-03T09:00:00.000Z'
const FUTURE = '2026-11-03T10:00:00.000Z'

const schedule = (occurrenceId: string, dueAt: string, now = NOW): ScheduleOccurrence => ({
  type: 'ScheduleOccurrence',
  data: { occurrenceId, dueAt, now },
})
const tick = (now = NOW): Tick => ({ type: 'Tick', data: { now } })
const complete = (occurrenceId: string, now = NOW): CompleteTask => ({
  type: 'CompleteTask',
  data: { occurrenceId, now },
})
const scheduled = (occurrenceId: string, dueAt: string): OccurrenceScheduled => ({
  type: 'OccurrenceScheduled',
  data: { occurrenceId, dueAt },
})
const completed = (occurrenceId: string, completedAt = NOW): TaskCompleted => ({
  type: 'TaskCompleted',
  data: { occurrenceId, completedAt },
})
const note = (text: string): NoteAdded => ({ type: 'NoteAdded', data: { text } })

export {
  complete,
  completed,
  FUTURE,
  note,
  NoOpenOccurrenceError,
  NOW,
  OccurrenceAlreadyOpenError,
  PAST,
  schedule,
  scheduled,
  scheduling,
  tick,
  type Occurrence,
  type SchedulingCommand,
  type SchedulingEvent,
}

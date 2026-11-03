import { describe, expect, test } from '@jest/globals'
import { applyProjection, assertNever, defineHermesProjection, type Event, type RecordedEvent } from '../index.js'
import { scheduling, type Occurrence, type SchedulingEvent } from './scheduling.fixture.js'

type PatientAdded = Event<'PatientAdded', { patientId: number }>
type Marker1Evaluated = Event<'Marker1Evaluated', { patientId: number; marker1: number; testDate: string }>
type Marker2Evaluated = Event<'Marker2Evaluated', { patientId: number; marker2: number; testDate: string }>
type AlertRaised = Event<'AlertRaised', { patientId: number }>
type PatientChecked = Event<'PatientChecked', { patientId: number }>
type PatientRemoved = Event<'PatientRemoved', { patientId: number }>
type PriorityPatientEvent = PatientAdded | Marker1Evaluated | Marker2Evaluated | AlertRaised | PatientChecked
type PatientEvent = PriorityPatientEvent | PatientRemoved

type PriorityPatient = {
  patientId: number
  marker1: number | null
  marker2: number | null
  lastTestAt: string | null
  priority: boolean
}

const initialPatient = (): PriorityPatient => ({
  patientId: 0,
  marker1: null,
  marker2: null,
  lastTestAt: null,
  priority: false,
})

const priorityPatients = defineHermesProjection<PriorityPatient, PatientEvent>()
  .ofName('priorityPatients')
  .ofDocumentType()
  .ofEvents('AlertRaised', 'Marker1Evaluated', 'Marker2Evaluated', 'PatientAdded', 'PatientChecked')
  .ofInitialState(initialPatient)
  .ofEvolve((state, event) => {
    switch (event.type) {
      case 'PatientAdded':
        return { ...state, patientId: event.data.patientId }
      case 'Marker1Evaluated':
        return { ...state, marker1: event.data.marker1, lastTestAt: event.data.testDate }
      case 'Marker2Evaluated':
        return { ...state, marker2: event.data.marker2, lastTestAt: event.data.testDate }
      case 'AlertRaised':
        return { ...state, priority: true }
      case 'PatientChecked':
        return { ...state, priority: false }
      default:
        return assertNever(event)
    }
  })
  .ofId((event) => `patient-${event.data.patientId}`)
  .done()

let position = 0n
const recorded = <E extends Event>(event: E, streamId = 'patients'): RecordedEvent<E> =>
  ({
    ...event,
    metadata: {},
    streamId,
    streamPosition: ++position,
    eventId: `${streamId}:${position}`,
    recordedAt: new Date(),
  }) as unknown as RecordedEvent<E>

const added = (patientId: number) => recorded<PatientEvent>({ type: 'PatientAdded', data: { patientId } })
const marker1 = (patientId: number, value: number, testDate: string) =>
  recorded<PatientEvent>({ type: 'Marker1Evaluated', data: { patientId, marker1: value, testDate } })
const alert = (patientId: number) => recorded<PatientEvent>({ type: 'AlertRaised', data: { patientId } })
const removed = (patientId: number) => recorded<PatientEvent>({ type: 'PatientRemoved', data: { patientId } })

describe('defineHermesProjection', () => {
  describe('the definition', () => {
    test('done() returns what the builder was given', () => {
      expect(priorityPatients).toMatchObject({
        name: 'priorityPatients',
        kind: 'document',
        mode: 'async',
        eventTypes: ['AlertRaised', 'Marker1Evaluated', 'Marker2Evaluated', 'PatientAdded', 'PatientChecked'],
      })
    })

    test('the definition cannot be changed', () => {
      expect(Object.isFrozen(priorityPatients)).toBe(true)
      expect(Object.isFrozen(priorityPatients.eventTypes)).toBe(true)
    })

    test('a projection is async unless it is inline', () => {
      const inline = defineHermesProjection<PriorityPatient, PatientEvent>()
        .ofName('inline')
        .ofDocumentType()
        .ofEvents('PatientAdded')
        .ofInitialState(initialPatient)
        .ofEvolve((state, event) => ({ ...state, patientId: event.data.patientId }))
        .inline()
        .done()

      expect(inline.mode).toBe('inline')
    })

    test('the event types are kept once', () => {
      const projection = defineHermesProjection<PriorityPatient, PatientEvent>()
        .ofName('twice')
        .ofDocumentType()
        .ofEvents('PatientAdded', 'AlertRaised', 'PatientAdded')
        .ofInitialState(initialPatient)
        .ofEvolve((state) => state)
        .done()

      expect(projection.eventTypes).toEqual(['PatientAdded', 'AlertRaised'])
    })

    test('a projection needs a name', () => {
      expect(() => defineHermesProjection<PriorityPatient, PatientEvent>().ofName('')).toThrow()
    })

    test('a projection needs at least one event type', () => {
      expect(() =>
        defineHermesProjection<PriorityPatient, PatientEvent>().ofName('none').ofDocumentType().ofEvents(),
      ).toThrow()
    })
  })

  describe('typing', () => {
    test('ofEvents accepts only the types of the events of the projection', () => {
      defineHermesProjection<PriorityPatient, PatientEvent>()
        .ofName('typed')
        .ofDocumentType()
        // @ts-expect-error `PatientArchived` is not an event of the projection
        .ofEvents('PatientAdded', 'PatientArchived')
    })

    test('evolve gets only the events listed in ofEvents', () => {
      defineHermesProjection<PriorityPatient, PatientEvent>()
        .ofName('narrowed')
        .ofDocumentType()
        .ofEvents('PatientAdded')
        .ofInitialState(initialPatient)
        .ofEvolve((state, event) => {
          // @ts-expect-error `PatientRemoved` is not listed, so `event` cannot be one
          if (event.type === 'PatientRemoved') {
            return state
          }

          return { ...state, patientId: event.data.patientId }
        })
    })

    test('the evolve of a decider can be reused when the projection lists all its events', () => {
      const occurrences = defineHermesProjection<Occurrence, SchedulingEvent>()
        .ofName('occurrences')
        .ofDocumentType()
        .ofEvents('OccurrenceScheduled', 'OccurrenceBecameDueNow', 'TaskCompleted', 'NoteAdded')
        .ofInitialState(scheduling.initialState)
        .ofEvolve(scheduling.evolve)
        .inline()
        .done()

      expect(occurrences.mode).toBe('inline')
    })
  })

  describe('routing', () => {
    test('canHandle tells whether an event is one of the projection', () => {
      expect(priorityPatients.canHandle(added(1))).toBe(true)
      expect(priorityPatients.canHandle(removed(1))).toBe(false)
    })

    test('ofId gives the id of the document of an event', () => {
      expect(priorityPatients.getDocumentId(alert(7))).toBe('patient-7')
    })

    test('without ofId, the document of an event is its stream', () => {
      const perStream = defineHermesProjection<PriorityPatient, PatientEvent>()
        .ofName('perStream')
        .ofDocumentType()
        .ofEvents('PatientAdded')
        .ofInitialState(initialPatient)
        .ofEvolve((state, event) => ({ ...state, patientId: event.data.patientId }))
        .done()

      expect(
        perStream.getDocumentId(
          recorded<PatientEvent>({ type: 'PatientAdded', data: { patientId: 1 } }, 'patient-stream-1'),
        ),
      ).toBe('patient-stream-1')
      expect(perStream.isSingleStream).toBe(true)
      expect(priorityPatients.isSingleStream).toBe(false)
    })
  })

  describe('applyProjection', () => {
    test('starts from the initial state', () => {
      expect(applyProjection(priorityPatients, null, [added(1)])).toEqual({ ...initialPatient(), patientId: 1 })
    })

    test('applies the events in order', () => {
      const state = applyProjection(priorityPatients, null, [
        added(2),
        marker1(2, 10, '2026-11-01'),
        alert(2),
        marker1(2, 12, '2026-11-02'),
      ])

      expect(state).toEqual({ patientId: 2, marker1: 12, marker2: null, lastTestAt: '2026-11-02', priority: true })
    })

    test('continues from the current state', () => {
      const current = applyProjection(priorityPatients, null, [added(3)])

      expect(applyProjection(priorityPatients, current, [alert(3)])).toEqual({ ...current, priority: true })
    })

    test('skips the events the projection does not handle', () => {
      expect(applyProjection(priorityPatients, null, [added(4), removed(4)])).toEqual({
        ...initialPatient(),
        patientId: 4,
      })
    })

    test('an evolve that returns null deletes the document', () => {
      const openPatients = defineHermesProjection<PriorityPatient | null, PatientEvent>()
        .ofName('openPatients')
        .ofDocumentType()
        .ofEvents('PatientAdded', 'PatientRemoved')
        .ofInitialState(() => null)
        .ofEvolve((state, event) =>
          event.type === 'PatientRemoved' ? null : { ...(state ?? initialPatient()), patientId: event.data.patientId },
        )
        .async()
        .done()

      expect(applyProjection(openPatients, null, [added(8)])).toMatchObject({ patientId: 8 })
      expect(applyProjection(openPatients, null, [added(8), removed(8)])).toBeNull()
    })

    test('returns the current state as it is when no event is handled', () => {
      const current = applyProjection(priorityPatients, null, [added(5)])

      expect(applyProjection(priorityPatients, current, [removed(5)])).toBe(current)
      expect(applyProjection(priorityPatients, current, [])).toBe(current)
    })
  })
})

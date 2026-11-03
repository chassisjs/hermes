import { type Event } from '../core/typing/event.js'
import { assert } from '../utils/assert.js'
import { type HermesProjection, type ProjectionMode, type RecordedEvent } from './types.js'

type Selected<E extends Event, T extends E['type']> = Extract<E, { type: T }>

type Finish<State, E extends Event> = {
  /** The projection is updated in the transaction of the append. */
  inline: () => { done: () => HermesProjection<State, E> }
  /** The projection is updated by a consumer of the event store. This is the default. */
  async: () => { done: () => HermesProjection<State, E> }
  done: () => HermesProjection<State, E>
}

/**
 * Defines a projection of events into documents, with a fluent API.
 *
 * `evolve` gets only the events listed in `ofEvents`, so a `switch (event.type)` over them is exhaustive. Return
 * `null` from it to delete the document. Without `ofId`, every stream has its own document (a single-stream
 * projection).
 *
 * @template State - The document
 * @template E - The events of the domain; the projection picks some of them with `ofEvents`
 *
 * @example
 * ```typescript
 * const occurrences = defineHermesProjection<Occurrence, SchedulingEvent>()
 *   .ofName('occurrences')
 *   .ofDocumentType()
 *   .ofEvents('OccurrenceScheduled', 'OccurrenceBecameDueNow', 'TaskCompleted')
 *   .ofInitialState(() => ({ status: 'none' }))
 *   .ofEvolve((state, event) => { ... })
 *   .inline()
 *   .done()
 * ```
 */
const defineHermesProjection = <State, E extends Event>() => ({
  ofName: (name: string) => {
    assert(typeof name === 'string' && name.trim().length > 0, 'A projection needs a name.')

    return {
      ofDocumentType: () => ({
        ofEvents: <T extends E['type']>(...eventTypes: T[]) => {
          assert(eventTypes.length > 0, `Projection ${name} needs at least one event type.`)

          const types = Object.freeze([...new Set(eventTypes)])

          return {
            ofInitialState: (initialState: () => State) => ({
              ofEvolve: (evolve: (state: State, event: RecordedEvent<Selected<E, T>>) => State) => {
                const build = (mode: ProjectionMode, getId?: (event: RecordedEvent<Selected<E, T>>) => string) =>
                  Object.freeze({
                    name,
                    kind: 'document' as const,
                    mode,
                    eventTypes: types,
                    isSingleStream: getId === undefined,
                    initialState,
                    evolve: evolve as unknown as (state: State, event: RecordedEvent<E>) => State,
                    canHandle: (event: { type: string }) => (types as readonly string[]).includes(event.type),
                    getDocumentId: (event: RecordedEvent<E>) =>
                      getId ? getId(event as unknown as RecordedEvent<Selected<E, T>>) : event.streamId,
                  }) as HermesProjection<State, E>
                const finish = (getId?: (event: RecordedEvent<Selected<E, T>>) => string): Finish<State, E> => ({
                  inline: () => ({ done: () => build('inline', getId) }),
                  async: () => ({ done: () => build('async', getId) }),
                  done: () => build('async', getId),
                })

                return {
                  ...finish(),
                  /** The id of the document of an event, for a document fed by many streams. */
                  ofId: (getId: (event: RecordedEvent<Selected<E, T>>) => string) => finish(getId),
                }
              },
            }),
          }
        },
      }),
    }
  },
})

/**
 * Applies the events that the projection handles to a document, in order, and skips the others.
 *
 * A `null` document (`current`, or returned by `evolve`) does not exist: the next handled event starts from the
 * initial state.
 *
 * @returns The new document, or `current` itself when no event was handled
 */
const applyProjection = <State, E extends Event>(
  projection: HermesProjection<State, E>,
  current: State | null,
  events: readonly RecordedEvent<NoInfer<E>>[],
): State => {
  let state = current
  let handled = false

  for (const event of events) {
    if (projection.canHandle(event)) {
      state = projection.evolve(state ?? projection.initialState(), event)
      handled = true
    }
  }

  return (handled ? state : current) as State
}

export { applyProjection, defineHermesProjection }

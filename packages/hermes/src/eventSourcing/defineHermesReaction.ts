import { type Event } from '../core/typing/event.js'
import { assert } from '../utils/assert.js'
import { type HermesReaction, type ReactionContext, type RecordedEvent } from './types.js'

type Selected<E extends Event, T extends E['type']> = Extract<E, { type: T }>

/**
 * Defines a reaction to events, with a fluent API, e.g. for an integration between modules: one module appends an
 * event, and another one reacts to it.
 *
 * The handler gets only the events listed in `ofEvents`, so a `switch (event.type)` over them is exhaustive. It runs
 * in the transaction that moves the checkpoint of the reaction (`tx`), so the work done in it commits together with
 * the checkpoint. Delivery is at least once for the work done outside of `tx`, e.g. a call of an HTTP API.
 *
 * @template E - The events of the domain; the reaction picks some of them with `ofEvents`
 * @template Tx - The transaction of the event store, e.g. `EventStoreTransaction` of `@chassisjs/hermes-mysql`
 *
 * @example
 * ```typescript
 * const chargeOnTaskCompleted = defineHermesReaction<SchedulingEvent, EventStoreTransaction>()
 *   .ofName('billing:charge-on-task-completed')
 *   .ofEvents('TaskCompleted')
 *   .ofHandler(async (event, { tx }) => {
 *     await billing.handle(`invoice-${event.data.taskId}`, { type: 'Charge', data: { ... } }, { tx })
 *   })
 *   .done()
 * ```
 */
const defineHermesReaction = <E extends Event, Tx = unknown>() => ({
  ofName: (name: string) => {
    assert(typeof name === 'string' && name.trim().length > 0, 'A reaction needs a name.')

    return {
      ofEvents: <T extends E['type']>(...eventTypes: T[]) => {
        assert(eventTypes.length > 0, `Reaction ${name} needs at least one event type.`)

        const types = Object.freeze([...new Set(eventTypes)])

        return {
          ofHandler: (
            handle: (event: RecordedEvent<Selected<E, T>>, context: ReactionContext<Tx>) => Promise<void> | void,
          ) => ({
            done: () =>
              Object.freeze({
                name,
                kind: 'reaction' as const,
                eventTypes: types,
                canHandle: (event: { type: string }) => (types as readonly string[]).includes(event.type),
                handle: handle as unknown as HermesReaction<E, Tx>['handle'],
              }) as HermesReaction<E, Tx>,
          }),
        }
      },
    }
  },
})

/**
 * An alias of {@link defineHermesReaction}.
 *
 * @example
 * ```typescript
 * const chargeOnTaskCompleted = reactOn<SchedulingEvent, EventStoreTransaction>()
 *   .ofName('billing:charge-on-task-completed')
 *   .ofEvents('TaskCompleted')
 *   .ofHandler(async (event, { tx }) => { ... })
 *   .done()
 * ```
 */
const reactOn = defineHermesReaction

export { defineHermesReaction, reactOn }

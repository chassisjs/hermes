import { setTimeout } from 'node:timers/promises'
import { VersionConflictError } from '../core/errors.js'
import { type Command } from '../core/typing/command.js'
import { type Event } from '../core/typing/event.js'
import { assert } from '../utils/assert.js'
import { type CommandHandler, type CommandHandlerParams, type StateLoader } from './types.js'

/**
 * Loads the state by folding the events of the stream with the `evolve` of the decider.
 */
const fromEvents =
  <State, E extends Event, Tx>(params: CommandHandlerParams<State, Command, E, Tx>): StateLoader<State, Tx> =>
  async ({ streamId, tx }) => {
    const { events, currentVersion } = await params.eventStore.readStream<E>(streamId, { tx })

    return {
      state: events.reduce(
        (state, event) => params.decider.evolve(state, event as unknown as E),
        params.decider.initialState(),
      ),
      version: currentVersion,
    }
  }

/**
 * Handles commands with a decider: loads the state of a stream, decides, and appends the new events with the version
 * the state was loaded at, so that a concurrent change of the stream is a {@link VersionConflictError}.
 *
 * With `retry`, a version conflict loads the fresh state and decides again, after the `delay` of the retry policy.
 * A conflict is never retried when the caller gives its own `expectedVersion`, and no other error is retried.
 *
 * A conflict is not retried in a transaction of the application (`tx`) either: in `REPEATABLE READ` a retry would read
 * the same snapshot again and conflict again. Retry the whole transaction of the application instead.
 *
 * @example
 * ```typescript
 * const handle = createCommandHandler({
 *   decider,
 *   eventStore,
 *   retry: { attempts: 5, delay: useExponentialRetryPolicy({ initial: Duration.ofMiliseconds(20) }) },
 * })
 *
 * await handle(`task-${taskId}`, { type: 'CompleteTask', data: { ... } })
 * ```
 */
const createCommandHandler = <State, C extends Command, E extends Event, Tx = never>(
  params: CommandHandlerParams<State, C, E, Tx>,
): CommandHandler<State, C, E, Tx> => {
  const { decider, retry } = params
  const loadState = params.loadState ?? fromEvents(params as unknown as CommandHandlerParams<State, Command, E, Tx>)
  const attempts = retry?.attempts ?? 0

  assert(Number.isInteger(attempts) && attempts >= 0, '`retry.attempts` has to be a non-negative integer.')

  return async (streamId, command, options) => {
    const signal = options?.signal
    const callerVersion = options?.expectedVersion

    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()

      const { state, version } = await loadState({ streamId, tx: options?.tx })
      const decided = decider.decide(command, state)
      const newEvents = Array.isArray(decided) ? decided : [decided]

      if (!newEvents.length) {
        return { newEvents, newState: state, nextVersion: version, createdNewStream: false }
      }

      try {
        const { nextVersion, createdNewStream } = await params.eventStore.appendToStream(streamId, newEvents, {
          expectedVersion: callerVersion ?? version,
          tx: options?.tx,
        })

        return { newEvents, newState: newEvents.reduce(decider.evolve, state), nextVersion, createdNewStream }
      } catch (error) {
        if (
          !(error instanceof VersionConflictError) ||
          callerVersion !== undefined ||
          options?.tx !== undefined ||
          attempt >= attempts
        ) {
          throw error
        }
      }

      if (retry?.delay) {
        await setTimeout(retry.delay(attempt + 1).ms, undefined, { signal })
      }
    }
  }
}

export { createCommandHandler }

import { type DefaultRecord } from '../core/typing/common.js'
import { type Command } from '../core/typing/command.js'
import { type Event } from '../core/typing/event.js'
import { type RetryPolicy } from '../pollingOutbox/types.js'

/**
 * The version of a stream that an append expects:
 *
 * - a number: the stream is at exactly this version (`0n` means that it does not exist);
 * - `'no_stream'`: the stream does not exist;
 * - `'stream_exists'`: the stream exists, at any version;
 * - `'any'`: no check.
 */
type ExpectedVersion = bigint | 'no_stream' | 'stream_exists' | 'any'

/**
 * An event as it was stored in a stream.
 *
 * @template E - The event; a union of events stays a union, so `switch (event.type)` narrows it
 */
type RecordedEvent<E extends Event = Event> = E extends Event
  ? Readonly<{
      type: E['type']
      data: E['data']
      metadata: E extends { metadata: infer M } ? M : DefaultRecord
      /** The stream the event belongs to. */
      streamId: string
      /** The position of the event in its stream, from 1. */
      streamPosition: bigint
      /** The unique identifier of the event. */
      eventId: string
      /** When the event was stored. */
      recordedAt: Date
    }>
  : never

type ReadStreamOptions<Tx> = {
  /** Read only the events after this position. */
  after?: bigint
  /** The transaction to read in. */
  tx?: Tx
}

type ReadStreamResult<E extends Event> = {
  events: RecordedEvent<E>[]
  /** The version of the stream: the number of its events, 0 when it does not exist. */
  currentVersion: bigint
  streamExists: boolean
}

type AppendOptions<Tx> = {
  /** @defaultValue `'any'` */
  expectedVersion?: ExpectedVersion
  /** The transaction of the application to append in. */
  tx?: Tx
}

type AppendResult = {
  /** The version of the stream after the append. */
  nextVersion: bigint
  createdNewStream: boolean
}

/**
 * Stores events in streams.
 *
 * @template Tx - The transaction of the application that an append or a read can run in
 */
type EventStore<Tx = never> = {
  /**
   * Reads the events of a stream, in their order.
   */
  readStream<E extends Event = Event>(streamId: string, options?: ReadStreamOptions<Tx>): Promise<ReadStreamResult<E>>

  /**
   * Appends the events to the end of a stream, all or none.
   *
   * @throws VersionConflictError when the stream is not at `expectedVersion`; nothing is appended then
   */
  appendToStream<E extends Event = Event>(
    streamId: string,
    events: E[],
    options?: AppendOptions<Tx>,
  ): Promise<AppendResult>
}

/**
 * The decider pattern: what happens (`decide`) and how it changes the state (`evolve`).
 *
 * @template State - The state that decisions are made on
 * @template C - The commands
 * @template E - The events
 */
type Decider<State, C extends Command, E extends Event> = {
  /** Decides what happens. Throw to reject the command. */
  decide: (command: C, state: State) => E | E[]
  /** Applies an event to the state. */
  evolve: (state: State, event: E) => State
  /** The state of a stream without events. */
  initialState: () => State
}

/**
 * Loads the state of a stream and the version it is at, e.g. from a document of an inline projection
 * (state-stored), instead of folding the events of the stream.
 */
type StateLoader<State, Tx = never> = (params: { streamId: string; tx?: Tx }) => Promise<{
  state: State
  version: bigint
}>

type CommandHandlerRetry = {
  /** How many times to decide again after a version conflict. */
  attempts: number
  /** How long to wait before every retry. Without it, the command is decided again at once. */
  delay?: RetryPolicy
}

type CommandHandlerParams<State, C extends Command, E extends Event, Tx> = {
  decider: Decider<State, C, E>
  eventStore: EventStore<Tx>
  /** Where the state comes from. @defaultValue the events of the stream, folded with `evolve` */
  loadState?: StateLoader<NoInfer<State>, Tx>
  /** Decide again on a fresh state after a version conflict. @defaultValue no retries */
  retry?: CommandHandlerRetry
}

type HandleOptions<Tx> = {
  /** Check this version instead of the version the state was loaded at. A conflict is then never retried. */
  expectedVersion?: ExpectedVersion
  /** The transaction of the application. */
  tx?: Tx
  /** Stops the command, also while it waits for a retry (rejects with `AbortError`). */
  signal?: AbortSignal
}

type CommandHandlerResult<State, E extends Event> = {
  /** The events that were appended (none when the decision had no events). */
  newEvents: E[]
  /** The state after the new events. */
  newState: State
  /** The version of the stream after the command. */
  nextVersion: bigint
  createdNewStream: boolean
}

type CommandHandler<State, C extends Command, E extends Event, Tx> = (
  streamId: string,
  command: C,
  options?: HandleOptions<Tx>,
) => Promise<CommandHandlerResult<State, E>>

type ProjectionMode = 'inline' | 'async'

/**
 * A projection of events into documents.
 *
 * @template State - The document
 * @template E - The events of the projection
 */
type HermesProjection<State, E extends Event = Event> = Readonly<{
  name: string
  kind: 'document'
  /** `inline`: updated in the transaction of the append. `async`: updated by a consumer of the event store. */
  mode: ProjectionMode
  eventTypes: readonly E['type'][]
  /** Without `ofId`, every stream has its own document, whose id is the id of the stream. */
  isSingleStream: boolean
  initialState(): State
  /** Applies a handled event. Returning `null` deletes the document. */
  evolve(state: State, event: RecordedEvent<E>): State
  canHandle(event: { type: string }): boolean
  /** The id of the document of a handled event. */
  getDocumentId(event: RecordedEvent<E>): string
  /** Never set: carries the types of the document and of the events, so that functions can infer them. */
  '~types'?: { state: State; event: E }
}>

export type {
  AppendOptions,
  AppendResult,
  CommandHandler,
  CommandHandlerParams,
  CommandHandlerResult,
  CommandHandlerRetry,
  Decider,
  EventStore,
  ExpectedVersion,
  HandleOptions,
  HermesProjection,
  ProjectionMode,
  ReadStreamOptions,
  ReadStreamResult,
  RecordedEvent,
  StateLoader,
}

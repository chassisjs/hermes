import { type Duration } from '../duration.js'

/**
 * A message read from the outbox storage by a polling outbox.
 *
 * @template Message - The type of the message's payload
 */
type PolledMessage<Message> = {
  /** The identifier of the row in the storage, e.g. an auto-increment position. */
  id: string | number | bigint
  /** The partition the message belongs to. */
  partitionKey: string
  /** The unique identifier of the message, given by the application. */
  messageId: string
  /** The type of the message. */
  messageType: string
  /** The number of failed publishing attempts so far. */
  attempts: number
  /** The payload of the message. */
  message: Message
}

/**
 * The part of a {@link PollingOutboxStore} that is used by every ordering policy.
 *
 * All the times (leases, retries) have to be computed with the clock of the database, not the clock of the
 * application, so that many instances of the application agree on them.
 *
 * @template Message - The type of the message's payload
 */
type PollingOutboxBaseStore<Message> = {
  /**
   * Marks the message as delivered and releases its claim. It is called after the message was published, so it marks
   * the message even when the claim of `owner` has expired, as long as the message is not delivered yet.
   */
  markDelivered(message: PolledMessage<Message>): Promise<void>

  /**
   * Increments the attempts of the message, releases its claim and hides it until `retryAfter` passes.
   *
   * Change only a message that is not delivered and not claimed by another instance: when the claim of `owner` has
   * expired and another instance claimed the message, it must keep its claim.
   */
  markFailed(message: PolledMessage<Message>, params: { retryAfter: Duration; owner: string }): Promise<void>
}

/**
 * A store that claims single messages. Used by {@link useNoOrderingPolicy}.
 *
 * @template Message - The type of the message's payload
 */
type MessageClaimingStore<Message> = PollingOutboxBaseStore<Message> & {
  /**
   * Claims up to `limit` undelivered messages that are due (their retry time has passed) and not claimed by anyone,
   * e.g. with `SELECT ... FOR UPDATE SKIP LOCKED`. A claim lasts for `lease`.
   *
   * @returns The claimed messages, in the order of their `id`.
   */
  claimMessages(params: { owner: string; lease: Duration; limit: number }): Promise<PolledMessage<Message>[]>

  /**
   * Extends the claim of the messages that are still claimed by `owner`.
   */
  renewMessages(params: { owner: string; lease: Duration; messages: PolledMessage<Message>[] }): Promise<void>

  /**
   * Releases the undelivered messages claimed by `owner`, so that other instances can take them at once.
   */
  releaseMessages(params: { owner: string }): Promise<void>
}

/**
 * A store that claims whole partitions. Used by {@link usePartitionOrderingPolicy}.
 *
 * @template Message - The type of the message's payload
 */
type PartitionClaimingStore<Message> = PollingOutboxBaseStore<Message> & {
  /**
   * Claims up to `limit` partitions that are free, expired, or already claimed by `owner`, and whose first undelivered
   * message is due. A claim lasts for `lease`.
   *
   * @returns The keys of the claimed partitions.
   */
  claimPartitions(params: { owner: string; lease: Duration; limit: number }): Promise<string[]>

  /**
   * Reads up to `limit` undelivered messages of the partition, in the order of their `id`.
   */
  readPartition(params: { partitionKey: string; limit: number }): Promise<PolledMessage<Message>[]>

  /**
   * Extends the claim of the partitions that are still claimed by `owner`.
   */
  renewPartitions(params: { owner: string; lease: Duration; partitionKeys: string[] }): Promise<void>

  /**
   * Releases all the partitions claimed by `owner`, so that other instances can take them at once.
   */
  releasePartitions(params: { owner: string }): Promise<void>
}

/**
 * The messages that one claim gave to a polling outbox, published one by one.
 *
 * @template Message - The type of the message's payload
 */
type PollingLane<Message> = {
  messages: PolledMessage<Message>[]
  /**
   * What to do with the rest of the lane when a message cannot be published:
   * `'stop'` keeps the order, `'continue'` publishes the other messages.
   */
  onFailure: 'stop' | 'continue'
}

/**
 * Decides which messages a polling outbox takes and in what order it publishes them.
 *
 * Hermes has two policies: {@link usePartitionOrderingPolicy} and {@link useNoOrderingPolicy}.
 *
 * @template Message - The type of the message's payload
 */
type PollingPolicy<Message> = PollingOutboxBaseStore<Message> & {
  /**
   * Claims the messages to publish. Lanes are published concurrently, the messages of a lane one by one.
   */
  claim(params: { owner: string; lease: Duration; limit: number }): Promise<PollingLane<Message>[]>

  /**
   * Extends the claims of the lanes that are still being published.
   */
  renew(params: { owner: string; lease: Duration; lanes: PollingLane<Message>[] }): Promise<void>

  /**
   * Releases all the claims of `owner`. Called when the polling outbox stops.
   */
  release(params: { owner: string }): Promise<void>
}

/**
 * Publishes a message to a message broker or any other destination. Throw to retry the message later.
 */
type PollingPublish<Message> = (message: PolledMessage<Message>) => Promise<void> | void

/**
 * Computes how long to wait before the next attempt to publish a message.
 *
 * @param attempts - The number of failed attempts so far, including the last one (1 or more)
 */
type RetryPolicy = (attempts: number) => Duration

type PollingOutboxParams<Message> = {
  /**
   * The policy that claims messages, e.g. `usePartitionOrderingPolicy(store)`.
   */
  policy: PollingPolicy<Message>

  /**
   * Publishes a message. Throw to retry it later.
   */
  publish: PollingPublish<Message>

  /**
   * How long to wait between polls when there was nothing more to publish.
   *
   * @defaultValue `Duration.ofSeconds(1)`
   */
  pollInterval?: Duration

  /**
   * The maximum number of messages in one lane (e.g. in one partition) per poll.
   *
   * @defaultValue `100`
   */
  batchSize?: number

  /**
   * How long a claim lasts. Hermes renews the claims every third of the lease while it publishes. When an instance
   * dies, other instances can take over its messages after the lease.
   *
   * @defaultValue `Duration.ofSeconds(30)`
   */
  lease?: Duration

  /**
   * How long to wait before publishing a failed message again.
   *
   * @defaultValue `useExponentialRetryPolicy()`: 1 second, doubled after every attempt, at most 1 minute
   */
  retry?: RetryPolicy

  /**
   * The identifier of this instance in the claims.
   *
   * @defaultValue a random UUID
   */
  owner?: string

  /**
   * Called when a message cannot be published.
   */
  onFailedPublish?: (error: unknown, message: PolledMessage<Message>) => void

  /**
   * Called when the store fails, e.g. when the database is not available. The polling outbox tries again after
   * `pollInterval`.
   */
  onDbError?: (error: unknown) => void
}

type PollingOutbox = {
  /**
   * Starts polling.
   *
   * @returns A function that stops polling, waits for the messages being published and releases the claims. Every
   * call returns the same promise, so a second call also waits until the outbox is stopped.
   */
  start(): () => Promise<void>
}

export type {
  MessageClaimingStore,
  PartitionClaimingStore,
  PolledMessage,
  PollingLane,
  PollingOutbox,
  PollingOutboxBaseStore,
  PollingOutboxParams,
  PollingPolicy,
  PollingPublish,
  RetryPolicy,
}

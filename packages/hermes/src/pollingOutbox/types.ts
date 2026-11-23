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
   *
   * @returns The number of partitions it renewed, so the polling outbox stops publishing a partition that another
   * instance took over. Return nothing when the store cannot tell.
   */
  renewPartitions(params: { owner: string; lease: Duration; partitionKeys: string[] }): Promise<number | void>

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
   *
   * @returns `false` when `owner` lost a claim of the lanes, e.g. because another instance took it over after it
   * expired, so the polling outbox stops publishing them
   */
  renew(params: { owner: string; lease: Duration; lanes: PollingLane<Message>[] }): Promise<boolean>

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

/**
 * How far a consumer of a polling outbox is behind, read from the database, e.g. for the gauges of a metrics library.
 * It is the same for every instance of the consumer, so aggregate it with `max`, not `sum`.
 */
type PollingOutboxLag = {
  /** The age of the oldest undelivered message, by the clock of the database. `null` when there is none. */
  oldestPendingAge: Duration | null
  /** The number of undelivered messages, counted up to a limit (see {@link isPendingExact}). */
  pending: number
  /** `false` when there are more undelivered messages than were counted. */
  isPendingExact: boolean
  /**
   * The number of counted undelivered messages that failed at least once. When {@link isPendingExact} is `false`, it
   * can include one message more than `pending`.
   */
  failing: number
  /** The number of partitions with undelivered messages. */
  partitions: number
}

/**
 * A store that reads the lag of its consumer. Implemented by the stores of the databases.
 */
type PollingOutboxLagStore = {
  /**
   * Reads how far the consumer is behind.
   *
   * @param params.countLimit - Count at most this many undelivered messages, so that a big backlog does not make the
   * query expensive
   */
  getLag(params: { countLimit: number }): Promise<PollingOutboxLag>
}

/**
 * What one poll of a polling outbox did. Given to {@link PollingOutboxParams.onPoll}, e.g. for the counters and
 * histograms of a metrics library.
 *
 * `messages` can be more than `published + failed`: a lane stops before its end after a failed message of
 * `usePartitionOrderingPolicy`, when its claim is lost or not renewed for two thirds of the lease, when the outbox
 * stops, or when the store fails.
 */
type PollingOutboxPoll = {
  /** How long the claim took, reading the claimed messages included. */
  claimDuration: Duration
  /** How long publishing the claimed messages took. */
  publishDuration: Duration
  /** The number of claimed lanes (e.g. partitions). */
  lanes: number
  /** The number of claimed messages. */
  messages: number
  /** The number of published messages that were marked as delivered. */
  published: number
  /** The number of messages that could not be published. */
  failed: number
  /** `true` when a renewal said that another instance took over a claim, so its lane stopped. */
  isClaimLost: boolean
}

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

  /**
   * Called after every poll that did not fail, also when there was nothing to publish. An error it throws is ignored.
   */
  onPoll?: (poll: PollingOutboxPoll) => void
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
  PollingOutboxLag,
  PollingOutboxLagStore,
  PollingOutboxParams,
  PollingOutboxPoll,
  PollingPolicy,
  PollingPublish,
  RetryPolicy,
}

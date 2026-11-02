import { type Duration, type RetryPolicy } from '@chassisjs/hermes'
import { type Pool, type PoolOptions } from 'mysql2/promise'

/**
 * A value that can be stored as JSON.
 */
type JSONValue =
  | null
  | string
  | number
  | boolean
  | Date // serialized as `string`
  | readonly JSONValue[]
  | { toJSON(): any }
  | {
      readonly [prop: string | number]: undefined | JSONValue | ((...args: any) => any)
    }

/**
 * Runs a SQL query with `?` placeholders.
 *
 * A connection of `mysql2` is a `QueryExecutor` as it is. Wrap the transactions of other libraries, e.g. Kysely:
 *
 * ```typescript
 * await db.transaction().execute(async (trx) => {
 *   await outbox.queue(message, {
 *     tx: { query: (text, params) => trx.executeQuery(CompiledQuery.raw(text, params)) },
 *   })
 * })
 * ```
 */
type QueryExecutor = {
  query(text: string, params: unknown[]): Promise<unknown>
}

/**
 * A transaction of the application that the messages are stored in: a `mysql2` connection with an open transaction,
 * or any {@link QueryExecutor}.
 */
type OutboxTransaction = QueryExecutor

/**
 * A message to store in the outbox.
 */
type MessageEnvelope<Message extends JSONValue> = {
  /** The unique identifier of the message, e.g. for the idempotency of its handlers (at most 250 characters). */
  messageId: string
  /** The type of the message (at most 250 characters). */
  messageType: string
  /** The payload of the message. */
  message: Message
}

/**
 * A message given to `publish`.
 */
type HermesMessageEnvelope<Message extends JSONValue> = {
  /** The auto-increment position of the message in the `hermes_outbox` table. */
  position: string
  /** The partition of the message. */
  partitionKey: string
  /** The unique identifier of the message. */
  messageId: string
  /** The type of the message. */
  messageType: string
  /** The number of failed attempts to publish the message (0 for the first one). */
  redeliveryCount: number
  /** The payload of the message. */
  message: Message
}

type PublishOptions = {
  /** The transaction of the application to store the messages in. Without it, the messages are stored at once. */
  tx?: OutboxTransaction
  /** The partition of the messages (at most 250 characters). @defaultValue the `partitionKey` of the consumer, or `'default'` */
  partitionKey?: string
}

type Stop = () => Promise<void>

type ConsumerCreationParams<Message extends JSONValue> = {
  /**
   * Returns the options of the `mysql2` pool that Hermes creates for itself.
   */
  getOptions: () => PoolOptions

  /**
   * Publishes a message, e.g. to a message broker. Throw to publish it again later.
   */
  publish: (message: HermesMessageEnvelope<Message>) => Promise<void> | void

  /**
   * The name of the consumer. Messages are stored for a consumer and published by the consumers of the same name.
   * At most 250 characters.
   */
  consumerName: string

  /**
   * Publish only the messages of this partition. All the partitions of the consumer when not given: the instances of
   * your application share them.
   */
  partitionKey?: string

  /**
   * How the messages are ordered and shared between many instances of the application.
   *
   * - `'partition'`: the messages of a partition are published one by one, in the order they were stored, by one
   *   instance at a time. A message that cannot be published stops its partition until it is published.
   * - `'none'`: the messages are published in any order, many instances share the messages of one partition, and a
   *   message that cannot be published does not stop other messages.
   *
   * @defaultValue `'partition'`
   */
  ordering?: 'partition' | 'none'

  /**
   * How long to wait between polls when there was nothing more to publish.
   *
   * @defaultValue `Duration.ofSeconds(1)`
   */
  pollInterval?: Duration

  /**
   * The maximum number of messages of a partition published per poll.
   *
   * @defaultValue `100`
   */
  batchSize?: number

  /**
   * The maximum number of partitions an instance publishes at the same time (`ordering: 'partition'`).
   *
   * @defaultValue `10`
   */
  maxPartitions?: number

  /**
   * How long a claim of a partition (or of a message) lasts. Another instance takes over the messages of an instance
   * that died after this time.
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
   * Whether `start()` runs the migrations of the Hermes tables. Turn it off when you run {@link migrate} yourself,
   * e.g. in a deployment pipeline.
   *
   * @defaultValue `true`
   */
  migrate?: boolean

  /**
   * Called when a message cannot be published.
   */
  onFailedPublish?: (error: unknown) => void

  /**
   * Called when a query fails, e.g. when the database is not available.
   */
  onDbError?: (error: unknown) => void
}

type OutboxConsumer<Message extends JSONValue> = {
  /**
   * Runs the migrations (unless `migrate` is `false`) and starts polling the outbox.
   *
   * @returns A function that stops polling, waits for the message being published, releases the claims and closes
   * the pool.
   */
  start(): Promise<Stop>

  /**
   * Stores one or many messages in the outbox, all or none.
   *
   * Pass `tx` to store them in the transaction of your application, so that they are stored only when it commits.
   */
  queue(message: MessageEnvelope<Message> | MessageEnvelope<Message>[], options?: PublishOptions): Promise<void>

  /**
   * Returns the pool of Hermes.
   */
  getDbConnection(): Pool
}

export type {
  ConsumerCreationParams,
  HermesMessageEnvelope,
  JSONValue,
  MessageEnvelope,
  OutboxConsumer,
  OutboxTransaction,
  PublishOptions,
  QueryExecutor,
  Stop,
}

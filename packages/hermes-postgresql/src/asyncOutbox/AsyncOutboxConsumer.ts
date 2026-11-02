import {
  createPollingOutbox,
  Duration,
  useExponentialRetryPolicy,
  useNoOrderingPolicy,
  usePartitionOrderingPolicy,
  type PolledMessage,
  type RetryPolicy,
} from '@chassisjs/hermes'
import { AsyncOrSync } from 'ts-essentials'
import { insertRowsAtomically } from '../common/queryExecutor.js'
import { ErrorCallback, HermesSql, JSONValue, MessageEnvelope, OutboxTransaction, Stop } from '../common/types.js'
import { createPollingStore } from './createPollingStore.js'

/**
 * Envelope for messages in the async outbox with processing metadata.
 *
 * @template Message - The type of the domain message/event
 * @internal
 */
type HermesAsyncMessageEnvelope<Message> = {
  /** Sequential position in the asyncOutbox table */
  position: number
  /** The partition of the message */
  partitionKey: string
  /** Unique message identifier */
  messageId: string
  /** Message type discriminator */
  messageType: string
  /** Number of delivery attempts */
  redeliveryCount: number
  /** The actual message data */
  message: Message
}

/**
 * Options for sending messages to the async outbox.
 * @internal
 */
type PublishOptions = {
  /** Optional transaction for atomic operations */
  tx?: OutboxTransaction
  /** The partition of the messages (default: `'default'`) */
  partitionKey?: string
}

/**
 * Configuration parameters for creating an async outbox consumer.
 *
 * @template Message - The type of domain messages/events
 * @internal
 */
type ConsumerCreationParams<Message> = {
  /**
   * Getter function for the PostgreSQL connection.
   *
   * Returns a regular Postgres.js instance (not the streaming connection).
   *
   * @returns PostgreSQL connection with BigInt support
   */
  getSql: () => HermesSql

  /**
   * Callback invoked when a message is ready to be published.
   *
   * @param message - Single message or array of messages
   * @throws Error to trigger redelivery
   */
  publish: (
    message: HermesAsyncMessageEnvelope<Message> | HermesAsyncMessageEnvelope<Message>[],
  ) => AsyncOrSync<void> | never

  /**
   * Consumer name (used for isolation between consumers).
   */
  consumerName: string

  /**
   * Publish only the messages of this partition. All the partitions of the consumer when not given.
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
   * The maximum number of messages of a partition published per poll.
   *
   * @defaultValue `100`
   */
  batchSize?: number

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
   * @defaultValue `useExponentialRetryPolicy({ initial: waitAfterFailedPublish })`
   */
  retry?: RetryPolicy

  /**
   * Interval for polling the asyncOutbox table for new messages.
   *
   * The next polling cycle starts after the previous one completes.
   *
   * @defaultValue `Duration.ofSeconds(15)`
   */
  checkInterval?: Duration

  /**
   * Duration to wait after the first failed publish attempt before retrying. The wait doubles after every next attempt,
   * up to 1 minute. Ignored when `retry` is given.
   *
   * @defaultValue `Duration.ofSeconds(1)`
   */
  waitAfterFailedPublish?: Duration

  /**
   * Callback invoked when publishing fails.
   *
   * @param error - The error that occurred
   * @defaultValue No-op function
   */
  onFailedPublish?: ErrorCallback

  /**
   * Callback invoked when a database error occurs.
   *
   * @param error - The database error
   * @defaultValue No-op function
   */
  onDbError?: ErrorCallback
}

/**
 * Interface for the asynchronous outbox consumer.
 *
 * @template Message - The type of domain messages/events
 */
interface IAsyncOutboxConsumer<Message extends JSONValue> {
  /**
   * Sends a message or array of messages to the async outbox.
   *
   * @param message - Single message or array of messages
   * @param options - Optional transaction for atomic operations
   */
  send(message: MessageEnvelope<Message> | MessageEnvelope<Message>[], options: PublishOptions): Promise<void>

  /**
   * Starts the async outbox consumer polling loop.
   *
   * @returns Stop function for graceful shutdown
   */
  start(): Stop

  /**
   * Stops the async outbox consumer.
   */
  stop(): Promise<void>
}

/**
 * Asynchronous outbox consumer for non-critical messages.
 *
 * Unlike the main outbox (WAL-based via Logical Replication), the async outbox
 * uses polling and is suitable for:
 * - Compensation commands
 * - Notifications
 * - Cleanup operations
 * - Messages where delivery timing is flexible
 *
 * ## Key Differences from Main Outbox
 *
 * | Feature | Main Outbox | Async Outbox |
 * |---------|-------------|--------------|
 * | Mechanism | PostgreSQL Logical Replication | Polling |
 * | Message Loss Risk | Zero (WAL-based) | Low (DB-based) |
 * | Latency | Real-time streaming | Poll interval |
 * | WAL Impact | Yes (retention) | No |
 * | Use Case | Critical events | Non-critical messages |
 *
 * ## Usage
 *
 * The async outbox is typically created via {@link useBasicAsyncOutboxConsumerPolicy}
 * and accessed through the main outbox consumer's `send()` method.
 *
 * @template Message - The type of domain messages/events
 *
 * @example
 * ```typescript
 * // Created automatically via policy
 * const outbox = createOutboxConsumer({
 *   // ...
 *   asyncOutbox: useBasicAsyncOutboxConsumerPolicy()
 * })
 *
 * // Critical events → main outbox (WAL-based)
 * await outbox.queue(orderCreatedEvent, { tx: sql })
 *
 * // Compensations → async outbox (polling-based)
 * await outbox.send(revertPaymentCommand)
 * ```
 *
 * @see {@link useBasicAsyncOutboxConsumerPolicy} for creating instances
 * @see {@link IAsyncOutboxConsumer} for the interface
 */
class AsyncOutboxConsumer<Message extends JSONValue> implements IAsyncOutboxConsumer<Message> {
  private readonly _checkInterval: Duration
  private readonly _getSql: () => HermesSql

  private _stop: (() => Promise<void>) | null = null

  /**
   * @internal
   */
  constructor(private readonly _params: ConsumerCreationParams<Message>) {
    this._checkInterval = _params.checkInterval || Duration.ofSeconds(15)
    this._getSql = _params.getSql
  }

  /**
   * Sends a message or array of messages to the async outbox.
   *
   * Messages are stored in the `asyncOutbox` table and processed via polling.
   * Unlike `queue()`, this doesn't use PostgreSQL Logical Replication.
   *
   * **When to use:**
   * - Compensation commands
   * - Non-critical notifications
   * - Cleanup operations
   * - Messages where delivery timing is flexible
   *
   * @param message - Single message or array of messages to send
   * @param options - Optional transaction for atomic operations
   *
   * @throws {Error} If database connection is not established
   * @throws {Error} If message insertion fails
   *
   * @example
   * ```typescript
   * // Send single compensation command
   * await outbox.send({
   *   messageId: constructMessageId('RevertPayment', orderId),
   *   messageType: 'RevertPayment',
   *   message: { type: 'RevertPayment', data: { orderId } }
   * })
   *
   * // Send multiple messages atomically
   * await outbox.send([compensationCmd1, compensationCmd2])
   *
   * // Send within a transaction
   * await sql.begin(async (sql) => {
   *   await updateSomething(sql)
   *   await outbox.send(compensationCmd, { tx: sql })
   * })
   * ```
   */
  async send(message: MessageEnvelope<Message> | MessageEnvelope<Message>[], options?: PublishOptions): Promise<void> {
    if (!this._getSql()) {
      throw new Error('Database connection not established. Call start() first.')
    }

    const messages = Array.isArray(message) ? message : [message]
    const partitionKey = options?.partitionKey || 'default'

    await insertRowsAtomically(
      this._getSql(),
      options?.tx,
      'asyncOutbox',
      [
        { name: 'consumerName' },
        { name: 'partitionKey' },
        { name: 'messageId' },
        { name: 'messageType' },
        { name: 'data', cast: 'text::jsonb' },
      ],
      messages.map((m) => [
        this._params.consumerName,
        partitionKey,
        m.messageId,
        m.messageType,
        JSON.stringify(m.message),
      ]),
    )
  }

  /**
   * Starts the async outbox consumer polling loop.
   *
   * Begins polling the `asyncOutbox` table at the configured interval for undelivered messages. It does not keep a
   * position like "the last published position", so a message is not skipped when its transaction commits after a
   * transaction with a greater position.
   *
   * @returns Stop function for graceful shutdown
   *
   * @throws {Error} If consumer is already started
   *
   * @example
   * ```typescript
   * const asyncOutbox = createAsyncOutboxConsumer({
   *   getSql: () => sql,
   *   publish: async (envelope) => {
   *     await handleMessage(envelope)
   *   },
   *   consumerName: 'my-service'
   * })
   *
   * const stop = asyncOutbox.start()
   *
   * // Later, stop gracefully
   * await stop()
   * ```
   */
  start() {
    if (this._stop) {
      throw new Error(`AsyncOutboxConsumer is already started`)
    }

    const { consumerName, partitionKey, ordering, batchSize, lease } = this._params
    const store = createPollingStore<Message>(this._getSql, { consumerName, partitionKey })

    this._stop = createPollingOutbox<Message>({
      policy: ordering === 'none' ? useNoOrderingPolicy(store) : usePartitionOrderingPolicy(store),
      publish: async (message) => {
        await this._params.publish(toEnvelope(message))
      },
      pollInterval: this._checkInterval,
      batchSize,
      lease,
      retry: this._params.retry ?? useExponentialRetryPolicy({ initial: this._params.waitAfterFailedPublish }),
      onFailedPublish: this._params.onFailedPublish,
      onDbError: this._params.onDbError,
    }).start()

    return (() => this.stop()) as Stop
  }

  /**
   * Stops the async outbox consumer.
   *
   * Stops polling, waits for the message being published and releases the claims, so that other instances can take
   * over the partitions at once.
   *
   * @example
   * ```typescript
   * await asyncOutbox.stop()
   * console.log('Async outbox consumer stopped')
   * ```
   */
  async stop(): Promise<void> {
    const stop = this._stop

    this._stop = null
    await stop?.()
  }
}

const toEnvelope = <Message>(message: PolledMessage<Message>): HermesAsyncMessageEnvelope<Message> => ({
  position: Number(message.id),
  partitionKey: message.partitionKey,
  messageId: message.messageId,
  messageType: message.messageType,
  redeliveryCount: message.attempts,
  message: message.message,
})

const createAsyncOutboxConsumer = <Message extends JSONValue>(params: ConsumerCreationParams<Message>) =>
  new AsyncOutboxConsumer<Message>(params)

export {
  AsyncOutboxConsumer,
  createAsyncOutboxConsumer,
  type ConsumerCreationParams,
  type HermesAsyncMessageEnvelope,
  type IAsyncOutboxConsumer,
}

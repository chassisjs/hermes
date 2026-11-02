import { assert, createPollingOutbox, useNoOrderingPolicy, usePartitionOrderingPolicy } from '@chassisjs/hermes'
import { createPool, type Pool } from 'mysql2/promise'
import { createPollingStore } from './createPollingStore.js'
import { migrate } from './migrate.js'
import { createPollingPool, insertRowsAtomically, OutboxTable } from './sql.js'
import { type ConsumerCreationParams, type JSONValue, type OutboxConsumer } from './types.js'

/**
 * Creates an outbox for MySQL 8.0+ (and Aurora MySQL 3).
 *
 * The application stores messages in the `hermes_outbox` table in its own transactions (`queue`), and the consumer
 * polls the table and publishes them. It does not keep a position like "the last published position", so a message is
 * not skipped when its transaction commits after a transaction with a greater `AUTO_INCREMENT` position.
 *
 * Many instances of the application can run the consumer. By default (`ordering: 'partition'`), every partition is
 * published by one instance at a time, in the order of the positions, and the instances share the partitions.
 *
 * Delivery is at-least-once, so make the handlers of the messages idempotent, e.g. with the `messageId`.
 *
 * `start()` polls with its own pool ({@link createPollingPool}), which runs in `READ COMMITTED`, and `stop()` closes
 * it. `queue()` without `tx` and `getDbConnection()` use another pool, which `stop()` does not close, because the
 * application may still use it; close it with `getDbConnection().end()`.
 *
 * @template Message - The type of the messages
 *
 * @example
 * ```typescript
 * import { createOutboxConsumer } from '@chassisjs/hermes-mysql'
 *
 * const outbox = createOutboxConsumer<DomainEvent>({
 *   getOptions: () => ({ host: 'localhost', port: 3306, user: 'app', password: 'secret', database: 'app' }),
 *   publish: async (envelope) => {
 *     await broker.publish(envelope.messageType, envelope.message)
 *   },
 *   consumerName: 'app',
 * })
 *
 * const stop = await outbox.start()
 *
 * const connection = await pool.getConnection()
 * await connection.beginTransaction()
 * await connection.query('INSERT INTO patient (id) VALUES (?)', [patientId])
 * await outbox.queue(
 *   { messageId: patientId, messageType: 'PatientRegistered', message: { patientId } },
 *   { tx: connection, partitionKey: tenantId },
 * )
 * await connection.commit()
 * ```
 */
const createOutboxConsumer = <Message extends JSONValue>(
  params: ConsumerCreationParams<Message>,
): OutboxConsumer<Message> => {
  const { consumerName, partitionKey } = params
  let pool: Pool | null = null
  let isStarted = false
  const getPool = () => {
    pool ??= createPool({ ...params.getOptions(), supportBigNumbers: true, bigNumberStrings: true })

    return pool
  }

  return {
    async start() {
      assert(!isStarted, 'The outbox consumer is already started.')

      isStarted = true

      const pollingPool = createPollingPool(params.getOptions())

      try {
        if (params.migrate !== false) {
          await migrate(pollingPool)
        }
      } catch (error) {
        isStarted = false
        await pollingPool.end().catch(() => {})

        throw error
      }

      const store = createPollingStore<Message>(() => pollingPool, { consumerName, partitionKey })
      const stopPolling = createPollingOutbox<Message>({
        policy:
          params.ordering === 'none'
            ? useNoOrderingPolicy(store)
            : usePartitionOrderingPolicy(store, { maxPartitions: params.maxPartitions }),
        publish: async (message) => {
          await params.publish({
            position: String(message.id),
            partitionKey: message.partitionKey,
            messageId: message.messageId,
            messageType: message.messageType,
            redeliveryCount: message.attempts,
            message: message.message,
          })
        },
        pollInterval: params.pollInterval,
        batchSize: params.batchSize,
        lease: params.lease,
        retry: params.retry,
        onFailedPublish: params.onFailedPublish,
        onDbError: params.onDbError,
      }).start()

      let stopping: Promise<void> | undefined

      return () => {
        stopping ??= (async () => {
          try {
            await stopPolling()
            await pollingPool.end()
          } finally {
            isStarted = false
          }
        })()

        return stopping
      }
    },

    async queue(message, options) {
      const messages = Array.isArray(message) ? message : [message]

      await insertRowsAtomically(
        getPool(),
        options?.tx,
        OutboxTable,
        [
          { name: 'consumer_name' },
          { name: 'partition_key' },
          { name: 'message_id' },
          { name: 'message_type' },
          { name: 'data', placeholder: 'CAST(? AS JSON)' },
        ],
        messages.map((m) => [
          consumerName,
          options?.partitionKey || partitionKey || 'default',
          m.messageId,
          m.messageType,
          JSON.stringify(m.message),
        ]),
      )
    },

    getDbConnection: getPool,
  }
}

export { createOutboxConsumer }

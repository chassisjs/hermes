import { CancellationPromise, addDisposeOnSigterm, assertDate, isNil, noop, swallow } from '@chassisjs/hermes'
import { ObjectId, type ChangeStreamDocument, type ClientSession, type ResumeToken } from 'mongodb'
import { setTimeout } from 'node:timers/promises'
import { assertSupportedMongoVersion } from './assertSupportedMongoVersion.js'
import { OutboxMessagesCollectionName } from './consts.js'
import { createChangeStream } from './createChangeStream.js'
import { ensureIndexes } from './ensureIndexes.js'
import { getConsumer } from './getConsumer.js'
import {
  type ConsumerCreationParams,
  type OutboxConsumer,
  type OutboxEvent,
  type OutboxMessageModel,
  type SaveWithEventCallback,
  type Stop,
} from './typings.js'

/**
 * Creates a new outbox consumer instance for MongoDB.
 *
 * This is the main entry point for using Hermes MongoDB. It creates a consumer
 * that leverages MongoDB Change Streams to implement the Outbox Pattern, ensuring
 * reliable at-least-once event delivery with transactional consistency.
 *
 * ## How It Works
 *
 * 1. **Publish events** to the outbox collection within your MongoDB transactions
 * 2. **MongoDB oplog** captures changes durably (within retention window)
 * 3. **Change Streams** streams changes to Hermes in real-time
 * 4. **Hermes invokes** your `publish` callback for each event
 * 5. **Acknowledgment** happens only after successful callback completion
 *
 * ## Important: Oplog Retention
 *
 * ⚠️ **Unlike PostgreSQL WAL**, MongoDB's oplog has limited retention (typically hours).
 * If a consumer is down longer than the oplog retention window, events will be lost.
 * Monitor oplog retention with `rs.printReplicationInfo()`.
 *
 * @template Event - The type of domain events this consumer will handle (use discriminated unions)
 *
 * @param params - Configuration parameters including database connection, publish callback, and consumer settings
 *
 * @returns An {@link OutboxConsumer} instance ready to start consuming events
 *
 * @example
 * ### Basic Setup
 * ```typescript
 * import { createOutboxConsumer } from '@chassisjs/hermes-mongodb'
 * import { MongoClient } from 'mongodb'
 *
 * type DomainEvent =
 *   | { type: 'MedicineAssigned'; patientId: string; medicineId: string }
 *   | { type: 'TaskCompleted'; taskId: string; completedAt: Date }
 *
 * const client = new MongoClient('mongodb://localhost:27017')
 * await client.connect()
 *
 * const outbox = createOutboxConsumer<DomainEvent>({
 *   client,
 *   db: client.db('hospital'),
 *   publish: async (event) => {
 *     // IMPORTANT: Throw error on failure to trigger retry
 *     await messageBroker.publish(event)
 *   }
 * })
 *
 * // Start consuming events
 * const stop = await outbox.start()
 * ```
 *
 * @example
 * ### Transactional Event Publishing
 * ```typescript
 * // Publish event with business logic in same transaction
 * await outbox.publish(
 *   {
 *     type: 'MedicineAssigned',
 *     patientId: 'patient-123',
 *     medicineId: 'med-456'
 *   },
 *   async (session, db) => {
 *     // Store assignment in same transaction
 *     await db.collection('medicine_assignments').insertOne({
 *       patientId: 'patient-123',
 *       medicineId: 'med-456',
 *       assignedAt: new Date()
 *     }, { session })
 *   }
 * )
 * // Either both succeed or both fail - no inconsistency possible
 * ```
 *
 * @example
 * ### Multiple Events with WithScope
 * ```typescript
 * await outbox.withScope(async ({ publish }) => {
 *   // All events in same transaction
 *   await publish({ type: 'OrderCreated', orderId: '123' })
 *   await publish({ type: 'InvoiceGenerated', invoiceId: '456' })
 *   await publish({ type: 'NotificationSent', userId: 'user-789' })
 * })
 * ```
 *
 * @example
 * ### Horizontal Scaling with Partition Keys
 * ```typescript
 * // Tenant 1 consumer
 * const tenant1Outbox = createOutboxConsumer({
 *   client,
 *   db: client.db('hospital'),
 *   publish: async (event) => await broker.publish(event),
 *   partitionKey: 'tenant-abc'
 * })
 *
 * // Tenant 2 consumer (can run concurrently)
 * const tenant2Outbox = createOutboxConsumer({
 *   client,
 *   db: client.db('hospital'),
 *   publish: async (event) => await broker.publish(event),
 *   partitionKey: 'tenant-xyz'
 * })
 * ```
 *
 * @example
 * ### Graceful Shutdown
 * ```typescript
 * const stop = await outbox.start()
 *
 * process.on('SIGTERM', async () => {
 *   console.log('Shutting down gracefully...')
 *   await stop()  // Waits for in-flight events
 *   await client.close()
 *   process.exit(0)
 * })
 * ```
 *
 * @example
 * ### With Error Handling
 * ```typescript
 * const outbox = createOutboxConsumer<DomainEvent>({
 *   client,
 *   db: client.db('hospital'),
 *   publish: async (event) => {
 *     await messageBroker.publish(event)
 *   },
 *   onFailedPublish: (error) => {
 *     console.error('Failed to publish:', error)
 *     monitoring.increment('outbox.publish.failures')
 *   },
 *   onDbError: (error) => {
 *     console.error('Database error:', error)
 *     monitoring.alert('outbox.database.error')
 *   }
 * })
 * ```
 *
 * @see {@link ConsumerCreationParams} for all configuration options
 * @see {@link OutboxConsumer} for the consumer API
 * @see {@link OutboxEvent} for event typing
 */
export const createOutboxConsumer = <Event extends OutboxEvent>(
  params: ConsumerCreationParams<Event>,
): OutboxConsumer<Event> => {
  const { client, db, publish: _publish } = params
  const partitionKey = params.partitionKey || 'default'
  const saveTimestamps = params.saveTimestamps || false
  const _now = params.now
  const now =
    typeof _now === 'function'
      ? () => {
          const value = _now()
          assertDate(value)
          return value
        }
      : () => new Date()
  const waitAfterFailedPublishMs = params.waitAfterFailedPublishMs || 1000
  const shouldDisposeOnSigterm = isNil(params.shouldDisposeOnSigterm) ? true : !!params.shouldDisposeOnSigterm
  const onDbError = params.onDbError || noop
  const onFailedPublish = params.onFailedPublish || noop
  const messages = db.collection<OutboxMessageModel<Event>>(OutboxMessagesCollectionName)
  const addMessage = async (event: Event | Event[], partitionKey: string, session?: ClientSession) => {
    const toMessage = (data: Event) => ({ _id: new ObjectId(), partitionKey, occurredAt: now(), data })

    return Array.isArray(event)
      ? await messages.insertMany(event.map(toMessage), { session })
      : await messages.insertOne(toMessage(event), { session })
  }
  // the promise will be resolved when `stop` method is called.
  // with that promise it's not possible to call the `start` for the second time,
  // which is important for stopping and resuming the outbox instance
  let shouldStopPromise: CancellationPromise<unknown> = CancellationPromise.resolved(undefined)
  let stopCurrent: Stop | undefined
  let isDisposedOnSigterm = false

  return {
    async start() {
      await assertSupportedMongoVersion(db)
      await ensureIndexes(db)

      await shouldStopPromise
      const stopSignal = new CancellationPromise<unknown>()
      shouldStopPromise = stopSignal

      let stopping = false
      const consumer = await getConsumer(db, partitionKey)
      let resumeToken: ResumeToken | undefined = consumer.resumeToken ?? undefined
      let cursor = createChangeStream<Event>(messages, partitionKey, resumeToken)
      const waitOrStop = (ms: number) => Promise.race([setTimeout(ms), stopSignal])
      const publishUntilSent = async (event: Event) => {
        while (!stopping) {
          try {
            await _publish(event)
            return true
          } catch (error) {
            onFailedPublish(error)
            await waitOrStop(waitAfterFailedPublishMs)
          }
        }

        return false
      }
      const watch = async () => {
        while (!stopping) {
          try {
            if (cursor.closed) {
              // the server ended the stream (e.g. after an `invalidate` or an error it cannot resume from)
              cursor = createChangeStream<Event>(messages, partitionKey, resumeToken)
            }

            const hasNext = await Promise.race([stopSignal, cursor.hasNext()])
            if (hasNext === null) {
              break
            }
            if (!hasNext) {
              continue
            }

            const change = (await cursor.next()) as ChangeStreamDocument<OutboxMessageModel<Event>>

            if (change.operationType === 'invalidate') {
              resumeToken = change._id
              await cursor.close()
              continue
            }
            if (change.operationType !== 'insert') {
              continue
            }

            const { fullDocument: message, documentKey } = change

            if (!(await publishUntilSent(message.data))) {
              break
            }

            resumeToken = change._id
            if (saveTimestamps) {
              await messages.updateOne({ _id: message._id }, { $set: { sentAt: now() } })
            }
            await consumer.update(documentKey._id, resumeToken)
          } catch (error) {
            if (stopping) {
              break
            }

            onDbError(error)
            await waitOrStop(waitAfterFailedPublishMs)
          }
        }
      }
      const watching = watch()
        .catch(onDbError)
        .finally(() => swallow(() => cursor.close()))
      const stop = async () => {
        stopping = true
        stopSignal.resolve(null)
        await watching
      }

      stopCurrent = stop

      if (shouldDisposeOnSigterm && !isDisposedOnSigterm) {
        isDisposedOnSigterm = true
        addDisposeOnSigterm(async () => {
          await stopCurrent?.()
        })
      }

      return stop
    },

    async publish(event: Event | Event[], sessionOrCallback?: ClientSession | SaveWithEventCallback) {
      if (typeof sessionOrCallback === 'function') {
        const saveWithEvent = sessionOrCallback

        await client.withSession(async (session) => {
          await session.withTransaction(async (session) => {
            await saveWithEvent(session, db, client)
            await addMessage(event, partitionKey, session)
          })
        })
      } else {
        await addMessage(event, partitionKey, sessionOrCallback)
      }
    },

    async withScope(scopeFn) {
      return await client.withSession((session) =>
        session.withTransaction(async (session) => {
          const publish = async (event: Event | Event[]) => {
            await addMessage(event, partitionKey, session)
          }

          return await scopeFn({ publish, session, client })
        }),
      )
    },
  }
}

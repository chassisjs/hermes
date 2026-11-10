import { type Duration, type PartitionClaimingStore, type PolledMessage, type RecordedEvent } from '@chassisjs/hermes'
import { type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'
import { changedStreamsQuery, EventsTable, StartedMarker, StreamsTable, SubscriptionsTable } from './eventStoreSql.js'
import { toBigInt } from './projections.js'
import { inTransaction, MaxRowsPerStatement, retryOnLockWaitTimeout } from './sql.js'

type EventStorePollingStoreScope = {
  /** The consumer whose checkpoints and claims the store keeps. */
  consumerName: string
  /**
   * Where a consumer without checkpoints starts: at the first event of every stream, or after the last event of every
   * stream that exists when it starts for the first time. Streams created later are read from their first event.
   *
   * A single-stream projection started from the end still builds a new document from all the events of its stream.
   *
   * @defaultValue `'beginning'`
   */
  startFrom?: 'beginning' | 'end'
}

type EventStorePollingStore = PartitionClaimingStore<RecordedEvent> & {
  /** Prepares the checkpoints of a new consumer (`startFrom`). Call it before polling. */
  initialize(): Promise<void>
}

const microseconds = (duration: Duration) => Math.round(duration.ms * 1000)

/**
 * Creates the store of the event store for `createPollingOutbox` with `usePartitionOrderingPolicy`: a partition is a
 * stream, so the events of a stream are published one by one, in their order, by one instance at a time.
 *
 * Every consumer has one row per stream in `hermes_subscriptions`, which keeps both its checkpoint (the version of
 * the stream it processed) and its claim (`owner`, `lease_until`), and the retry of a failed event (`attempts`,
 * `retry_at`). A poll registers the streams the consumer does not know yet, finds the streams with new events
 * ({@link changedStreamsQuery}) and claims them with `FOR UPDATE SKIP LOCKED` on the rows of `hermes_subscriptions`.
 * It never locks `hermes_streams`, so it does not block appends.
 *
 * The version of a stream changes in the same transaction as its events, so a consumer sees a version only together
 * with all the events up to it: an append that commits after a later one is not skipped.
 *
 * @param getPool - Returns the pool, preferably of `createPollingPool` (`READ COMMITTED`)
 * @param scope - The consumer
 */
const createEventStorePollingStore = (
  getPool: () => Pool,
  scope: EventStorePollingStoreScope,
): EventStorePollingStore => {
  const { consumerName } = scope
  // Where the next poll starts looking for changed streams, so that every stream gets its turn.
  let cursor: string | undefined

  const registerNewStreams = async (pool: Pool) => {
    const [missing] = await pool.query<RowDataPacket[]>(
      `SELECT s.\`stream_id\`
       FROM \`${StreamsTable}\` s
       LEFT JOIN \`${SubscriptionsTable}\` sub ON sub.\`consumer_name\` = ? AND sub.\`stream_id\` = s.\`stream_id\`
       WHERE sub.\`stream_id\` IS NULL AND s.\`version\` > 0
       LIMIT ?`,
      [consumerName, MaxRowsPerStatement],
    )

    if (missing.length) {
      await pool.query(`INSERT IGNORE INTO \`${SubscriptionsTable}\` (\`consumer_name\`, \`stream_id\`) VALUES ?`, [
        missing.map((row) => [consumerName, String(row.stream_id)]),
      ])
    }
  }

  return {
    async initialize() {
      if (scope.startFrom !== 'end') {
        return
      }

      const pool = getPool()
      const [started] = await pool.query<RowDataPacket[]>(
        `SELECT 1 FROM \`${SubscriptionsTable}\` WHERE \`consumer_name\` = ? AND \`stream_id\` = ?`,
        [consumerName, StartedMarker],
      )

      if (started.length) {
        return
      }

      // page through the streams by their primary key, so that a big event store does not land in memory at once
      for (let after = ''; ;) {
        const [streams] = await pool.query<RowDataPacket[]>(
          `SELECT \`stream_id\`, \`version\` FROM \`${StreamsTable}\`
           WHERE \`stream_id\` > ? ORDER BY \`stream_id\` LIMIT ?`,
          [after, MaxRowsPerStatement],
        )

        if (!streams.length) {
          break
        }

        await pool.query(
          `INSERT IGNORE INTO \`${SubscriptionsTable}\` (\`consumer_name\`, \`stream_id\`, \`version\`) VALUES ?`,
          [streams.map((row) => [consumerName, String(row.stream_id), String(row.version)])],
        )
        after = String(streams[streams.length - 1].stream_id)
      }

      await pool.query(
        `INSERT IGNORE INTO \`${SubscriptionsTable}\` (\`consumer_name\`, \`stream_id\`, \`version\`) VALUES (?, ?, 0)`,
        [consumerName, StartedMarker],
      )
    },

    async claimPartitions({ owner, lease, limit }) {
      const pool = getPool()

      await registerNewStreams(pool)

      const find = async (after: string | undefined, max: number) => {
        const { text, params } = changedStreamsQuery({ consumerName, limit: max, owner, after })
        const [rows] = await pool.query<RowDataPacket[]>(text, params)

        return rows.map((row) => String(row.stream_id))
      }
      const fromCursor = await find(cursor, limit)
      // Wrap around: the streams from the beginning, without those already found. With fewer than `limit` found after
      // the cursor, those are all the changed streams after it, so the rest are before it. (No comparison of ids in
      // JavaScript: its order of strings differs from the binary collation of MySQL.)
      const wrapped =
        cursor !== undefined && fromCursor.length < limit
          ? (await find(undefined, limit)).filter((id) => !fromCursor.includes(id))
          : []
      const changed = [...fromCursor, ...wrapped].slice(0, limit)

      cursor = changed.length ? changed[changed.length - 1] : undefined

      if (!changed.length) {
        return []
      }

      return inTransaction(
        pool,
        async (connection) => {
          const [rows] = await connection.query<RowDataPacket[]>(
            `SELECT \`stream_id\` FROM \`${SubscriptionsTable}\`
             WHERE \`consumer_name\` = ? AND \`stream_id\` IN (?)
               AND (\`owner\` = ? OR \`lease_until\` IS NULL OR \`lease_until\` < NOW(6))
               AND (\`retry_at\` IS NULL OR \`retry_at\` <= NOW(6))
             FOR UPDATE SKIP LOCKED`,
            [consumerName, changed, owner],
          )
          const streamIds = rows.map((row) => String(row.stream_id))

          if (streamIds.length) {
            await connection.query(
              `UPDATE \`${SubscriptionsTable}\`
               SET \`owner\` = ?, \`lease_until\` = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND)
               WHERE \`consumer_name\` = ? AND \`stream_id\` IN (?)`,
              [owner, microseconds(lease), consumerName, streamIds],
            )
          }

          return streamIds
        },
        { readCommitted: true },
      )
    },

    async readPartition({ partitionKey: streamId, limit }) {
      const pool = getPool()
      const [[subscription]] = await pool.query<RowDataPacket[]>(
        `SELECT \`version\`, \`attempts\` FROM \`${SubscriptionsTable}\` WHERE \`consumer_name\` = ? AND \`stream_id\` = ?`,
        [consumerName, streamId],
      )
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT \`stream_position\`, \`event_id\`, \`type\`, \`data\`, \`metadata\`, \`recorded_at\`
         FROM \`${EventsTable}\`
         WHERE \`stream_id\` = ? AND \`stream_position\` > ?
         ORDER BY \`stream_position\`
         LIMIT ?`,
        [streamId, subscription ? String(subscription.version) : '0', limit],
      )

      return rows.map((row, i): PolledMessage<RecordedEvent> => ({
        id: String(row.stream_position),
        partitionKey: streamId,
        messageId: String(row.event_id),
        messageType: String(row.type),
        attempts: i === 0 && subscription ? Number(subscription.attempts) : 0,
        message: {
          type: row.type,
          data: row.data,
          metadata: row.metadata ?? {},
          streamId,
          streamPosition: toBigInt(row.stream_position),
          eventId: String(row.event_id),
          recordedAt: row.recorded_at,
        },
      }))
    },

    // No check of the claim, on purpose: the event is already published, whoever published it, and `GREATEST` never
    // moves the checkpoint back, so a late call of an instance that lost its claim is harmless.
    async markDelivered(message) {
      await retryOnLockWaitTimeout(() =>
        getPool().query(
          `UPDATE \`${SubscriptionsTable}\`
           SET \`attempts\` = IF(\`version\` < CAST(? AS UNSIGNED), 0, \`attempts\`),
               \`retry_at\` = IF(\`version\` < CAST(? AS UNSIGNED), NULL, \`retry_at\`),
               \`version\` = GREATEST(\`version\`, CAST(? AS UNSIGNED))
           WHERE \`consumer_name\` = ? AND \`stream_id\` = ?`,
          [message.id, message.id, message.id, consumerName, message.partitionKey],
        ),
      )
    },

    async markFailed(message, { retryAfter, owner }) {
      await getPool().query(
        `UPDATE \`${SubscriptionsTable}\`
         SET \`attempts\` = \`attempts\` + 1,
             \`retry_at\` = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND),
             \`owner\` = NULL,
             \`lease_until\` = NULL
         WHERE \`consumer_name\` = ? AND \`stream_id\` = ? AND \`owner\` = ? AND \`version\` < CAST(? AS UNSIGNED)`,
        [microseconds(retryAfter), consumerName, message.partitionKey, owner, message.id],
      )
    },

    async renewPartitions({ owner, lease, partitionKeys }) {
      const [result] = await retryOnLockWaitTimeout(() =>
        getPool().query<ResultSetHeader>(
          `UPDATE \`${SubscriptionsTable}\`
           SET \`lease_until\` = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND)
           WHERE \`consumer_name\` = ? AND \`stream_id\` IN (?) AND \`owner\` = ?`,
          [microseconds(lease), consumerName, partitionKeys, owner],
        ),
      )

      return result.affectedRows
    },

    async releasePartitions({ owner }) {
      const pool = getPool()
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT \`stream_id\` FROM \`${SubscriptionsTable}\` WHERE \`consumer_name\` = ? AND \`owner\` = ?`,
        [consumerName, owner],
      )

      if (rows.length) {
        await pool.query(
          `UPDATE \`${SubscriptionsTable}\`
           SET \`owner\` = NULL, \`lease_until\` = NULL
           WHERE \`consumer_name\` = ? AND \`stream_id\` IN (?) AND \`owner\` = ?`,
          [consumerName, rows.map((row) => String(row.stream_id)), owner],
        )
      }
    },
  }
}

export { createEventStorePollingStore, type EventStorePollingStore, type EventStorePollingStoreScope }

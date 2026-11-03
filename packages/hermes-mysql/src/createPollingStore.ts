import {
  type Duration,
  type MessageClaimingStore,
  type PartitionClaimingStore,
  type PolledMessage,
} from '@chassisjs/hermes'
import { type Pool, type RowDataPacket } from 'mysql2/promise'
import { inTransaction, OutboxTable, PartitionTable, retryOnLockWaitTimeout } from './sql.js'

type OutboxRow<Message> = RowDataPacket & {
  position: string | number
  partition_key: string
  message_id: string
  message_type: string
  attempts: number
  data: Message
}

type PollingStoreScope = {
  /** Only the messages of this consumer. */
  consumerName: string
  /** Only the messages of this partition. All the partitions of the consumer when not given. */
  partitionKey?: string
}

const Columns = '`position`, `partition_key`, `message_id`, `message_type`, `attempts`, `data`'

const microseconds = (duration: Duration) => Math.round(duration.ms * 1000)

/**
 * Creates the store of the `hermes_outbox` table for `createPollingOutbox` from `@chassisjs/hermes`. It works with
 * `usePartitionOrderingPolicy` and `useNoOrderingPolicy`.
 *
 * The claims use `SELECT ... FOR UPDATE SKIP LOCKED` (MySQL 8.0+), and all the times are computed with the clock of
 * MySQL. The claims run in `READ COMMITTED` transactions whatever the isolation level of the pool is, so that they do
 * not lock the gaps between the rows and do not block the inserts of the application. The other statements change the
 * rows of `hermes_outbox` by their primary key, which locks only those rows in `REPEATABLE READ` too. Still, use a
 * pool of {@link createPollingPool}, whose connections run in `READ COMMITTED`.
 *
 * `claimPartitions` first finds the partitions with undelivered messages with a skip scan of an index (one index
 * lookup per partition), so the cost of a poll does not grow with the number of undelivered messages, but it grows
 * with the number of partitions that have them. It adds the new ones to `hermes_outbox_partition` and removes the free
 * partitions without undelivered messages. It reads the messages with plain `SELECT`s: in MySQL, a subquery of
 * `INSERT ... SELECT` or `DELETE` locks the rows it reads, so it would wait for the open transactions of the
 * application. It does it before the claim, in other statements, so it does not hold the locks of the partitions while
 * it claims them. The next poll adds a removed partition again when it gets new messages, so a message that commits
 * during the removal is not lost. The statements change rows found by their primary key (found first with a plain
 * `SELECT` when needed): an `UPDATE` that scans a secondary index waits for the rows that the application inserted and
 * did not commit yet, even in `READ COMMITTED`.
 *
 * `markFailed` changes a message only when `owner` still has the claim of the message, or of its partition when the
 * message itself is not claimed (`usePartitionOrderingPolicy`).
 *
 * `markDelivered` and the renewals try again when they wait for a lock of a row too long (`innodb_lock_wait_timeout`
 * of {@link createPollingPool}).
 *
 * `markDelivered` does not check the claim on purpose: the message is already published, so it is delivered whoever
 * published it. Checking the claim would only leave a published message undelivered, to be published again.
 *
 * @param getPool - Returns the `mysql2` pool, preferably of {@link createPollingPool}
 * @param scope - The consumer and, optionally, the partition whose messages the store reads
 */
const createPollingStore = <Message>(
  getPool: () => Pool,
  scope: PollingStoreScope,
): MessageClaimingStore<Message> & PartitionClaimingStore<Message> => {
  const { consumerName, partitionKey } = scope
  const inScope = (alias: string) =>
    partitionKey === undefined
      ? { where: `${alias}.\`consumer_name\` = ?`, params: [consumerName] }
      : {
          where: `${alias}.\`consumer_name\` = ? AND ${alias}.\`partition_key\` = ?`,
          params: [consumerName, partitionKey],
        }
  const toMessage = (row: OutboxRow<Message>): PolledMessage<Message> => ({
    id: String(row.position),
    partitionKey: row.partition_key,
    messageId: row.message_id,
    messageType: row.message_type,
    attempts: row.attempts,
    message: row.data,
  })

  return {
    async markDelivered(message) {
      await retryOnLockWaitTimeout(() =>
        getPool().query(
          `UPDATE \`${OutboxTable}\`
         SET \`delivered_at\` = NOW(6), \`claimed_by\` = NULL, \`claimed_until\` = NULL
         WHERE \`position\` = ? AND \`delivered_at\` IS NULL`,
          [message.id],
        ),
      )
    },

    async markFailed(message, { retryAfter, owner }) {
      await getPool().query(
        `UPDATE \`${OutboxTable}\`
         SET \`attempts\` = \`attempts\` + 1,
             \`next_attempt_at\` = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND),
             \`claimed_by\` = NULL,
             \`claimed_until\` = NULL
         WHERE \`position\` = ?
           AND \`delivered_at\` IS NULL
           AND (
             \`claimed_by\` = ?
             OR (
               \`claimed_by\` IS NULL
               AND EXISTS (
                 SELECT 1 FROM \`${PartitionTable}\` p
                 WHERE p.\`consumer_name\` = \`${OutboxTable}\`.\`consumer_name\`
                   AND p.\`partition_key\` = \`${OutboxTable}\`.\`partition_key\`
                   AND p.\`claimed_by\` = ?
               )
             )
           )`,
        [microseconds(retryAfter), message.id, owner, owner],
      )
    },

    async claimMessages({ owner, lease, limit }) {
      const { where, params } = inScope('m')

      return inTransaction(
        getPool(),
        async (connection) => {
          const [rows] = await connection.query<OutboxRow<Message>[]>(
            `SELECT ${Columns} FROM \`${OutboxTable}\` m
           WHERE ${where}
             AND m.\`delivered_at\` IS NULL
             AND (m.\`next_attempt_at\` IS NULL OR m.\`next_attempt_at\` <= NOW(6))
             AND (m.\`claimed_until\` IS NULL OR m.\`claimed_until\` < NOW(6))
           ORDER BY m.\`position\`
           LIMIT ?
           FOR UPDATE SKIP LOCKED`,
            [...params, limit],
          )

          if (rows.length) {
            await connection.query(
              `UPDATE \`${OutboxTable}\`
             SET \`claimed_by\` = ?, \`claimed_until\` = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND)
             WHERE \`position\` IN (?)`,
              [owner, microseconds(lease), rows.map(({ position }) => position)],
            )
          }

          return rows.map(toMessage)
        },
        { readCommitted: true },
      )
    },

    async renewMessages({ owner, lease, messages }) {
      await retryOnLockWaitTimeout(() =>
        getPool().query(
          `UPDATE \`${OutboxTable}\`
         SET \`claimed_until\` = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND)
         WHERE \`position\` IN (?) AND \`claimed_by\` = ? AND \`delivered_at\` IS NULL`,
          [microseconds(lease), messages.map(({ id }) => id), owner],
        ),
      )
    },

    async releaseMessages({ owner }) {
      const { where, params } = inScope('m')
      const [rows] = await getPool().query<RowDataPacket[]>(
        `SELECT m.\`position\` FROM \`${OutboxTable}\` m
         WHERE ${where} AND m.\`claimed_by\` = ? AND m.\`delivered_at\` IS NULL`,
        [...params, owner],
      )

      if (rows.length) {
        await getPool().query(
          `UPDATE \`${OutboxTable}\`
           SET \`claimed_by\` = NULL, \`claimed_until\` = NULL
           WHERE \`position\` IN (?) AND \`claimed_by\` = ? AND \`delivered_at\` IS NULL`,
          [rows.map(({ position }) => position), owner],
        )
      }
    },

    async claimPartitions({ owner, lease, limit }) {
      const pool = getPool()
      const { where, params } = inScope('m')
      const { where: partitionWhere, params: partitionParams } = inScope('p')

      const [pending] = await pool.query<RowDataPacket[]>(
        `WITH RECURSIVE pending (partition_key) AS (
           SELECT MIN(m.\`partition_key\`) FROM \`${OutboxTable}\` m
           WHERE ${where} AND m.\`delivered_at\` IS NULL
           UNION ALL
           SELECT (
             SELECT MIN(m.\`partition_key\`) FROM \`${OutboxTable}\` m
             WHERE ${where} AND m.\`delivered_at\` IS NULL AND m.\`partition_key\` > pending.partition_key
           )
           FROM pending
           WHERE pending.partition_key IS NOT NULL
         )
         SELECT /*+ SET_VAR(cte_max_recursion_depth = 4294967295) */ pending.partition_key FROM pending
         WHERE pending.partition_key IS NOT NULL`,
        [...params, ...params],
      )
      const [registered] = await pool.query<RowDataPacket[]>(
        `SELECT p.\`partition_key\`, p.\`claimed_until\` IS NULL OR p.\`claimed_until\` < NOW(6) AS is_free
         FROM \`${PartitionTable}\` p
         WHERE ${partitionWhere}`,
        partitionParams,
      )
      const pendingKeys = new Set(pending.map((row) => String(row.partition_key)))
      const registeredKeys = new Set(registered.map((row) => String(row.partition_key)))
      const missing = [...pendingKeys].filter((key) => !registeredKeys.has(key)).sort()
      const empty = registered
        .filter((row) => Number(row.is_free) === 1 && !pendingKeys.has(String(row.partition_key)))
        .map((row) => String(row.partition_key))
        .sort()

      if (missing.length) {
        await pool.query(`INSERT IGNORE INTO \`${PartitionTable}\` (\`consumer_name\`, \`partition_key\`) VALUES ?`, [
          missing.map((key) => [consumerName, key]),
        ])
      }

      if (empty.length) {
        await pool.query(
          `DELETE FROM \`${PartitionTable}\`
           WHERE \`consumer_name\` = ?
             AND \`partition_key\` IN (?)
             AND (\`claimed_until\` IS NULL OR \`claimed_until\` < NOW(6))`,
          [consumerName, empty],
        )
      }

      return inTransaction(
        pool,
        async (connection) => {
          const [rows] = await connection.query<RowDataPacket[]>(
            `SELECT p.\`partition_key\` FROM \`${PartitionTable}\` p
           WHERE ${partitionWhere}
             AND (p.\`claimed_by\` = ? OR p.\`claimed_until\` IS NULL OR p.\`claimed_until\` < NOW(6))
             AND (
               SELECT m.\`next_attempt_at\` IS NULL OR m.\`next_attempt_at\` <= NOW(6)
               FROM \`${OutboxTable}\` m
               WHERE m.\`consumer_name\` = p.\`consumer_name\`
                 AND m.\`partition_key\` = p.\`partition_key\`
                 AND m.\`delivered_at\` IS NULL
               ORDER BY m.\`position\`
               LIMIT 1
             )
           ORDER BY p.\`claimed_until\`
           LIMIT ?
           FOR UPDATE OF p SKIP LOCKED`,
            [...partitionParams, owner, limit],
          )
          const partitionKeys = rows.map((row) => String(row.partition_key))

          if (partitionKeys.length) {
            await connection.query(
              `UPDATE \`${PartitionTable}\`
             SET \`claimed_by\` = ?, \`claimed_until\` = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND)
             WHERE \`consumer_name\` = ? AND \`partition_key\` IN (?)`,
              [owner, microseconds(lease), consumerName, partitionKeys],
            )
          }

          return partitionKeys
        },
        { readCommitted: true },
      )
    },

    async readPartition({ partitionKey, limit }) {
      const [rows] = await getPool().query<OutboxRow<Message>[]>(
        `SELECT ${Columns} FROM \`${OutboxTable}\`
         WHERE \`consumer_name\` = ? AND \`partition_key\` = ? AND \`delivered_at\` IS NULL
         ORDER BY \`position\`
         LIMIT ?`,
        [consumerName, partitionKey, limit],
      )

      return rows.map(toMessage)
    },

    async renewPartitions({ owner, lease, partitionKeys }) {
      await retryOnLockWaitTimeout(() =>
        getPool().query(
          `UPDATE \`${PartitionTable}\`
         SET \`claimed_until\` = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND)
         WHERE \`consumer_name\` = ? AND \`partition_key\` IN (?) AND \`claimed_by\` = ?`,
          [microseconds(lease), consumerName, partitionKeys, owner],
        ),
      )
    },

    async releasePartitions({ owner }) {
      const { where, params } = inScope('p')

      await getPool().query(
        `UPDATE \`${PartitionTable}\` p
         SET p.\`claimed_by\` = NULL, p.\`claimed_until\` = NULL
         WHERE ${where} AND p.\`claimed_by\` = ?`,
        [...params, owner],
      )
    },
  }
}

export { createPollingStore, type PollingStoreScope }

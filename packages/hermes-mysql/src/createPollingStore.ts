import {
  type Duration,
  type MessageClaimingStore,
  type PartitionClaimingStore,
  type PolledMessage,
} from '@chassisjs/hermes'
import { type Pool, type RowDataPacket } from 'mysql2/promise'
import { inTransaction, OutboxTable, PartitionTable } from './sql.js'

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
 * The claims use `SELECT ... FOR UPDATE SKIP LOCKED` (MySQL 8.0+) in `READ COMMITTED` transactions, and all the times
 * are computed with the clock of MySQL.
 *
 * @param getPool - Returns the `mysql2` pool
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
      await getPool().query(
        `UPDATE \`${OutboxTable}\`
         SET \`delivered_at\` = NOW(6), \`claimed_by\` = NULL, \`claimed_until\` = NULL
         WHERE \`position\` = ?`,
        [message.id],
      )
    },

    async markFailed(message, { retryAfter }) {
      await getPool().query(
        `UPDATE \`${OutboxTable}\`
         SET \`attempts\` = \`attempts\` + 1,
             \`next_attempt_at\` = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND),
             \`claimed_by\` = NULL,
             \`claimed_until\` = NULL
         WHERE \`position\` = ?`,
        [microseconds(retryAfter), message.id],
      )
    },

    async claimMessages({ owner, lease, limit }) {
      const { where, params } = inScope('m')

      return inTransaction(getPool(), async (connection) => {
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
      })
    },

    async renewMessages({ owner, lease, messages }) {
      await getPool().query(
        `UPDATE \`${OutboxTable}\`
         SET \`claimed_until\` = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND)
         WHERE \`position\` IN (?) AND \`claimed_by\` = ? AND \`delivered_at\` IS NULL`,
        [microseconds(lease), messages.map(({ id }) => id), owner],
      )
    },

    async releaseMessages({ owner }) {
      const { where, params } = inScope('m')

      await getPool().query(
        `UPDATE \`${OutboxTable}\` m
         SET m.\`claimed_by\` = NULL, m.\`claimed_until\` = NULL
         WHERE ${where} AND m.\`claimed_by\` = ? AND m.\`delivered_at\` IS NULL`,
        [...params, owner],
      )
    },

    async claimPartitions({ owner, lease, limit }) {
      const pool = getPool()
      const { where, params } = inScope('m')
      const { where: partitionWhere, params: partitionParams } = inScope('p')

      // A separate transaction: it commits at once, so it does not hold locks of the partitions.
      await inTransaction(pool, (connection) =>
        connection.query(
          `INSERT IGNORE INTO \`${PartitionTable}\` (\`consumer_name\`, \`partition_key\`)
           SELECT DISTINCT m.\`consumer_name\`, m.\`partition_key\` FROM \`${OutboxTable}\` m
           WHERE ${where}
             AND m.\`delivered_at\` IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM \`${PartitionTable}\` p
               WHERE p.\`consumer_name\` = m.\`consumer_name\` AND p.\`partition_key\` = m.\`partition_key\`
             )`,
          params,
        ),
      )

      return inTransaction(pool, async (connection) => {
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
      })
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
      await getPool().query(
        `UPDATE \`${PartitionTable}\`
         SET \`claimed_until\` = DATE_ADD(NOW(6), INTERVAL ? MICROSECOND)
         WHERE \`consumer_name\` = ? AND \`partition_key\` IN (?) AND \`claimed_by\` = ?`,
        [microseconds(lease), consumerName, partitionKeys, owner],
      )
    },

    async releasePartitions({ owner, partitionKeys }) {
      await getPool().query(
        `UPDATE \`${PartitionTable}\`
         SET \`claimed_by\` = NULL, \`claimed_until\` = NULL
         WHERE \`consumer_name\` = ? AND \`partition_key\` IN (?) AND \`claimed_by\` = ?`,
        [consumerName, partitionKeys, owner],
      )
    },
  }
}

export { createPollingStore, type PollingStoreScope }

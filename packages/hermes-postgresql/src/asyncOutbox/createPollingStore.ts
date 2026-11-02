import {
  type Duration,
  type MessageClaimingStore,
  type PartitionClaimingStore,
  type PolledMessage,
} from '@chassisjs/hermes'
import { HermesSql } from '../common/types.js'

type AsyncOutboxRow<Message> = {
  position: string | number | bigint
  partitionKey: string
  messageId: string
  messageType: string
  failsCount: number | null
  data: Message
}

type PollingStoreScope = {
  /** Only the messages of this consumer. */
  consumerName: string
  /** Only the messages of this partition. All the partitions of the consumer when not given. */
  partitionKey?: string
}

/**
 * Creates the store of the `asyncOutbox` table for {@link createPollingOutbox} from `@chassisjs/hermes`. It works with
 * {@link usePartitionOrderingPolicy} and {@link useNoOrderingPolicy}.
 *
 * The claims use `SELECT ... FOR UPDATE SKIP LOCKED`, and all the times are computed with the clock of PostgreSQL.
 *
 * @param getSql - Returns the connection to the database
 * @param scope - The consumer and, optionally, the partition whose messages the store reads
 */
const createPollingStore = <Message>(
  getSql: () => HermesSql,
  scope: PollingStoreScope,
): MessageClaimingStore<Message> & PartitionClaimingStore<Message> => {
  const { consumerName, partitionKey } = scope
  const toMessage = (row: AsyncOutboxRow<Message>): PolledMessage<Message> => ({
    id: row.position,
    partitionKey: row.partitionKey,
    messageId: row.messageId,
    messageType: row.messageType,
    attempts: row.failsCount ?? 0,
    message: row.data,
  })
  const byPosition = (a: AsyncOutboxRow<Message>, b: AsyncOutboxRow<Message>) => {
    const difference = BigInt(a.position) - BigInt(b.position)

    return difference < 0n ? -1 : difference > 0n ? 1 : 0
  }
  const after = (duration: Duration) => getSql()`now() + ${duration.ms}::float8 * interval '1 millisecond'`
  const inScope = (table: string) => {
    const sql = getSql()

    return partitionKey === undefined
      ? sql`${sql(table)}."consumerName" = ${consumerName}`
      : sql`${sql(table)}."consumerName" = ${consumerName} AND ${sql(table)}."partitionKey" = ${partitionKey}`
  }

  return {
    async markDelivered(message) {
      await getSql()`
        UPDATE "asyncOutbox"
        SET "delivered" = true, "sentAt" = now(), "claimedBy" = NULL, "claimedUntil" = NULL
        WHERE "position" = ${message.id.toString()}
      `
    },

    async markFailed(message, { retryAfter }) {
      await getSql()`
        UPDATE "asyncOutbox"
        SET "failsCount" = COALESCE("failsCount", 0) + 1,
            "nextAttemptAt" = ${after(retryAfter)},
            "claimedBy" = NULL,
            "claimedUntil" = NULL
        WHERE "position" = ${message.id.toString()}
      `
    },

    async claimMessages({ owner, lease, limit }) {
      const rows = await getSql()<AsyncOutboxRow<Message>[]>`
        UPDATE "asyncOutbox"
        SET "claimedBy" = ${owner}, "claimedUntil" = ${after(lease)}
        WHERE "position" IN (
          SELECT "position" FROM "asyncOutbox"
          WHERE ${inScope('asyncOutbox')}
            AND "delivered" = false
            AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
            AND ("claimedUntil" IS NULL OR "claimedUntil" < now())
          ORDER BY "position"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING "position", "partitionKey", "messageId", "messageType", "failsCount", "data"
      `

      return [...rows].sort(byPosition).map(toMessage)
    },

    async renewMessages({ owner, lease, messages }) {
      const sql = getSql()

      await sql`
        UPDATE "asyncOutbox"
        SET "claimedUntil" = ${after(lease)}
        WHERE "position" IN ${sql(messages.map(({ id }) => id.toString()))}
          AND "claimedBy" = ${owner}
          AND "delivered" = false
      `
    },

    async releaseMessages({ owner }) {
      await getSql()`
        UPDATE "asyncOutbox"
        SET "claimedBy" = NULL, "claimedUntil" = NULL
        WHERE ${inScope('asyncOutbox')} AND "claimedBy" = ${owner} AND "delivered" = false
      `
    },

    async claimPartitions({ owner, lease, limit }) {
      const sql = getSql()

      await sql`
        INSERT INTO "asyncOutboxPartition" ("consumerName", "partitionKey")
        SELECT DISTINCT "consumerName", "partitionKey" FROM "asyncOutbox"
        WHERE ${inScope('asyncOutbox')} AND "delivered" = false
        ON CONFLICT DO NOTHING
      `

      const rows = await sql<{ partitionKey: string }[]>`
        UPDATE "asyncOutboxPartition"
        SET "claimedBy" = ${owner}, "claimedUntil" = ${after(lease)}
        WHERE ("consumerName", "partitionKey") IN (
          SELECT p."consumerName", p."partitionKey" FROM "asyncOutboxPartition" p
          WHERE ${inScope('p')}
            AND (p."claimedBy" = ${owner} OR p."claimedUntil" IS NULL OR p."claimedUntil" < now())
            AND (
              SELECT m."nextAttemptAt" IS NULL OR m."nextAttemptAt" <= now()
              FROM "asyncOutbox" m
              WHERE m."consumerName" = p."consumerName" AND m."partitionKey" = p."partitionKey" AND m."delivered" = false
              ORDER BY m."position"
              LIMIT 1
            )
          ORDER BY p."claimedUntil" NULLS FIRST
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING "partitionKey"
      `

      return rows.map((row) => row.partitionKey)
    },

    async readPartition({ partitionKey, limit }) {
      const rows = await getSql()<AsyncOutboxRow<Message>[]>`
        SELECT "position", "partitionKey", "messageId", "messageType", "failsCount", "data"
        FROM "asyncOutbox"
        WHERE "consumerName" = ${consumerName} AND "partitionKey" = ${partitionKey} AND "delivered" = false
        ORDER BY "position"
        LIMIT ${limit}
      `

      return rows.map(toMessage)
    },

    async renewPartitions({ owner, lease, partitionKeys }) {
      const sql = getSql()

      await sql`
        UPDATE "asyncOutboxPartition"
        SET "claimedUntil" = ${after(lease)}
        WHERE "consumerName" = ${consumerName} AND "partitionKey" IN ${sql(partitionKeys)} AND "claimedBy" = ${owner}
      `
    },

    async releasePartitions({ owner, partitionKeys }) {
      const sql = getSql()

      await sql`
        UPDATE "asyncOutboxPartition"
        SET "claimedBy" = NULL, "claimedUntil" = NULL
        WHERE "consumerName" = ${consumerName} AND "partitionKey" IN ${sql(partitionKeys)} AND "claimedBy" = ${owner}
      `
    },
  }
}

export { createPollingStore, type PollingStoreScope }

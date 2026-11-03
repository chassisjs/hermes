import { Sql } from 'postgres'
import { PublicationName, type SlotName } from '../common/consts.js'
import { OutboxConsumerStatuses } from './OutboxConsumerState.js'

export const dropReplicationSlot = async (sql: Sql, slotName: SlotName) => {
  await sql.unsafe(
    `
    SELECT pg_drop_replication_slot(slot_name)
    FROM pg_replication_slots
    WHERE slot_name = $1
    AND active = false
  `,
    [slotName],
  )
}

export const migrate = async (sql: Sql, slotName: string) => {
  await sql`
    DO $$
    BEGIN
      IF current_setting('wal_level') != 'logical' THEN
        RAISE EXCEPTION 'wal_level must be set to logical';
      END IF;
    END $$;
  `
  const [{ exists }] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_type t 
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace 
      WHERE t.typname = 'ConsumerStatus'
    )
  `
  if (!exists) {
    const enumValues = OutboxConsumerStatuses.map((status) => `'${status}'`).join(', ')
    await sql.unsafe(`
    CREATE TYPE "ConsumerStatus" AS ENUM (${enumValues})
  `)
  }

  await sql`
    CREATE TABLE IF NOT EXISTS "outbox" (
      "position"      BIGSERIAL     PRIMARY KEY,
      "messageId"     VARCHAR(250)  NOT NULL,
      "messageType"   VARCHAR(250)  NOT NULL,
      "partitionKey"  VARCHAR(30)   DEFAULT 'default' NOT NULL,
      "data"          JSONB         NOT NULL,
      "addedAt"       TIMESTAMPTZ   DEFAULT NOW() NOT NULL,
      "createdAt"     TIMESTAMPTZ   DEFAULT NOW() NOT NULL,
      "lsn"           VARCHAR(50)   NULL,
      "sentAt"        TIMESTAMPTZ   NULL
    );
  `

  await sql`
    CREATE TABLE IF NOT EXISTS "asyncOutbox" (
      "position"      BIGSERIAL     PRIMARY KEY,
      "consumerName"  VARCHAR(30)   NOT NULL,
      "messageId"     VARCHAR(250)  NOT NULL,
      "messageType"   VARCHAR(250)  NOT NULL,
      "data"          JSONB         NOT NULL,
      "addedAt"       TIMESTAMPTZ   DEFAULT NOW() NOT NULL,
      "createdAt"     TIMESTAMPTZ   DEFAULT NOW() NOT NULL,
      "failsCount"    INTEGER       DEFAULT 0,
      "sentAt"        TIMESTAMPTZ   NULL,
      "delivered"     BOOLEAN       DEFAULT FALSE
    );
  `

  await sql`
    DO $$
    BEGIN
      IF to_regclass('"asyncOutboxDeliveredIdx"') IS NULL THEN
        CREATE INDEX "asyncOutboxDeliveredIdx" ON "asyncOutbox" ("delivered" ASC);
      END IF;

      IF to_regclass('"asyncOutboxDeliveredWithDateIdx"') IS NULL THEN
        CREATE INDEX "asyncOutboxDeliveredWithDateIdx" ON "asyncOutbox" ("delivered" ASC, "addedAt" ASC);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'asyncOutbox' AND column_name = 'partitionKey'
      ) THEN
        ALTER TABLE "asyncOutbox"
          ADD COLUMN "partitionKey"   VARCHAR(250)  DEFAULT 'default' NOT NULL,
          ADD COLUMN "nextAttemptAt"  TIMESTAMPTZ   NULL,
          ADD COLUMN "claimedBy"      VARCHAR(250)  NULL,
          ADD COLUMN "claimedUntil"   TIMESTAMPTZ   NULL;
      ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'asyncOutbox' AND column_name = 'partitionKey'
          AND (character_maximum_length < 250 OR is_nullable = 'YES' OR column_default IS NULL)
      ) THEN
        UPDATE "asyncOutbox" SET "partitionKey" = 'default' WHERE "partitionKey" IS NULL;
        ALTER TABLE "asyncOutbox"
          ALTER COLUMN "partitionKey" TYPE VARCHAR(250),
          ALTER COLUMN "partitionKey" SET DEFAULT 'default',
          ALTER COLUMN "partitionKey" SET NOT NULL;
      END IF;

      IF to_regclass('"asyncOutboxPendingIdx"') IS NULL THEN
        CREATE INDEX "asyncOutboxPendingIdx" ON "asyncOutbox" ("consumerName", "partitionKey", "position")
        WHERE "delivered" = false;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'asyncOutboxPartition' AND column_name = 'partitionKey'
          AND character_maximum_length < 250
      ) THEN
        ALTER TABLE "asyncOutboxPartition" ALTER COLUMN "partitionKey" TYPE VARCHAR(250);
      END IF;
    END $$;
  `
  await sql`
    CREATE TABLE IF NOT EXISTS "asyncOutboxPartition" (
      "consumerName"  VARCHAR(30)   NOT NULL,
      "partitionKey"  VARCHAR(250)  NOT NULL,
      "claimedBy"     VARCHAR(250)  NULL,
      "claimedUntil"  TIMESTAMPTZ   NULL,
      PRIMARY KEY ("consumerName", "partitionKey")
    );
  `

  await sql`
    CREATE TABLE IF NOT EXISTS "outboxConsumer" (
      "id"                      BIGSERIAL         PRIMARY KEY,
      "consumerName"            VARCHAR(30)       NOT NULL,
      "partitionKey"            VARCHAR(30)       DEFAULT 'default' NOT NULL,
      "status"                  "ConsumerStatus"  DEFAULT 'CREATED' NOT NULL,
      "lastProcessedLsn"        VARCHAR(20)       DEFAULT '0/00000000' NOT NULL,
      "failedNextLsn"           VARCHAR(20)       DEFAULT NULL,
      "nextLsnRedeliveryCount"  INTEGER           DEFAULT 0 NOT NULL,
      "createdAt"               TIMESTAMPTZ       DEFAULT NOW() NOT NULL,
      "lastUpdatedAt"           TIMESTAMPTZ       DEFAULT NOW() NULL
    );
  `

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "consumerNameIdx" ON "outboxConsumer" ("consumerName" DESC, "partitionKey");`

  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = '${PublicationName}') THEN
        CREATE PUBLICATION ${PublicationName} FOR TABLE outbox;
      END IF;
    END $$;
  `)

  await sql.unsafe(`
    DO $$
    DECLARE
      slot_created boolean;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_replication_slots WHERE slot_name = '${slotName}')
      THEN
          PERFORM pg_create_logical_replication_slot('${slotName}', 'pgoutput');
          slot_created := true;
      END IF;

      RAISE NOTICE 'Slot created: %', slot_created;
    END $$;
  `)
}

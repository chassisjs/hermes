import { Duration } from '@chassisjs/hermes'
import { setTimeout } from 'node:timers/promises'
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

const LockTimeoutAttempts = 12
const LockNotAvailable = '55P03'

/**
 * Runs a migration that may wait for a lock of a table, e.g. behind a long transaction of the application. The
 * migration gives up after `lock_timeout` (5 seconds), so it does not hold up the statements queued behind its lock (all the
 * inserts of the application, for `ACCESS EXCLUSIVE`), and tries again a moment later.
 */
const migrateWithLockTimeout = async (migration: () => Promise<unknown>) => {
  for (let attempt = 1; ; attempt++) {
    try {
      await migration()

      return
    } catch (error) {
      if ((error as { code?: string }).code !== LockNotAvailable || attempt >= LockTimeoutAttempts) {
        throw error
      }

      await setTimeout(Duration.ofSeconds(1).ms)
    }
  }
}

/**
 * Creates and upgrades the tables of Hermes. Instances that start at the same time upgrade the tables of the
 * asynchronous outbox one after another (an advisory lock of the current schema), and the upgrade checks the schema
 * first, so it takes no lock of a table that is up to date.
 */
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

  await migrateWithLockTimeout(
    () => sql`
      DO $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('hermes.migrate.' || current_schema()));
        PERFORM set_config('lock_timeout', '5s', true);

        IF to_regclass(format('%I.%I', current_schema(), 'asyncOutboxDeliveredIdx')) IS NULL THEN
          CREATE INDEX IF NOT EXISTS "asyncOutboxDeliveredIdx" ON "asyncOutbox" ("delivered" ASC);
        END IF;

        IF to_regclass(format('%I.%I', current_schema(), 'asyncOutboxDeliveredWithDateIdx')) IS NULL THEN
          CREATE INDEX IF NOT EXISTS "asyncOutboxDeliveredWithDateIdx" ON "asyncOutbox" ("delivered" ASC, "addedAt" ASC);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'asyncOutbox' AND column_name = 'partitionKey'
        ) THEN
          ALTER TABLE "asyncOutbox"
            ADD COLUMN IF NOT EXISTS "partitionKey"   VARCHAR(250)  DEFAULT 'default' NOT NULL,
            ADD COLUMN IF NOT EXISTS "nextAttemptAt"  TIMESTAMPTZ   NULL,
            ADD COLUMN IF NOT EXISTS "claimedBy"      VARCHAR(250)  NULL,
            ADD COLUMN IF NOT EXISTS "claimedUntil"   TIMESTAMPTZ   NULL;
        ELSIF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'asyncOutbox' AND column_name = 'partitionKey'
            AND (character_maximum_length < 250 OR is_nullable = 'YES' OR column_default IS NULL)
        ) THEN
          LOCK TABLE "asyncOutbox" IN ACCESS EXCLUSIVE MODE;
          UPDATE "asyncOutbox" SET "partitionKey" = 'default' WHERE "partitionKey" IS NULL;
          ALTER TABLE "asyncOutbox"
            ALTER COLUMN "partitionKey" TYPE VARCHAR(250),
            ALTER COLUMN "partitionKey" SET DEFAULT 'default',
            ALTER COLUMN "partitionKey" SET NOT NULL;
        END IF;

        IF to_regclass(format('%I.%I', current_schema(), 'asyncOutboxPendingIdx')) IS NULL THEN
          CREATE INDEX IF NOT EXISTS "asyncOutboxPendingIdx" ON "asyncOutbox" ("consumerName", "partitionKey", "position")
          WHERE "delivered" = false;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'asyncOutboxPartition' AND column_name = 'partitionKey'
            AND character_maximum_length < 250
        ) THEN
          ALTER TABLE "asyncOutboxPartition" ALTER COLUMN "partitionKey" TYPE VARCHAR(250);
        END IF;

        IF to_regclass(format('%I.%I', current_schema(), 'consumerNameIdx')) IS NULL THEN
          CREATE UNIQUE INDEX IF NOT EXISTS "consumerNameIdx" ON "outboxConsumer" ("consumerName" DESC, "partitionKey");
        END IF;
      END $$;
    `,
  )

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

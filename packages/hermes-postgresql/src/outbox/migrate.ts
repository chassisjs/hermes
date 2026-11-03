import { Duration } from '@chassisjs/hermes'
import { setTimeout } from 'node:timers/promises'
import { type ReservedSql, Sql } from 'postgres'
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

const MigrationLock = { classId: 0x48524d53, objectId: 1 }
const LockTimeoutAttempts = 20
const LockNotAvailable = '55P03'
const SmallTableRows = 10_000
const MigrationLockWarningAfter = Duration.ofSeconds(30)
const MigrationLockTimeout = Duration.ofMinutes(10)

/**
 * Runs a migration that may wait for a lock of a table, e.g. behind a long transaction of the application. The
 * migration gives up after `lock_timeout` (500 milliseconds), so the statements queued behind its lock (all the
 * inserts of the application, for `ACCESS EXCLUSIVE`) wait only a moment, and tries again later, waiting longer after
 * every attempt (at most 10 seconds).
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

      await setTimeout(Math.min(250 * 2 ** attempt, Duration.ofSeconds(10).ms))
    }
  }
}

/**
 * Creates and upgrades the tables, the publication and the replication slot of Hermes.
 *
 * Instances that start at the same time migrate one after another (an advisory lock of the database, held by one
 * connection for the whole migration). The others try to take the lock again and again instead of waiting in a
 * statement, so they can warn after 30 seconds and give up after 10 minutes, e.g. when a connection of an instance
 * that died still holds the lock. The upgrades check the schema first, so they take no lock of a table that is up
 * to date. The index of the polling outbox is created only with a small table ({@link warnAboutPendingIndex}).
 */
export const migrate = async (sql: Sql, slotName: string) => {
  const connection = await sql.reserve()

  try {
    await lockMigration(connection)

    let migrationError: unknown

    try {
      await migrateSchema(connection, slotName)
    } catch (error) {
      migrationError = error
      throw error
    } finally {
      await unlockMigration(connection, migrationError)
    }
  } finally {
    connection.release()
  }
}

const lockMigration = async (connection: ReservedSql) => {
  const startedAt = Date.now()
  let warned = false

  while (
    !(
      await connection<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(${MigrationLock.classId}::int, ${MigrationLock.objectId}::int) AS "locked"
      `
    )[0].locked
  ) {
    if (Date.now() - startedAt > MigrationLockTimeout.ms) {
      throw new Error(
        `Hermes could not take the advisory lock of its migration within ${MigrationLockTimeout.ms} ms. Another ` +
          'session holds it: find it in pg_locks (locktype = advisory, classid = 1213353299, objid = 1) and ' +
          'pg_stat_activity, e.g. a connection of an instance that died, and end it with pg_terminate_backend.',
      )
    }

    if (!warned && Date.now() - startedAt > MigrationLockWarningAfter.ms) {
      warned = true
      process.emitWarning(
        'Hermes is waiting for the migration of another instance (an advisory lock of the database). If no other ' +
          'instance is migrating, check that Hermes connects to PostgreSQL directly or through a session pooler: ' +
          'a transaction pooler (e.g. PgBouncer in the transaction mode) can leave the lock taken.',
        { code: 'HERMES_MIGRATION_LOCK' },
      )
    }

    await setTimeout(Duration.ofMiliseconds(200).ms)
  }
}

const unlockMigration = async (connection: ReservedSql, migrationError: unknown) => {
  try {
    const [{ unlocked }] = await connection<{ unlocked: boolean }[]>`
      SELECT pg_advisory_unlock(${MigrationLock.classId}::int, ${MigrationLock.objectId}::int) AS "unlocked"
    `

    if (!unlocked) {
      process.emitWarning(
        'Hermes could not release the advisory lock of its migration, because the session that took it is not the ' +
          'current one. Connect to PostgreSQL directly or through a session pooler, not a transaction pooler.',
        { code: 'HERMES_MIGRATION_LOCK' },
      )
    }
  } catch (error) {
    if (migrationError === undefined) {
      throw error
    }
  }
}

const PendingIndexDefinition =
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS "asyncOutboxPendingIdx" ON "asyncOutbox" ("consumerName", "partitionKey", "position") WHERE "delivered" = false'

const findPendingIndex = async (sql: Sql | ReservedSql) => {
  const [index] = await sql<{ isValid: boolean }[]>`
    SELECT i.indisvalid AS "isValid" FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'asyncOutboxPendingIdx'
  `

  return index
}

/**
 * Creates the index of the polling outbox when `asyncOutbox` is small, so the build takes a moment. It is a separate
 * step, after the upgrade of the tables: when it cannot lock the table within `lock_timeout`, e.g. behind a long
 * transaction of the application, it gives up without failing the start, and {@link warnAboutPendingIndex} warns.
 * The next start tries again.
 */
const createPendingIndexOfSmallTable = async (sql: ReservedSql) => {
  try {
    await sql.unsafe(`
      DO $$
      BEGIN
        PERFORM set_config('lock_timeout', '500ms', true);

        IF to_regclass(format('%I.%I', current_schema(), 'asyncOutboxPendingIdx')) IS NULL
          AND (SELECT COUNT(*) FROM (SELECT 1 FROM "asyncOutbox" LIMIT ${SmallTableRows + 1}) AS "rows") <= ${SmallTableRows}
        THEN
          CREATE INDEX IF NOT EXISTS "asyncOutboxPendingIdx" ON "asyncOutbox" ("consumerName", "partitionKey", "position")
          WHERE "delivered" = false;
        END IF;
      END $$;
    `)
  } catch (error) {
    if ((error as { code?: string }).code !== LockNotAvailable) {
      throw error
    }
  }
}

/**
 * Warns (`process.emitWarning`) when the index of the polling outbox is missing or invalid. Hermes creates it only
 * when `asyncOutbox` has at most {@link SmallTableRows} rows ({@link createPendingIndexOfSmallTable}), because `CREATE INDEX` would stop the inserts of the application while
 * it reads a big table, and `CREATE INDEX CONCURRENTLY` waits for all older transactions, so it does not belong in the start of an
 * application. Build it yourself, e.g. after the upgrade.
 */
const warnAboutPendingIndex = async (sql: ReservedSql) => {
  const index = await findPendingIndex(sql)

  if (index?.isValid) {
    return
  }

  process.emitWarning(
    'The index "asyncOutboxPendingIdx" of the polling outbox is ' +
      (index ? 'invalid' : 'missing') +
      '. The polling outbox works without it, but its polls read the whole "asyncOutbox" table. Build it: ' +
      (index ? 'DROP INDEX CONCURRENTLY "asyncOutboxPendingIdx"; ' : '') +
      PendingIndexDefinition,
    { code: 'HERMES_INDEX_MISSING' },
  )
}

const migrateSchema = async (sql: ReservedSql, slotName: string) => {
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
      WHERE t.typname = 'ConsumerStatus' AND n.nspname = current_schema()
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
        PERFORM set_config('lock_timeout', '500ms', true);

        IF to_regclass(format('%I.%I', current_schema(), 'asyncOutboxDeliveredIdx')) IS NULL THEN
          CREATE INDEX IF NOT EXISTS "asyncOutboxDeliveredIdx" ON "asyncOutbox" ("delivered" ASC);
        END IF;

        IF to_regclass(format('%I.%I', current_schema(), 'asyncOutboxDeliveredWithDateIdx')) IS NULL THEN
          CREATE INDEX IF NOT EXISTS "asyncOutboxDeliveredWithDateIdx" ON "asyncOutbox" ("delivered" ASC, "addedAt" ASC);
        END IF;

        IF (
          SELECT COUNT(*) FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'asyncOutbox'
            AND column_name IN ('partitionKey', 'nextAttemptAt', 'claimedBy', 'claimedUntil')
        ) < 4 THEN
          ALTER TABLE "asyncOutbox"
            ADD COLUMN IF NOT EXISTS "partitionKey"   VARCHAR(250)  DEFAULT 'default' NOT NULL,
            ADD COLUMN IF NOT EXISTS "nextAttemptAt"  TIMESTAMPTZ   NULL,
            ADD COLUMN IF NOT EXISTS "claimedBy"      VARCHAR(250)  NULL,
            ADD COLUMN IF NOT EXISTS "claimedUntil"   TIMESTAMPTZ   NULL;
        END IF;

        IF EXISTS (
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

  await createPendingIndexOfSmallTable(sql)
  await warnAboutPendingIndex(sql)

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

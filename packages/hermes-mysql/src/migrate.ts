import { Duration } from '@chassisjs/hermes'
import { setTimeout } from 'node:timers/promises'
import { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { EventStoreMigrationTable, eventStoreMigrations } from './eventStoreSql.js'
import { MigrationTable, OutboxTable, PartitionTable } from './sql.js'

/**
 * A change of the Hermes tables.
 *
 * MySQL commits every DDL statement at once, so a migration can stop in the middle. Write the statements so that they
 * can run again, e.g. `CREATE TABLE IF NOT EXISTS`, and define the indexes in `CREATE TABLE`.
 */
type Migration = {
  version: number
  name: string
  statements: string[]
}

/**
 * The migrations of the Hermes tables, in the order of their versions. Never change a released migration: add a new
 * version instead.
 *
 * Version 1 was changed before the first release of the package (`1.0.0-alpha.20`): the binary collation of the keys
 * and the `idx_hermes_outbox_pending_partitions` index were added to it. A database migrated by an unreleased build of
 * the `feat/polling-outbox` branch has version 1 without them, so drop its `hermes_*` tables.
 */
const migrations: Migration[] = [
  {
    version: 1,
    name: 'create the outbox',
    statements: [
      `CREATE TABLE IF NOT EXISTS \`${OutboxTable}\` (
        \`position\`         BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
        \`consumer_name\`    VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`partition_key\`    VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'default',
        \`message_id\`       VARCHAR(250)     NOT NULL,
        \`message_type\`     VARCHAR(250)     NOT NULL,
        \`data\`             JSON             NOT NULL,
        \`added_at\`         DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`attempts\`         INT UNSIGNED     NOT NULL DEFAULT 0,
        \`next_attempt_at\`  DATETIME(6)      NULL,
        \`claimed_by\`       VARCHAR(250)     COLLATE utf8mb4_0900_bin NULL,
        \`claimed_until\`    DATETIME(6)      NULL,
        \`delivered_at\`     DATETIME(6)      NULL,
        PRIMARY KEY (\`position\`),
        KEY \`idx_hermes_outbox_pending\` (\`consumer_name\`, \`delivered_at\`, \`position\`),
        KEY \`idx_hermes_outbox_partition\` (\`consumer_name\`, \`partition_key\`, \`delivered_at\`, \`position\`),
        KEY \`idx_hermes_outbox_pending_partitions\` (\`consumer_name\`, \`delivered_at\`, \`partition_key\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`${PartitionTable}\` (
        \`consumer_name\`  VARCHAR(250)  COLLATE utf8mb4_0900_bin NOT NULL,
        \`partition_key\`  VARCHAR(250)  COLLATE utf8mb4_0900_bin NOT NULL,
        \`claimed_by\`     VARCHAR(250)  COLLATE utf8mb4_0900_bin NULL,
        \`claimed_until\`  DATETIME(6)   NULL,
        PRIMARY KEY (\`consumer_name\`, \`partition_key\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
    ],
  },
]

const TableLockWaitTimeoutSeconds = 5
const TableLockAttempts = 10
const LockWaitTimeoutErrno = 1205

const retryOnTableLockTimeout = async <T>(statement: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await statement()
    } catch (error) {
      if ((error as { errno?: number }).errno !== LockWaitTimeoutErrno || attempt >= TableLockAttempts) {
        throw error
      }

      await setTimeout(Duration.ofSeconds(1).ms)
    }
  }
}

/**
 * Applies the pending migrations of one track, recorded in `table`.
 *
 * @returns The versions it applied
 */
const applyMigrations = async (connection: PoolConnection, table: string, track: Migration[]) => {
  await retryOnTableLockTimeout(() =>
    connection.query(`
      CREATE TABLE IF NOT EXISTS \`${table}\` (
        \`version\`     INT           NOT NULL,
        \`name\`        VARCHAR(250)  NOT NULL,
        \`applied_at\`  DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`version\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4
    `),
  )

  const [rows] = await retryOnTableLockTimeout(() =>
    connection.query<RowDataPacket[]>(`SELECT \`version\` FROM \`${table}\``),
  )
  const applied = new Set(rows.map(({ version }) => Number(version)))
  const pending = track.filter(({ version }) => !applied.has(version))

  for (const { version, name, statements } of pending) {
    for (const statement of statements) {
      await retryOnTableLockTimeout(() => connection.query(statement))
    }

    await retryOnTableLockTimeout(() =>
      connection.query(`INSERT INTO \`${table}\` (\`version\`, \`name\`) VALUES (?, ?)`, [version, name]),
    )
  }

  return pending.map(({ version }) => version)
}

/**
 * Creates or updates the Hermes tables: `hermes_outbox`, `hermes_outbox_partition` and `hermes_migrations`, which
 * keeps the versions that were applied.
 *
 * Many instances of the application can run it at the same time: they wait for each other on a named lock
 * (`GET_LOCK`) of the database, and every migration runs once. A statement waits for the lock of a table at most
 * 5 seconds (`lock_wait_timeout`), because the waiting statement stops the queries of the application on that table,
 * and then tries again a moment later, up to about a minute. The migrations are safe to run again, so a statement
 * can be repeated. The connection gets its own `lock_wait_timeout` back afterwards.
 *
 * `createOutboxConsumer` runs it on `start()`. Call it yourself when you turn that off (`migrate: false`), e.g. in a
 * deployment pipeline with a user that can change the schema.
 *
 * With `eventStore`, it also creates the tables of the event store (`hermes_streams`, `hermes_events`,
 * `hermes_subscriptions`, `hermes_projections`, `hermes_projection_versions`), whose versions are kept apart in
 * `hermes_event_store_migrations`. The event store is opt-in, so an application that uses only the outbox does not
 * get its tables.
 *
 * @param pool - A `mysql2` pool
 * @param options.lockTimeout - How long to wait for other instances that are migrating (default: 10 minutes)
 * @param options.eventStore - Whether to create or update the tables of the event store too (default: `false`)
 * @returns The versions of the outbox that this call applied
 */
const migrate = async (pool: Pool, options?: { lockTimeout?: Duration; eventStore?: boolean }): Promise<number[]> => {
  const lockTimeout = options?.lockTimeout ?? Duration.ofMinutes(10)
  const connection = await pool.getConnection()
  const lockName = `CONCAT('hermes_migrations.', DATABASE())`

  let sessionLockWaitTimeout: unknown

  try {
    const [[session]] = await connection.query<RowDataPacket[]>('SELECT @@SESSION.lock_wait_timeout AS lockWaitTimeout')

    sessionLockWaitTimeout = session.lockWaitTimeout
    await connection.query('SET SESSION lock_wait_timeout = ?', [TableLockWaitTimeoutSeconds])

    const [[{ locked }]] = await connection.query<RowDataPacket[]>(`SELECT GET_LOCK(${lockName}, ?) AS locked`, [
      Math.ceil(lockTimeout.ms / 1000),
    ])

    if (Number(locked) !== 1) {
      throw new Error(`Hermes could not take the lock of the migrations within ${lockTimeout.ms} ms.`)
    }

    try {
      const applied = await applyMigrations(connection, MigrationTable, migrations)

      if (options?.eventStore) {
        await applyMigrations(connection, EventStoreMigrationTable, eventStoreMigrations)
      }

      return applied
    } finally {
      await connection.query(`SELECT RELEASE_LOCK(${lockName})`)
    }
  } finally {
    try {
      if (sessionLockWaitTimeout !== undefined) {
        await connection.query('SET SESSION lock_wait_timeout = ?', [Number(sessionLockWaitTimeout)])
      }
      connection.release()
    } catch {
      connection.destroy()
    }
  }
}

export { migrate, migrations, type Migration }

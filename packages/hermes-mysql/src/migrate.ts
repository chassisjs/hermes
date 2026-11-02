import { Duration } from '@chassisjs/hermes'
import { type Pool, type RowDataPacket } from 'mysql2/promise'
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

const migrations: Migration[] = [
  {
    version: 1,
    name: 'create the outbox',
    statements: [
      `CREATE TABLE IF NOT EXISTS \`${OutboxTable}\` (
        \`position\`         BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
        \`consumer_name\`    VARCHAR(250)     COLLATE utf8mb4_bin NOT NULL,
        \`partition_key\`    VARCHAR(250)     COLLATE utf8mb4_bin NOT NULL DEFAULT 'default',
        \`message_id\`       VARCHAR(250)     NOT NULL,
        \`message_type\`     VARCHAR(250)     NOT NULL,
        \`data\`             JSON             NOT NULL,
        \`added_at\`         DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`attempts\`         INT UNSIGNED     NOT NULL DEFAULT 0,
        \`next_attempt_at\`  DATETIME(6)      NULL,
        \`claimed_by\`       VARCHAR(250)     COLLATE utf8mb4_bin NULL,
        \`claimed_until\`    DATETIME(6)      NULL,
        \`delivered_at\`     DATETIME(6)      NULL,
        PRIMARY KEY (\`position\`),
        KEY \`idx_hermes_outbox_pending\` (\`consumer_name\`, \`delivered_at\`, \`position\`),
        KEY \`idx_hermes_outbox_partition\` (\`consumer_name\`, \`partition_key\`, \`delivered_at\`, \`position\`),
        KEY \`idx_hermes_outbox_pending_partitions\` (\`consumer_name\`, \`delivered_at\`, \`partition_key\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`${PartitionTable}\` (
        \`consumer_name\`  VARCHAR(250)  COLLATE utf8mb4_bin NOT NULL,
        \`partition_key\`  VARCHAR(250)  COLLATE utf8mb4_bin NOT NULL,
        \`claimed_by\`     VARCHAR(250)  COLLATE utf8mb4_bin NULL,
        \`claimed_until\`  DATETIME(6)   NULL,
        PRIMARY KEY (\`consumer_name\`, \`partition_key\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
    ],
  },
]

/**
 * Creates or updates the Hermes tables: `hermes_outbox`, `hermes_outbox_partition` and `hermes_migrations`, which
 * keeps the versions that were applied.
 *
 * Many instances of the application can run it at the same time: they wait for each other on a named lock
 * (`GET_LOCK`) of the database, and every migration runs once.
 *
 * `createOutboxConsumer` runs it on `start()`. Call it yourself when you turn that off (`migrate: false`), e.g. in a
 * deployment pipeline with a user that can change the schema.
 *
 * @param pool - A `mysql2` pool
 * @param options.lockTimeout - How long to wait for other instances that are migrating (default: 1 minute)
 * @returns The versions that this call applied
 */
const migrate = async (pool: Pool, options?: { lockTimeout?: Duration }): Promise<number[]> => {
  const lockTimeout = options?.lockTimeout ?? Duration.ofMinutes(1)
  const connection = await pool.getConnection()
  const lockName = `CONCAT('hermes_migrations.', DATABASE())`

  try {
    const [[{ locked }]] = await connection.query<RowDataPacket[]>(`SELECT GET_LOCK(${lockName}, ?) AS locked`, [
      Math.ceil(lockTimeout.ms / 1000),
    ])

    if (Number(locked) !== 1) {
      throw new Error(`Hermes could not take the lock of the migrations within ${lockTimeout.ms} ms.`)
    }

    try {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS \`${MigrationTable}\` (
          \`version\`     INT           NOT NULL,
          \`name\`        VARCHAR(250)  NOT NULL,
          \`applied_at\`  DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          PRIMARY KEY (\`version\`)
        ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4
      `)

      const [rows] = await connection.query<RowDataPacket[]>(`SELECT \`version\` FROM \`${MigrationTable}\``)
      const applied = new Set(rows.map(({ version }) => Number(version)))
      const pending = migrations.filter(({ version }) => !applied.has(version))

      for (const { version, name, statements } of pending) {
        for (const statement of statements) {
          await connection.query(statement)
        }

        await connection.query(`INSERT INTO \`${MigrationTable}\` (\`version\`, \`name\`) VALUES (?, ?)`, [
          version,
          name,
        ])
      }

      return pending.map(({ version }) => version)
    } finally {
      await connection.query(`SELECT RELEASE_LOCK(${lockName})`)
    }
  } finally {
    connection.release()
  }
}

export { migrate, migrations, type Migration }

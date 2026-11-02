import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql'
import { createPool, type Pool, type PoolOptions } from 'mysql2/promise'

type TestContext = {
  options: PoolOptions
  pool: Pool
  onDispose: (fn: () => Promise<void>) => void
}

/**
 * Starts one MySQL for a test file. Every test gets its own, empty database.
 */
export const createMySql = (version = '8.0') => {
  let container: StartedMySqlContainer | undefined
  let databases = 0

  return {
    async start() {
      container = await new MySqlContainer(`mysql:${version}`).start()
    },

    async stop() {
      await container?.stop()
    },

    async withDatabase(test: (context: TestContext) => Promise<void>) {
      if (!container) {
        throw new Error('MySQL is not started.')
      }

      const database = `test_${++databases}`
      const options: PoolOptions = {
        host: container.getHost(),
        port: container.getPort(),
        user: 'root',
        password: container.getRootPassword(),
        database,
      }
      const admin = createPool({ ...options, database: undefined })

      await admin.query(`CREATE DATABASE \`${database}\``)
      await admin.end()

      const pool = createPool({ ...options, supportBigNumbers: true, bigNumberStrings: true })
      const disposable: (() => Promise<void>)[] = []

      try {
        await test({ options, pool, onDispose: (fn) => disposable.push(fn) })
      } finally {
        for (const dispose of disposable.reverse()) {
          await dispose().catch(() => {})
        }
        await pool.end()
      }
    },
  }
}

import { Duration } from '@chassisjs/hermes'
import { createHash } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { createConnection } from 'mysql2'
import { type Connection, type PoolOptions, type RowDataPacket } from 'mysql2/promise'

const MaxLockNameLength = 64

/**
 * The name of the lock in MySQL: as it is, or, when it is longer than the 64 characters that MySQL allows, its
 * beginning and a hash of the whole of it.
 */
const lockNameOf = (name: string) => {
  if (name.length <= MaxLockNameLength) {
    return name
  }

  const hash = createHash('sha256').update(name).digest('hex').slice(0, 32)

  return `${name.slice(0, MaxLockNameLength - hash.length - 1)}~${hash}`
}

type Mutex = {
  /** Takes the lock when it is free. @returns whether this instance holds the lock */
  tryLock(): Promise<boolean>
  /** Waits until it takes the lock, trying every `retryEvery`. Rejects with `AbortError` when `signal` aborts. */
  lock(signal?: AbortSignal): Promise<void>
  /** Whether this instance still holds the lock: `false` once its connection was lost, e.g. after a failover. */
  stillHeld(): Promise<boolean>
  /** Releases the lock and closes the connection. Does nothing when the lock is not held. */
  unlock(): Promise<void>
}

/**
 * A mutex on a named lock of MySQL (`GET_LOCK`), e.g. to run a scheduler on one instance of the application.
 *
 * The lock belongs to a connection of its own, which the mutex keeps open while it holds the lock: MySQL releases the
 * lock when the connection closes, e.g. when the process dies. The lock lives only on the server it was taken on, so
 * a failover of Aurora releases it: call {@link Mutex.stillHeld} before every piece of work and stop when it is false.
 *
 * `GET_LOCK` is reentrant, but the mutex is not: taking the lock again while holding it does nothing, so one
 * `unlock()` releases it. An instance that does not hold the lock keeps its connection open between its attempts,
 * until `unlock()`.
 */
const createMutex = (params: { getOptions: () => PoolOptions; name: string; retryEvery?: Duration }): Mutex => {
  const name = lockNameOf(params.name)
  const retryEvery = params.retryEvery ?? Duration.ofSeconds(1)
  let connection: Connection | null = null
  let held = false

  const drop = () => {
    const lost = connection

    connection = null
    held = false
    lost?.destroy()
  }

  const connect = () => {
    if (!connection) {
      const callbackConnection = createConnection(params.getOptions())

      callbackConnection.on('error', () => {
        if (connection === promised) {
          drop()
        }
      })

      const promised = callbackConnection.promise()

      connection = promised
    }

    return connection
  }

  const isHeldHere = async () => {
    if (!connection || !held) {
      return false
    }

    try {
      const [[row]] = await connection.query<RowDataPacket[]>('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held', [
        name,
      ])

      return Number(row.held) === 1
    } catch {
      drop()

      return false
    }
  }

  let pending: Promise<boolean> | undefined

  const takeLock = async () => {
    if (await isHeldHere()) {
      return true
    }

    try {
      const [[row]] = await connect().query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS locked', [name])

      held = Number(row.locked) === 1
    } catch {
      drop()
    }

    return held
  }
  // One attempt at a time, so that concurrent calls do not take the reentrant lock of MySQL twice.
  const tryLock = () => {
    pending ??= takeLock().finally(() => {
      pending = undefined
    })

    return pending
  }

  return {
    tryLock,

    async lock(signal) {
      signal?.throwIfAborted()

      while (!(await tryLock())) {
        await setTimeout(retryEvery.ms, undefined, { signal })
      }
    },

    stillHeld: isHeldHere,

    async unlock() {
      if (!connection) {
        return
      }

      try {
        if (held) {
          await connection.query('SELECT RELEASE_LOCK(?)', [name])
        }
        await connection.end()
      } catch {
        // the connection is lost, and so is the lock
      } finally {
        connection = null
        held = false
      }
    },
  }
}

export { createMutex, type Mutex }

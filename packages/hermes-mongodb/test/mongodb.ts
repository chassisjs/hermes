import { swallow } from '@chassisjs/hermes'
import { Db, MongoClient, ObjectId } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'

/** The versions of MongoDB that the basic scenarios run on: the major versions supported by MongoDB. */
export const TestedMongoVersions = ['7.0.45', '8.0.34', '9.0.4'] as const
export const DefaultMongoVersion = '8.0.34'

type Server = { replSet: MongoMemoryReplSet; client: MongoClient; instances: number; idleStop?: NodeJS.Timeout }

// one replica set per version, shared by the tests of a file, and stopped when no test has used it for a while
const servers = new Map<string, Promise<Server>>()

const startServer = async (version: string): Promise<Server> => {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    binary: { version },
  })
  const client = await MongoClient.connect(replSet.getUri())

  return { replSet, client, instances: 0 }
}

const getServer = (version: string) => {
  let server = servers.get(version)

  if (!server) {
    server = startServer(version)
    servers.set(version, server)
    server.catch(() => servers.delete(version))
  }

  return server
}

const scheduleStop = (version: string, server: Server) => {
  clearTimeout(server.idleStop)
  server.idleStop = setTimeout(() => {
    if (server.instances === 0) {
      servers.delete(version)
      void (async () => {
        await swallow(() => server.client.close())
        await swallow(() => server.replSet.stop())
      })()
    }
  }, 6000)
  server.idleStop.unref()
}

export const mongodb = async (
  test: (db: Db, client: MongoClient, onDispose: (fn: () => Promise<void>) => void) => Promise<void | never>,
  version: string = DefaultMongoVersion,
) => {
  const server = await getServer(version)
  const disposable: (() => Promise<void>)[] = []
  const onDispose = (fn: () => Promise<void>) => {
    disposable.push(fn)
  }
  const db = server.client.db(`db_${new ObjectId().toString()}`)

  clearTimeout(server.idleStop)
  server.instances++

  try {
    await test(db, server.client, onDispose)
  } finally {
    await Promise.all(disposable.map((fn) => swallow(fn)))
    await swallow(() => db.dropDatabase())
    server.instances--
    scheduleStop(version, server)
  }
}

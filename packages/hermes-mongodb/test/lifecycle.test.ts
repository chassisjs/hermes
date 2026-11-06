import { Duration } from '@chassisjs/hermes'
import { describe, expect, jest, test } from '@jest/globals'
import nodeTimersPromises from 'node:timers/promises'
import { OutboxConsumersCollectionName, OutboxMessagesCollectionName } from '../src/consts.js'
import { createOutboxConsumer } from '../src/index.js'
import { generateEvent, type MedicineEvent } from './events.js'
import { mongodb, TestedMongoVersions } from './mongodb.js'

jest.setTimeout(Duration.ofMinutes(5).ms)

const waitUntil = async (condition: () => boolean | Promise<boolean>, timeout = Duration.ofSeconds(20)) => {
  const deadline = Date.now() + timeout.ms

  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('The condition was not met in time.')
    }
    await nodeTimersPromises.setTimeout(20)
  }
}

describe.each(TestedMongoVersions)('MongoDB %s', (version) => {
  test('the tests run on the requested version', async () => {
    await mongodb(async (db) => {
      expect((await db.admin().buildInfo()).version).toBe(version)
    }, version)
  })
})

test('stop() waits for the event being published, and its resume token is saved', async () => {
  await mongodb(async (db, client) => {
    let finishPublish: (() => void) | undefined
    const published: string[] = []
    const outbox = createOutboxConsumer<MedicineEvent>({
      client,
      db,
      shouldDisposeOnSigterm: false,
      publish: (event) =>
        new Promise<void>((resolve) => {
          finishPublish = () => {
            published.push(event.data.medicineId)
            resolve()
          }
        }),
    })
    const consumers = db.collection(OutboxConsumersCollectionName)

    const stop = await outbox.start()
    await outbox.publish(generateEvent('med1'))
    await waitUntil(() => finishPublish !== undefined)

    let stopped = false
    const stopping = stop().then(() => {
      stopped = true
    })

    await nodeTimersPromises.setTimeout(100)
    expect(stopped).toBe(false)

    finishPublish?.()
    await stopping

    expect(published).toEqual(['med1'])
    expect((await consumers.findOne())?.resumeToken).toBeTruthy()
  })
})

test('stop() ends the retries of an event that keeps failing, without marking it as sent', async () => {
  await mongodb(async (db, client) => {
    const publish = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('the broker is down'))
    const outbox = createOutboxConsumer<MedicineEvent>({
      client,
      db,
      shouldDisposeOnSigterm: false,
      waitAfterFailedPublishMs: Duration.ofMinutes(1).ms,
      publish,
    })

    const stop = await outbox.start()
    await outbox.publish(generateEvent('med1'))
    await waitUntil(() => publish.mock.calls.length === 1)

    const startedAt = Date.now()
    await stop()

    expect(Date.now() - startedAt).toBeLessThan(Duration.ofSeconds(5).ms)
    expect((await db.collection(OutboxConsumersCollectionName).findOne())?.resumeToken).toBeNull()
  })
})

test('goes on after the server ends the change stream (dropping the outbox collection invalidates it)', async () => {
  await mongodb(async (db, client, onDispose) => {
    const published: string[] = []
    const onDbError = jest.fn()
    const outbox = createOutboxConsumer<MedicineEvent>({
      client,
      db,
      shouldDisposeOnSigterm: false,
      waitAfterFailedPublishMs: 50,
      onDbError,
      publish: (event) => {
        published.push(event.data.medicineId)
      },
    })

    onDispose(await outbox.start())

    await outbox.publish(generateEvent('med1'))
    await waitUntil(() => published.length === 1)

    await db.collection(OutboxMessagesCollectionName).drop()
    await outbox.publish(generateEvent('med2'))

    await waitUntil(() => published.length === 2)
    expect(published).toEqual(['med1', 'med2'])
  })
})

test('start() registers its SIGTERM and SIGINT handlers once', async () => {
  await mongodb(async (db, client) => {
    const listeners = () => process.listenerCount('SIGTERM') + process.listenerCount('SIGINT')
    const before = listeners()
    const outbox = createOutboxConsumer<MedicineEvent>({ client, db, publish: () => {} })

    for (let i = 0; i < 3; i++) {
      const stop = await outbox.start()
      await stop()
    }

    expect(listeners()).toBe(before + 2)
  })
})

test('occurredAt comes from now()', async () => {
  await mongodb(async (db, client) => {
    const now = new Date('2026-01-02T03:04:05.000Z')
    const outbox = createOutboxConsumer<MedicineEvent>({
      client,
      db,
      shouldDisposeOnSigterm: false,
      now: () => now,
      publish: () => {},
    })

    await outbox.publish([generateEvent('med1'), generateEvent('med2')])

    const messages = await db.collection(OutboxMessagesCollectionName).find().toArray()
    expect(messages.map(({ occurredAt }) => occurredAt)).toEqual([now, now])
  })
})

import { Duration } from '@chassisjs/hermes'
import { describe, expect, jest, test } from '@jest/globals'
import { setTimeout } from 'node:timers/promises'
import { createOutboxConsumer } from '../src/index.js'
import { generateEvent, MedicineEvent } from './events.js'
import { postgres } from './postgresql.js'

jest.setTimeout(Duration.ofMinutes(5).ms)

describe.each([true, false])('Stopping the consumer', (serialization) => {
  test(`stops redelivering a failing message when serialization is ${serialization ? 'on' : 'off'}`, async () => {
    await postgres(async (sql, container, onDispose) => {
      const unhandledRejections: unknown[] = []
      const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason)
      process.on('unhandledRejection', onUnhandledRejection)
      onDispose(async () => {
        process.off('unhandledRejection', onUnhandledRejection)
      })

      const publishEventStub = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('broker is down'))
      const outbox = createOutboxConsumer<MedicineEvent>({
        getOptions() {
          return {
            host: container.getHost(),
            port: container.getPort(),
            username: container.getUsername(),
            password: container.getPassword(),
            database: container.getDatabase(),
          }
        },
        publish: publishEventStub,
        consumerName: 'app',
        serialization,
        waitAfterFailedPublish: Duration.ofMiliseconds(100),
      })

      const stop = await outbox.start()
      onDispose(stop)

      const event = generateEvent('med1')

      await outbox.queue({ message: event, messageId: 'abc1', messageType: event.name })
      await setTimeout(Duration.ofMiliseconds(500).ms)

      expect(publishEventStub.mock.calls.length).toBeGreaterThan(1)

      await stop()
      await setTimeout(Duration.ofMiliseconds(500).ms)

      expect(unhandledRejections).toEqual([])
    })
  })
})

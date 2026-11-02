import { assertNever, CancellationPromise, Duration, noop } from '@chassisjs/hermes'
import { setTimeout } from 'node:timers/promises'
import { Lsn } from '../common/lsn.js'
import { MessageToPublish, PublishingQueue, PublishingQueueOptions } from './publishingQueue.js'

type PublishResult = 'published' | 'failed' | 'unacknowledged' | 'exhausted'

const createSerializedPublishingQueue = <InsertResult>(
  publish: (messageToPublish: MessageToPublish<InsertResult>) => Promise<void>,
  options?: PublishingQueueOptions<InsertResult>,
): PublishingQueue<'SerializedPublishingQueue', InsertResult> => {
  const waitAfterFailedPublish = options?.waitAfterFailedPublish || Duration.ofSeconds(1)
  const onFailedPublish = options?.onFailedPublish || (() => Promise.resolve())
  const onDequeued = options?.onDequeued || noop
  const ids = new Set<Lsn>()
  // FIFO
  const messages = new Array<MessageToPublish<InsertResult>>()
  const disposal = new AbortController()
  let isPublishing = false
  let publishingPromise = CancellationPromise.resolved()
  let running = Promise.resolve()
  let deliveredLsn: Lsn | undefined

  const queue = (messageToPublish: MessageToPublish<InsertResult>) => {
    if (ids.has(messageToPublish.transaction.lsn)) {
      return messageToPublish
    }

    ids.add(messageToPublish.transaction.lsn)
    messages.push(messageToPublish)

    return messageToPublish
  }

  const dequeueOldest = () => {
    if (messages.length === 0) {
      return
    }

    const oldest = messages.shift()!
    ids.delete(oldest.transaction.lsn)
    onDequeued()
  }

  const _waitAfterFailure = async () => {
    if (waitAfterFailedPublish) {
      await setTimeout(waitAfterFailedPublish.ms, undefined, { signal: disposal.signal }).catch(noop)
    }
  }

  const run = async () => {
    if (isPublishing || disposal.signal.aborted) {
      return
    }

    isPublishing = true
    publishingPromise = new CancellationPromise()
    running = _publishUntilExhausted()

    await running
  }

  const _publishUntilExhausted = async () => {
    try {
      do {
        const result = await _publishOldestMessage()

        switch (result) {
          case 'published':
            continue
          case 'failed':
            await onFailedPublish(messages[0].transaction).catch((error) => console.error(error, 'onFailedPublish'))
            await _waitAfterFailure()
            break
          case 'unacknowledged':
            await _waitAfterFailure()
            break
          case 'exhausted':
            isPublishing = false
            publishingPromise.resolve()
            break
          default:
            assertNever(result)
        }
      } while (isPublishing && !disposal.signal.aborted)
    } finally {
      isPublishing = false

      if (messages.length === 0) {
        publishingPromise.resolve()
      }
    }
  }

  const _publishOldestMessage = async (): Promise<PublishResult> => {
    if (messages.length === 0) {
      return 'exhausted'
    }

    const oldest = messages[0]

    if (deliveredLsn !== oldest.transaction.lsn) {
      try {
        await publish(oldest)
      } catch {
        return 'failed'
      }

      deliveredLsn = oldest.transaction.lsn
    }

    try {
      await oldest.acknowledge()
    } catch (error) {
      console.error(error, 'acknowledge')
      return 'unacknowledged'
    }

    dequeueOldest()

    return 'published'
  }

  return {
    name: () => 'SerializedPublishingQueue',
    queue,
    run,
    size: () => messages.length,
    waitUntilIsEmpty: () => publishingPromise,
    dispose: async () => {
      disposal.abort()
      await running
    },
  }
}

export { createSerializedPublishingQueue, type MessageToPublish }

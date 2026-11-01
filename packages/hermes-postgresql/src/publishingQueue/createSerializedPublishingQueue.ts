import { assertNever, CancellationPromise, Duration, noop } from '@chassisjs/hermes'
import { setTimeout } from 'node:timers/promises'
import { Lsn } from '../common/lsn.js'
import { Transaction } from '../subscribeToReplicationSlot/types.js'
import { MessageToPublish, PublishingQueue } from './publishingQueue.js'

type PublishingQueueOptions<InsertResult> = {
  waitAfterFailedPublish?: Duration
  onFailedPublish?: (tx: Transaction<InsertResult>) => Promise<void>
}

type PublishResult = 'published' | 'failed' | 'exhausted'

const createSerializedPublishingQueue = <InsertResult>(
  publish: (messageToPublish: MessageToPublish<InsertResult>) => Promise<void>,
  options?: PublishingQueueOptions<InsertResult>,
): PublishingQueue<'SerializedPublishingQueue', InsertResult> => {
  const waitAfterFailedPublish = options?.waitAfterFailedPublish || Duration.ofSeconds(1)
  const onFailedPublish = options?.onFailedPublish || (() => Promise.resolve())
  const ids = new Set<Lsn>()
  // FIFO
  const messages = new Array<MessageToPublish<InsertResult>>()
  const disposal = new AbortController()
  let isPublishing = false
  let publishingPromise = CancellationPromise.resolved()

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
  }

  const run = async () => {
    if (isPublishing || disposal.signal.aborted) {
      return
    }

    isPublishing = true
    publishingPromise = new CancellationPromise()

    try {
      do {
        const result = await _publishOldestMessage()

        switch (result) {
          case 'published':
            continue
          case 'failed':
            await onFailedPublish(messages[0].transaction).catch((error) => console.error(error, 'onFailedPublish'))

            if (waitAfterFailedPublish) {
              await setTimeout(waitAfterFailedPublish.ms, undefined, { signal: disposal.signal }).catch(noop)
            }

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
      publishingPromise.resolve()
    }
  }

  const _publishOldestMessage = async (): Promise<PublishResult> => {
    if (messages.length === 0) {
      return 'exhausted'
    }

    const oldest = messages[0]

    try {
      await publish(oldest)
      await oldest.acknowledge()
      dequeueOldest()

      return 'published'
    } catch {
      return 'failed'
    }
  }

  return {
    name: () => 'SerializedPublishingQueue',
    queue,
    run,
    size: () => messages.length,
    waitUntilIsEmpty: () => publishingPromise,
    dispose: () => disposal.abort(),
  }
}

export { createSerializedPublishingQueue, type MessageToPublish }

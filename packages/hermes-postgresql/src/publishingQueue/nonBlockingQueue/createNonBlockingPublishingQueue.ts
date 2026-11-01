import { CancellationPromise, Duration } from '@chassisjs/hermes'
import { Lsn } from '../../common/lsn.js'
import { MessageToPublish, PublishingQueue, PublishingQueueOptions } from '../publishingQueue.js'
import { createIntervalResendingStrategy } from './intervalResendingStrategy.js'
import { StateMessage } from './typings.js'

const createNonBlockingPublishingQueue = <InsertResult>(
  publish: (messageToPublish: MessageToPublish<InsertResult>) => Promise<void>,
  options?: PublishingQueueOptions<InsertResult>,
): PublishingQueue<'NonBlockingPublishingQueue', InsertResult> => {
  const onFailedPublish = options?.onFailedPublish || (() => Promise.resolve())
  const ids = new Set<Lsn>()
  // FIFO
  const messages = new Array<StateMessage<InsertResult>>()
  const inProgress = new Set<Promise<void>>()
  let publishingPromise = CancellationPromise.resolved()
  let isAcknowledging = false
  let isDisposed = false

  const getState = (lsn: Lsn) => {
    return messages.find(({ transaction }) => transaction.lsn === lsn)
  }

  const queue = (messageToPublish: MessageToPublish<InsertResult>) => {
    if (ids.has(messageToPublish.transaction.lsn)) {
      return messageToPublish
    }

    ids.add(messageToPublish.transaction.lsn)
    messages.push({ ...messageToPublish, delivered: false, failed: false })

    return messageToPublish
  }

  const run = async (messageToPublish?: MessageToPublish<InsertResult>) => {
    if (messages.length > 0 && !publishingPromise.isPending) {
      publishingPromise = new CancellationPromise()
    }

    // If the message to publish is not given, then we take the oldest message.
    // The `messageToPublish` can be different than the oldest message because
    // it can be that the oldest message has not yet been delivered (and thus has not been dequeued).
    // Also, in the scenario when one of the younger messages is tried to be delivered another time,
    // after a failed previous attempt.
    messageToPublish = messageToPublish || messages[0]

    if (messageToPublish) {
      await _track(_publishMessage(messageToPublish))
    }
  }

  const _track = async (operation: Promise<void>) => {
    inProgress.add(operation)

    try {
      await operation
    } finally {
      inProgress.delete(operation)
    }
  }

  const _removeMessage = (message: MessageToPublish<InsertResult>) => {
    const index = messages.findIndex(({ transaction }) => transaction.lsn === message.transaction.lsn)

    if (index !== -1) {
      messages.splice(index, 1)
      ids.delete(message.transaction.lsn)
    }
  }

  const _acknowledgeDelivered = async () => {
    if (isAcknowledging) {
      return
    }

    isAcknowledging = true

    try {
      while (messages[0]?.delivered) {
        const oldest = messages[0]

        try {
          await oldest.acknowledge()
        } catch (error) {
          console.error(error, 'acknowledge')
          return
        }

        _removeMessage(oldest)
      }
    } finally {
      isAcknowledging = false
    }

    if (messages.length === 0) {
      publishingPromise.resolve()
    }
  }

  const _publishMessage = async (message: MessageToPublish<InsertResult>) => {
    const state = getState(message.transaction.lsn)

    if (isDisposed || !state || state.delivered) {
      return
    }

    state.failed = false

    try {
      await publish(message)
    } catch {
      state.failed = true
      await onFailedPublish(message.transaction).catch((error) => console.error(error, 'onFailedPublish'))
      return
    }

    state.delivered = true

    await _acknowledgeDelivered()
  }

  const stopResending = createIntervalResendingStrategy<InsertResult>()({
    getMessages: () => messages,
    publishMessage: (message) => _track(_publishMessage(message)),
    acknowledgeDelivered: () => _track(_acknowledgeDelivered()),
    isPublishing: () => publishingPromise.isPending,
    interval: options?.waitAfterFailedPublish || Duration.ofSeconds(30),
  })

  const dispose = async () => {
    isDisposed = true
    stopResending()
    await Promise.allSettled([...inProgress])
  }

  return {
    name: () => 'NonBlockingPublishingQueue',
    queue,
    run,
    size: () => messages.length,
    waitUntilIsEmpty: () => publishingPromise,
    dispose,
  }
}

export { createNonBlockingPublishingQueue, type MessageToPublish }

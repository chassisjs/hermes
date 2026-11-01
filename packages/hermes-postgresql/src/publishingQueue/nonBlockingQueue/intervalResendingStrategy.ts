import { clearInterval, setInterval } from 'node:timers'
import { ResendingStrategy } from './typings.js'

const createIntervalResendingStrategy =
  <InsertResult>(): ResendingStrategy<InsertResult> =>
  ({ getMessages, publishMessage, acknowledgeDelivered, isPublishing, interval }) => {
    const _iteration = () => {
      if (getMessages()[0]?.delivered) {
        void acknowledgeDelivered()
      }

      // first failed and still not delivered.
      const failedMessage = getMessages().find((message) => !message.delivered && message.failed)

      if (failedMessage) {
        void publishMessage(failedMessage)
      }

      // if for some reason, a queue is not publishing and there are still not delivered messages,
      // then pick up the first one and publish it.
      const notDeliveredMessage = getMessages().find((message) => !message.delivered && !message.failed)

      if (!isPublishing() && notDeliveredMessage) {
        void publishMessage(notDeliveredMessage)
      }
    }

    const timer = setInterval(_iteration, interval.ms)

    return () => clearInterval(timer)
  }

export { createIntervalResendingStrategy }

import { type Collection, type Document, type ResumeToken } from 'mongodb'
import { type OutboxMessageModel, type OutboxMessageStream } from './typings.js'

/**
 * Watches the inserts of the outbox messages of a partition. An insert always carries the whole document, so the
 * stream needs no `fullDocument` lookup.
 *
 * @param resumeToken - Start after this event of the stream (`startAfter`, so it also works after an `invalidate`)
 */
const createChangeStream = <Event>(
  messages: Collection<OutboxMessageModel<Event>>,
  partitionKey: string,
  resumeToken?: ResumeToken,
) => {
  const pipeline: Document[] = [
    {
      $match: {
        $or: [{ operationType: 'insert', 'fullDocument.partitionKey': partitionKey }, { operationType: 'invalidate' }],
      },
    },
  ]

  return messages.watch<OutboxMessageModel<Event>, OutboxMessageStream<Event>>(pipeline, {
    startAfter: resumeToken ?? undefined,
  })
}

export { createChangeStream }

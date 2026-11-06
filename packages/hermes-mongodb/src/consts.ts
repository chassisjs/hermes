const OutboxMessagesCollectionName = '__outboxMessages'
const OutboxConsumersCollectionName = '__outboxConsumers'
/** The oldest major version of MongoDB with the Change Streams that Hermes needs (also AWS DocumentDB 5.0). */
const MinimumMongoMajorVersion = 5

export { MinimumMongoMajorVersion, OutboxConsumersCollectionName, OutboxMessagesCollectionName }

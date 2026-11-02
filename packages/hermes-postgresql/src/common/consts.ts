import { createHash } from 'node:crypto'

const PublicationName = `hermes_pub`
const SlotNamePrefix = `hermes_slot`
// https://www.postgresql.org/docs/current/warm-standby.html#STREAMING-REPLICATION-SLOTS-MANIPULATION
const MaxSlotNameLength = 63
const ValidSlotName = /^[a-z0-9_]+$/

type SlotName = `${typeof SlotNamePrefix}_${string}_${string}`
const getSlotName = (consumerName: string, partitionKey: string): SlotName => {
  const name: SlotName = `${SlotNamePrefix}_${consumerName}_${partitionKey}`

  if (ValidSlotName.test(name) && name.length <= MaxSlotNameLength) {
    return name
  }

  const hash = createHash('sha256').update(`${consumerName}\0${partitionKey}`).digest('hex').slice(0, 12)
  const readable = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, MaxSlotNameLength - hash.length - 1)

  return `${readable}_${hash}` as SlotName
}

export { getSlotName, PublicationName, type SlotName }

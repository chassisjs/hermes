import { DefaultRecord } from './common.js'

type Event<
  EventType extends string = string,
  EventData extends DefaultRecord = DefaultRecord,
  EventMetaData extends DefaultRecord | undefined = undefined,
> = Readonly<
  EventMetaData extends undefined
    ? {
        type: EventType
        data: EventData
      }
    : {
        type: EventType
        data: EventData
        metadata: EventMetaData
      }
> & {
  readonly kind?: 'Event'
}

export type { Event }

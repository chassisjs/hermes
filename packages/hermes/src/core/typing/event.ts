import { DefaultRecord } from './common.js'

/**
 * A domain event: something that happened, with its `type`, `data` and, optionally, `metadata`.
 *
 * @template EventType - The type of the event, e.g. `'PatientRegistered'`
 * @template EventData - The data of the event
 * @template EventMetaData - The metadata of the event; without it, the event has no `metadata`
 *
 * @example
 * ```typescript
 * type PatientRegistered = Event<'PatientRegistered', { patientId: string }>
 * ```
 */
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

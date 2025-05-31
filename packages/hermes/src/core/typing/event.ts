import { DeepReadonly, Dictionary } from 'ts-essentials'
import { WithBrand } from './brand.js'

type Event<
  Name extends string = string,
  Props extends Dictionary<T> = {},
  Metadata extends Dictionary<U> = {},
  T = unknown,
  U = unknown,
> = DeepReadonly<{
  type: Name
  data: Props
  metadata?: Metadata
}> &
  WithBrand<'Event'>
type EventName<E> = E extends Event<infer Name, any> ? Name : never

export type { Event, EventName }

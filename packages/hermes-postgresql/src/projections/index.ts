import { DeepReadonly } from 'ts-essentials'

/*
  ----------------------------------------
  Types
  ----------------------------------------
*/
// Transaction<InsertResult>
type HermesProjectionDocument<State> = DeepReadonly<{
  projectionId: number | string
  data: State
  _createdAt: Date
  _updatedAt: Date
  _version: number
  _archived: boolean
}>
type HermesProjectionEvolve<State, Event> = (currentState: State, event: Event) => State
type HermesProjection<State = unknown, Event = unknown> = {
  name: string
  ofEvents: Event[]
  evolve: HermesProjectionEvolve<State, Event>
}

/*
  ----------------------------------------
  Fluid API / Builder
  ----------------------------------------
*/
// type HermesProjectionDefinition
const defineHermesProjection = <State, Event>() => {
  const definition: HermesProjection<State, Event> = {
    name: '',
    ofEvents: [],
    evolve: () => {
      throw new Error('Not implemented')
    },
  }

  return {
    ofName: (name: string) => {
      definition.name = name

      const ofEvolve = (evolve: HermesProjectionEvolve<State, Event>) => {
        definition.evolve = evolve

        return {
          done: () => definition as DeepReadonly<HermesProjection<State, Event>>,
        }
      }
      const ofEvent = {
        ofEvent: (event: Event) => {
          if (!definition.ofEvents.includes(event)) {
            definition.ofEvents.push(event)
          }

          return ofEvent
        },
        ofEvolve,
      }

      return {
        ...ofEvent,
        ofEvents: (...events: Event[]) => {
          definition.ofEvents = [...events]

          return { ofEvolve }
        },
      }
    },
  }
}

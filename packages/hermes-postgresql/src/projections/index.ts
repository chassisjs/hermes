import { assertNever, Event, EventName } from '@chassisjs/hermes'
import * as E from 'fp-ts/Either'
import { Sql, type TransactionSql } from 'postgres'
import type { DeepReadonly, Dictionary, Prettify } from 'ts-essentials'
import type { InsertResult } from '../common/types.js'
import type { Transaction } from '../subscribeToReplicationSlot/types.js'
/*
  ----------------------------------------
  Types
  ----------------------------------------
*/
// Transaction<InsertResult>
type HermesProjectionDocument<
  State extends Dictionary<T, K> = any,
  T = State[keyof State],
  K extends string = keyof State & string,
> = DeepReadonly<{
  id: string
  data: State
  _createdAt: Date
  _updatedAt: Date
  _version: number
  _archived: boolean
}>
type HermesProjectionSql<State> = DeepReadonly<
  {
    projectionId: number | string
  } & {
    [K in keyof State]: State[K]
  } & {
    _createdAt: Date
    _updatedAt: Date
    _version: number
    _archived: boolean
  }
>

type HermesProjectionStoreType = 'sql' | 'document'
type HermesProjectionEvolve<State, EventType extends Event> = (currentState: State, event: EventType) => State
type HermesProjectionCommon<
  State extends Dictionary<T, K> = any,
  EventType extends Event = Event,
  T = State[keyof State],
  K extends string = keyof State & string,
> = {
  name: string
  ofEvents: EventName<EventType>[]
  evolve: (currentState: DeepReadonly<State> | undefined, event: EventType) => DeepReadonly<State>
  getProjectionId: (event: EventType) => string
  getInitialState: (() => DeepReadonly<State>) | null
  update: (
    tx: TransactionSql,
    projection: HermesDocumentProjection<State, EventType, T, K>,
    id: string,
    newState: DeepReadonly<State>,
  ) => Promise<void>
}
type HermesDocumentProjection<
  State extends Dictionary<T, K> = any,
  EventType extends Event = Event,
  T = State[keyof State],
  K extends string = keyof State & string,
> = Prettify<HermesProjectionCommon<State, EventType> & { storeType: 'document' }>
type HermesSqlProjection<
  State extends Dictionary<T, K> = any,
  EventType extends Event = Event,
  T = State[keyof State],
  K extends string = keyof State & string,
> = Prettify<HermesProjectionCommon<State, EventType> & { storeType: 'sql'; columns: Dictionary<ProjectionColumn, K> }>
type HermesProjection<
  State extends Dictionary<T, K> = any,
  EventType extends Event = Event,
  T = State[keyof State],
  K extends string = keyof State & string,
> = HermesSqlProjection<State, EventType> | HermesDocumentProjection<State, EventType>

/*
  ----------------------------------------
  Fluid API / Builder
  ----------------------------------------
*/
// type HermesProjectionDefinition
const updateDocumentProjection = async <
  State extends Dictionary<T, K>,
  EventType extends Event,
  T = State[keyof State],
  K extends string = keyof State & string,
>(
  tx: TransactionSql,
  projection: HermesDocumentProjection<State, EventType, T, K>,
  id: string,
  newState: DeepReadonly<State>,
) => {
  await tx`
    INSERT INTO ${tx(projection.name)} ("id", "data")
    VALUES (${id}, ${newState as any})
    ON CONFLICT ("id")
    DO UPDATE
    SET 
      "data"=${newState as any},
      "_updatedAt"=NOW(),
      "_version"=${tx(projection.name)}."_version" + 1
  `
}
const defineHermesProjection = <
  State extends Dictionary<T, K>,
  EventType extends Event,
  T = State[keyof State],
  K extends string = keyof State & string,
>() => {
  let storeType: HermesProjectionStoreType
  const common: HermesProjectionCommon<State, EventType> = {
    name: '',
    ofEvents: [],
    evolve: () => {
      throw new Error('Not implemented')
    },
    getProjectionId: () => {
      throw new Error('Not implemented')
    },
    update: () => {
      throw new Error('Not implemented')
    },
    getInitialState: null,
  }
  const sqlConfig: Omit<HermesSqlProjection<State, EventType>, keyof HermesProjectionCommon<State, Event>> = {
    storeType: 'sql',
    columns: {} as Dictionary<ProjectionColumn, keyof State & string>,
  }
  const documentConfig: Omit<HermesDocumentProjection<State, EventType>, keyof HermesProjectionCommon<State, Event>> = {
    storeType: 'document',
  }

  const doneLevel = {
    done: (): HermesProjection<State, EventType> => {
      switch (storeType) {
        case 'document':
          return {
            ...common,
            ...documentConfig,
            update: updateDocumentProjection,
          }
        case 'sql':
          return { ...common, ...sqlConfig, update: updateDocumentProjection }
        default:
          assertNever(storeType)
      }
    },
  }
  const level7 = {
    ofInitialState: (getInitialState: () => DeepReadonly<State>) => {
      common.getInitialState = getInitialState
      return doneLevel
    },
    ...doneLevel,
  }
  const level6 = {
    ofId: (getProjectionId: (event: EventType) => string) => {
      common.getProjectionId = getProjectionId
      return level7
    },
  }
  const level5 = {
    ofEvolve: (evolve: (currentState: DeepReadonly<State> | undefined, event: EventType) => DeepReadonly<State>) => {
      common.evolve = evolve

      return level6
    },
  }
  const level4 = {
    ofEvent: (event: EventName<EventType>) => {
      if (!common.ofEvents.includes(event)) {
        common.ofEvents.push(event)
      }

      return level4
    },
    ...level5,
  }

  const level3 = {
    ...level4,
    ofEvents: (...events: EventName<EventType>[]) => {
      common.ofEvents = [...events]

      return level5
    },
  }

  const level2 = {
    ofDocumentType: () => {
      storeType = 'document'

      return level3
    },
    ofSqlType: (columns: Dictionary<ProjectionColumn, keyof State & string>) => {
      storeType = 'sql'
      sqlConfig.columns = columns

      return level3
    },
  }

  const level1 = {
    ofConfig: (config: HermesProjection<State, EventType>) => {
      Object.assign(common, config)

      return doneLevel
    },
    ofName: (name: string) => {
      common.name = name

      return level2
    },
  }

  return level1
}

/*
  ----------------------------------------
  PostgreSQL's Creation and Update Facade.
  ----------------------------------------
*/
type ProjectionColumn = DeepReadonly<{ getRaw: () => string }>
const _columnFn = (raw: string) => {
  let modified = raw

  const setters = {
    notNull: () => ({ getRaw: () => `${modified} NOT NULL` }),
    null: () => ({ getRaw: () => `${modified} NULL` }),
  }
  return {
    default: (value: unknown) => {
      modified = `${raw} DEFAULT ${value}`

      return setters
    },
    ...setters,
  }
}
const integer = () => _columnFn('integer')
const real = () => _columnFn('real')
const timestamp = () => _columnFn('timestamp')
const text = () => _columnFn('text')
const boolean = () => _columnFn('boolean')
const varchar = (size: number) => _columnFn(`varchar(${size})`)

const ensureTable = async (sql: Sql, tableName: string, columns: Dictionary<ProjectionColumn, string>) => {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${tableName}"
    ${Object.keys(columns).map((columnName) => `"${columnName}" ${columns[columnName].getRaw()}`)}
  `)
}

/*
  ----------------------------------------
  Store projection definitions.
  ----------------------------------------
*/
const table = '_hermes_projections'
const migrate = async (sql: Sql) => {
  await sql`
    CREATE TABLE IF NOT EXISTS ${table} (
      "id"              BIGSERIAL     PRIMARY KEY,
      "name"            TEXT          NOT NULL,
      "config"          JSONB         NOT NULL,
      "createdAt"       TIMESTAMPTZ   DEFAULT NOW() NOT NULL,
      "_version"        INTEGER       DEFAULT 0 NOT NULL,
      "_schemaVersion"  INTEGER       DEFAULT 0 NOT NULL,
      UNIQUE("name")
    );
  `
}
const ensureProjectionDefinition = async (sql: Sql, projection: HermesProjection) => {
  await sql`
    INSERT INTO ${table} ("name", "config")
    VALUES (${projection.name}, value2, ...)
    ON CONFLICT ("name")
    DO NOTHING
  `
}
const ensureProjectionDefinitions = async (sql: Sql, projections: HermesProjection[]) => {}
const ensureProjection = async <
  State extends Dictionary<T, K>,
  EventType extends Event = Event,
  T = State[keyof State],
  K extends string = keyof State & string,
>(
  sql: Sql,
  projection: HermesProjection<State, EventType, T, K>,
) => {
  const { storeType } = projection

  switch (storeType) {
    case 'document':
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS "${projection.name}" (
          "id"              TEXT          PRIMARY KEY,
          "data"            JSONB         NOT NULL,
          "_version"        INTEGER       DEFAULT 0 NOT NULL,
          "_createdAt"      TIMESTAMPTZ   DEFAULT NOW() NOT NULL,
          "_updatedAt"      TIMESTAMPTZ   DEFAULT NOW() NOT NULL,
          "_archived"       BOOLEAN       DEFAULT FALSE NOT NULL
        );
      `)
      return
    case 'sql':
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS "${projection.name}" (
          "id"              BIGSERIAL     PRIMARY KEY,
          ${Object.keys(projection.columns)
            .map((name) => {
              return `"${name}" ${projection.columns[name as K].getRaw()},\r\n`
            })
            .join('')}
          "_version"        INTEGER       DEFAULT 0 NOT NULL,
          "_createdAt"      TIMESTAMPTZ   DEFAULT NOW() NOT NULL,
          "_updatedAt"      TIMESTAMPTZ   DEFAULT NOW() NOT NULL,
          "_archived"       BOOLEAN       DEFAULT FALSE NOT NULL
        );
      `)
      return
    default:
      assertNever(storeType)
  }
}

/*
  ----------------------------------------
  ?
  ----------------------------------------
  process projections(p,t) ->
  get projections for the transaction(p,t) ->
  update all projections

    T = State[keyof State],
  K extends string = keyof State & string,
*/

type GetImpactedProjections<
  State extends Dictionary<T, K>,
  EventType extends Event = Event,
  T = State[keyof State],
  K extends string = keyof State & string,
> = (
  tx: TransactionSql,
  projections: HermesProjection<State, EventType, T, K>[],
  transaction: Transaction<InsertResult>,
) => HermesProjection[]
type UpdateProjection<
  State extends Dictionary<T, K>,
  EventType extends Event = Event,
  T = State[keyof State],
  K extends string = keyof State & string,
> = (
  tx: TransactionSql,
  projection: HermesProjection<State, EventType, T, K>,
  transaction: Transaction<InsertResult>,
) => Promise<E.Either<Error, Date>>

const getImpactedProjections = (
  tx: TransactionSql,
  projections: HermesProjection[],
  { results: events }: Transaction<InsertResult>,
) => {
  const transactionEvents = events.map(({ messageType }) => messageType)

  return projections.filter(({ ofEvents }) => isOneOfEventsOnTheList(ofEvents, transactionEvents))
}

const updateProjection = async <
  State extends Dictionary<T, K>,
  EventType extends Event = Event,
  T = State[keyof State],
  K extends string = keyof State & string,
>(
  tx: TransactionSql,
  projection: HermesProjection<State, EventType, T, K>,
  { results }: Transaction<InsertResult>,
) => {
  const events = results
    .filter((event) => projection.ofEvents.includes(event.messageType as EventName<EventType>))
    .map((insertResult) => JSON.parse(insertResult.payload) as EventType)

  for (const event of events) {
    const id = projection.getProjectionId(event)
    const [result]: HermesProjectionDocument<State, T, K>[] =
      await tx`SELECT * FROM ${tx(projection.name)} WHERE "id"=${id}`

    const currentState = result?.data || (projection.getInitialState ? projection.getInitialState() : undefined)

    const newState = projection.evolve(currentState, event)
    const { storeType } = projection
    // await projection.update(tx, projection, id, newState)
    switch (storeType) {
      case 'document':
        await updateDocumentProjection(tx, projection, id, newState)
        break
      case 'sql':
        await updateDocumentProjection(tx, projection as any, id, newState)
        break
      default:
        assertNever(storeType)
    }
  }
}
const intersection = <EventType extends Event>(events: EventName<EventType>[], list: EventName<EventType>[]) =>
  new Set(events).intersection(new Set(list))
const isOneOfEventsOnTheList = <EventType extends Event>(
  events: EventName<EventType>[],
  list: EventName<EventType>[],
) => !!intersection(events, list).size

export { boolean, defineHermesProjection, ensureProjection, integer, real, text, timestamp, updateProjection, varchar }
export type { HermesProjection }

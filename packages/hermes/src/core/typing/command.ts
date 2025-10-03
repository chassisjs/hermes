import { DefaultRecord, DefaultCommandMetadata } from './common.js'

type Command<
  CommandType extends string = string,
  CommandData extends DefaultRecord = DefaultRecord,
  CommandMetaData extends DefaultRecord | undefined = undefined,
> = Readonly<
  CommandMetaData extends undefined
    ? {
        type: CommandType
        data: Readonly<CommandData>
        metadata?: DefaultCommandMetadata | undefined
      }
    : {
        type: CommandType
        data: CommandData
        metadata: CommandMetaData
      }
> & {
  readonly kind?: 'Command'
}

export type { Command }

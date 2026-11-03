import { DefaultRecord, DefaultCommandMetadata } from './common.js'

/**
 * A command: a request to do something, with its `type`, `data` and, optionally, `metadata`.
 *
 * @template CommandType - The type of the command, e.g. `'RegisterPatient'`
 * @template CommandData - The data of the command
 * @template CommandMetaData - The metadata of the command; without it, the command has optional
 * {@link DefaultCommandMetadata}
 *
 * @example
 * ```typescript
 * type RegisterPatient = Command<'RegisterPatient', { email: string }>
 * ```
 */
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

/** The default type of the data and the metadata of an {@link Event} or a {@link Command}. */
type DefaultRecord = Record<string, unknown>
/** The default metadata of a {@link Command}: when it was issued. */
type DefaultCommandMetadata = {
  now: Date
}

export type { DefaultCommandMetadata, DefaultRecord }

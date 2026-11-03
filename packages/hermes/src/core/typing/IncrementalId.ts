import { AssertionError } from '../errors.js'
import { Flavour } from './flavour.js'
import { assertSomething } from './utils.js'

/**
 * An integer greater than 0, like an auto-increment identifier of a database row.
 *
 * @template T - The kind of the identifier, e.g. `'PatientId'`, so identifiers of different kinds are not mixed up
 */
export type IncrementalId<T extends string = string> = Flavour<number, 'IncrementalId'> & {
  readonly __incrementalIdType?: T
}

type IncrementalIdTest = IncrementalId extends number ? number : never
const incrementalIdTest: IncrementalIdTest = 1
assertSomething(incrementalIdTest)

/**
 * Checks that the value is a safe integer greater than 0. A string, e.g. a `BIGINT` returned by the database driver as
 * a string, has to be written only with digits, without leading zeros, and is converted to a number.
 *
 * @param arg - The value to check
 * @param error - The message of the error thrown when the value is not an incremental identifier
 * @throws {AssertionError} When the value is not a safe integer greater than 0
 */
export const parseIncrementalId = <T extends string = string>(
  arg: string | number | undefined,
  error?: string,
): IncrementalId<T> => {
  const value = typeof arg === 'string' && /^[1-9]\d*$/.test(arg) ? Number(arg) : arg

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AssertionError({ forValue: arg }, error || `The value is not an integer greater than 0`)
  }

  return value
}

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
 * Checks that the value is a safe integer greater than 0.
 *
 * @param arg - The value to check
 * @param error - The message of the error thrown when the value is not an incremental identifier
 * @throws {AssertionError} When the value is not a safe integer greater than 0
 */
export const parseIncrementalId = <T extends string = string>(
  arg: number | undefined,
  error?: string,
): IncrementalId<T> => {
  if (!Number.isSafeInteger(arg) || (arg as number) <= 0) {
    throw new AssertionError({ forValue: arg }, error || `The value is not an integer greater than 0`)
  }

  return arg as number
}

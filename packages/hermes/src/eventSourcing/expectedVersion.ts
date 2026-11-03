import { VersionConflictError } from '../core/errors.js'
import { type ExpectedVersion } from './types.js'

/**
 * Throws {@link VersionConflictError} when a stream at `currentVersion` (0 when it does not exist) is not at
 * `expectedVersion`.
 */
const assertExpectedVersion = (streamId: string, expectedVersion: ExpectedVersion, currentVersion: bigint) => {
  const exists = currentVersion > 0n
  const matches =
    expectedVersion === 'any' ||
    (expectedVersion === 'no_stream' && !exists) ||
    (expectedVersion === 'stream_exists' && exists) ||
    (typeof expectedVersion === 'bigint' && expectedVersion === currentVersion)

  if (!matches) {
    throw new VersionConflictError({ streamId, expectedVersion, currentVersion })
  }
}

export { assertExpectedVersion }

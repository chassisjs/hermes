enum HermesErrorCode {
  Assertion = 'Assertion',
  NotSupportedMongoVersion = 'NotSupportedMongoVersion',
  VersionConflict = 'VersionConflict',
}
type HermesErrorDetails<T extends Record<string, unknown> = Record<string, never>> = {
  [K in keyof T]: T[K]
}

abstract class HermesError<
  T extends Record<string, unknown> = Record<string, never>,
  Code extends string = HermesErrorCode,
> extends Error {
  constructor(
    public code: Code,
    public details?: HermesErrorDetails<T>,
    message?: string,
  ) {
    super(message)
  }
}

class AssertionError extends HermesError<{ forKey?: string; forValue?: any }> {
  constructor(
    public details: HermesErrorDetails<{ forKey?: string; forValue?: any }>,
    message?: string,
  ) {
    super(HermesErrorCode.Assertion, details, message)
  }
}

class NotSupportedMongoVersionError extends HermesError<{ supportedVersions: number[]; currentVersion: string }> {
  constructor(
    public details?: HermesErrorDetails<{ supportedVersions: number[]; currentVersion: string }>,
    message?: string,
  ) {
    super(HermesErrorCode.NotSupportedMongoVersion, details, message)
  }
}

type VersionConflictDetails = {
  /** The stream that was appended to. */
  streamId: string
  /** The version the caller expected. */
  expectedVersion: bigint | 'no_stream' | 'stream_exists' | 'any'
  /** The version of the stream when the append was rejected (0 when the stream does not exist). */
  currentVersion: bigint
}

/**
 * An append was rejected because the stream is not at the version the caller expected, e.g. because another instance
 * appended first. Nothing of the rejected append is stored.
 */
class VersionConflictError extends HermesError<VersionConflictDetails> {
  constructor(public details: HermesErrorDetails<VersionConflictDetails>) {
    super(
      HermesErrorCode.VersionConflict,
      details,
      `Stream ${details.streamId} is at version ${details.currentVersion}, expected ${String(details.expectedVersion)}.`,
    )
    this.name = 'VersionConflictError'
  }
}

export {
  AssertionError,
  HermesError,
  HermesErrorCode,
  NotSupportedMongoVersionError,
  VersionConflictError,
  type VersionConflictDetails,
}

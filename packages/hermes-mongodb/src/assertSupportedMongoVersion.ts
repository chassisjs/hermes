import { NotSupportedMongoVersionError, parseSemVer } from '@chassisjs/hermes'
import { type Db } from 'mongodb'
import { MinimumMongoMajorVersion } from './consts.js'

/**
 * Throws {@link NotSupportedMongoVersionError} when the server is older than MongoDB 5.0.
 */
const assertSupportedMongoVersion = async (db: Db) => {
  const { version } = await db.admin().buildInfo()
  const major = parseSemVer(String(version)).major ?? 0

  if (major < MinimumMongoMajorVersion) {
    throw new NotSupportedMongoVersionError(
      { currentVersion: String(version), supportedVersions: [MinimumMongoMajorVersion] },
      `Hermes MongoDB needs MongoDB ${MinimumMongoMajorVersion}.0 or newer, the server is ${String(version)}.`,
    )
  }
}

export { assertSupportedMongoVersion }

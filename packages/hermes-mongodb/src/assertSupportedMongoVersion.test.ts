import { NotSupportedMongoVersionError } from '@chassisjs/hermes'
import { describe, expect, it } from '@jest/globals'
import { type Db } from 'mongodb'
import { assertSupportedMongoVersion } from './assertSupportedMongoVersion.js'

const mockDb = (version: string) => ({ admin: () => ({ buildInfo: async () => ({ version }) }) }) as unknown as Db

describe('assertSupportedMongoVersion', () => {
  it.each(['4.4.0', '3.6.23'])('rejects MongoDB %s', async (version) => {
    await expect(assertSupportedMongoVersion(mockDb(version))).rejects.toThrow(NotSupportedMongoVersionError)
  })

  it.each(['5.0.0', '6.0.29', '7.0.45', '8.0.34', '8.3.13', '9.0.4', '9.0.0-rc0'])(
    'accepts MongoDB %s',
    async (version) => {
      await expect(assertSupportedMongoVersion(mockDb(version))).resolves.toBeUndefined()
    },
  )
})

import { describe, expect, jest, test } from '@jest/globals'
import { Duplex } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { convertBigIntToLsn, convertLsnToBigInt, Lsn } from '../common/lsn.js'
import { HermesSql } from '../common/types.js'
import { startLogicalReplication } from './logicalReplicationStream.js'
import { LogicalReplicationState, Transaction } from './types.js'

type Row = { messageId: string }

// pgoutput message builders: https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html
const int64 = (value: bigint) => {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(value)
  return buffer
}
const xLogData = (data: Buffer) => Buffer.concat([Buffer.from('w'), int64(0n), int64(0n), int64(0n), data])
const begin = (lsn: Lsn, transactionId: number) => {
  const xid = Buffer.alloc(4)
  xid.writeUInt32BE(transactionId)
  return xLogData(Buffer.concat([Buffer.from('B'), int64(convertLsnToBigInt(lsn)), int64(0n), xid]))
}
const insert = (messageId: string) => {
  const header = Buffer.alloc(8)
  header.write('I', 0)
  header.writeUInt32BE(1, 1)
  header.write('N', 5)
  header.writeInt16BE(1, 6)
  const columnLength = Buffer.alloc(4)
  columnLength.writeUInt32BE(Buffer.byteLength(messageId))
  return xLogData(Buffer.concat([header, Buffer.from('t'), columnLength, Buffer.from(messageId)]))
}
const commit = (lsn: Lsn) =>
  xLogData(Buffer.concat([Buffer.from('C'), Buffer.alloc(1), int64(convertLsnToBigInt(lsn)), int64(0n), int64(0n)]))

const createReplicationStream = () => {
  const written: Buffer[] = []
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk)
      callback()
    },
  })
  const sql = {
    unsafe: () => ({ writable: async () => stream }),
    end: async () => {},
  } as unknown as HermesSql
  const receive = async (...messages: Buffer[]) => {
    for (const message of messages) {
      stream.push(message)
      await setImmediate()
    }
  }
  const acknowledgedLsns = () =>
    written
      .filter((buffer) => String.fromCharCode(buffer[0]) === 'r')
      // the status update reports the next WAL position to read from, so the acknowledged LSN is one less.
      .map((buffer) => convertBigIntToLsn(buffer.readBigUInt64BE(1) - 1n))

  return { sql, stream, receive, acknowledgedLsns, destroy: () => stream.destroy() }
}

describe('startLogicalReplication', () => {
  test(`acknowledging a transaction while the next one is being received does not affect the latter`, async () => {
    const { sql, receive, acknowledgedLsns, destroy } = createReplicationStream()
    const state: LogicalReplicationState = {
      lastProcessedLsn: '0/10',
      timestamp: new Date(),
      publication: 'hermes_pub',
      slotName: 'hermes_slot_app_default',
    }
    const transactions: { transaction: Transaction<Row>; acknowledge: () => void }[] = []
    const onInsert = jest.fn(async (transaction: Transaction<Row>, acknowledge: () => void) => {
      transactions.push({ transaction, acknowledge })
    })

    await startLogicalReplication<Row>({ state, sql, columnConfig: { messageId: 'text' }, onInsert })

    await receive(begin('0/20', 1), insert('a1'), commit('0/20'))
    await receive(begin('0/30', 2), insert('b1'))

    transactions[0].acknowledge()

    expect(state.lastProcessedLsn).toBe('0/20')
    expect(acknowledgedLsns()).toEqual(['0/20'])

    await receive(insert('b2'), commit('0/30'))

    expect(transactions).toHaveLength(2)
    expect(transactions[0].transaction).toMatchObject({ lsn: '0/20', results: [{ messageId: 'a1' }] })
    expect(transactions[1].transaction).toMatchObject({
      lsn: '0/30',
      transactionId: 2,
      results: [{ messageId: 'b1' }, { messageId: 'b2' }],
    })

    transactions[1].acknowledge()

    expect(state.lastProcessedLsn).toBe('0/30')
    expect(acknowledgedLsns()).toEqual(['0/20', '0/30'])

    destroy()
  })

  test(`acknowledging after the stream is closed and a connection error without a query are handled`, async () => {
    const { sql, stream, receive, acknowledgedLsns, destroy } = createReplicationStream()
    const state: LogicalReplicationState = {
      lastProcessedLsn: '0/10',
      timestamp: new Date(),
      publication: 'hermes_pub',
      slotName: 'hermes_slot_app_default',
    }
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason)
    const errors: unknown[] = []
    const acknowledgments: (() => void)[] = []

    process.on('unhandledRejection', onUnhandledRejection)
    stream.on('error', (error) => errors.push(error))

    await startLogicalReplication<Row>({
      state,
      sql,
      columnConfig: { messageId: 'text' },
      onInsert: async (_transaction, acknowledge) => {
        acknowledgments.push(acknowledge)
      },
    })
    await receive(begin('0/20', 1), insert('a1'), commit('0/20'))

    stream.emit('error', Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' }))
    destroy()
    acknowledgments[0]()
    await setImmediate()

    process.off('unhandledRejection', onUnhandledRejection)

    expect(state.lastProcessedLsn).toBe('0/20')
    expect(acknowledgedLsns()).toEqual([])
    expect(errors).toHaveLength(1)
    expect(unhandledRejections).toEqual([])
  })
})

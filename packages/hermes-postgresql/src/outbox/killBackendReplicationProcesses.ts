import { swallow } from '@chassisjs/hermes'
import { Sql } from 'postgres'
import { SlotName } from '../common/consts.js'

const killReplicationProcesses = async (sql: Sql, slotName: SlotName) => {
  // Find PIDs of processes holding our replication slot
  await swallow(async () => {
    const backendProcesses = await sql.unsafe<[{ pid: number }]>(`
      SELECT pid 
      FROM pg_stat_replication 
      WHERE application_name = '${slotName}'
      AND state = 'streaming'
    `)

    // Kill each process
    for (const { pid } of backendProcesses) {
      await sql.unsafe(`SELECT pg_terminate_backend($1)`, [pid])
    }
  })

  // Also terminate any idle processes holding our slot
  await swallow(async () => {
    const idleProcesses = await sql.unsafe<[{ pid: number }]>(`
      SELECT pid
      FROM pg_stat_activity 
      WHERE application_name = '${slotName}'
      AND state = 'idle'
    `)

    for (const { pid } of idleProcesses) {
      await sql.unsafe(`SELECT pg_terminate_backend($1)`, [pid])
    }
  })
}

export { killReplicationProcesses }

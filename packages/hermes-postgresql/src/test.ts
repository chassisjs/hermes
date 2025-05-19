// import { addDisposeOnSigterm, assertNever, Event, literalObject } from '@chassisjs/hermes'
// import postgres from 'postgres'
// import { DeepReadonly } from 'ts-essentials'
// import { InsertResult } from './common/types.js'
// import { defineHermesProjection, ensureProjection, updateProjection } from './projections/index.js'
// import { Transaction } from './subscribeToReplicationSlot/types.js'

// type PatientAdded = Event<'PatientAdded', { patientId: number }>
// type Marker1Evaluated = Event<'Marker1Evaluated', { patientId: number; marker1: number; testDate: Date }>
// type Marker2Evaluated = Event<'Marker2Evaluated', { patientId: number; marker2: number; testDate: Date }>
// type AlertRaised = Event<'AlertRaised', { patientId: number; reason: string; raisedAt: Date }>
// type PatientChecked = Event<'PatientChecked', { patientId: number; checkedAt: Date }>
// type PriorityPatientEvent = PatientAdded | Marker1Evaluated | Marker2Evaluated | AlertRaised | PatientChecked
// type PriorityPatient = DeepReadonly<{
//   patientId: number
//   priority: boolean
//   marker1: number | null
//   marker2: number | null
//   lastTestAt: Date | null
// }>

// const sql = postgres({ host: 'localhost', port: 5434, database: 'hermes', user: 'hermes', password: 'hermes' })
// const priorityPatientsProjection = defineHermesProjection<PriorityPatient, PriorityPatientEvent>()
//   .ofName('priorityPatientsProjection')
//   .ofDocumentType()
//   .ofEvents('AlertRaised', 'Marker1Evaluated', 'Marker2Evaluated', 'PatientAdded', 'PatientChecked')
//   .ofEvolve((currentState, { data, type }) => {
//     currentState = currentState || {
//       lastTestAt: null,
//       marker1: null,
//       marker2: null,
//       priority: false,
//       patientId: 0,
//     }

//     switch (type) {
//       case 'PatientAdded':
//         return {
//           ...currentState,
//           patientId: data.patientId,
//         }
//       case 'Marker1Evaluated':
//         return {
//           ...currentState,
//           marker1: data.marker1,
//           lastTestAt: data.testDate,
//         }
//       case 'Marker2Evaluated':
//         return {
//           ...currentState,
//           marker2: data.marker2,
//           lastTestAt: data.testDate,
//         }
//       case 'AlertRaised':
//         return {
//           ...currentState,
//           priority: true,
//         }
//       case 'PatientChecked':
//         return {
//           ...currentState,
//           priority: false,
//         }
//       default:
//         assertNever(type)
//     }
//   })
//   .ofId((event) => `patient-${event.data.patientId}`)
//   .done()

// const test = async () => {
//   addDisposeOnSigterm(() => sql.end())
//   const message: Transaction<InsertResult> = {
//     lsn: '000/000',
//     timestamp: new Date(),
//     transactionId: 627,
//     results: [
//       {
//         messageId: 'event-123',
//         messageType: 'PatientAdded',
//         partitionKey: 'default',
//         position: 1,
//         payload: JSON.stringify(
//           literalObject<PatientAdded>({
//             type: 'PatientAdded',
//             data: {
//               patientId: 10000,
//             },
//           }),
//         ),
//       },
//       {
//         messageId: 'event-124',
//         messageType: 'Marker1Evaluated',
//         partitionKey: 'default',
//         position: 1,
//         payload: JSON.stringify(
//           literalObject<Marker1Evaluated>({
//             type: 'Marker1Evaluated',
//             data: {
//               patientId: 10000,
//               marker1: 1.646,
//               testDate: new Date(),
//             },
//           }),
//         ),
//       },
//       {
//         messageId: 'event-125',
//         messageType: 'AlertRaised',
//         partitionKey: 'default',
//         position: 1,
//         payload: JSON.stringify(
//           literalObject<AlertRaised>({
//             type: 'AlertRaised',
//             data: {
//               patientId: 10000,
//               reason: `blood test result exceeded a threshold`,
//               raisedAt: new Date(),
//             },
//           }),
//         ),
//       },
//     ],
//   }
//   try {
//     await ensureProjection(sql, priorityPatientsProjection)
//     await sql.begin(async (tx) => {
//       await updateProjection(tx, priorityPatientsProjection, message)
//       console.log('ok')
//     })
//   } catch (error) {
//     console.error(error)
//     throw error
//   }
//   console.log('ok!')
// }

// export { test }

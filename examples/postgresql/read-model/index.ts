import { Duration, Uuid4String, addDisposeOnSigterm, parseUuid4, swallow } from '@chassisjs/hermes'
import {
  type HermesMessageEnvelope,
  createOutboxConsumer,
  useBasicAsyncOutboxConsumerPolicy,
} from '@chassisjs/hermes-postgresql'
import {
  Command,
  DeepReadonly,
  DefaultCommandMetadata,
  DefaultRecord,
  Event,
  getInMemoryMessageBus,
} from '@event-driven-io/emmett'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import chalk from 'chalk'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { StatusCodes } from 'http-status-codes'
import crypto from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import ora from 'ora'
import postgres from 'postgres'
import { AbstractStartedContainer } from 'testcontainers'

const app = express()
const hostPort = Number(process.env.HOST_PORT || 5444)

app.use(express.json())
app.use(cors())
app.use(helmet())

type MessageId = Uuid4String<'MessageId'>
type PatientId = Uuid4String<'PatientId'>
type TreatmentId = Uuid4String<'TreatmentId'>
type MedicineId = Uuid4String<'MedicineId'>
type RegisterPatientRequest = {
  email: string
}
type RegisterPatientResponse = {
  id: PatientId
}
type CommonMetadata = DefaultCommandMetadata & {
  redeliveryCount: number
  messageId: string
}
type DomainCommand<CommandType extends string = string, CommandData extends DefaultRecord = DefaultRecord> = {
  kind: 'command'
} & Command<CommandType, CommandData, CommonMetadata | undefined>
type DomainEvent<EventType extends string = string, EventData extends DefaultRecord = DefaultRecord> = {
  kind: 'event'
} & Event<EventType, EventData, CommonMetadata | undefined>

type Dosage = DeepReadonly<{
  frequency: 'everyday' | 'twice per day' | string
  unit: 'ml' | 'mg' | 'pill'
  value: number
}>
type TreatmentStarted = DomainEvent<
  'TreatmentStarted',
  {
    treatmentId: TreatmentId
    patientId: PatientId
    start: Date
    end: Date
  }
>
type MedicineAssignedToTreatment = DomainEvent<
  'MedicineAssignedToTreatment',
  {
    treatmentId: TreatmentId
    medicineId: MedicineId
    dosage: Dosage
  }
>
type PatientInTreatmentEvent = TreatmentStarted | MedicineAssignedToTreatment

let deps: AbstractStartedContainer[] = []
const runDeps = async () => {
  deps = [
    await new PostgreSqlContainer('postgres:17-alpine')
      .withNetworkAliases('postgres')
      .withHostname('postgres')
      .withExposedPorts({ container: 5432, host: hostPort })
      .withUsername('hermes')
      .withPassword('hermes')
      .withDatabase('hermes')
      .withCommand(['postgres', '-c', 'wal_level=logical'])
      .start(),
  ]

  await setTimeout(Duration.ofSeconds(5).ms)
}
const stopDeps = async () => {
  await Promise.all(deps.map((dep) => dep.stop()))
}

const dbOptions = {
  host: 'localhost',
  port: hostPort,
  database: 'hermes',
  user: 'hermes',
  password: 'hermes',
}
const messageBus = getInMemoryMessageBus()
const sql = postgres(dbOptions)

const parsePatientId = (value: string) => parseUuid4<'PatientId'>(value) as PatientId
const parseMessageId = (value: string) => parseUuid4<'MessageId'>(value) as MessageId

const getIdPUser = async (email: Email): Promise<Subject> => Promise.resolve(crypto.randomUUID() as Subject)
const addUserToIdentityProvider = async (email: Email) => {
  console.info(`Adding ${email} to IdP`)
  await setTimeout(200)
  return crypto.randomUUID() as Subject
}

const constructMessageId = (...values: (string | { toString: () => string })[]) => {
  return values
    .reduce<crypto.Hash>((messageId, value) => {
      messageId.update(value.toString())

      return messageId
    }, crypto.createHash('sha256'))
    .digest('hex')
}

const publishOne = async (
  envelope: Omit<HermesMessageEnvelope<RegisterPatientCommand | RegisterPatientEvent>, 'lsn'>,
) => {
  const { message, messageId, redeliveryCount } = envelope
  const metadata: CommonMetadata = {
    redeliveryCount,
    messageId,
    now: new Date(),
  }
  console.info(`publish ${message.type}`)

  if (message.kind === 'command') {
    await messageBus.send({
      ...message,
      metadata,
    })
  } else {
    await messageBus.publish({
      ...message,
      metadata,
    })
  }
}
const outbox = createOutboxConsumer<PatientInTreatmentEvent>({
  getOptions() {
    return dbOptions
  },
  publish: async (message) => {
    /*
      If this callback successfully finishes ✅,
      then the event is considered as delivered 📨🎉;
      If this callback throws an error ⛔,
      then Hermes PostgreSQL 🫒 will try to deliver this message again later ⏲️.
    */

    if (Array.isArray(message)) {
      for (const nextMessage of message) {
        await publishOne(nextMessage)
      }
    } else {
      await publishOne(message)
    }
  },
  consumerName: 'app',
  asyncOutbox: useBasicAsyncOutboxConsumerPolicy(),
})

app.post<string, any, RegisterPatientResponse, RegisterPatientRequest>('/patient', async (req, res) => {
  const { body } = req

  const patientId = await registerPatient(body)

  try {
    await waitForResult(patientId)

    res.send({ id: patientId })
  } catch (error) {
    // do logging
    res.sendStatus(StatusCodes.REQUEST_TIMEOUT)
  }
})

const main = async () => {
  const spinner = ora({ color: 'green', text: 'Starting the dependencies...' })

  try {
    spinner.start()

    await runDeps()

    spinner.succeed()
    spinner.start()
    spinner.text = 'Connecting to the dependencies...'

    const stopOutbox = await outbox.start()

    spinner.succeed()

    console.log(chalk.green(`\r\n\Everything is set!\r\n\r\n`))
    console.log(
      chalk.green(`
      Now you can register a new patient!\r\n      Use the cURL:\r\n
    `),
    )
    console.log(
      chalk.yellow(`
      curl --location 'http://localhost:3000/patient' \ \r\n
      --header 'Content-Type: application/json' \ \r\n
      --data-raw '{"email": "john.kowalski@gmail.com"}'\r\n
    `),
    )

    addDisposeOnSigterm(stopOutbox)
    // addDisposeOnSigterm(stopAsyncOutbox)
    addDisposeOnSigterm(sql.end)
    addDisposeOnSigterm(async () => {
      spinner.text = 'Stopping the dependencies...'
      await stopDeps()
      spinner.succeed()
      process.exit()
    })

    addDisposeOnSigterm(() => process.exit(0))
  } catch (error) {
    await swallow(() => stopDeps())
    spinner.fail()
    console.log(chalk.red(error))
    throw error
  }
}

main()

app.listen(3000)

console.log(chalk.blue(`\r\nApp started at 3000.\r\n\r\n`))

const StreamsTable = 'hermes_streams'
const EventsTable = 'hermes_events'
const SubscriptionsTable = 'hermes_subscriptions'
const ProjectionsTable = 'hermes_projections'
const ProjectionVersionsTable = 'hermes_projection_versions'
const DeadLettersTable = 'hermes_dead_letters'
const EventStoreMigrationTable = 'hermes_event_store_migrations'

/**
 * A row of `hermes_subscriptions` that marks a consumer as started, so that `startFrom: 'end'` applies only once.
 * Stream ids cannot be empty, so it never matches a stream.
 */
const StartedMarker = ''

const DuplicateEntryErrno = 1062
const DeadlockErrno = 1213

/**
 * The migrations of the event store, on their own track (`hermes_event_store_migrations`), apart from the outbox.
 * Never change a released migration: add a new version instead.
 */
const eventStoreMigrations = [
  {
    version: 1,
    name: 'create the event store',
    statements: [
      `CREATE TABLE IF NOT EXISTS \`${StreamsTable}\` (
        \`stream_id\`   VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`version\`     BIGINT UNSIGNED  NOT NULL DEFAULT 0,
        \`created_at\`  DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\`  DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`stream_id\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`${EventsTable}\` (
        \`global_position\`  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
        \`stream_id\`        VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`stream_position\`  BIGINT UNSIGNED  NOT NULL,
        \`event_id\`         VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`type\`             VARCHAR(250)     NOT NULL,
        \`data\`             JSON             NOT NULL,
        \`metadata\`         JSON             NOT NULL,
        \`recorded_at\`      DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`global_position\`),
        UNIQUE KEY \`uq_hermes_events_stream\` (\`stream_id\`, \`stream_position\`),
        UNIQUE KEY \`uq_hermes_events_event_id\` (\`event_id\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`${SubscriptionsTable}\` (
        \`consumer_name\`  VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`stream_id\`      VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`version\`        BIGINT UNSIGNED  NOT NULL DEFAULT 0,
        \`owner\`          VARCHAR(250)     COLLATE utf8mb4_0900_bin NULL,
        \`lease_until\`    DATETIME(6)      NULL,
        \`attempts\`       INT UNSIGNED     NOT NULL DEFAULT 0,
        \`retry_at\`       DATETIME(6)      NULL,
        PRIMARY KEY (\`consumer_name\`, \`stream_id\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`${ProjectionsTable}\` (
        \`name\`        VARCHAR(250)  COLLATE utf8mb4_0900_bin NOT NULL,
        \`id\`          VARCHAR(250)  COLLATE utf8mb4_0900_bin NOT NULL,
        \`data\`        JSON          NULL,
        \`created_at\`  DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\`  DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`name\`, \`id\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`${ProjectionVersionsTable}\` (
        \`name\`       VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`id\`         VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`stream_id\`  VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`version\`    BIGINT UNSIGNED  NOT NULL,
        PRIMARY KEY (\`name\`, \`id\`, \`stream_id\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
    ],
  },
  {
    version: 2,
    name: 'create the dead letters of the consumers',
    statements: [
      `CREATE TABLE IF NOT EXISTS \`${DeadLettersTable}\` (
        \`consumer_name\`    VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`stream_id\`        VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`stream_position\`  BIGINT UNSIGNED  NOT NULL,
        \`event_id\`         VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`event_type\`       VARCHAR(250)     NOT NULL,
        \`attempts\`         INT UNSIGNED     NOT NULL,
        \`error\`            MEDIUMTEXT       NULL,
        \`failed_at\`        DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`consumer_name\`, \`stream_id\`, \`stream_position\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
    ],
  },
]

/**
 * The query that finds the streams with events that a consumer has not processed yet, and that it can claim now: not
 * claimed by another instance (or the claim expired), and not waiting for the retry of a failed event.
 *
 * It reads the rows of the consumer in `hermes_subscriptions` in the order of the primary key, from `after` on, and
 * joins every stream by its primary key, so it needs no sort, and its cost grows with the number of streams that the
 * consumer knows. The caller moves `after` past the streams it got and wraps around at the end, so busy streams at the
 * beginning of the key order do not starve the others.
 *
 * @param params.consumerName - The consumer
 * @param params.limit - The maximum number of streams
 * @param params.owner - The instance that claims; the streams it already claims are included
 * @param params.after - Only the streams after this one, in the order of their ids
 */
const changedStreamsQuery = (params: { consumerName: string; limit: number; owner?: string; after?: string }) => ({
  text: `SELECT sub.\`stream_id\`
    FROM \`${SubscriptionsTable}\` sub
    JOIN \`${StreamsTable}\` s ON s.\`stream_id\` = sub.\`stream_id\`
    WHERE sub.\`consumer_name\` = ?${params.after === undefined ? '' : ' AND sub.`stream_id` > ?'}
      AND s.\`version\` > sub.\`version\`
      AND (${params.owner === undefined ? '' : 'sub.`owner` = ? OR '}sub.\`lease_until\` IS NULL OR sub.\`lease_until\` < NOW(6))
      AND (sub.\`retry_at\` IS NULL OR sub.\`retry_at\` <= NOW(6))
    ORDER BY sub.\`stream_id\`
    LIMIT ?`,
  params: [
    params.consumerName,
    ...(params.after === undefined ? [] : [params.after]),
    ...(params.owner === undefined ? [] : [params.owner]),
    params.limit,
  ] as unknown[],
})

export {
  changedStreamsQuery,
  DeadLettersTable,
  DeadlockErrno,
  DuplicateEntryErrno,
  EventsTable,
  EventStoreMigrationTable,
  eventStoreMigrations,
  ProjectionsTable,
  ProjectionVersionsTable,
  StartedMarker,
  StreamsTable,
  SubscriptionsTable,
}

<img src="../../public/logo-main.png" alt="Hermes logo" style="margin: 0 auto; width: 70%; display: block;" />
<br />

# Quick start

## PostgreSQL configuration

First, change your Write-Ahead Log mode to [logical](https://www.postgresql.org/docs/current/runtime-config-wal.html#GUC-WAL-LEVEL).

The aim is to set the _wal_level_ parameter.

This is how this can be done with Docker Compose 👇

```bash
services:
  postgres:
    image: postgres:17-alpine
    restart: always
    ports:
      - "5434:5432"
    environment:
      - POSTGRES_DB=hermes
      - POSTGRES_USER=hermes
      - POSTGRES_PASSWORD=hermes
    command:
      - "postgres"
      - "-c"
      - "wal_level=logical"
```

You can also change the maximum number of [replication slots](./limitations.md) when you will be working on many partitions or Hermes PostgreSQL instances.

```bash
command:
  - "postgres"
  - "-c"
  - "wal_level=logical"
  - "max_replication_slots=20" 👈👈👈
```

When it comes e.g. to _AWS RDS for PostgreSQL_ you can use _AWS CDK_ and _CloudFormation_.

You have to use the [logical_replication](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.LogicalReplication.html) set to 1 👇

```javascript
import * as cdk from 'aws-cdk-lib'
import { aws_ec2 as ec2, aws_rds as rds } from 'aws-cdk-lib'

const vpc = ec2.Vpc.fromLookup(this, 'DefaultVPC', { isDefault: true })
// Create a parameter group with logical replication enabled
const parameterGroup = new rds.ParameterGroup(this, 'PostgresParams', {
  engine: rds.DatabaseInstanceEngine.postgres({
    version: rds.PostgresEngineVersion.VER_14,
  }),
  parameters: {
    'rds.logical_replication': '1', // 👈👈👈
    max_replication_slots: '10', // 👈👈👈
  },
})

// Create the RDS PostgreSQL instance
new rds.DatabaseInstance(this, 'PostgresRDS', {
  engine: rds.DatabaseInstanceEngine.postgres({
    version: rds.PostgresEngineVersion.VER_14,
  }),
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MICRO),
  vpc,
  multiAz: false,
  allocatedStorage: 20,
  storageType: rds.StorageType.GP2,
  publiclyAccessible: false,
  credentials: rds.Credentials.fromGeneratedSecret('postgres'),
  databaseName: 'mydb',
  parameterGroup: parameterGroup,
})
```

## Installation

```bash
npm i @chassisjs/hermes @chassisjs/hermes-postgresql

# or

pnpm install @chassisjs/hermes @chassisjs/hermes-postgresql

# or

yarn add @chassisjs/hermes @chassisjs/hermes-postgresql
```

## Good to know

One instance of Hermes PostgreSQL, identified by the _consumerName_ and _partitionKey_ parameters, equals one [replication slot](./how-does-it-work.md).

It means that the instance of your app which created the consumer will receive all messages related to this consumer and its _partition_.

When you try to start another consumer of _the same name_ and with the same partition's name, you get the `HermesConsumerAlreadyTakenError` error, rooted in _PostgreSQL Logical Replication_.

It's a beautiful native mechanism that does a job for you of taking care of instantiating of exactly one consumer of given name.

You can use it to take advantage of the fact that no other instance executes this code.

Next, see the [basic usage](./basic-usage.md).

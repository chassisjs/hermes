# Hermes Monorepo - Agent Guide

This document provides essential information about the Hermes monorepo structure, build system, and deployment process for AI agents and developers.

## Project Overview

Hermes is a Production-Ready TypeScript Outbox Pattern implementation distributed as a monorepo with multiple packages.

**Repository:** https://github.com/chassisjs/hermes  
**Documentation:** https://docs.hermesjs.tech  
**NPM Organization:** @chassisjs

## Monorepo Structure

This is a Lerna-managed monorepo with npm workspaces containing four main packages:

```
hermes/
├── packages/
│   ├── hermes/                    # Core package with base utilities
│   ├── hermes-mongodb/            # MongoDB implementation
│   ├── hermes-mysql/              # MySQL implementation (polling)
│   └── hermes-postgresql/         # PostgreSQL implementation
├── examples/                      # Example implementations
├── docs/                         # VitePress documentation
├── .github/workflows/            # CI/CD pipelines
├── package.json                  # Root package with workspace config
└── lerna.json                    # Lerna configuration
```

### Package Details

#### @chassisjs/hermes

- **Location:** `packages/hermes`
- **Description:** Core package with shared utilities, types, and base functionality
- **Polling outbox:** `src/pollingOutbox` has the database-independent engine (`createPollingOutbox`) and the ordering policies (`usePartitionOrderingPolicy`, `useNoOrderingPolicy`). Databases provide a store (e.g. `createPollingStore` in hermes-postgresql, used by the async outbox)
- **Main Dependencies:** `uuid@~14.0.3`
- **Node:** `>=18.20.3` (`engines`)
- **Exports:** `./lib/index.cjs` (CommonJS), `./lib/index.mjs` (ESM)

#### @chassisjs/hermes-mongodb

- **Location:** `packages/hermes-mongodb`
- **Description:** MongoDB-specific Outbox Pattern implementation
- **Dependencies:** none
- **Peer Dependencies:** `@chassisjs/hermes@~1.0.0-alpha.15`, `mongodb@>=6.8.0 <8`
- **Tests:** `mongodb-memory-server`, one replica set per version. The basic scenarios run on every version in `TestedMongoVersions` (`test/mongodb.ts`): the major versions that MongoDB supports (7.0, 8.0, 9.0). The code accepts MongoDB 5.0+ (`MinimumMongoMajorVersion`), also because of AWS DocumentDB 5.0
- **Node:** `>=18.20.3` (`engines`)

#### @chassisjs/hermes-mysql

- **Location:** `packages/hermes-mysql`
- **Description:** MySQL 8.0+ / Aurora MySQL 3 Outbox Pattern implementation on the polling outbox of the core package (`createPollingStore` + `usePartitionOrderingPolicy`/`useNoOrderingPolicy`)
- **Dependencies:** `mysql2@~3.24.6`
- **Peer Dependencies:** `@chassisjs/hermes` (needs the polling outbox; raise the range in the release like for hermes-postgresql)
- **Node:** `>=18.20.3` (`engines`)
- **Tables:** `hermes_outbox`, `hermes_outbox_partition`, `hermes_migrations`. Migrations are versioned in `src/migrate.ts` and run under `GET_LOCK`. Never change a released migration; add a new version. Version 1 was changed before the first release, so databases migrated by unreleased builds need their `hermes_*` tables dropped. MySQL commits DDL at once, so every migration has to be safe to run again (`CREATE TABLE IF NOT EXISTS`, indexes inside `CREATE TABLE`)
- **Pools:** `start()` polls with its own small pool (`createPollingPool`, `pollingConnectionLimit`, 3 by default), whose connections run in `READ COMMITTED` (`SET SESSION` on every new connection, with `innodb_lock_wait_timeout = 5`; `resetOnRelease` forced off because the reset brings back the default isolation level), and `stop()` closes only that one. The claims also run `SET TRANSACTION ... READ COMMITTED`, so they do not lock gaps with any pool. `queue()` without `tx` and `getDbConnection()` use another, lazy pool that `stop()` never closes, so the isolation level of the application never changes
- **Migrate:** `migrate` waits for a table lock at most 5 seconds (`lock_wait_timeout`, because the waiting DDL stops the queries of the application on the table) and retries every statement on 1205; other instances wait for its `GET_LOCK` up to 10 minutes; it gives the connection its own `lock_wait_timeout` back
- **Event store (opt-in):** `migrate(pool, { eventStore: true })` adds `hermes_streams`, `hermes_events`, `hermes_subscriptions`, `hermes_projections`, `hermes_projection_versions` and `hermes_dead_letters` (the events a reaction gave up on after `maxAttempts`), on their own track of versions (`hermes_event_store_migrations`). An append locks its row of `hermes_streams` (found with a plain `SELECT` first, created with an `INSERT`, so a missing stream never takes a gap lock) and runs inside a savepoint in the transaction of the application. `hermes_subscriptions` keeps, per (consumer, stream), both the checkpoint and the claim. Every projection document keeps the version of every stream that fed it in `hermes_projection_versions`, so replays are idempotent. Compare positions with `CAST(? AS UNSIGNED)`: `GREATEST(bigint, '10')` compares as strings. Cost: every poll of every consumer instance scans `hermes_streams` (to register new streams) and the consumer's rows of `hermes_subscriptions` (`changedStreamsQuery`, from a round-robin cursor), so it grows with the number of streams; tested up to 5,000 streams. `hermes_projection_versions` is never cleaned (one row per document and stream). A version conflict inside the application's transaction is not retried by `createCommandHandler`: in `REPEATABLE READ` the retry would read the same snapshot
- **Claims:** `SELECT ... FOR UPDATE SKIP LOCKED` on the `READ COMMITTED` pool, so that they do not lock gaps and block the inserts of the application. Every other write changes rows by their primary key: an `UPDATE` that scans a secondary index waits for uncommitted rows of the application even in `READ COMMITTED`, and a subquery of `INSERT ... SELECT`/`DELETE` locks the rows it reads, so find the rows with a plain `SELECT` first
- **Tests:** Testcontainers with `mysql:8.0` (Aurora MySQL 3 is 8.0 compatible); `MYSQL_VERSION=8.4 npm test -w packages/hermes-mysql` runs them on another version

#### @chassisjs/hermes-postgresql

- **Location:** `packages/hermes-postgresql`
- **Description:** PostgreSQL-specific Outbox Pattern implementation using logical replication
- **Dependencies:** `fp-ts@~2.16.11`, `postgres@~4.0.0`, `nodemon@~3.1.14`
- **Migrations:** `migrate` holds a session advisory lock of the database on one reserved connection for the whole migration, taken with `pg_try_advisory_lock` in a loop, so it can warn after 30 seconds (`HERMES_MIGRATION_LOCK`) and give up after 10 minutes. Upgrades check the schema first, run with `lock_timeout = 500ms` and retry with backoff on `55P03`. `asyncOutboxPendingIdx` is created only when `asyncOutbox` has at most 10 000 rows (plain `CREATE INDEX` inside the upgrade block); for a bigger table `migrate` only warns (`HERMES_INDEX_MISSING`) with the `CREATE INDEX CONCURRENTLY` to run by hand, so the start never builds an index on a big table. Connect directly or through a session pooler, not a transaction pooler
- **Peer Dependencies:** `@chassisjs/hermes@~1.0.0-alpha.15`. The async outbox uses the polling outbox of the core package (from `1.0.0-alpha.20`), so the minimum has to be raised in the release that publishes it. It cannot be raised earlier: npm resolves the range against the local workspace version and the registry, so `~1.0.0-alpha.20` fails with `ETARGET` until that version exists, and the pre-commit hook (`npm install --package-lock-only`) fails with it. Lerna does not bump plain `peerDependencies` ranges (only `workspace:` ones, which npm does not support). So bump the versions without a commit (`npx lerna version prerelease --preid alpha --no-git-tag-version --no-push --yes`), set the peer range to the new version, run `npm install --package-lock-only`, commit with the usual release message, tag `vX.Y.Z`, push, and publish with `npx lerna publish from-package --yes --ignore-scripts`
- **Node:** `^20.19.0 || >=22.12.0` (`engines`). `postgres@4` (Postgres.js) is ESM-only, so the CommonJS build (`lib/index.cjs`) needs `require(esm)`, which Node enables by default from 20.19 and 22.12
- **Own types:** `JSONValue`, `QueryExecutor` and `OutboxTransaction` are defined in Hermes (`src/common/types.ts`); Postgres.js 4 no longer exports `JSONValue`

## Build System

### Technology Stack

- **Package Manager:** npm with workspaces
- **Monorepo Tool:** Lerna 10.x
- **Bundler:** Rollup with TypeScript plugin
- **TypeScript:** 6.0 (TypeScript 7 and ESLint 10 are blocked by the peer dependencies of `typescript-eslint` and `eslint-plugin-import`)
- **Node Version:** 26 LTS (`v26.13.0` in `.nvmrc`, used by all CI workflows; the examples have their own `.nvmrc`)
- **Tests:** Jest 30 with `ts-jest`

### Build Configuration

Each package uses Rollup to build both CommonJS and ESM outputs:

**Rollup Configuration (`rollup.config.js`):**

```javascript
{
  input: 'src/index.ts',
  output: [
    { file: 'lib/index.cjs', format: 'cjs', sourcemap: true },
    { file: 'lib/index.mjs', format: 'es', sourcemap: true }
  ],
  plugins: [
    json(),
    typescript({
      tsconfig: './tsconfig.build.json',
      outputToFilesystem: true,      // CRITICAL: Must be true to write .d.ts files
      declaration: true,               // CRITICAL: Enables .d.ts generation
      declarationDir: './lib',         // CRITICAL: Output directory for declarations
      noEmitOnError: true,
      sourceMap: true,
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
      },
    }),
    resolve({
      exportConditions: ['node', 'import', 'require', 'default'], // For proper package resolution
    }),
    commonjs(),
  ]
}
```

**IMPORTANT BUILD NOTES:**

1. **Declaration Files:** `outputToFilesystem: true` is REQUIRED. In v1.0.0-alpha.14, this was set to `false`, which caused the published package to contain ONLY `LICENSE` and `package.json` files - no actual code!
2. **Export Conditions:** The `exportConditions` in the resolve plugin is necessary for packages like `uuid@13.x` that use conditional exports
3. **Dependencies:** For hermes-postgresql, if fp-ts is not properly installed (missing `lib` directory), reinstall: `rm -rf packages/hermes-postgresql/node_modules/fp-ts && npm install -w packages/hermes-postgresql`

### Build Output

Each package generates:

- `lib/index.cjs` - CommonJS bundle
- `lib/index.mjs` - ES Module bundle
- `lib/index.d.ts` - TypeScript declarations (main entry)
- `lib/**/*.d.ts` - Additional type definitions
- `lib/**/*.map` - Source maps

### Available Build Scripts

```bash
# Build all packages
npm run build

# Build specific package
npm run build:core        # packages/hermes
npm run build:mongodb     # packages/hermes-mongodb
npm run build:mysql       # packages/hermes-mysql
npm run build:postgres    # packages/hermes-postgresql

# Clean build artifacts
npm run build:clear       # Removes all node_modules, lib, and cache files

# Individual package builds (with workspace flag)
npm run build -w packages/hermes
npm run build -w packages/hermes-mongodb
npm run build -w packages/hermes-postgresql

# Clean individual package
npm run clean -w packages/hermes
```

## Version Management

The project uses **Lerna** for synchronized version management across all packages.

### Versioning Commands

**CRITICAL:** Before deployment, you MUST run one of these version commands:

```bash
# Patch version (1.0.0 -> 1.0.1)
npm run version:patch

# Minor version (1.0.0 -> 1.1.0)
npm run version:minor

# Major version (1.0.0 -> 2.0.0)
npm run version:major

# Alpha prerelease (1.0.0 -> 1.0.1-alpha.0)
npm run version:alpha
```

**What these commands do:**

1. Bump version in all package.json files (root + all packages)
2. Update lerna.json with new version
3. Create a git commit with message: `chore(release): set \`package.json\` to X.X.X [skip ci]`
4. Create a git tag (e.g., `v1.0.0-alpha.15`)
5. Push commit and tag to GitHub

### Current Version

`lerna.json` is at `1.0.0-alpha.18`. Lerna bumps only the packages that changed since the last tag, so the packages can be at different versions (e.g. `hermes-postgresql` `1.0.0-alpha.18`, `hermes-mongodb` `1.0.0-alpha.16`).

## Deployment Process

### Manual Deployment (Local)

**Prerequisites:**

- NPM authentication token configured (`~/.npmrc` or environment variable)
- All changes committed to git
- Build passes successfully

**Steps:**

1. **Run tests** (ensure everything works):

   ```bash
   npm run test
   ```

2. **Build all packages** (verify build succeeds):

   ```bash
   npm run build
   ```

3. **Bump version** (REQUIRED - choose appropriate version):

   ```bash
   npm run version:alpha    # For alpha releases
   # OR
   npm run version:patch    # For patch releases
   # OR
   npm run version:minor    # For minor releases
   # OR
   npm run version:major    # For major releases
   ```

4. **Deploy to NPM**:

   ```bash
   npm run deploy
   ```

   **Alternative:** Use `npm run publish` which publishes from current package versions without git operations

### CI/CD Deployment (GitHub Actions)

**Workflow:** `.github/workflows/publish.yaml`

**Trigger:** Manual via GitHub Actions UI (workflow_dispatch)

**Process:**

1. Checkout code
2. Setup Node.js (version from `.nvmrc`)
3. Install dependencies with `npm ci`
4. Build all packages with `npm run build`
5. Configure git user
6. Publish to NPM with `npm run publish`

**To trigger:**

1. Go to GitHub repository
2. Navigate to Actions → "Publish to NPM"
3. Click "Run workflow"
4. Select branch and run

**Important:** The CI workflow uses `npm run publish` (which is `lerna publish from-package --no-git-tag-version --no-push --yes`), so you should run the versioning command BEFORE triggering the workflow.

### Publish Scripts Explained

```bash
# Lerna deploy - versions, tags, and publishes
npm run deploy
# Equivalent to: lerna publish --yes

# Lerna publish from package - publishes current versions without git operations
npm run publish
# Equivalent to: lerna publish from-package --no-git-tag-version --no-push --yes
```

## Testing

```bash
# Run all tests
npm run test

# Run tests for specific package
npm run test -w packages/hermes
npm run test -w packages/hermes-mongodb
npm run test -w packages/hermes-postgresql
```

## Linting and Formatting

```bash
# Lint all packages
npm run lint

# Fix linting issues
npm run lint:fix

# Format code with prettier
npm run fix:prettier

# Fix everything
npm run fix:all
```

## Documentation

The project uses **VitePress** for documentation.

```bash
# Serve docs locally
npm run docs:dev

# Build docs
npm run docs:build

# Preview built docs
npm run docs:preview

# Clear docs cache
npm run docs:clear
```

**Docs are published via:** `.github/workflows/publish-docs.yaml`

## Common Issues and Solutions

### Issue: Build fails with "Cannot find module 'fp-ts/lib/function.js'"

**Solution:**

```bash
rm -rf packages/hermes-postgresql/node_modules/fp-ts
npm install -w packages/hermes-postgresql
```

The fp-ts package needs the `lib` directory which sometimes doesn't install properly.

### Issue: Build fails with "Cannot find module 'uuid/dist/index.js'"

**Solution:** Already fixed in current rollup config with `exportConditions`. If you see this, ensure `resolve` plugin has:

```javascript
resolve({
  exportConditions: ['node', 'import', 'require', 'default'],
})
```

### Issue: Published package missing files (only LICENSE and package.json)

**Cause:** `outputToFilesystem: false` in rollup config prevents files from being written to disk.

**Solution:** Already fixed. Ensure rollup config has:

```javascript
typescript({
  outputToFilesystem: true,
  declaration: true,
  declarationDir: './lib',
  // ...
})
```

### Issue: TypeScript declaration files not generated

**Solution:** Same as above - ensure `outputToFilesystem: true` and `declaration: true` are set in rollup config.

### Issue: `lerna publish` / `npm run deploy` fails at the end with `lifecycle "publish" errored`

**Cause:** The root `package.json` has a script named `publish`. Lerna runs it as an npm lifecycle hook, so it starts a nested `lerna publish from-package`, which fails with `EUNCOMMIT` on the temporary `gitHead` change in the package's `package.json`.

**Solution:** Check the registry first: the package may already be published. `npm view` can show a cached state for a few minutes, so query `https://registry.npmjs.org/<package>` directly. Revert the `gitHead` change (`git checkout -- packages/*/package.json`) and, if needed, publish with `npx lerna publish from-package --yes --ignore-scripts`. Renaming the root `publish` script (and the CI workflow that calls it) fixes it for good.

### Issue: Tests fail with "Cannot find module 'jest-util'"

**Cause:** Since `ts-jest@29.4.15`, `jest-util` is an optional peer dependency, so npm does not hoist it anymore.

**Solution:** Keep `jest-util` in the root `devDependencies`, at the version matching `jest`.

### Issue: TypeScript 6 errors TS5101 (`baseUrl` is deprecated) or TS5011 (`rootDir` must be set)

**Solution:** Do not use `baseUrl`; `paths` are resolved relative to the `tsconfig` file. Set `rootDir` explicitly when `outDir` is set and the sources are in more than one directory (e.g. `src` and `test` in `tsconfig.jest.json`).

### Issue: Updating dependencies

Use `ncu --peer -w` (all workspaces and the root). Upgrade minor/patch versions first (`--target minor`), then majors one by one, running lint, build and the tests of all packages after each step. `ncu` 23 with `--peer` and `--filter` may still propose versions that break peer dependencies (e.g. TypeScript 7), so check what it proposes. `overrides` in the root `package.json` pin the `typescript-eslint` family; keep all of them at the same version.

### Issue: Tests need Docker

The PostgreSQL integration tests start PostgreSQL with Testcontainers, so Docker has to be running.

## Important Files

- `lerna.json` - Lerna configuration and current version
- `package.json` - Root package with scripts and workspace configuration
- `packages/*/rollup.config.js` - Build configuration for each package
- `packages/*/package.json` - Individual package configuration
- `.nvmrc` - Node.js version specification
- `tsconfig.json` - TypeScript configuration
- `.github/workflows/` - CI/CD pipelines

## Git Workflow

The project uses:

- **Husky** for git hooks
- **Commitlint** for conventional commits
- **Commit message format:** Follows conventional commits specification
- **Lerna commit messages:** `chore(release): set \`package.json\` to X.X.X [skip ci]`
- **Pre-commit hook:** runs `npm run lint`, `npm run lint:prettier` and `npm install --package-lock-only`, so a commit can change `package-lock.json`

## Development Workflow Summary

1. Make changes to code
2. Run tests: `npm run test`
3. Build locally: `npm run build`
4. Commit changes
5. Run version command: `npm run version:alpha` (or appropriate version)
6. Deploy: `npm run deploy` OR trigger GitHub Actions workflow

## Package Dependencies Graph

```
@chassisjs/hermes (core)
    ├── uuid@~14.0.3
    │
    ├── @chassisjs/hermes-mysql (depends on core)
    │   └── mysql2@~3.24.6
    │
    ├── @chassisjs/hermes-mongodb (depends on core)
    │   └── mongodb@>=6.8.0 <8 (peer)
    │
    └── @chassisjs/hermes-postgresql (depends on core)
        ├── fp-ts@~2.16.11
        ├── postgres@~4.0.0 (ESM-only)
        └── nodemon@~3.1.14
```

## Key Takeaways for Agents

1. **Always build before deploying** - Run `npm run build` to ensure all packages compile
2. **Always version before deploying** - Run `npm run version:X` to bump versions and create git tags
3. **Check the lib folder** - Verify that `packages/*/lib/` contains `.cjs`, `.mjs`, `.d.ts` files and source maps before publishing
4. **Rollup config is critical** - `outputToFilesystem: true` and `declaration: true` are REQUIRED
5. **Workspace commands** - Use `-w packages/<name>` to target specific packages
6. **Lerna manages versions** - Don't manually edit version numbers; use `npm run version:X` commands
7. **Git tags matter** - Lerna creates tags like `v1.0.0-alpha.15` which should be pushed to GitHub
8. **CI/CD requires version first** - The GitHub Actions workflow publishes existing versions, so version locally first
9. **Do not use comments over code unless it is absolutely needed**. Write JSDoc for live documentation.

## Support and Resources

- **Issues:** https://github.com/chassisjs/hermes/issues
- **Docs:** https://docs.hermesjs.tech
- **NPM:** https://www.npmjs.com/package/@chassisjs/hermes
- **Author:** Artur Wojnar <contact@arturwojnar.dev>

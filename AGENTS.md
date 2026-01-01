# Hermes Monorepo - Agent Guide

This document provides essential information about the Hermes monorepo structure, build system, and deployment process for AI agents and developers.

## Project Overview

Hermes is a Production-Ready TypeScript Outbox Pattern implementation distributed as a monorepo with multiple packages.

**Repository:** https://github.com/chassisjs/hermes  
**Documentation:** https://docs.hermesjs.tech  
**NPM Organization:** @chassisjs

## Monorepo Structure

This is a Lerna-managed monorepo with npm workspaces containing three main packages:

```
hermes/
├── packages/
│   ├── hermes/                    # Core package with base utilities
│   ├── hermes-mongodb/            # MongoDB implementation
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
- **Main Dependencies:** `uuid@~13.0.0`
- **Exports:** `./lib/index.cjs` (CommonJS), `./lib/index.mjs` (ESM)

#### @chassisjs/hermes-mongodb

- **Location:** `packages/hermes-mongodb`
- **Description:** MongoDB-specific Outbox Pattern implementation
- **Dependencies:** `whatwg-url@^15.1.0`
- **Peer Dependencies:** `@chassisjs/hermes@~1.0.0-alpha.15`, `mongodb@>= 6.8.0 || < 7.0.0`

#### @chassisjs/hermes-postgresql

- **Location:** `packages/hermes-postgresql`
- **Description:** PostgreSQL-specific Outbox Pattern implementation using logical replication
- **Dependencies:** `fp-ts@~2.16.11`, `postgres@~3.4.7`, `nodemon@~3.1.11`
- **Peer Dependencies:** `@chassisjs/hermes@~1.0.0-alpha.15`

## Build System

### Technology Stack

- **Package Manager:** npm with workspaces
- **Monorepo Tool:** Lerna 9.x
- **Bundler:** Rollup with TypeScript plugin
- **TypeScript:** 5.9.3
- **Node Version:** >=20.9.0 (defined in .nvmrc)

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

The monorepo is currently at version `1.0.0-alpha.15`.

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
    ├── uuid@~13.0.0
    │
    ├── @chassisjs/hermes-mongodb (depends on core)
    │   ├── whatwg-url@^15.1.0
    │   └── mongodb@>= 6.8.0 (peer)
    │
    └── @chassisjs/hermes-postgresql (depends on core)
        ├── fp-ts@~2.16.11
        ├── postgres@~3.4.7
        └── nodemon@~3.1.11
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

## Support and Resources

- **Issues:** https://github.com/chassisjs/hermes/issues
- **Docs:** https://docs.hermesjs.tech
- **NPM:** https://www.npmjs.com/package/@chassisjs/hermes
- **Author:** Artur Wojnar <contact@arturwojnar.dev>

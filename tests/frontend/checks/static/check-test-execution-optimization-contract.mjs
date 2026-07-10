#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const errors = []

function read(relativePath) {
  const absolutePath = path.join(root, relativePath)
  if (!existsSync(absolutePath)) {
    errors.push(`missing required file: ${relativePath}`)
    return ''
  }
  return readFileSync(absolutePath, 'utf8')
}

function requireIncludes(relativePath, needles) {
  const source = read(relativePath)
  for (const needle of needles) {
    if (!source.includes(needle)) {
      errors.push(`${relativePath} missing contract token: ${needle}`)
    }
  }
}

const vitestConfigs = readdirSync(path.join(root, 'src/frontend'))
  .filter((name) => /^vitest(?:\..+)?\.config\.ts$/u.test(name))
  .sort()

read('src/frontend/vitest.shared.mjs')
for (const configName of vitestConfigs) {
  requireIncludes(`src/frontend/${configName}`, [
    "from './vitest.shared.mjs'",
    'createVitestRuntimeOptions('
  ])
}

const packageJson = JSON.parse(read('src/frontend/package.json') || '{}')
for (const scriptName of [
  'test:unit:fast',
  'test:unit:coverage',
  'coverage:unit-core',
  'coverage:public-renderers',
  'coverage:bootstrap-hydration',
  'coverage:workers',
  'coverage:wasm-bridges',
  'coverage:adapters-binary',
  'coverage:composables-state'
]) {
  const command = String(packageJson.scripts?.[scriptName] ?? '')
  if (!command.includes('check:public-page-manifest-sync')) {
    errors.push(`${scriptName} must validate the public page manifest before tests`)
  }
  if (command.includes('generate:public-page-manifest')) {
    errors.push(`${scriptName} must not generate tracked public page manifest sources`)
  }
}

for (const relativePath of [
  'tests/frontend/support/fixture-paths.mjs',
  'tools/test/run-once.mjs',
  'tools/test/run-command-manifest.mjs',
  'tests/frontend/checks/static/manifest.json',
  'tests/frontend/checks/runtime/manifest.json',
  'tests/backend/xunit.runner.json',
  'tests/backend/Fixtures/postgres-test-collections.json',
  'tools/check-postgres-test-collections.mjs',
  'tools/test/resolve-dotnet-test-processors.mjs',
  'tools/test/lanes/backend-build-governance.sh',
  'tools/test/lanes/backend-unit.sh',
  'tools/test/lanes/frontend-property-model-perf.sh'
]) {
  read(relativePath)
}

requireIncludes('tests/frontend/fixtures/discover-playwright-fixtures.mjs', [
  'resolvePublicFixtureFile',
  'resolveFixtureAssetDirectory'
])
requireIncludes('tests/frontend/fixtures/prepare-playwright-sessions.mjs', [
  'resolveSessionFixtureDirectory'
])
requireIncludes('tests/frontend/support/public-fixtures.mjs', [
  'resolvePublicFixtureFile'
])
requireIncludes('tests/frontend/checks/resilience/check-runtime-resilience.mjs', [
  'readPublicFixtures'
])
for (const relativePath of [
  'tests/frontend/support/public-fixtures.mjs',
  'tests/frontend/checks/resilience/check-runtime-resilience.mjs'
]) {
  if (read(relativePath).includes('.playwright-fixtures.aeds')) {
    errors.push(`${relativePath} must not fall back to tracked Playwright fixtures`)
  }
}
requireIncludes('tests/frontend/support/playwright/routeAuditFixtures.ts', [
  'resolvePublicFixtureFile'
])
requireIncludes('tests/frontend/support/playwright/testSession.ts', [
  'resolveSessionFixtureFile'
])
requireIncludes('tests/frontend/support/session-fixtures.mjs', [
  'resolveAuthFixtureDirectory'
])
requireIncludes('tests/frontend/e2e/acceptance/admin-console.spec.ts', [
  'resolveAuthFixtureManifest'
])
requireIncludes('src/backend/Modules/Endpoints/LocalAuthFixtureEndpoints.cs', [
  'FSUSBLOG_FIXTURE_ROOT',
  'FSUSBLOG_TEST_NAMESPACE'
])

requireIncludes('.gitignore', ['/package-lock.json'])
requireIncludes('tools/test/legacy-test.sh', [
  'run_once_command',
  'run_frontend_fast_build_lane() {\n  ensure_wasm_once',
  'run_frontend_runtime_contracts_lane() {\n  ensure_wasm_once',
  'run-command-manifest.mjs',
  'resolve-dotnet-test-processors.mjs',
  '--no-build',
  'run_backend_build_governance_lane',
  'run_backend_unit_lane',
  'run_backend_fast_summary_lane',
  'run_frontend_property_model_perf_lane'
])
requireIncludes('tools/frontend/build.mjs', [
  'FSUSBLOG_VALIDATE_GENERATED_ONLY',
  "['--check']",
  'FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC=1',
  'await mkdir(backendWebRoot, { recursive: true })'
])
const frontendBuildSource = read('tools/frontend/build.mjs')
if (frontendBuildSource.includes('skipping backend wwwroot sync because target is missing')) {
  errors.push('tools/frontend/build.mjs must create and sync a missing backend wwwroot by default')
}

requireIncludes('tools/contracts/export-openapi.sh', [
  '--update-snapshot',
  'cmp -s "$OUT_FILE" "$SNAPSHOT_FILE"'
])
if (read('tools/test/lanes/rights-v3-test-matrix.sh').includes('generate:public-page-manifest')) {
  errors.push('rights-v3 test lane must validate, not regenerate, the tracked public page manifest')
}
if (read('.github/workflows/quality-gate.yml').includes('docs --out docs/testing.generated.md')) {
  errors.push('quality-gate tests must not rewrite tracked docs/testing.generated.md')
}

const legacyTestSource = read('tools/test/legacy-test.sh')
const frontendBuildFingerprintStart = legacyTestSource.indexOf('run_frontend_fast_build_group()')
const frontendBuildFingerprintEnd = legacyTestSource.indexOf('write_frontend_split_summary()', frontendBuildFingerprintStart)
const frontendBuildFingerprint = legacyTestSource.slice(frontendBuildFingerprintStart, frontendBuildFingerprintEnd)
for (const token of [
  'for tsconfig in "$CLIENT_DIR"/tsconfig*.json',
  'fingerprint_args+=(--path "${tsconfig#"$ROOT_DIR/"}")'
]) {
  if (!frontendBuildFingerprint.includes(token)) {
    errors.push(`frontend fast build fingerprint does not cover existing tsconfig*.json files: ${token}`)
  }
}

const authFingerprintStart = legacyTestSource.indexOf('prepare_auth_fixtures_once()')
const authFingerprintEnd = legacyTestSource.indexOf('prepare_public_fixtures_once()', authFingerprintStart)
const authFingerprint = legacyTestSource.slice(authFingerprintStart, authFingerprintEnd)
for (const secretName of [
  'Jwt__SecretKey',
  'JWT_SECRET',
  'FSUSBLOG_JWT_SECRET',
  'FSUSBLOG_TEST_SESSION_SECRET',
  'AnonymousCredentialIssuer__SubjectHashPepper',
  'FSUSBLOG_DEV_ANONYMOUS_SUBJECT_HASH_PEPPER'
]) {
  if (!authFingerprint.includes(`--secret-env ${secretName}`)) {
    errors.push(`auth fixture fingerprint must hash ${secretName} through --secret-env`)
  }
  if (authFingerprint.includes(`--value "\${${secretName}`)) {
    errors.push(`auth fixture fingerprint must not pass raw ${secretName} through argv`)
  }
}
requireIncludes('tools/test/run-once.mjs', [
  "name === 'secret-env'",
  "createHash('sha256').update(String(env[name] ?? '')).digest('hex')"
])
requireIncludes('tools/bootstrap-acceptance-env.sh', [
  'tools/frontend',
  'FSUSBLOG_FIXTURE_SERVICE_GENERATION',
  'source "$ROOT_DIR/tools/test/lanes/_legacy.sh"',
  'prepare_runtime_fixtures_once',
  'run_frontend_fast_build_group',
  'reusing frontend release bundle produced by this scheduler run'
])
requireIncludes('tools/test/lanes/static-governance.sh', [
  'run-test-matrix.mjs" evidence-plan --out .tmp/release-evidence/test-plan.json'
])
requireIncludes('tools/run-test-matrix.mjs', [
  "evidencePlan(matrix, '.tmp/release-evidence/test-plan.json')"
])
requireIncludes('tools/test/lanes/visual-public-playwright.sh', [
  'write_visual_playwright_skip_evidence public'
])
requireIncludes('tools/test/lanes/visual-console-playwright.sh', [
  'write_visual_playwright_skip_evidence console'
])
const bootstrapSource = read('tools/bootstrap-acceptance-env.sh')
for (const duplicateFixtureCommand of ['npm run prepare:binary-smoke:auth-users', 'npm run prepare:playwright:fixtures']) {
  if (bootstrapSource.includes(duplicateFixtureCommand)) {
    errors.push(`bootstrap must use shared run-once fixture helpers instead of direct command: ${duplicateFixtureCommand}`)
  }
}
requireIncludes('tools/coverage/collect-backend-coverage.sh', [
  'ensure_backend_filtered_build',
  'configure_dotnet_test_processors',
  '--filter "$BACKEND_ORDINARY_TEST_FILTER"',
  'ORDINARY_RESULTS_DIR="$RESULTS_DIR/ordinary"',
  'rm -rf "$ORDINARY_RESULTS_DIR" "$SUMMARY_DIR"',
  'EXPECTED_RESULT_LANES=(ordinary special-api-integration special-auth-state-machine special-concurrency special-property special-golden)',
  'find "$RESULTS_DIR" -mindepth 1 -maxdepth 1 -print0',
  '--no-build'
])
const ordinaryBackendFilter = 'Category!=Integration&Category!=ApiIntegration&Category!=Concurrency&Category!=Performance&Category!=Property&Category!=GoldenContract&Category!=SecurityStateMachine'
if (!legacyTestSource.includes(`BACKEND_ORDINARY_TEST_FILTER="\${FSUSBLOG_BACKEND_ORDINARY_TEST_FILTER:-${ordinaryBackendFilter}}"`)) {
  errors.push('backend ordinary and coverage lanes must share a fail-closed filter that excludes every dedicated special suite')
}
if (!legacyTestSource.includes('run_backend_dotnet_filter_only "$BACKEND_ORDINARY_TEST_FILTER"')) {
  errors.push('backend ordinary lane must consume BACKEND_ORDINARY_TEST_FILTER')
}
if (!legacyTestSource.includes("FsusBlog.Server.Tests.dll|tests/backend/bin/Debug/net10.0/FsusBlog.Server.Tests.deps.json|tests/backend/bin/Debug/net10.0/FsusBlog.Server.Tests.runtimeconfig.json")) {
  errors.push('backend shared build cache must require the test DLL and both testhost companion files')
}
for (const [lane, filter] of [
  ['api-integration', 'Category=ApiIntegration'],
  ['auth-state-machine', 'Category=SecurityStateMachine'],
  ['concurrency', 'Category=Concurrency'],
  ['property', 'Category=Property'],
  ['golden', 'Category=GoldenContract']
]) {
  if (!legacyTestSource.includes(`run_backend_dotnet_filter_with_coverage ${lane} "${filter}"`)) {
    errors.push(`backend dedicated ${lane} suite must execute exactly once while producing mergeable coverage`)
  }
}
requireIncludes('tests/backend/FsusBlog.Server.Tests.csproj', [
  'xunit.runner.json',
  'CopyToOutputDirectory'
])

const postgresManifest = read('tests/backend/Fixtures/postgres-test-collections.json')
if (postgresManifest) {
  try {
    const parsed = JSON.parse(postgresManifest)
    const entries = parsed.collections?.flatMap((collection) => collection.tests ?? []) ?? []
    if (parsed.schema !== 'fsusblog.postgres-test-collections.v1') {
      errors.push('postgres test collection manifest schema mismatch')
    }
    if (parsed.collections?.length !== 2) {
      errors.push('postgres test collection manifest must declare exactly two collections')
    }
    if (entries.length !== 28) {
      errors.push(`postgres test collection manifest must classify 28 classes, got ${entries.length}`)
    }
  } catch (error) {
    errors.push(`postgres test collection manifest is invalid JSON: ${error.message}`)
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[test-execution-contract] ${error}`)
  process.exit(1)
}

console.log(`[test-execution-contract] ok vitestConfigs=${vitestConfigs.length}`)

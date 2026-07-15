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

function requireSectionIncludes(relativePath, startToken, endToken, needles) {
  const source = read(relativePath)
  const start = source.indexOf(startToken)
  if (start < 0) {
    errors.push(`${relativePath} missing contract section: ${startToken}`)
    return
  }
  const end = endToken === null ? source.length : source.indexOf(endToken, start + startToken.length)
  if (end < 0) {
    errors.push(`${relativePath} missing contract section boundary: ${endToken}`)
    return
  }
  const section = source.slice(start, end)
  for (const needle of needles) {
    if (!section.includes(needle)) {
      errors.push(`${relativePath} section ${startToken} missing contract token: ${needle}`)
    }
  }
}

const vitestConfigs = readdirSync(path.join(root, 'src/frontend'))
  .filter((name) => /^vitest(?:\..+)?\.config\.ts$/u.test(name))
  .sort()

read('src/frontend/vitest.shared.mjs')
for (const configName of vitestConfigs) {
  if (configName === 'vitest.production.config.ts') {
    requireIncludes(`src/frontend/${configName}`, [
      "from './vitest.config'",
      "from './vitest.property.config'",
      "from './vitest.model.config'",
      "from './vitest.perf.config'",
      "from './vitest.shared.mjs'",
      "createVitestRuntimeOptions('production')",
      'deps: { optimizer: { ssr: { enabled: true } } }',
      'projects:'
    ])
  } else {
    requireIncludes(`src/frontend/${configName}`, [
      "from './vitest.shared.mjs'",
      'createVitestRuntimeOptions('
    ])
  }
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
  'resolveSessionFixtureDirectory',
  'resolveWorkerTestSession',
  'Promise.all(sessions.map',
  "import { spawn } from 'node:child_process'",
  'process.env.FSUSBLOG_DEBUG_BACKEND_URL',
  'process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME',
  'process.env.FSUSBLOG_REDIS_CONTAINER_NAME',
  'FSUSBLOG_BASE_URL: backendBaseUrl',
  'FSUSBLOG_PG_CONTAINER: pgContainer',
  'FSUSBLOG_REDIS_CONTAINER: redisContainer',
  'FSUSBLOG_USER_USERNAME: `binaryuser-${session}`',
  'FSUSBLOG_ADMIN_USERNAME: `binaryadmin-${session}`',
  'FSUSBLOG_DEVICE_FP: `${session}-playwright`',
  "assertSafeFixtureContainer(redisContainer, 'FSUSBLOG_REDIS_CONTAINER')"
])
if (read('tests/frontend/fixtures/prepare-playwright-sessions.mjs').includes('spawnSync')) {
  errors.push('prepare-playwright-sessions.mjs must not serialize isolated session workers with spawnSync')
}
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
  'resolveSessionFixtureFile',
  'resolveWorkerTestSession'
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
  'run_frontend_property_model_perf_lane',
  '--value "session-prefix=${FSUSBLOG_TEST_SESSION_PREFIX:-pw}"'
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
  'cmp -s "$OUT_FILE" "$SNAPSHOT_FILE"',
  'generate-cross-stack-contract.mjs',
  'OpenApiDocumentsDirectory="$RUNTIME_OUT_DIR"'
])
requireIncludes('src/frontend/wasm/build.sh', [
  'WASM_SOURCE_DIR="${WASM_ROOT}"',
  'WASM_POW_SOURCE_DIR="${WASM_ROOT}/pow"',
  '--check-source-paths',
  'emcmake "${CMAKE_BIN}" --fresh "${WASM_SOURCE_DIR}"',
  'emcmake "${CMAKE_BIN}" --fresh "${WASM_POW_SOURCE_DIR}"',
  '--sort=name',
  '--mtime=@0',
  '--numeric-owner',
  'gzip -n -9'
])
requireIncludes('tools/test/bundles/bundle-steps.mjs', [
  "step('cross-stack', 'FSUSBLOG_OPENAPI_BUILD=0 tools/test/legacy-test.sh cross-stack-contract static'",
  "step('cross-stack-runtime', 'tools/test/legacy-test.sh cross-stack-contract runtime'",
  'for (const resource of record.exclusiveResources ?? [])',
  'const conflictingResource = resources.find((resource) => resourceOwners.has(resource))',
  "holderState: 'admission-wave'",
  'exclusiveResource=${wait.resource}',
  'heldBy=${wait.heldBy}'
])
const bundleStepSource = read('tools/test/bundles/bundle-steps.mjs')
if (bundleStepSource.includes('record.exclusive) return []')) {
  errors.push('bundle weighted DAG must not restore global serialization for unrelated exclusive resource names')
}
requireSectionIncludes('tools/test/bundles/bundle-steps.mjs', "step('ux-risk-matrix'", "step('runtime-integration'", [
  "dependsOn: ['release-public']",
  'resources: { cpuWeight: 4, memoryWeight: 8, minCpuUnits: 1, countedResources: chromiumLane }'
])
requireIncludes('tools/test/bundles/bundle-steps.mjs', [
  'resolveChromiumLaneCapacity',
  'blockedByCountedResources',
  'countedResource=${wait.resource}'
])
requireIncludes('tools/test/bundles/run-bundle.mjs', [
  'createBrowserLaneProxySet',
  'FSUSBLOG_TEST_SESSION_PREFIX',
  'FSUSBLOG_FIXTURE_ROOT',
  'PLAYWRIGHT_OUTPUT_DIR',
  "schema: 'fsusblog.runtime-browser-admission.v1'",
  'blockedBySlotMs'
])
requireIncludes('tools/test/run-command-manifest.mjs', [
  'export function resolveNestedManifestMemoryGiBPerWorker',
  'inheritedMemoryGiB / workers',
  'orchestrationMemoryGiBPerWorker: resolveNestedManifestMemoryGiBPerWorker({ env })'
])
requireIncludes('tools/test/lanes/cross-browser-smoke.sh', [
  'PLAYWRIGHT_OUTPUT_DIR="${PLAYWRIGHT_OUTPUT_DIR:-test-results/playwright/cross-browser}"'
])
requireSectionIncludes('tools/test/bundles/run-bundle.mjs', "commandStep('privacy-zk-contract-prebuild',", "commandStep('privacy-zk-contract',", [
  "commandStep('privacy-zk-contract-prebuild', 'tools/test/lanes/privacy-zk-comment-matrix.sh contract-prebuild'",
  "dependsOn: ['frontend-early-test-capacity-ready']",
  'resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }'
])
requireSectionIncludes('tools/test/bundles/run-bundle.mjs', "commandStep('privacy-zk-contract',", "staticStageStep('postbuild',", [
  "commandStep('privacy-zk-contract', 'tools/test/lanes/privacy-zk-comment-matrix.sh contract-postbuild'",
  "dependsOn: ['frontend-build-ready', 'privacy-zk-contract-prebuild']",
  'resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }'
])
requireSectionIncludes('tools/test/bundles/run-bundle.mjs', "await executeStep(staticStageStep('blocking-prebuild',", 'const step =', [
  "await executeStep(staticStageStep('blocking-prebuild'",
  'resources: { cpuWeight: 1, memoryWeight: 0.5, minCpuUnits: 1 }'
])
requireIncludes('tools/test/bundles/run-bundle.mjs', [
  'function bundleDagCapacityForSteps(steps)',
  'const stepExclusiveResources = steps.flatMap((entry) => entry.resources?.exclusiveResources ?? [])',
  '() => bundleDagCapacityForSteps(steps)',
  'dotnet restore tests/FsusBlog.ProductionBackend.slnx --locked-mode'
])
requireSectionIncludes('tools/test/bundles/run-bundle.mjs', "staticStageStep('concurrent',", "commandStep('static-governance-concurrent'", [
  "staticStageStep('concurrent'",
  "exclusiveResources: ['generated-contracts']"
])
requireSectionIncludes('tools/test/bundles/run-bundle.mjs', "const step = commandStep('vitest-production-projects'", 'const frontendDagResults', [
  "dependsOn: ['frontend-early-test-capacity-ready']",
  'minCpuUnits: resolvedFrontendVitestAdmissionFloor()'
])
if (read('tools/test/bundles/run-bundle.mjs').includes('FSUSBLOG_VITEST_TARGET_WORKERS')) {
  errors.push('production frontend bundle must derive Vitest workers from the live admitted step grant')
}
requireSectionIncludes('tools/test/bundles/bundle-steps.mjs', "step('privacy-zk-project-functional'", "step('coverage-merge'", [
  'tools/test/lanes/privacy-zk-comment-matrix.sh project-functional',
  'resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }'
])
const bundleStepsSource = read('tools/test/bundles/bundle-steps.mjs')
if (bundleStepsSource.includes("step('privacy-zk'")) {
  errors.push('legacy monolithic privacy-zk step must not return to runtime-browser')
}
requireSectionIncludes('tools/test/bundles/bundle-steps.mjs', 'export function performanceSteps()', null, [
  "const benchmarkResources = { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['benchmark-window'] }",
  "step('privacy-zk-performance-ready'",
  "step('privacy-zk-benchmark'",
  "step('privacy-zk-finalize'"
])
requireIncludes('tests/frontend/checks/runtime/zero-auth-probe-matrix.mjs', [
  'process.env.FSUSBLOG_DEBUG_FRONTEND_URL',
  "page.locator('a[href=\"/about\"]:visible').first()",
  "waitFor({ state: 'visible', timeout: 0 })"
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
  "createHash('sha256').update(String(env[name] ?? '')).digest('hex')",
  "fsusblog.physical-execution-receipt.v3",
  'runBoundExecution',
  'physicalExecutionReceiptDigest',
  'avoidedChildStartups'
])
requireIncludes('tools/test/run-deterministic-command.mjs', [
  'FSUSBLOG_TEST_RUN_ID',
  'inputDigest',
  'environmentDigest',
  'worktreeFingerprint',
  'runBoundExecution'
])
requireIncludes('tools/test/run-matrix-governance-once.sh', [
  '--key matrix-governance',
  '--test-id matrix-validate',
  '--test-id matrix-preflight',
  '--test-id matrix-evidence-plan'
])
requireIncludes('tools/bootstrap-acceptance-env.sh', [
  'tools/frontend',
  'FSUSBLOG_FIXTURE_SERVICE_GENERATION',
  'source "$ROOT_DIR/tools/test/lanes/_legacy.sh"',
  'run_parallel "bootstrap-runtime-fixtures"',
  '"auth-fixtures::prepare_auth_fixtures_once"',
  '"public-fixtures::prepare_public_fixtures_once"',
  'run_frontend_fast_build_group',
  'reusing digest-verified frontend release bundle produced by this build-static scheduler run'
])
requireIncludes('tools/test/lanes/static-governance.sh', [
  'run-matrix-governance-once.sh" static-evidence-plan',
  'run-matrix-governance-once.sh" static-matrix-contract',
  'run-matrix-governance-once.sh" static-matrix-schema'
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
if (!legacyTestSource.includes('FSUSBLOG_PRODUCTION_BUILD_ROOT/dotnet/FsusBlog.Server.Tests/bin/Debug/net10.0')
  || !legacyTestSource.includes('$debug_output_dir/FsusBlog.Server.Tests.dll|$debug_output_dir/FsusBlog.Server.Tests.deps.json|$debug_output_dir/FsusBlog.Server.Tests.runtimeconfig.json')) {
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
    if (entries.length < 28) {
      errors.push(`postgres test collection manifest must retain at least 28 classified classes, got ${entries.length}`)
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

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/perf-regression.sh'), 'utf8')
const legacy = fs.readFileSync(path.join(root, 'tools/test/lanes/_suite-support.sh'), 'utf8')
const ensureBuild = fs.readFileSync(path.join(root, 'tools/test/ensure-benchmark-release-build.sh'), 'utf8')
const releaseLock = fs.readFileSync(path.join(root, 'tools/test/run-with-dotnet-release-build-lock.sh'), 'utf8')
const frameCost = fs.readFileSync(path.join(root, 'tools/test/lanes/aeds-frame-cost.sh'), 'utf8')
const compression = fs.readFileSync(path.join(root, 'tools/test/lanes/aeds-compression-profile.sh'), 'utf8')
const benchmarkRegression = fs.readFileSync(path.join(root, 'tools/test/lanes/backend-benchmark-regression.sh'), 'utf8')
const productionBuild = fs.readFileSync(path.join(root, 'tools/test/lanes/production-build-artifacts.sh'), 'utf8')

function shellFunction(source, name, nextName) {
  const start = source.indexOf(`${name}() {`)
  const end = source.indexOf(`\n${nextName}() {`, start)
  assert.ok(start >= 0 && end > start, `unable to isolate ${name}`)
  return source.slice(start, end)
}

test('backend perf prepares Release readers in parallel before opening an isolated native P99 window', () => {
  assert.match(lane, /export FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release/u)
  assert.match(lane, /RunCollectParallel backend-perf-preparation/u)
  assert.match(lane, /release-readiness RunBackendPerfReleaseReadiness/u)
  assert.match(lane, /governance RunBackendPerfGovernanceOnly/u)
  assert.match(lane, /RunBackendPerfReleaseReadiness\(\)[\s\S]*?RunBackendPerfReadinessBuildOnly \|\| return \$\?[\s\S]*?EnsureBackendFilteredBuild/u)
  assert.ok(
    lane.indexOf('FinishCollect') < lane.indexOf('RunCollect native-p99 RunBackendPerfNativeP99Only'),
    'all compiler/readiness work must settle before native P99 starts'
  )
})

test('backend perf uses the shared run-bound Release build producer', () => {
  const readiness = shellFunction(
    legacy,
    'RunBackendPerfReadinessBuildOnly',
    'RunBackendMutationWithConfig'
  )
  assert.match(readiness, /verify-benchmark-build-ready\.mjs/u)
  assert.match(readiness, /ensure-benchmark-release-build\.sh/u)
  assert.doesNotMatch(readiness, /dotnet build/u)
})

test('all logical benchmark consumers share one warning-free build and remain no-build readers', () => {
  assert.match(ensureBuild, /--key backend-benchmark-release-build/u)
  assert.match(ensureBuild, /--require-output "\$BENCHMARK_DLL"/u)
  assert.match(ensureBuild, /--require-output "\$BENCHMARK_DEPS"/u)
  assert.match(ensureBuild, /--require-output "\$BENCHMARK_RUNTIMECONFIG"/u)
  assert.match(ensureBuild, /FSUSBLOG_PRODUCTION_BUILD_ROOT\/dotnet\/FsusBlog\.Core\.Benchmarks\/bin\/Release\/net10\.0/u)
  assert.match(ensureBuild, /FSUSBLOG_TIER_CPU_UNITS/u)
  assert.match(ensureBuild, /-c Release --no-incremental -warnaserror -v minimal/u)
  assert.match(ensureBuild, /run-with-dotnet-release-build-lock\.sh/u)
  assert.doesNotMatch(
    ensureBuild,
    /--path global\.json/u,
    'an optional repository SDK pin cannot be a required fingerprint input'
  )

  for (const source of [frameCost, compression]) {
    assert.match(source, /ensure-benchmark-release-build\.sh/u)
    assert.match(source, /--no-build/u)
    assert.match(source, /--no-restore/u)
    assert.doesNotMatch(source, /dotnet_args/u)
  }
  assert.match(benchmarkRegression, /ensure-benchmark-release-build\.sh/u)
  assert.doesNotMatch(benchmarkRegression, /dotnet build/u)
})

test('shared backend producers bind scheduler source identity without hashing runtime-mutated source directories', () => {
  const filteredBuild = shellFunction(
    legacy,
    'EnsureBackendFilteredBuild',
    'BackendTrxFile'
  )
  const scheduledStart = filteredBuild.indexOf('if [[ -n "${FSUSBLOG_TEST_SOURCE_COMMIT:-}"')
  const scheduledEnd = filteredBuild.indexOf('\n    else', scheduledStart)
  const scheduledBranch = filteredBuild.slice(scheduledStart, scheduledEnd)
  assert.ok(scheduledStart >= 0 && scheduledEnd > scheduledStart)
  assert.match(scheduledBranch, /source-commit=\$\{FSUSBLOG_TEST_SOURCE_COMMIT\}/u)
  assert.match(scheduledBranch, /source-fingerprint=\$\{FSUSBLOG_TEST_SOURCE_FINGERPRINT\}/u)
  assert.match(scheduledBranch, /dotnet-sdk=\$dotnetSdkVersion/u)
  assert.doesNotMatch(scheduledBranch, /--path (?:src\/backend|src\/core|src\/shared|tests\/backend)/u)
  assert.match(filteredBuild.slice(scheduledEnd), /--path src\/backend/u)
  assert.match(filteredBuild.slice(scheduledEnd), /--path tools\/architecture\/FsusBlog\.DiLifetimeAnalyzer/u)
  assert.match(filteredBuild.slice(scheduledEnd), /--path tools\/security\/ZkCommentV2MclFixture/u)
  assert.match(filteredBuild, /configuration="\$\(BackendTestConfiguration\)" \|\| return \$\?/u)
  assert.match(filteredBuild, /ConfigureDotnetBuildParallelism \|\| return \$\?/u)
  assert.match(filteredBuild, /fingerprint="\$\(TestInputFingerprint[\s\S]*?\)" \|\| return \$\?/u)
  assert.match(filteredBuild, /buildTarget="\$SERVER_TEST_PROJ"/u)
  assert.match(filteredBuild, /buildTarget="\$ROOT_DIR\/FsusBlog\.slnx"/u)
  assert.match(filteredBuild, /dotnet build "\$buildTarget"/u)
  assert.match(filteredBuild, /outputContract="\$debugOutputDir\|\$debugServerOutputDir\|\$debugFixtureOutputDir"/u)
  assert.match(filteredBuild, /outputContract="\$releaseOutputDir"/u)
  assert.doesNotMatch(filteredBuild, /FSUSBLOG_LOCAL_PROFILE[\s\S]*?return/u)
  assert.match(
    filteredBuild,
    /if \[\[ "\$configuration" == "Release" \]\]; then[\s\S]*?run-with-dotnet-release-build-lock\.sh[\s\S]*?fi/u
  )

  const benchmarkScheduledStart = ensureBuild.indexOf('if [[ -n "${FSUSBLOG_TEST_SOURCE_COMMIT:-}"')
  const benchmarkScheduledEnd = ensureBuild.indexOf('\nelse', benchmarkScheduledStart)
  const benchmarkScheduledBranch = ensureBuild.slice(benchmarkScheduledStart, benchmarkScheduledEnd)
  assert.ok(benchmarkScheduledStart >= 0 && benchmarkScheduledEnd > benchmarkScheduledStart)
  assert.match(benchmarkScheduledBranch, /source-commit=\$\{FSUSBLOG_TEST_SOURCE_COMMIT\}/u)
  assert.match(benchmarkScheduledBranch, /source-fingerprint=\$\{FSUSBLOG_TEST_SOURCE_FINGERPRINT\}/u)
  assert.doesNotMatch(benchmarkScheduledBranch, /--path (?:benchmarks\/core|src\/backend|src\/core|src\/shared)/u)
  assert.match(ensureBuild.slice(benchmarkScheduledEnd), /--path benchmarks\/core/u)
  assert.match(ensureBuild.slice(benchmarkScheduledEnd), /--path tools\/architecture\/FsusBlog\.DiLifetimeAnalyzer/u)
})

test('dynamic .NET grant resolvers propagate failure even inside collector conditionals', () => {
  assert.match(
    legacy,
    /mode="\$\("\$\{FSUSBLOG_NODE:-node\}" "\$ROOT_DIR\/tools\/test\/resolve-dotnet-build-parallelism\.mjs"\)" \|\| return \$\?/u
  )
  assert.match(
    legacy,
    /DOTNET_PROCESSOR_COUNT="\$\("\$\{FSUSBLOG_NODE:-node\}" "\$ROOT_DIR\/tools\/test\/resolve-dotnet-test-processors\.mjs"\)" \|\| return \$\?/u
  )
})

test('production artifact builds share the same run-bound Release writer lock', () => {
  assert.match(releaseLock, /FSUSBLOG_PRODUCTION_BUILD_ROOT/u)
  assert.match(releaseLock, /flock --exclusive --close/u)
  assert.ok(
    (productionBuild.match(/run-with-dotnet-release-build-lock\.sh/gu) ?? []).length >= 3,
    'restore, server build and test build must share the Release writer lock'
  )
})

test('Release writer lock is not inherited by a detached compiler descendant', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-lock-'))
  const executable = path.join(root, 'tools/test/run-with-dotnet-release-build-lock.sh')
  const env = {
    ...process.env,
    FSUSBLOG_PRODUCTION_BUILD_ROOT: path.join(directory, 'build')
  }
  try {
    const first = spawnSync(executable, [
      'bash',
      '-c',
      'sleep 2 >/dev/null 2>&1 &'
    ], { cwd: root, env, encoding: 'utf8' })
    assert.equal(first.status, 0, first.stderr || first.stdout)

    const startedAt = Date.now()
    const second = spawnSync(executable, ['true'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(second.status, 0, second.stderr || second.stdout)
    assert.ok(Date.now() - startedAt < 1_000, 'detached child retained the Release build lock')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('backend perf native P99 consumes the fresh Release test assembly without a duplicate Debug build', () => {
  assert.match(legacy, /BackendTestConfiguration\(\)[\s\S]*?FSUSBLOG_BACKEND_TEST_CONFIGURATION:-Debug/u)
  assert.match(legacy, /Debug \| Release/u)
  assert.match(legacy, /releaseOutputDir="\$\{FSUSBLOG_PRODUCTION_BUILD_ROOT:\+\$FSUSBLOG_PRODUCTION_BUILD_ROOT\/dotnet\/FsusBlog\.Server\.Tests\/bin\/Release\/net10\.0\}"/u)
  assert.match(legacy, /debugServerOutputDir="\$\{FSUSBLOG_PRODUCTION_BUILD_ROOT:\+\$FSUSBLOG_PRODUCTION_BUILD_ROOT\/dotnet\/FsusBlog\.Server\/bin\/Debug\/net10\.0\}"/u)
  assert.match(legacy, /debugFixtureOutputDir="\$\{FSUSBLOG_PRODUCTION_BUILD_ROOT:\+\$FSUSBLOG_PRODUCTION_BUILD_ROOT\/dotnet\/FsusBlog\.ZkCommentV2MclFixture\/bin\/Debug\/net10\.0\}"/u)
  assert.match(legacy, /dotnet test "\$SERVER_TEST_PROJ" -c "\$configuration" -v minimal --no-build --no-restore/u)
})

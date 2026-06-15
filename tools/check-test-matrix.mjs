#!/usr/bin/env node
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))

function requireFileIncludes(file, expected, message) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  if (!text.includes(expected)) {
    console.error(`[test-matrix] ${message}`)
    process.exit(1)
  }
}

function requireCondition(condition, message) {
  if (!condition) {
    console.error(`[test-matrix] ${message}`)
    process.exit(1)
  }
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
}

function run(args) {
  const result = spawnSync('node', ['tools/run-test-matrix.mjs', ...args], {
    cwd: root,
    encoding: 'utf8'
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function output(args) {
  const result = spawnSync('node', ['tools/run-test-matrix.mjs', ...args], {
    cwd: root,
    encoding: 'utf8'
  })
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout
}

function runTestSh(args) {
  if (process.platform === 'win32') {
    const script = fs.readFileSync(path.join(root, 'tools/test.sh'), 'utf8')
    if (!script.includes('tools/run-test-matrix.mjs') || !script.includes('ci-plan --format github-actions')) {
      console.error('[test-matrix] tools/test.sh does not delegate ci-plan to run-test-matrix')
      process.exit(1)
    }
    if (args[0] === 'ci-plan') {
      run(['ci-plan', '--format', 'github-actions', ...args.slice(1)])
      return
    }
  }

  const script = 'tools/test.sh'
  const result = spawnSync('bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8'
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(['preflight'])
run(['validate'])
run(['plan', 'production'])
{
  const fastBackendPlan = output(['ci-job', 'fast-backend', '--plan-only'])
  process.stdout.write(fastBackendPlan)
  if (!fastBackendPlan.includes('scheduler: parallel')) {
    console.error('[test-matrix] fast-backend ci-job plan must advertise parallel scheduler')
    process.exit(1)
  }
  if (!fastBackendPlan.includes('FSUSBLOG_CI_JOB_SERIAL=1')) {
    console.error('[test-matrix] ci-job plan must document serial debug fallback')
    process.exit(1)
  }

  const coveragePlan = output(['ci-job', 'coverage-merge-threshold', '--plan-only'])
  if (!coveragePlan.includes('scheduler: serial')) {
    console.error('[test-matrix] exclusive-resource ci-job plan must remain serial')
    process.exit(1)
  }
}
run(['ci-job-matrix', 'fast-backend', '--out', '.tmp/docs/fast-backend-matrix.json'])
run(['ci-job-matrix', 'fast-frontend-unit', '--out', '.tmp/docs/fast-frontend-unit-matrix.json'])
run(['ci-job-matrix', 'acceptance-playwright', '--out', '.tmp/docs/acceptance-playwright-matrix.json'])
run(['ci-job-matrix', 'visual-public-playwright', '--out', '.tmp/docs/visual-public-playwright-matrix.json'])
run(['ci-job-matrix', 'visual-console-playwright', '--out', '.tmp/docs/visual-console-playwright-matrix.json'])
run(['ci-job-matrix', 'ux-viewport-smoke', '--out', '.tmp/docs/ux-viewport-smoke-matrix.json'])
{
  const matrix = readJsonFile('.tmp/docs/fast-frontend-unit-matrix.json').matrix
  const shards = matrix.include.map((entry) => entry.shard).filter(Boolean)
  requireCondition(
    shards.length === 2 && shards.includes('1/2') && shards.includes('2/2'),
    'fast-frontend-unit matrix must expand frontend-fast into 2 Vitest shards'
  )
  requireCondition(
    matrix.include.every((entry) => /^fast-frontend-unit-\d-of-2$/.test(entry.artifact_name)),
    'fast-frontend-unit shard artifacts must be named per shard'
  )
}
{
  const matrix = readJsonFile('.tmp/docs/acceptance-playwright-matrix.json').matrix
  const shards = matrix.include.map((entry) => entry.shard).filter(Boolean)
  requireCondition(
    shards.length === 4 && ['1/4', '2/4', '3/4', '4/4'].every((shard) => shards.includes(shard)),
    'acceptance-playwright matrix must expand acceptance into 4 Playwright shards'
  )
  requireCondition(
    matrix.include.every((entry) => entry.playwright_workers === 1 && /^acceptance-playwright-\d-of-4$/.test(entry.artifact_name)),
    'acceptance-playwright shard artifacts and worker policy must come from matrix metadata'
  )
}
{
  const matrix = readJsonFile('.tmp/docs/ux-viewport-smoke-matrix.json').matrix
  const shards = matrix.include.map((entry) => entry.shard).filter(Boolean)
  requireCondition(
    shards.length === 2 && shards.includes('1/2') && shards.includes('2/2'),
    'ux-viewport-smoke matrix must expand into 2 Playwright shards'
  )
  requireCondition(
    matrix.include.every((entry) => entry.playwright_workers === 1 && /^ux-viewport-smoke-\d-of-2$/.test(entry.artifact_name)),
    'ux-viewport-smoke shard artifacts and worker policy must come from matrix metadata'
  )
}
for (const [jobId, file] of [
  ['visual-public-playwright', '.tmp/docs/visual-public-playwright-matrix.json'],
  ['visual-console-playwright', '.tmp/docs/visual-console-playwright-matrix.json']
]) {
  const matrix = readJsonFile(file).matrix
  const shards = matrix.include.map((entry) => entry.shard).filter(Boolean)
  requireCondition(
    shards.length === 2 && shards.includes('1/2') && shards.includes('2/2'),
    `${jobId} matrix must expand into 2 Playwright shards`
  )
  requireCondition(
    matrix.include.every((entry) => entry.playwright_workers === 2 && new RegExp(`^${jobId}-\\d-of-2$`).test(entry.artifact_name)),
    `${jobId} shard artifacts and worker policy must come from matrix metadata`
  )
}
run(['aggregate', 'fast-summary', '--dry-run', '--out', '.tmp/docs/fast-summary-aggregate-plan.json'])
{
  const aggregatePlan = readJsonFile('.tmp/docs/fast-summary-aggregate-plan.json')
  for (const summaryId of ['fast-frontend-unit-1-of-2', 'fast-frontend-unit-2-of-2']) {
    requireCondition(
      aggregatePlan.requiredJobSummaries.includes(summaryId),
      `fast-summary aggregate plan must require ${summaryId}`
    )
  }
}
run(['ci-tier', 'backend-fast', '--plan-only'])
{
  const frontendPlan = output(['ci-job', 'fast-frontend-unit', '--plan-only'])
  process.stdout.write(frontendPlan)
  if (!frontendPlan.includes('./tools/test.sh ci-tier frontend-fast --no-deps --shard 1/2')) {
    console.error('[test-matrix] fast-frontend-unit plan must include a shard reproduction example')
    process.exit(1)
  }
}
run(['ci-fast', '--plan-only'])
run(['ci-production', '--plan-only'])
run(['ci-plan', '--format', 'github-actions', '--out', '.tmp/docs/run-test-matrix-ci-plan-compat.json'])
runTestSh(['ci-plan', '--out', '.tmp/docs/test-sh-ci-plan-compat.json'])
run(['docs', '--out', '.tmp/docs/run-test-matrix-docs-compat.md'])

{
  const result = spawnSync('node', [
    'tools/check-workflow-matrix-sync.mjs',
    '.tmp/docs/run-test-matrix-ci-plan-compat.json',
    '.github/workflows/quality-gate.yml'
  ], {
    cwd: root,
    encoding: 'utf8'
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

for (const script of [
  'tools/ci/check-flaky-registry.mjs',
  'tools/ci/check-flaky-evidence.mjs',
  'tools/docs/generate-testing-docs.mjs',
  'tools/docs/check-time-budget-sync.mjs'
]) {
  const args = script.endsWith('generate-testing-docs.mjs') ? [script, '--check'] : [script]
  const result = spawnSync('node', args, {
    cwd: root,
    encoding: 'utf8'
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  "FSUSBLOG_TEST_SELECTION: ${{ github.event_name == 'pull_request' && 'affected' || 'full' }}",
  'fast-backend workflow must use affected backend selection on pull_request and full selection otherwise'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  'fetch-depth: 0',
  'fast-backend workflow checkout must fetch enough history for affected backend selection'
)
requireFileIncludes(
  'tools/dotnet-affected-tests.sh',
  'auth-security-sensitive',
  'affected backend selection must conservatively escalate auth/security changes'
)
requireFileIncludes(
  'docs/testing.md',
  'Backend affected-test selection',
  'docs/testing.md must document backend affected-test changed-file rules'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  "FSUSBLOG_DOTNET_BUILD_PARALLELISM: ${{ vars.FSUSBLOG_DOTNET_BUILD_PARALLELISM || 'safe' }}",
  'fast-backend workflow must expose env-controlled .NET build parallelism'
)
requireFileIncludes(
  'tools/test/legacy-test.sh',
  'FSUSBLOG_DOTNET_BUILD_PARALLELISM',
  'backend build parallelism must be configurable through FSUSBLOG_DOTNET_BUILD_PARALLELISM'
)
requireFileIncludes(
  'tools/test/legacy-test.sh',
  'dotnet-build parallelism=',
  'backend build logs must print the selected .NET build parallelism mode'
)
requireFileIncludes(
  'docs/testing.md',
  'Backend build parallelism',
  'docs/testing.md must document backend build parallelism policy and benchmark notes'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  'fast_frontend_unit_matrix',
  'validate-matrix must generate the fast-frontend-unit shard matrix'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  './tools/test.sh ci-tier ${{ matrix.tier }} --no-deps --shard ${{ matrix.shard }}',
  'fast-frontend-unit workflow must run generated frontend shard tiers'
)
requireFileIncludes(
  'docs/testing.md',
  'Frontend fast Vitest sharding',
  'docs/testing.md must document frontend-fast shard reproduction and artifacts'
)
requireFileIncludes(
  'tools/test/legacy-test.sh',
  'run_frontend_fast_group build',
  'frontend-fast must time the build group before post-build checks'
)
requireFileIncludes(
  'tools/test/legacy-test.sh',
  'run_parallel "frontend-fast-post-build"',
  'frontend-fast must run independent post-build groups in parallel'
)
requireFileIncludes(
  'tools/test/legacy-test.sh',
  'tests::run_frontend_fast_tests_group',
  'frontend-fast must expose a named tests group for failure localization'
)
requireFileIncludes(
  'tools/test/legacy-test.sh',
  'runtime-contracts::run_frontend_fast_runtime_contracts_group',
  'frontend-fast must expose a named runtime-contracts group for failure localization'
)
requireFileIncludes(
  'tools/test/legacy-test.sh',
  'static-governance::run_frontend_fast_static_governance_group',
  'frontend-fast must expose a named static-governance group for failure localization'
)
requireFileIncludes(
  'tools/run-test-matrix.mjs',
  'groupDurationsMs',
  'frontend-fast group durations must be copied into the job summary'
)
requireFileIncludes(
  'tools/ci/summarize-quality-gate.mjs',
  'groups: ${groups}',
  'quality gate summary must render frontend-fast group durations for failed jobs'
)
requireFileIncludes(
  'docs/testing.md',
  'Frontend fast group parallelism',
  'docs/testing.md must document frontend-fast group parallelism and group duration evidence'
)
requireFileIncludes(
  'tests/matrix.yml',
  'coverage: [playwright-acceptance]\n    artifacts: [src/frontend/test-results/playwright/acceptance, src/frontend/playwright-report]',
  'acceptance matrix entry must remain identifiable for browser shard policy checks'
)
requireFileIncludes(
  'tests/matrix.yml',
  'id: acceptance\n    owner: InteropGlueAgent\n    command: tools/test/lanes/acceptance-playwright.sh',
  'acceptance tier must stay in the browser lane policy'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  'acceptance_playwright_matrix',
  'acceptance-playwright workflow must use the generated shard matrix'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  'acceptance_playwright_max_parallel',
  'acceptance-playwright workflow must run four generated shards concurrently before raising workers'
)
requireFileIncludes(
  'tests/matrix.yml',
  'id: ux-viewport-smoke\n    owner: InteropGlueAgent\n    command: tools/test/lanes/ux-viewport-smoke.sh',
  'ux-viewport-smoke tier must stay in the browser lane policy'
)
requireFileIncludes(
  'tests/matrix.yml',
  'coverage: [ux-viewport-boundary, responsive-layout, content-boundary]\n    artifacts: [.tmp/ux/viewport-smoke.json, .tmp/release-evidence/ux-viewport-summary.json, src/frontend/test-results/playwright/ux-viewport-smoke]',
  'ux-viewport-smoke artifacts must remain stable across shards'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  'ux_viewport_smoke_matrix',
  'ux-viewport-smoke workflow must use the generated shard matrix'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  '${{ matrix.artifact_name }}',
  'ux-viewport-smoke workflow must isolate artifacts per shard'
)
requireFileIncludes(
  'src/frontend/package.json',
  'npx playwright test ${FSUSBLOG_PLAYWRIGHT_SHARD_ARG:-}',
  'UX viewport smoke script must pass the Playwright shard argument'
)
requireFileIncludes(
  'tools/run-test-matrix.mjs',
  'env.FSUSBLOG_PLAYWRIGHT_SHARD_ARG = `--shard=${index}/${total}`',
  'matrix runner must pass Playwright shard arguments to direct browser lanes'
)
requireFileIncludes(
  'docs/testing.md',
  'Browser lane scaling policy',
  'docs/testing.md must document browser lane shard/worker scaling policy and evidence'
)
requireFileIncludes(
  'tests/matrix.yml',
  'id: visual-public\n    owner: InteropGlueAgent\n    command: tools/test/lanes/visual-public-playwright.sh',
  'public screenshot checks must run as a separate matrix tier'
)
requireFileIncludes(
  'tests/matrix.yml',
  'id: visual-console\n    owner: InteropGlueAgent\n    command: tools/test/lanes/visual-console-playwright.sh',
  'console screenshot checks must run as a separate matrix tier'
)
requireFileIncludes(
  'tests/matrix.yml',
  'id: visual\n    owner: InteropGlueAgent\n    command: tools/test/lanes/visual-screenshots-aggregate.sh\n    dependsOn: [visual-public, visual-console]',
  'visual screenshot checks must have a final aggregate tier'
)
requireFileIncludes(
  'tests/matrix.yml',
  'artifacts: [.tmp/visual/public, src/frontend/test-results/playwright/visual-public]',
  'public screenshot artifacts must use isolated output paths'
)
requireFileIncludes(
  'tests/matrix.yml',
  'artifacts: [.tmp/visual/console, src/frontend/test-results/playwright/visual-console]',
  'console screenshot artifacts must use isolated output paths'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  'visual_public_playwright_matrix',
  'visual public workflow must use generated shard matrix'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  'visual_console_playwright_matrix',
  'visual console workflow must use generated shard matrix'
)
requireFileIncludes(
  'tools/visual/aggregate-screenshot-evidence.mjs',
  'fsusblog.visual.screenshot-aggregate.v1',
  'visual screenshot aggregate script must emit a versioned evidence schema'
)
requireFileIncludes(
  'docs/testing.md',
  'Screenshot evidence tiers',
  'docs/testing.md must document visual screenshot tier split and aggregate evidence'
)
console.log('[test-matrix] ok')

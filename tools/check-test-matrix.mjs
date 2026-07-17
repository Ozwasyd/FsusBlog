#!/usr/bin/env node
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMatrix } from './test-matrix/parse-matrix.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const matrixSourceText = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8')

function requireFileIncludes(file, expected, message) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  if (!text.includes(expected)) {
    console.error(`[test-matrix] ${message}`)
    process.exit(1)
  }
}

function requireFileExcludes(file, forbidden, message) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  if (text.includes(forbidden)) {
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

function validateStructuredToolWiring() {
  const matrix = parseMatrix(matrixSourceText)
  const tiers = new Map(matrix.tiers.map((tier) => [tier.id, tier]))
  const requireTierDependencies = (tierId, expected) => {
    const tier = tiers.get(tierId)
    requireCondition(Boolean(tier), `structured matrix is missing tier ${tierId}`)
    requireCondition(
      JSON.stringify(tier.dependsOn ?? []) === JSON.stringify(expected),
      `${tierId}.dependsOn must equal ${expected.join(', ')}`
    )
  }
  requireTierDependencies('data-scale-evidence-summary', ['data-scale-xs', 'data-scale-s'])
  requireTierDependencies('performance-evidence-summary', [
    'load-baseline',
    'load-peak',
    'backend-benchmark-regression'
  ])
  const releaseDependencies = new Set(tiers.get('release-evidence')?.dependsOn ?? [])
  for (const aggregate of ['data-scale-evidence-summary', 'performance-evidence-summary']) {
    requireCondition(releaseDependencies.has(aggregate), `release-evidence must depend on ${aggregate}`)
  }

  const scripts = readJsonFile('src/frontend/package.json').scripts ?? {}
  for (const mode of ['smoke', 'visual', 'boundaries']) {
    const name = `check:ux:viewport-${mode}`
    const command = scripts[name]
    requireCondition(typeof command === 'string', `frontend package is missing ${name}`)
    const tokens = command.trim().split(/\s+/u)
    const runnerIndex = tokens.findIndex((token) => token.endsWith('run-ux-viewport-playwright.mjs'))
    requireCondition(runnerIndex >= 0, `${name} must invoke the summary-preserving viewport runner`)
    requireCondition(tokens[runnerIndex + 1] === mode, `${name} must pass mode ${mode} to the viewport runner`)
    requireCondition(!tokens.includes('write-ux-viewport-summary.mjs'), `${name} must not chain a second summary writer`)
  }
}

validateStructuredToolWiring()

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

function replaceTierField(matrixText, tierId, field, value) {
  const fieldPattern = new RegExp(`(  - id: ${tierId}\\n[\\s\\S]*?\\n    ${field}: )[^\\n]+`)
  if (!fieldPattern.test(matrixText)) {
    console.error(`[test-matrix] missing ${tierId}.${field} in matrix fixture`)
    process.exit(1)
  }
  return matrixText.replace(fieldPattern, `$1${value}`)
}

function setTierBooleanField(matrixText, tierId, field, value) {
  const tierPattern = new RegExp(`(  - id: ${tierId}\\n[\\s\\S]*?)(\\n  - id: |\\n$)`)
  const match = matrixText.match(tierPattern)
  if (!match) {
    console.error(`[test-matrix] missing ${tierId} in matrix fixture`)
    process.exit(1)
  }
  const tierText = match[1]
  const updatedTierText = new RegExp(`\\n    ${field}: `).test(tierText)
    ? tierText.replace(new RegExp(`(\\n    ${field}: )[^\\n]+`), `$1${value}`)
    : tierText.replace(/(\n    requiresBootstrap: [^\n]+)/, `$1\n    ${field}: ${value}`)
  return matrixText.replace(tierText, updatedTierText)
}

function removeTier(matrixText, tierId) {
  const tierPattern = new RegExp(`\\n  - id: ${tierId}\\n[\\s\\S]*?(?=\\n  - id: |\\n*$)`)
  if (!tierPattern.test(matrixText)) {
    console.error(`[test-matrix] missing ${tierId} in matrix fixture`)
    process.exit(1)
  }
  return matrixText.replace(tierPattern, '')
}

function writeTempMatrix(matrixText) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-matrix-'))
  const tempMatrix = path.join(tempDir, 'matrix.yml')
  fs.writeFileSync(tempMatrix, matrixText)
  return { tempDir, tempMatrix }
}

function expectMatrixValidateFailure(matrixText, expected, message) {
  const { tempDir, tempMatrix } = writeTempMatrix(matrixText)
  const result = spawnSync('node', ['tools/run-test-matrix.mjs', 'validate'], {
    cwd: root,
    env: { ...process.env, FSUSBLOG_MATRIX_FILE: tempMatrix },
    encoding: 'utf8'
  })
  fs.rmSync(tempDir, { recursive: true, force: true })
  const outputText = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status === 0 || !outputText.includes(expected)) {
    console.error(`[test-matrix] ${message}`)
    console.error(outputText)
    process.exit(1)
  }
}

function expectWorkflowSyncFailure(matrixText, expected, message) {
  const { tempDir, tempMatrix } = writeTempMatrix(matrixText)
  const planPath = path.join(tempDir, 'ci-plan.json')
  const planResult = spawnSync('node', ['tools/run-test-matrix.mjs', 'ci-plan', '--format', 'github-actions', '--out', planPath], {
    cwd: root,
    env: { ...process.env, FSUSBLOG_MATRIX_FILE: tempMatrix },
    encoding: 'utf8'
  })
  if (planResult.status !== 0) {
    if (planResult.stdout) process.stdout.write(planResult.stdout)
    if (planResult.stderr) process.stderr.write(planResult.stderr)
    fs.rmSync(tempDir, { recursive: true, force: true })
    process.exit(planResult.status ?? 1)
  }

  const result = spawnSync('node', ['tools/check-workflow-matrix-sync.mjs', planPath, '.github/workflows/quality-gate.yml'], {
    cwd: root,
    env: { ...process.env, FSUSBLOG_MATRIX_FILE: tempMatrix },
    encoding: 'utf8'
  })
  fs.rmSync(tempDir, { recursive: true, force: true })
  const outputText = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status === 0 || !outputText.includes(expected)) {
    console.error(`[test-matrix] ${message}`)
    console.error(outputText)
    process.exit(1)
  }
}

function expectWorkflowTextFailure(transform, expected, message) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-workflow-'))
  const workflowFile = path.join(tempDir, 'quality-gate.yml')
  const planFile = path.join(tempDir, 'ci-plan.json')
  const workflowSource = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8')
  fs.writeFileSync(workflowFile, transform(workflowSource))
  const planResult = spawnSync('node', ['tools/run-test-matrix.mjs', 'ci-plan', '--format', 'github-actions', '--out', planFile], {
    cwd: root,
    encoding: 'utf8'
  })
  if (planResult.status !== 0) {
    fs.rmSync(tempDir, { recursive: true, force: true })
    process.exit(planResult.status ?? 1)
  }
  const result = spawnSync('node', ['tools/check-workflow-matrix-sync.mjs', planFile, workflowFile], {
    cwd: root,
    encoding: 'utf8'
  })
  fs.rmSync(tempDir, { recursive: true, force: true })
  const outputText = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status === 0 || !outputText.includes(expected)) {
    console.error(`[test-matrix] ${message}`)
    console.error(outputText)
    process.exit(1)
  }
}

expectMatrixValidateFailure(
  replaceTierField(matrixSourceText, 'coverage-backend', 'phase', '5'),
  'coverage-merge depends on coverage-backend with later phase 5 > 4',
  'validate must reject dependency phase inversion'
)

expectMatrixValidateFailure(
  replaceTierField(matrixSourceText, 'integration', 'dependsOn', '[]'),
  'integration.requiresBootstrap=full needs dependency path to bootstrap, selfBootstraps=true, or workflowBootstraps=true',
  'validate must reject runtime tiers without an explicit bootstrap source'
)

expectWorkflowSyncFailure(
  setTierBooleanField(matrixSourceText, 'backend-qps-view-count-flush', 'workflowBootstraps', 'false'),
  'workflow job backend-qps-collectors manually runs bootstrap but tier backend-qps-view-count-flush does not declare workflowBootstraps=true',
  'workflow manual bootstrap must be backed by matrix metadata'
)

expectWorkflowTextFailure(
  (workflow) => workflow.replace(
    '  fast-backend:\n    name: Fast Backend DAG\n    runs-on: ubuntu-latest\n    needs: validate-matrix',
    '  fast-backend:\n    name: Fast Backend DAG\n    runs-on: ubuntu-latest\n    needs: [validate-matrix, missing-workflow-job]'
  ),
  'workflow job fast-backend needs undefined workflow job: missing-workflow-job',
  'workflow sync must reject undefined GitHub Actions needs before workflow load time'
)

expectWorkflowTextFailure(
  (workflow) => {
    const start = workflow.indexOf('  fast-backend:\n')
    const end = workflow.indexOf('\n  fast-frontend-unit:\n', start)
    const job = workflow.slice(start, end).replace(
      '      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6\n',
      '      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6\n      - run: npm --prefix src/frontend exec -- playwright install chromium\n'
    )
    return `${workflow.slice(0, start)}${job}${workflow.slice(end)}`
  },
  'browserless workflow job fast-backend must not install Playwright browsers',
  'workflow sync must reject hidden browser installation in a browserless job'
)

expectWorkflowTextFailure(
  (workflow) => {
    const start = workflow.indexOf('  browser-contract:\n')
    const end = workflow.indexOf('\n  resilience-runtime:\n', start)
    const job = workflow.slice(start, end).replace('    timeout-minutes: 10\n', '    timeout-minutes: 11\n')
    return `${workflow.slice(0, start)}${job}${workflow.slice(end)}`
  },
  'workflow job browser-contract timeout-minutes 11 does not match ci-plan 10',
  'workflow sync must reject Browser Contract timeout drift'
)

expectWorkflowTextFailure(
  (workflow) => {
    const start = workflow.indexOf('  production-summary:\n')
    return `${workflow.slice(0, start)}${workflow.slice(start).replace(
      '    needs:\n',
      '    needs:\n      - browser-contract\n'
    )}`
  },
  'production-summary must remain browserless and must not wait for browser-contract',
  'workflow sync must reject Browser Contract as a production summary dependency'
)

expectWorkflowSyncFailure(
  matrixSourceText.replace('identity-kind-anonymous-account', 'identity-kind-legacy-user'),
  'matrix coverage dimensions missing required identity kind: identity-kind-anonymous-account',
  'workflow sync must reject matrices without anonymous account identity-kind coverage'
)

expectMatrixValidateFailure(
  matrixSourceText.replace(/\n    cadence: [^\n]+\n/, '\n'),
  'validate-matrix missing cadence',
  'validate must require explicit cadence metadata'
)

expectMatrixValidateFailure(
  setTierBooleanField(matrixSourceText, 'ux-viewport-visual', 'nightlyOnly', 'false'),
  'ux-viewport-visual.cadence=nightly requires nightlyOnly=true',
  'nightly diagnostics tiers must declare nightly-only cadence ownership'
)

expectMatrixValidateFailure(
  setTierBooleanField(matrixSourceText, 'release-final', 'requiredFor', 'production'),
  'release-final.manualOnly must not be requiredFor=production',
  'manual-only tiers must not count as ordinary production coverage'
)

expectMatrixValidateFailure(
  replaceTierField(matrixSourceText, 'production-correctness', 'dependsOn', '[fast, acceptance]'),
  'production-correctness dependency closure must be browserless: acceptance',
  'production correctness must reject any transitive Playwright tier'
)

expectMatrixValidateFailure(
  replaceTierField(matrixSourceText, 'browser-contract', 'resourceClass', 'network'),
  'browser-contract.requiresPlaywright=chromium requires resourceClass=browser',
  'every browser tier must declare the browser resource boundary'
)

expectMatrixValidateFailure(
  replaceTierField(matrixSourceText, 'release-final', 'dependsOn', '[production-correctness, browser-contract, acceptance]'),
  'release-final dependency closure must contain only browser-contract as a browser tier: acceptance, browser-contract',
  'release-final must reject a second browser dependency'
)

expectMatrixValidateFailure(
  removeTier(matrixSourceText, 'frontend-build'),
  'frontend fast split missing tier frontend-build',
  'validate must reject missing frontend-fast split tiers'
)

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
run(['ci-job-matrix', 'browser-contract', '--out', '.tmp/docs/browser-contract-matrix.json'])
for (const tierId of [
  'frontend-build',
  'frontend-unit-shard',
  'frontend-property-model-perf',
  'frontend-runtime-contracts',
  'frontend-static-governance',
  'frontend-fast-summary'
]) {
  requireFileIncludes(
    'tests/matrix.yml',
    `id: ${tierId}\n`,
    `frontend fast split must declare ${tierId}`
  )
}
{
  const matrix = readJsonFile('.tmp/docs/fast-frontend-unit-matrix.json').matrix
  const shardCount = matrix.resource_resolution.defaultShards
  const tierIds = matrix.include.map((entry) => entry.tier).sort()
  const expectedTierIds = [
    'coverage-frontend',
    'frontend-property-model-perf',
    ...Array.from({ length: shardCount }, () => 'frontend-unit-shard'),
    'ux-viewport-plan-progress'
  ].sort()
  requireCondition(
    JSON.stringify(tierIds) === JSON.stringify(expectedTierIds),
    'fast-frontend-unit effective plan must retain ordinary unit, coverage, property/model/perf and viewport governance when cross-tier coverage prevents safe superseding'
  )
  requireCondition(
    matrix.include.every((entry) => entry.tier === 'frontend-unit-shard'
      ? shardCount > 1
        ? Array.from({ length: shardCount }, (_, index) => `${index + 1}/${shardCount}`).includes(entry.shard)
          && new RegExp(`^fast-frontend-unit-\\d-of-${shardCount}$`).test(entry.artifact_name)
        : entry.shard === '' && entry.artifact_name === 'fast-frontend-unit-frontend-unit-shard'
      : entry.shard === '' && entry.artifact_name === `fast-frontend-unit-${entry.tier}`),
    'fast-frontend-unit tiers must preserve machine-resolved unit shards and independently attributable non-unit artifacts'
  )
}
{
  const matrix = readJsonFile('.tmp/docs/browser-contract-matrix.json').matrix
  requireCondition(
    matrix.include.length === 1
      && matrix.include[0].tier === 'browser-contract'
      && matrix.include[0].shard === ''
      && matrix.include[0].playwright_workers === 1
      && matrix.include[0].max_parallel === 1
      && matrix.include[0].timeout_minutes === 10
      && matrix.include[0].artifact_name === 'browser-contract-browser-contract',
    'browser-contract CI matrix must remain one unsharded, single-worker, ten-minute Chromium contract'
  )
}
run(['aggregate', 'fast-summary', '--dry-run', '--out', '.tmp/docs/fast-summary-aggregate-plan.json'])
{
  const aggregatePlan = readJsonFile('.tmp/docs/fast-summary-aggregate-plan.json')
  const frontendMatrix = readJsonFile('.tmp/docs/fast-frontend-unit-matrix.json').matrix
  const shardCount = frontendMatrix.resource_resolution.defaultShards
  for (const summaryId of [
    'frontend-build',
    ...(shardCount > 1
      ? Array.from({ length: shardCount }, (_, index) => `fast-frontend-unit-${index + 1}-of-${shardCount}`)
      : ['fast-frontend-unit-frontend-unit-shard']),
    'fast-frontend-unit-coverage-frontend',
    'fast-frontend-unit-frontend-property-model-perf',
    'fast-backend-coverage-backend',
    'frontend-runtime-contracts',
    'frontend-static-governance'
  ]) {
    requireCondition(
      aggregatePlan.requiredJobSummaries.includes(summaryId),
      `fast-summary aggregate plan must require ${summaryId}`
    )
  }
  requireCondition(
    aggregatePlan.requiredArtifactPaths.includes('.tmp/frontend/frontend-unit-shard.json'),
    'fast-summary aggregate must require ordinary unit evidence when safe superseding is unavailable'
  )
  requireCondition(
    aggregatePlan.requiredArtifactPaths.includes('.tmp/coverage/frontend/Summary.json'),
    'fast-summary aggregate must require coverage replacement evidence'
  )
}
run(['ci-tier', 'backend-fast', '--plan-only'])
{
  const frontendPlan = output(['ci-job', 'fast-frontend-unit', '--plan-only'])
  process.stdout.write(frontendPlan)
  const shardCount = readJsonFile('.tmp/docs/fast-frontend-unit-matrix.json').matrix.resource_resolution.defaultShards
  if (!frontendPlan.includes(`./tools/test.sh ci-tier frontend-unit-shard --no-deps --shard 1/${shardCount}`)
      || !frontendPlan.includes('./tools/test.sh ci-tier coverage-frontend --no-deps')
      || !frontendPlan.includes('./tools/test.sh ci-tier frontend-property-model-perf --no-deps')) {
    console.error('[test-matrix] fast-frontend-unit plan must retain ordinary unit, coverage and special suites')
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

{
  const workflowPath = '.tmp/docs/quality-gate-hidden-artifact-regression.yml'
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8')
    .replace(/\n\s+include-hidden-files: true/u, '')
  fs.writeFileSync(path.join(root, workflowPath), workflow)
  const result = spawnSync('node', [
    'tools/check-workflow-matrix-sync.mjs',
    '.tmp/docs/run-test-matrix-ci-plan-compat.json',
    workflowPath
  ], { cwd: root, encoding: 'utf8' })
  requireCondition(
    result.status !== 0 && /include-hidden-files: true/u.test(result.stderr),
    'workflow checker must reject .tmp artifact uploads that omit include-hidden-files: true'
  )
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
  'FSUSBLOG_TEST_SELECTION: full',
  'coverage-backed fast-backend workflow must execute the complete ordinary unit selection exactly once'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  'node tools/verify-matrix-identity-kinds.mjs',
  'security-runtime workflow must verify anonymous migration identity-kind dimensions'
)
requireFileIncludes(
  'tests/matrix.yml',
  'anonymous-account-endpoint-protocol-status-cache-error-frame',
  'endpoint-depth coverage must include anonymous-account actor dimensions'
)
requireFileIncludes(
  'tests/matrix.yml',
  'admin-principal-endpoint-protocol-status-cache-error-frame',
  'endpoint-depth coverage must include admin-principal actor dimensions'
)
requireFileIncludes(
  'tests/matrix.yml',
  'endpoint-role-protocol-status-cache-error-frame-deprecated',
  'legacy endpoint-role-protocol coverage must be explicitly deprecated'
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
  './tools/test.sh ci-job fast-frontend-unit --fresh',
  'fast-frontend-unit workflow must run the resource-aware DAG in fresh mode'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  'frontend-build:',
  'quality gate must run frontend build as an independent job'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  'frontend-runtime-contracts:',
  'quality gate must run frontend runtime contracts as an independent job'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  'frontend-static-governance:',
  'quality gate must run frontend static governance as an independent job'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  './tools/test.sh ci-job fast-backend --fresh',
  'fast-backend workflow must run the resource-aware DAG in fresh mode'
)
requireFileIncludes(
  'docs/testing.md',
  'Frontend fast split',
  'docs/testing.md must document frontend-fast split reproduction and artifacts'
)
requireFileIncludes(
  'tools/test/legacy-test.sh',
  'run_frontend_fast_build_lane',
  'frontend-fast split must expose a standalone build lane'
)
requireFileIncludes(
  'tools/test/legacy-test.sh',
  'run_frontend_unit_shard_lane',
  'frontend-fast split must expose a standalone unit shard lane'
)
requireFileIncludes(
  'tools/test/legacy-test.sh',
  'run_frontend_runtime_contracts_lane',
  'frontend-fast split must expose a standalone runtime contracts lane'
)
requireFileIncludes(
  'tools/test/legacy-test.sh',
  'run_frontend_static_governance_lane',
  'frontend-fast split must expose a standalone static governance lane'
)
requireFileIncludes(
  'tools/test/legacy-test.sh',
  'run_frontend_fast_summary_lane',
  'frontend-fast split must expose a standalone summary lane'
)
requireFileIncludes(
  'tools/run-test-matrix.mjs',
  'frontendFastSplitIds',
  'matrix validator must know the required frontend-fast split tiers'
)
requireFileIncludes(
  'tools/ci/summarize-quality-gate.mjs',
  'groups: ${groups}',
  'quality gate summary must render frontend-fast group durations for failed jobs'
)
requireFileIncludes(
  'docs/testing.md',
  '`fast-summary` 下载这些 artifacts',
  'docs/testing.md must document frontend-fast split aggregate evidence'
)
{
  const parsed = parseMatrix(matrixSourceText)
  const tiers = new Map(parsed.tiers.map((tier) => [tier.id, tier]))
  const production = tiers.get('production-correctness')
  const contract = tiers.get('browser-contract')
  const acceptance = tiers.get('acceptance')
  const releaseFinal = tiers.get('release-final')
  requireCondition(
    production?.requiresPlaywright === 'none'
      && production?.requiredFor === 'production'
      && production?.dependsOn?.includes('release-evidence')
      && !production?.dependsOn?.includes('acceptance'),
    'production-correctness must be the browserless production aggregate'
  )
  requireCondition(
    contract?.ciJob === 'browser-contract'
      && contract?.resourceClass === 'browser'
      && contract?.requiresPlaywright === 'chromium'
      && contract?.parallelizable === false
      && contract?.timeoutMinutes === 10
      && contract?.selfBootstraps === true,
    'browser-contract must remain the single fixed release Chromium boundary'
  )
  requireCondition(
    acceptance?.ciJob === 'browser-diagnostics'
      && acceptance?.requiredFor === 'none'
      && acceptance?.nightlyOnly === true,
    'legacy acceptance must be diagnostics-only'
  )
  requireCondition(
    releaseFinal?.requiresPlaywright === 'none'
      && releaseFinal?.dependsOn?.includes('production-correctness')
      && releaseFinal?.dependsOn?.includes('browser-contract'),
    'release-final must aggregate browserless correctness and exactly one Browser Contract'
  )
}
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  '  browser-contract:\n    name: Browser Contract',
  'quality gate must expose one explicit Browser Contract job'
)
requireFileExcludes(
  '.github/workflows/quality-gate.yml',
  'acceptance_playwright_matrix',
  'ordinary quality gate must not generate an acceptance Playwright shard matrix'
)
requireFileExcludes(
  '.github/workflows/quality-gate.yml',
  'acceptance_playwright_max_parallel',
  'ordinary quality gate must not consume acceptance Playwright shard concurrency'
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
requireFileExcludes(
  '.github/workflows/quality-gate.yml',
  'ux-viewport-smoke:',
  'ordinary quality gate must not define the UX viewport diagnostics job'
)
requireFileIncludes(
  'src/frontend/package.json',
  'run-ux-viewport-playwright.mjs smoke',
  'UX viewport smoke must use the summary-preserving runner'
)
requireFileIncludes(
  'src/frontend/package.json',
  'FSUSBLOG_UX_VIEWPORT_WORKERS=${FSUSBLOG_UX_VIEWPORT_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-`node ../../tools/test/resolve-playwright-workers.mjs ux-viewport-smoke`}} PLAYWRIGHT_OUTPUT_DIR=${PLAYWRIGHT_OUTPUT_DIR:-test-results/playwright/ux-viewport-smoke} node ../../tests/frontend/checks/ux/run-ux-viewport-playwright.mjs smoke',
  'UX viewport smoke must honor lane-computed Playwright workers'
)
requireFileIncludes(
  'tests/frontend/e2e/ux/viewport-boundaries.spec.ts',
  'for (const group of testGroups)',
  'UX viewport runner must execute the shared route-theme plan'
)
requireFileIncludes(
  'tools/test/resolve-playwright-workers.mjs',
  'FSUSBLOG_BUNDLE_CPU_UNITS',
  'Playwright browser lanes must prefer the scheduler CPU grant before host capacity'
)
requireFileIncludes(
  'tools/test/lanes/ux-viewport-smoke.sh',
  'resolve-playwright-workers.mjs" ux-viewport-smoke',
  'UX viewport smoke lane must compute workers from local CPU, memory, and load'
)
requireFileIncludes(
  'tools/test/lanes/ux-viewport-smoke.sh',
  'FSUSBLOG_PLAYWRIGHT_WORKERS="$FSUSBLOG_UX_VIEWPORT_WORKERS" prepare_session_fixtures_once',
  'UX viewport smoke must prepare exactly the worker-counted session fixtures once'
)
requireFileIncludes(
  'src/frontend/package.json',
  'check:visual:public:playwright": "env -u NO_COLOR NODE_PATH=./node_modules npx playwright test --config=${FSUSBLOG_PLAYWRIGHT_CONFIG:-playwright.config.ts} ${FSUSBLOG_PLAYWRIGHT_SHARD_ARG:-} --workers=${FSUSBLOG_VISUAL_PUBLIC_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-`node ../../tools/test/resolve-playwright-workers.mjs visual-public`}}',
  'visual public Playwright script must honor matrix or lane-computed workers'
)
requireFileIncludes(
  'tools/frontend/check-console-visual.sh',
  'workers="${FSUSBLOG_CONSOLE_VISUAL_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-$(node ../../tools/test/resolve-playwright-workers.mjs visual-console)}}"',
  'visual console grouped screenshot runner must honor matrix or lane-computed workers'
)
requireFileIncludes(
  'src/frontend/package.json',
  'check:spa:routes": "npm run ensure:wasm && env -u NO_COLOR NODE_PATH=./node_modules npx playwright test ${FSUSBLOG_PLAYWRIGHT_SHARD_ARG:-} --workers=${FSUSBLOG_SPA_ROUTES_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-`node ../../tools/test/resolve-playwright-workers.mjs acceptance-spa-routes`}}',
  'SPA route audit must honor the acceptance lane worker cap'
)
requireFileIncludes(
  'src/frontend/package.json',
  'check:acceptance:public": "npm run ensure:wasm && env -u NO_COLOR NODE_PATH=./node_modules npx playwright test ${FSUSBLOG_PLAYWRIGHT_SHARD_ARG:-} --workers=${FSUSBLOG_PUBLIC_ACCEPTANCE_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-`node ../../tools/test/resolve-playwright-workers.mjs acceptance-public-routes`}}',
  'public route audit must honor the isolated acceptance worker cap'
)
requireFileIncludes(
  'tools/test/lanes/ux-viewport-visual.sh',
  'configure_playwright_workers ux-viewport-visual FSUSBLOG_UX_VIEWPORT_WORKERS',
  'ux-viewport-visual must resolve a bounded worker cap from the current machine'
)
requireFileIncludes(
  'tools/test/lanes/ux-viewport-boundaries.sh',
  "profile='ux-viewport-boundaries'",
  'ux-viewport-boundaries must use its dedicated profile when screenshots are disabled'
)
requireFileIncludes(
  'tools/test/lanes/ux-viewport-boundaries.sh',
  "profile='ux-viewport-visual'",
  'ux-viewport-boundaries must fall back to the visual profile when screenshots are enabled'
)
requireFileIncludes(
  'tools/test/lanes/ux-viewport-boundaries.sh',
  'configure_playwright_workers "$profile" FSUSBLOG_UX_VIEWPORT_WORKERS',
  'ux-viewport-boundaries must apply its selected worker profile'
)
for (const file of [
  'tools/test/lanes/ux-viewport-smoke.sh',
  'tools/test/lanes/ux-viewport-visual.sh',
  'tools/test/lanes/ux-viewport-boundaries.sh'
]) {
  requireFileIncludes(
    file,
    'FSUSBLOG_PLAYWRIGHT_WORKERS="$FSUSBLOG_UX_VIEWPORT_WORKERS" prepare_session_fixtures_once',
    `${file} must prepare isolated session fixtures for its computed worker cap`
  )
  requireFileIncludes(
    file,
    'require_release_preview',
    `${file} must exercise the release preview instead of the concurrent Vite development server`
  )
  requireFileIncludes(
    file,
    'PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"',
    `${file} must direct browser checks through the release preview proxy`
  )
}
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
for (const forbidden of [
  'acceptance-playwright:',
  'frontend-render-pressure:',
  'visual-public-playwright:',
  'visual-console-playwright:',
  'visual-playwright:',
  'cross-browser-smoke:'
]) {
  requireFileExcludes(
    '.github/workflows/quality-gate.yml',
    forbidden,
    `ordinary quality gate must not define diagnostics job ${forbidden}`
  )
}
requireFileIncludes(
  '.github/workflows/browser-diagnostics.yml',
  'playwright install --with-deps chromium firefox webkit',
  'scheduled/manual diagnostics must install every governed browser engine'
)
requireFileIncludes(
  'src/frontend/playwright.config.ts',
  "'acceptance/cross-browser-smoke.spec.ts'",
  'ordinary Playwright config must exclude cross-browser diagnostics'
)
requireFileIncludes(
  'src/frontend/playwright.config.ts',
  "'visual/**'",
  'ordinary Playwright config must exclude visual diagnostics'
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
for (const testFile of [
  'tests/tools/issue-1150-matrix-commands.test.mjs',
  'tests/tools/issue-1150-browserless-ci-topology.test.mjs'
]) {
  const result = spawnSync(process.execPath, ['--test', testFile], { cwd: root, encoding: 'utf8' })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  requireCondition(result.status === 0, `${testFile} must pass the #1150 browser-boundary governance contract`)
}
console.log('[test-matrix] ok')

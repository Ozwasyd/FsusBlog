#!/usr/bin/env node
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const matrixSourceText = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8')

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
  setTierBooleanField(matrixSourceText, 'ux-viewport-visual', 'cadence', 'pr'),
  'ux-viewport-visual.manualOnly requires cadence=release-manual',
  'manual-only tiers must use release-manual cadence'
)

expectMatrixValidateFailure(
  setTierBooleanField(matrixSourceText, 'release-final', 'requiredFor', 'production'),
  'release-final.manualOnly must not be requiredFor=production',
  'manual-only tiers must not count as ordinary production coverage'
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
run(['ci-job-matrix', 'acceptance-playwright', '--out', '.tmp/docs/acceptance-playwright-matrix.json'])
run(['ci-job-matrix', 'visual-public-playwright', '--out', '.tmp/docs/visual-public-playwright-matrix.json'])
run(['ci-job-matrix', 'visual-console-playwright', '--out', '.tmp/docs/visual-console-playwright-matrix.json'])
run(['ci-job-matrix', 'ux-viewport-smoke', '--out', '.tmp/docs/ux-viewport-smoke-matrix.json'])
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
  const tierIds = matrix.include.map((entry) => entry.tier).sort()
  requireCondition(
    JSON.stringify(tierIds) === JSON.stringify(['coverage-frontend', 'frontend-property-model-perf', 'ux-viewport-plan-progress']),
    'fast-frontend-unit effective plan must retain property/model/perf and viewport governance while replacing ordinary unit with coverage'
  )
  requireCondition(
    matrix.include.every((entry) => entry.shard === '' && entry.artifact_name === `fast-frontend-unit-${entry.tier}`),
    'fast-frontend-unit effective tiers must be unsharded and independently attributable'
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
  requireCondition(
    matrix.include.length === 1 && matrix.include[0].tier === 'ux-viewport-smoke' && matrix.include[0].shard === '',
    'ux-viewport-smoke must run as one non-sharded planner execution'
  )
  requireCondition(
    matrix.include[0].playwright_workers === 1 && matrix.include[0].artifact_name === 'ux-viewport-smoke-ux-viewport-smoke',
    'ux-viewport-smoke worker policy must come from matrix metadata'
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
  for (const summaryId of [
    'frontend-build',
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
    !aggregatePlan.requiredArtifactPaths.some((artifact) => artifact.includes('frontend-unit-shard')),
    'fast-summary aggregate must not require artifacts from a superseded ordinary unit tier'
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
  if (!frontendPlan.includes('superseded: frontend-unit-shard -> coverage-frontend')
      || !frontendPlan.includes('./tools/test.sh ci-tier frontend-property-model-perf --no-deps')) {
    console.error('[test-matrix] fast-frontend-unit plan must prove coverage substitution while retaining special suites')
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
requireFileIncludes(
  'tests/matrix.yml',
  'coverage: [playwright-acceptance]\n    artifacts: [src/frontend/test-results/playwright/acceptance]\n    evidence: [src/frontend/test-results/playwright/acceptance]',
  'acceptance matrix entry must expose the governed Playwright test-results artifact'
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
  './tools/test.sh ci-tier ux-viewport-smoke --no-deps --fresh',
  'ux-viewport-smoke workflow must run one authoritative fresh plan'
)
requireFileIncludes(
  '.github/workflows/quality-gate.yml',
  'name: ux-viewport-smoke',
  'ux-viewport-smoke workflow must retain one stable artifact'
)
requireFileIncludes(
  'src/frontend/package.json',
  'run-ux-viewport-playwright.mjs smoke',
  'UX viewport smoke must use the summary-preserving runner'
)
requireFileIncludes(
  'src/frontend/package.json',
  'FSUSBLOG_UX_VIEWPORT_WORKERS=${FSUSBLOG_UX_VIEWPORT_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-1}} PLAYWRIGHT_OUTPUT_DIR=test-results/playwright/ux-viewport-smoke node ../../tests/frontend/checks/ux/run-ux-viewport-playwright.mjs smoke',
  'UX viewport smoke must honor lane-computed Playwright workers'
)
requireFileIncludes(
  'tests/frontend/e2e/ux/viewport-boundaries.spec.ts',
  'for (const group of testGroups)',
  'UX viewport runner must execute the shared route-theme plan'
)
requireFileIncludes(
  'tools/test/resolve-playwright-workers.mjs',
  "name === 'ux-viewport-smoke'",
  'Playwright browser lanes must resolve workers from the local machine profile'
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
  'check:visual:public": "npm run ensure:wasm && env -u NO_COLOR NODE_PATH=./node_modules npx playwright test ${FSUSBLOG_PLAYWRIGHT_SHARD_ARG:-} --workers=${FSUSBLOG_VISUAL_PUBLIC_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-2}}',
  'visual public Playwright script must honor matrix or lane-computed workers'
)
requireFileIncludes(
  'tools/frontend/check-console-visual.sh',
  'workers="${FSUSBLOG_CONSOLE_VISUAL_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-2}}"',
  'visual console grouped screenshot runner must honor matrix or lane-computed workers'
)
requireFileIncludes(
  'src/frontend/package.json',
  'check:spa:routes": "npm run ensure:wasm && env -u NO_COLOR NODE_PATH=./node_modules npx playwright test ${FSUSBLOG_PLAYWRIGHT_SHARD_ARG:-} --workers=${FSUSBLOG_SPA_ROUTES_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-1}}',
  'SPA route audit must honor the acceptance lane worker cap'
)
requireFileIncludes(
  'src/frontend/package.json',
  'check:acceptance:public": "npm run ensure:wasm && env -u NO_COLOR NODE_PATH=./node_modules npx playwright test ${FSUSBLOG_PLAYWRIGHT_SHARD_ARG:-} --workers=${FSUSBLOG_PUBLIC_ACCEPTANCE_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-1}}',
  'public route audit must honor the isolated acceptance worker cap'
)
requireFileIncludes(
  'tools/test/legacy-test.sh',
  'configure_playwright_workers acceptance-public-routes FSUSBLOG_PUBLIC_ACCEPTANCE_WORKERS',
  'acceptance lane must resolve a public route worker cap from the current machine'
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
  'tools/test/legacy-test.sh',
  'FSUSBLOG_PLAYWRIGHT_WORKERS="$FSUSBLOG_SPA_ROUTES_WORKERS" prepare_session_fixtures_once',
  'acceptance lane must prepare session fixtures for the computed SPA route worker cap'
)
requireFileIncludes(
  'tools/test/legacy-test.sh',
  'FSUSBLOG_PLAYWRIGHT_WORKERS="$FSUSBLOG_CONSOLE_VISUAL_WORKERS" prepare_session_fixtures_once',
  'visual console lane must prepare session fixtures for the computed screenshot worker cap'
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

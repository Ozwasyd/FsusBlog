import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflowFile = path.join(root, '.github/workflows/quality-gate.yml')
const actionFile = path.join(root, '.github/actions/consume-production-build/action.yml')
const producerLaneFile = path.join(root, 'tools/test/lanes/production-build-artifacts.sh')

function jobSource(workflow, jobId) {
  const start = workflow.indexOf(`\n  ${jobId}:\n`)
  assert.notEqual(start, -1, `missing workflow job ${jobId}`)
  const next = workflow.slice(start + 1).search(/\n  [A-Za-z0-9_-]+:\n/u)
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next)
}

test('quality gate has one smart-gated producer and all immutable-build consumers verify it', () => {
  const workflow = fs.readFileSync(workflowFile, 'utf8')
  const producer = jobSource(workflow, 'production-build-artifacts')
  assert.match(producer, /ci-tier production-build-artifacts --no-deps/u)
  assert.match(producer, /if-no-files-found: error/u)
  assert.match(producer, /retention-days: 3/u)
  assert.match(producer, /source_fingerprint:[\s\S]*receipt_digest:/u)
  const uploaded = producer.slice(producer.lastIndexOf('uses: actions/upload-artifact@'))
  assert.doesNotMatch(uploaded, /node_modules|~\/\.nuget\/packages/u)

  const consumers = [
    'integration-runtime', 'endpoint-depth-runtime', 'release-public', 'security-runtime',
    'browser-contract', 'resilience-runtime', 'load-smoke',
    'backend-qps-collectors', 'perf-regression'
  ]
  for (const jobId of consumers) {
    const source = jobSource(workflow, jobId)
    assert.match(source, /needs:.*production-build-artifacts/u, jobId)
    assert.match(source, /uses: \.\/\.github\/actions\/consume-production-build/u, jobId)
    assert.match(source, /needs\.production-build-artifacts\.outputs\.source_fingerprint/u, jobId)
    assert.match(source, /needs\.production-build-artifacts\.outputs\.receipt_digest/u, jobId)
    const consumerAction = source.indexOf('uses: ./.github/actions/consume-production-build')
    assert.ok(source.indexOf('actions/setup-node@') < consumerAction, `${jobId} must set up Node before verification`)
    assert.ok(source.indexOf('actions/setup-dotnet@') < consumerAction, `${jobId} must set up .NET before verification`)
  }
})

test('consumer action verifies same-run source and receipt identity before tests', () => {
  const source = fs.readFileSync(actionFile, 'utf8')
  for (const contract of [
    'actions/download-artifact@',
    'snapshotGitWorktree',
    'production-build-artifacts-cli.mjs verify',
    '--expected-commit',
    '--expected-fingerprint',
    '--expected-workflow "$GITHUB_WORKFLOW"',
    '--expected-run-id',
    '--expected-run-attempt "$GITHUB_RUN_ATTEMPT"',
    '--expected-job production-build-artifacts',
    '--expected-current-toolchain true',
    '--expected-input-root "$GITHUB_WORKSPACE"',
    '--expected-receipt-digest',
    '--transfer-started-at-ms',
    'FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT=',
    'FSUSBLOG_RUNTIME_NO_BUILD=1'
  ]) assert.ok(source.includes(contract), contract)
})

test('producer receipts existing lock, project and build configuration inputs', () => {
  const source = fs.readFileSync(producerLaneFile, 'utf8')
  assert.match(source, /PRODUCER_RUN_ID="\$\{GITHUB_RUN_ID:-\$\{FSUSBLOG_TEST_RUN_ID:/u)
  assert.match(source, /PRODUCER_RUN_ATTEMPT="\$\{GITHUB_RUN_ATTEMPT:-1\}"/u)
  assert.match(source, /--run-id "\$PRODUCER_RUN_ID"/u)
  assert.match(source, /--run-attempt "\$PRODUCER_RUN_ATTEMPT"/u)
  for (const input of [
    'Directory.Build.props',
    'FsusBlog.slnx',
    'src/backend/FsusBlog.Server.csproj',
    'src/backend/packages.lock.json',
    'src/core/FsusBlog.Core.csproj',
    'src/shared/FsusBlog.Shared.csproj',
    'tests/backend/FsusBlog.Server.Tests.csproj',
    'src/frontend/package.json',
    'src/frontend/package-lock.json',
    'src/frontend/vite.config.ts',
    'tools/frontend/build.mjs',
    'tools/frontend/ensure-wasm.mjs',
    'tools/frontend/write-comment-privacy-prover-manifest.mjs',
    'tools/security/comment-privacy-build-contract.mjs',
    'security/zk/contracts/comment-v5-circuit.manifest.json',
    'security/zk/provenance/comment-v5-trusted-setup.manifest.json',
    'config/zk/anonymous-comment-v5-verifying-key.manifest.json',
    'src/frontend/wasm/CMakeLists.txt'
  ]) assert.match(source, new RegExp(`--input ${input.replaceAll('.', '\\.')}`, 'u'), input)
  assert.doesNotMatch(source, /--input global\.json/u)
  const declaredInputs = [...source.matchAll(/--input ([A-Za-z0-9_./-]+)/gu)].map(match => match[1])
  assert.ok(declaredInputs.length > 0)
  for (const input of declaredInputs) {
    assert.equal(fs.existsSync(path.join(root, input)), true, `missing producer receipt input: ${input}`)
  }
})

test('smart gate selects producer exactly when an immutable build consumer is selected', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-build-smart-gate-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const run = changedFile => {
    const changed = path.join(temp, `${path.basename(changedFile)}.txt`)
    const output = path.join(temp, `${path.basename(changedFile)}.json`)
    const githubOutput = path.join(temp, `${path.basename(changedFile)}.github-output`)
    fs.writeFileSync(changed, `${changedFile}\n`)
    const result = spawnSync(process.execPath, [
      'tools/run-test-matrix.mjs', 'ci-pr-plan',
      '--event-name', 'pull_request',
      '--changed-files', changed,
      '--out', output,
      '--github-output', githubOutput
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return {
      plan: JSON.parse(fs.readFileSync(output, 'utf8')),
      githubOutput: fs.readFileSync(githubOutput, 'utf8')
    }
  }

  const runtimeResult = run('src/backend/Program.cs')
  const runtime = runtimeResult.plan
  assert.ok(runtime.selectedTierIds.includes('production-build-artifacts'))
  assert.ok(runtime.selectedJobs.includes('production-build-artifacts'))
  const producer = runtime.selectedTiers.find(tier => tier.id === 'production-build-artifacts')
  assert.match(producer.reason, /immutable production build/u)
  assert.match(runtimeResult.githubOutput, /production_build_domains=.*backend-runtime/u)

  const frontendResult = run('src/frontend/src/App.vue')
  assert.ok(frontendResult.plan.selectedTierIds.includes('production-build-artifacts'))
  assert.doesNotMatch(frontendResult.githubOutput, /production_build_domains=.*frontend-dist/u)
  assert.doesNotMatch(frontendResult.githubOutput, /production_build_domains=.*wasm/u)
  assert.match(frontendResult.githubOutput, /browser_diagnostics=false/u)

  const docsOnlyResult = run('docs/README-only.md')
  const docsOnly = docsOnlyResult.plan
  assert.ok(docsOnly.selectedTierIds.includes('backend-qps-cache-hit'))
  assert.ok(docsOnly.selectedTierIds.includes('production-build-artifacts'))
  assert.match(
    docsOnly.selectedTiers.find(tier => tier.id === 'production-build-artifacts').reason,
    /selected runtime\/browser job requires/u
  )
  assert.match(docsOnlyResult.githubOutput, /production_build_domains=backend-runtime\n/u)
})

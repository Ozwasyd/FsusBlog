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
run(['aggregate', 'fast-summary', '--dry-run', '--out', '.tmp/docs/fast-summary-aggregate-plan.json'])
run(['ci-tier', 'backend-fast', '--plan-only'])
run(['ci-fast', '--plan-only'])
run(['ci-production', '--plan-only'])
run(['ci-plan', '--format', 'github-actions', '--out', '.tmp/docs/run-test-matrix-ci-plan-compat.json'])
runTestSh(['ci-plan', '--out', '.tmp/docs/test-sh-ci-plan-compat.json'])
run(['docs', '--out', '.tmp/docs/run-test-matrix-docs-compat.md'])

{
  const result = spawnSync('node', ['tools/check-workflow-matrix-sync.mjs'], {
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

console.log('[test-matrix] ok')

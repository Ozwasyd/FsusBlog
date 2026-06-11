#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))

function run(args) {
  const result = spawnSync('node', ['tools/run-test-matrix.mjs', ...args], {
    cwd: root,
    encoding: 'utf8'
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function runTestSh(args) {
  const result = spawnSync('bash', ['tools/test.sh', ...args], {
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
run(['ci-job', 'fast-backend', '--plan-only'])
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

console.log('[test-matrix] ok')

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

run(['validate'])
run(['plan', 'production'])
run(['ci-plan', '--format', 'github-actions'])
run(['docs', '--out', '.tmp/docs/run-test-matrix-docs-compat.md'])

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

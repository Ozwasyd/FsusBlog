import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('the fixed migration catalog resolves through the sole matrix DAG', () => {
  const result = spawnSync(process.execPath, ['tools/check-test-orchestrator-uniqueness.mjs'], {
    cwd: root,
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /passed: \d+ tiers, 10 migrated lanes/u)
})

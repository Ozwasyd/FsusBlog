import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const backendQpsLane = path.join(root, 'tools/test/lanes/backend-qps.sh')
const runtimeCacheLane = path.join(root, 'tools/test/lanes/runtime-cache-evidence.sh')
const migrationTest = fileURLToPath(import.meta.url)
const retiredPaths = [
  'config/testing/backend-qps-scenario-catalog.json',
  'tools/test/run-backend-qps-scenarios.mjs',
  'tests/tools/backend-qps-driver.test.mjs'
]
const retiredReferences = [
  'backend-qps-scenario-catalog',
  'run-backend-qps-scenarios',
  'backend-qps-driver.test'
]
const temporaryRoots = []

function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(absolute))
    else if (/\.(?:json|mjs|sh)$/u.test(entry.name)) files.push(absolute)
  }
  return files
}

function createFakeNode() {
  const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-runtime-cache-cutover-'))
  temporaryRoots.push(directory)
  const executable = path.join(directory, 'node')
  const capture = path.join(directory, 'arguments.txt')
  writeFileSync(executable, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" >"$FSUSBLOG_ARGUMENT_CAPTURE"\n')
  chmodSync(executable, 0o755)
  return { executable, capture }
}

test.after(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true })
})

test('legacy backend QPS owners are deleted and closed over their migration-owned directories', () => {
  for (const relativePath of retiredPaths) {
    assert.equal(existsSync(path.join(root, relativePath)), false, `${relativePath} must stay retired`)
  }

  const roots = ['config/testing', 'tools/test', 'tests/tools'].map((directory) => path.join(root, directory))
  for (const file of roots.flatMap(sourceFiles)) {
    if (file === migrationTest) continue
    const source = readFileSync(file, 'utf8')
    for (const retiredReference of retiredReferences) {
      assert.equal(source.includes(retiredReference), false, `${path.relative(root, file)} retains ${retiredReference}`)
    }
  }
})

test('backend-qps lane rejects every legacy argument before executing the runtime cache lane', () => {
  const { executable, capture } = createFakeNode()
  const result = spawnSync(backendQpsLane, ['cache-hit'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FSUSBLOG_NODE: executable, FSUSBLOG_ARGUMENT_CAPTURE: capture }
  })

  assert.equal(result.status, 64)
  assert.match(result.stderr, /arguments are retired/u)
  assert.equal(existsSync(capture), false, 'legacy arguments must not reach the runtime-cache checker')
})

test('zero-argument backend-qps lane execs only the current runtime cache checker', () => {
  const { executable, capture } = createFakeNode()
  const result = spawnSync(backendQpsLane, [], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FSUSBLOG_NODE: executable, FSUSBLOG_ARGUMENT_CAPTURE: capture }
  })

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(
    readFileSync(capture, 'utf8').trim().split(/\r?\n/u),
    [path.join(root, 'tools/test/check-runtime-cache-evidence.mjs')]
  )
  assert.doesNotMatch(readFileSync(backendQpsLane, 'utf8'), /\$@/u)
  assert.match(readFileSync(runtimeCacheLane, 'utf8'), /check-runtime-cache-evidence\.mjs" "\$@"/u)
})

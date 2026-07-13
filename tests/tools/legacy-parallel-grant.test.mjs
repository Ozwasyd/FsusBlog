import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const legacy = path.join(root, 'tools/test/legacy-test.sh')

test('legacy run_parallel rolls jobs within the inherited CPU and memory grant', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-legacy-parallel-'))
  const markers = path.join(temp, 'markers.txt')
  const worker = path.join(temp, 'worker.mjs')
  fs.writeFileSync(worker, [
    "import fs from 'node:fs'",
    'const [file, id] = process.argv.slice(2)',
    "const append = (event) => fs.appendFileSync(file, `${JSON.stringify({ id, event, cpu: process.env.FSUSBLOG_STEP_CPU_BUDGET, memory: process.env.FSUSBLOG_STEP_MEMORY_GIB, nested: process.env.FSUSBLOG_NODE_TEST_CONCURRENCY })}\\n`)",
    "append('start')",
    "await new Promise((resolve) => setTimeout(resolve, 120))",
    "append('end')"
  ].join('\n'))

  const specs = ['a', 'b', 'c', 'd']
    .map((id) => `"${id}::node ${worker} ${markers} ${id}"`)
    .join(' ')
  const result = spawnSync('bash', ['-c', [
    'export FSUSBLOG_TEST_LEGACY_SOURCE_ONLY=1',
    `source ${legacy}`,
    `run_parallel grant-contract ${specs}`
  ].join('; ')], {
    cwd: root,
    env: {
      ...process.env,
      FSUSBLOG_BUNDLE_CPU_UNITS: '2',
      FSUSBLOG_BUNDLE_MEMORY_GIB: '4'
    },
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /parallel done: [a-d] \(\d+ms\)/u)
  const events = fs.readFileSync(markers, 'utf8').trim().split('\n').map(JSON.parse)
  let active = 0
  let maximum = 0
  for (const event of events) {
    if (event.event === 'start') active += 1
    else active -= 1
    maximum = Math.max(maximum, active)
  }
  assert.equal(maximum, 2)
  assert.equal(events.filter((event) => event.event === 'end').length, 4)
  assert.ok(events.every((event) => event.cpu === '1'))
  assert.ok(events.every((event) => event.memory === '2'))
  assert.ok(events.every((event) => event.nested === '1'))
  fs.rmSync(temp, { recursive: true, force: true })
})

test('legacy run_parallel gives a serial tail the complete STEP grant', () => {
  const result = spawnSync('bash', ['-c', [
    'export FSUSBLOG_TEST_LEGACY_SOURCE_ONLY=1',
    `source ${legacy}`,
    'run_parallel serial-contract "only::test \"$FSUSBLOG_STEP_CPU_BUDGET:$FSUSBLOG_STEP_MEMORY_GIB\" = 3:6"'
  ].join('; ')], {
    cwd: root,
    env: {
      ...process.env,
      FSUSBLOG_STEP_CPU_BUDGET: '3',
      FSUSBLOG_STEP_MEMORY_GIB: '6'
    },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
})

test('legacy run_parallel collects every bounded child failure', () => {
  const result = spawnSync('bash', ['-c', [
    'export FSUSBLOG_TEST_LEGACY_SOURCE_ONLY=1',
    `source ${legacy}`,
    'run_parallel failure-contract "a::sh -c \'exit 2\'" "b::sh -c \'exit 3\'" "c::true"'
  ].join('; ')], {
    cwd: root,
    env: {
      ...process.env,
      FSUSBLOG_BUNDLE_CPU_UNITS: '1',
      FSUSBLOG_BUNDLE_MEMORY_GIB: String(os.totalmem() / 1024 ** 3)
    },
    encoding: 'utf8'
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /a:2/u)
  assert.match(result.stderr, /b:3/u)
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const script = path.join(root, 'tools/coverage/merge-coverage.sh')

function writeSummary(coverageRoot, lane, summary) {
  const file = path.join(coverageRoot, lane, 'Summary.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof summary === 'string' ? summary : `${JSON.stringify(summary)}\n`)
  return file
}

function runMerge(coverageRoot, cpu = '2') {
  return spawnSync('bash', [script], {
    cwd: root,
    env: {
      ...process.env,
      FSUSBLOG_COVERAGE_ROOT: coverageRoot,
      FSUSBLOG_STEP_CPU_BUDGET: cpu,
      FSUSBLOG_STEP_MEMORY_GIB: '2'
    },
    encoding: 'utf8',
    timeout: 10_000
  })
}

test('coverage merge retains both summaries and weighted totals under a dynamic STEP grant', (t) => {
  const coverageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-coverage-merge-'))
  t.after(() => fs.rmSync(coverageRoot, { recursive: true, force: true }))
  writeSummary(coverageRoot, 'backend-merged', {
    summary: { assemblies: 2, classes: 3, files: 4 },
    totals: {
      lines: { covered: 80, total: 100 },
      branches: { covered: 30, total: 50 },
      methods: { covered: 20, total: 25 }
    },
    reportPaths: ['backend.xml']
  })
  writeSummary(coverageRoot, 'frontend', {
    summary: { assemblies: 1, classes: 5, files: 6 },
    totals: {
      lines: { covered: 45, total: 50 },
      branches: { covered: 40, total: 50 },
      methods: { covered: 15, total: 25 }
    },
    reportPaths: ['frontend.json']
  })

  const result = runMerge(coverageRoot)
  assert.equal(result.status, 0, result.stderr)
  const merged = JSON.parse(fs.readFileSync(path.join(coverageRoot, 'merged/Summary.json'), 'utf8'))
  assert.deepEqual(merged.totals.lines, { covered: 125, total: 150 })
  assert.deepEqual(merged.totals.branches, { covered: 70, total: 100 })
  assert.deepEqual(merged.totals.methods, { covered: 35, total: 50 })
  assert.equal(merged.sources.backend, true)
  assert.equal(merged.sources.frontend, true)
  assert.deepEqual(merged.sources.backendReportPaths, ['backend.xml'])
  assert.deepEqual(merged.sources.frontendReportPaths, ['frontend.json'])
})

test('coverage merge exposes every malformed input instead of stopping at the first', (t) => {
  const coverageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-coverage-merge-errors-'))
  t.after(() => fs.rmSync(coverageRoot, { recursive: true, force: true }))
  const backend = writeSummary(coverageRoot, 'backend-merged', '{broken backend')
  const frontend = writeSummary(coverageRoot, 'frontend', '{broken frontend')

  const result = runMerge(coverageRoot)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, new RegExp(backend.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.match(result.stderr, new RegExp(frontend.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
})

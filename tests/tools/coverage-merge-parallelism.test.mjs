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

function runMerge(coverageRoot, cpu = '2', extraEnvironment = {}) {
  return spawnSync('bash', [script], {
    cwd: root,
    env: {
      ...process.env,
      FSUSBLOG_COVERAGE_ROOT: coverageRoot,
      FSUSBLOG_STEP_CPU_BUDGET: cpu,
      FSUSBLOG_STEP_MEMORY_GIB: '2',
      ...extraEnvironment
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
    files: [{ path: 'src/backend/Example.cs', linecoverage: 80, branchcoverage: 60 }],
    reportPaths: ['backend-shard/coverage.json'],
    source: 'backend-coverlet-json-authoritative-merge',
    authoritativeRaw: '.tmp/coverage/backend-merged/coverage.json',
    exchangeFormats: ['.tmp/coverage/backend-merged/coverage.cobertura.xml'],
    producer: {
      runId: 'coverage-merge-test',
      sourceCommit: '0123456789abcdef',
      sourceFingerprint: 'fingerprint-0123456789abcdef'
    }
  })
  writeSummary(coverageRoot, 'frontend', {
    summary: { assemblies: 1, classes: 5, files: 6 },
    totals: {
      lines: { covered: 45, total: 50 },
      branches: { covered: 40, total: 50 },
      methods: { covered: 15, total: 25 }
    },
    files: [{ path: 'src/frontend/src/example.ts', linecoverage: 90, branchcoverage: 80 }],
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
  assert.deepEqual(merged.sources.backendReportPaths, ['backend-shard/coverage.json'])
  assert.deepEqual(merged.sources.frontendReportPaths, ['frontend.json'])
  assert.deepEqual(merged.files.map((file) => file.path), [
    'src/backend/Example.cs',
    'src/frontend/src/example.ts'
  ])
  assert.equal(merged.sources.backendAuthoritativeRaw, '.tmp/coverage/backend-merged/coverage.json')
  assert.deepEqual(merged.sources.backendExchangeFormats, [
    '.tmp/coverage/backend-merged/coverage.cobertura.xml'
  ])
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

test('coverage merge rejects a backend summary bound to a foreign release run', (t) => {
  const coverageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-coverage-merge-binding-'))
  t.after(() => fs.rmSync(coverageRoot, { recursive: true, force: true }))
  writeSummary(coverageRoot, 'backend-merged', {
    summary: { assemblies: 1, classes: 1, files: 1 },
    totals: {
      lines: { covered: 1, total: 1 },
      branches: { covered: 1, total: 1 },
      methods: { covered: 1, total: 1 }
    },
    files: [{ path: 'src/backend/Example.cs', linecoverage: 100, branchcoverage: 100 }],
    reportPaths: ['backend-shard/coverage.json'],
    source: 'backend-coverlet-json-authoritative-merge',
    authoritativeRaw: '.tmp/coverage/backend-merged/coverage.json',
    exchangeFormats: ['.tmp/coverage/backend-merged/coverage.cobertura.xml'],
    producer: {
      runId: 'foreign-run',
      sourceCommit: '0123456789abcdef',
      sourceFingerprint: 'fingerprint-0123456789abcdef'
    }
  })

  const result = runMerge(coverageRoot, '2', {
    FSUSBLOG_TEST_RUN_ID: 'current-run',
    FSUSBLOG_TEST_SOURCE_COMMIT: '0123456789abcdef',
    FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'fingerprint-0123456789abcdef'
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /backend runId binding mismatch/u)
})

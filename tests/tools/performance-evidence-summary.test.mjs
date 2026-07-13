import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolvePerformanceEvidenceWorkers } from '../../tools/test/aggregate-performance-evidence.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const aggregateScript = path.join(root, 'tools/test/aggregate-performance-evidence.mjs')
const sourceFiles = {
  'load-baseline': '.tmp/perf/release-summaries/load-baseline.json',
  'load-peak': '.tmp/perf/release-summaries/load-expected-peak.json',
  'backend-benchmark-regression': '.tmp/perf/release-summaries/backend-benchmark-regression.json',
  'browser-performance-regression': '.tmp/perf/release-summaries/browser-performance-regression.json'
}

function writeJson(base, relative, payload) {
  const absolute = path.join(base, relative)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, `${JSON.stringify(payload, null, 2)}\n`)
}

function runAggregator(base) {
  return spawnSync(process.execPath, [aggregateScript, '--root', base], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000
  })
}

test('performance evidence workers follow the complete scheduler grant and source count', () => {
  assert.equal(resolvePerformanceEvidenceWorkers({
    sourceCount: 4,
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '3',
      FSUSBLOG_STEP_MEMORY_GIB: '2'
    },
    cpuCount: 8,
    freeMemoryBytes: 512,
    totalMemoryBytes: 8192,
    load1: 8
  }), 3)
  assert.equal(resolvePerformanceEvidenceWorkers({
    sourceCount: 2,
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '8',
      FSUSBLOG_STEP_MEMORY_GIB: '8'
    },
    cpuCount: 16,
    freeMemoryBytes: 16384,
    totalMemoryBytes: 16384,
    load1: 0
  }), 2)
})

test('performance evidence aggregation reports every missing producer in one run', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-perf-summary-missing-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))

  const result = runAggregator(temp)
  assert.notEqual(result.status, 0)
  for (const id of Object.keys(sourceFiles)) {
    assert.match(result.stderr, new RegExp(`missing ${id} performance evidence`, 'u'))
  }
})

test('performance evidence producers stay isolated and the fresh aggregate retains all four classes', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-perf-summary-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  for (const [id, relative] of Object.entries(sourceFiles)) {
    writeJson(temp, relative, { schema: `fixture.${id}.v1`, status: 'ok', id })
  }
  writeJson(temp, '.tmp/release-evidence/perf-summary.json', { stale: true })

  const first = runAggregator(temp)
  assert.equal(first.status, 0, first.stderr)
  const outputFile = path.join(temp, '.tmp/release-evidence/perf-summary.json')
  const firstSummary = JSON.parse(fs.readFileSync(outputFile, 'utf8'))
  assert.equal(firstSummary.schema, 'fsusblog.performance-evidence-summary.v1')
  assert.equal(firstSummary.status, 'blocked')
  assert.equal(firstSummary.stale, undefined)
  assert.deepEqual(firstSummary.entries.map((entry) => entry.id), [
    ...Object.keys(sourceFiles),
    'performance-saturation-v2'
  ])
  assert.ok(firstSummary.entries.slice(0, 4).every((entry) => entry.status === 'ok' && entry.summary.id === entry.id))
  assert.equal(firstSummary.entries.at(-1).status, 'blocked')
  assert.match(firstSummary.entries.at(-1).summary.reason, /not supplied/u)

  writeJson(temp, sourceFiles['browser-performance-regression'], {
    schema: 'fixture.browser-performance-regression.v1',
    status: 'blocked',
    id: 'browser-performance-regression'
  })
  const second = runAggregator(temp)
  assert.equal(second.status, 0, second.stderr)
  const secondSummary = JSON.parse(fs.readFileSync(outputFile, 'utf8'))
  assert.equal(secondSummary.status, 'blocked')
  assert.deepEqual(secondSummary.entries.map((entry) => entry.id), [
    ...Object.keys(sourceFiles),
    'performance-saturation-v2'
  ])
  assert.equal(secondSummary.entries.find((entry) => entry.id === 'browser-performance-regression').status, 'blocked')
  for (const relative of Object.values(sourceFiles)) assert.ok(fs.existsSync(path.join(temp, relative)))

  writeJson(temp, sourceFiles['backend-benchmark-regression'], {
    status: 'failed',
    id: 'backend-benchmark-regression'
  })
  const third = runAggregator(temp)
  assert.equal(third.status, 0, third.stderr)
  assert.equal(JSON.parse(fs.readFileSync(outputFile, 'utf8')).status, 'failed')
})

test('performance aggregate restores producer summaries from downloaded CI artifacts', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-perf-summary-ci-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  for (const [id, relative] of Object.entries(sourceFiles)) {
    const artifactName = id.startsWith('load-') ? 'load-smoke' : 'perf-regression'
    const artifactRelative = id.startsWith('load-') ? relative.replace(/^\.tmp\//u, '') : relative
    const downloadedRelative = path.join(
      '.tmp/downloaded-artifacts',
      artifactName,
      artifactRelative
    )
    writeJson(temp, downloadedRelative, { status: 'ok', id })
  }

  const result = runAggregator(temp)
  assert.equal(result.status, 0, result.stderr)
  const summary = JSON.parse(fs.readFileSync(path.join(temp, '.tmp/release-evidence/perf-summary.json'), 'utf8'))
  assert.deepEqual(summary.entries.map((entry) => entry.id), [
    ...Object.keys(sourceFiles),
    'performance-saturation-v2'
  ])
  assert.ok(summary.entries.slice(0, 4).every((entry) => entry.sourceLocation.startsWith('.tmp/downloaded-artifacts/')))
  assert.equal(summary.entries.at(-1).sourceLocation, null)
})

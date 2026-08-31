import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const aggregateScript = path.join(root, 'tools/test/aggregate-data-scale-evidence.mjs')
const sourceFiles = {
  'scale-xs': '.tmp/scale/release-summaries/scale-xs.json',
  'scale-s': '.tmp/scale/release-summaries/scale-s.json'
}

function writeJson(base, relative, payload) {
  const absolute = path.join(base, relative)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, `${JSON.stringify(payload, null, 2)}\n`)
}

function runAggregator(base, env = {}) {
  return spawnSync(process.execPath, [aggregateScript, '--root', base], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 10_000
  })
}

function sourceSummary(tier, status = 'ok') {
  return {
    schema: 'fsusblog.data-scale-tier-summary.v1',
    status,
    tier,
    expectedSeed: tier === 'scale-xs'
      ? { articles: 1, comments: 0 }
      : { articles: 100, comments: 1000 },
    seed: { status },
    observed: { status },
    cleanup: { status }
  }
}

test('data-scale aggregate retains both production tiers and replaces stale output atomically', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-data-scale-summary-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  for (const [tier, relative] of Object.entries(sourceFiles)) {
    writeJson(temp, relative, sourceSummary(tier))
  }
  writeJson(temp, '.tmp/release-evidence/data-scale-summary.json', { stale: true })

  const result = runAggregator(temp)
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(fs.readFileSync(
    path.join(temp, '.tmp/release-evidence/data-scale-summary.json'),
    'utf8'
  ))
  assert.equal(output.schema, 'fsusblog.data-scale-evidence-summary.v1')
  assert.equal(output.status, 'ok')
  assert.equal(output.stale, undefined)
  assert.deepEqual(output.requiredTiers, ['scale-xs', 'scale-s'])
  assert.deepEqual(output.tiers.map((entry) => entry.tier), ['scale-xs', 'scale-s'])
  assert.ok(output.tiers.every((entry) => entry.summary.tier === entry.tier))

  writeJson(temp, sourceFiles['scale-xs'], sourceSummary('scale-xs', 'blocked'))
  writeJson(temp, sourceFiles['scale-s'], sourceSummary('scale-s', 'failed'))
  const failed = runAggregator(temp)
  assert.equal(failed.status, 0, failed.stderr)
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(temp, '.tmp/release-evidence/data-scale-summary.json'),
    'utf8'
  )).status, 'failed')
})

test('data-scale aggregate restores unique summaries from a transport manifest', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-data-scale-summary-ci-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  writeJson(temp, 'artifacts/current-run/transport/scale-xs.json', sourceSummary('scale-xs'))
  writeJson(temp, 'artifacts/current-run/transport/scale-s.json', sourceSummary('scale-s'))
  writeJson(temp, 'artifacts/current-run/transport-manifest.json', {
    schema: 'fsusblog.current-run-evidence-transport-manifest.v1',
    objects: [
      {
        authorityId: 'evidence-consumer.test.aggregate-data-scale-evidence.scale-xs',
        archiveEntries: [{ path: 'artifacts/current-run/transport/scale-xs.json',
          extractedPath: 'artifacts/current-run/transport/scale-xs.json' }]
      },
      {
        authorityId: 'evidence-consumer.test.aggregate-data-scale-evidence.scale-s',
        archiveEntries: [{ path: 'artifacts/current-run/transport/scale-s.json',
          extractedPath: 'artifacts/current-run/transport/scale-s.json' }]
      }
    ]
  })
  const result = runAggregator(temp, {
    FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST: path.join(temp, 'artifacts/current-run/transport-manifest.json')
  })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(fs.readFileSync(
    path.join(temp, '.tmp/release-evidence/data-scale-summary.json'),
    'utf8'
  ))
  assert.equal(output.status, 'ok')
  assert.ok(output.tiers.every((entry) => (
    entry.sourceLocation.startsWith('artifacts/current-run/transport/')
  )))
})

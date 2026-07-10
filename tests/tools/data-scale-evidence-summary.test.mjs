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

function runAggregator(base) {
  return spawnSync(process.execPath, [aggregateScript, '--root', base], {
    cwd: root,
    encoding: 'utf8'
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

test('data-scale aggregate retains both production tiers and replaces stale output atomically', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-data-scale-summary-'))
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

test('data-scale aggregate restores unique summaries from either CI artifact layout', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-data-scale-summary-ci-'))
  writeJson(
    temp,
    '.tmp/downloaded-artifacts/integration-runtime/scale/release-summaries/scale-xs.json',
    sourceSummary('scale-xs')
  )
  writeJson(
    temp,
    '.tmp/downloaded-artifacts/integration-runtime/.tmp/scale/release-summaries/scale-s.json',
    sourceSummary('scale-s')
  )

  const result = runAggregator(temp)
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(fs.readFileSync(
    path.join(temp, '.tmp/release-evidence/data-scale-summary.json'),
    'utf8'
  ))
  assert.equal(output.status, 'ok')
  assert.ok(output.tiers.every((entry) => (
    entry.sourceLocation.startsWith('.tmp/downloaded-artifacts/integration-runtime/')
  )))
})

test('lane, matrix, registry, and workflow assign one writer to the production aggregate', () => {
  const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/data-scale.sh'), 'utf8')
  const matrix = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8')
  const registry = fs.readFileSync(path.join(root, 'tests/coverage-registry.json'), 'utf8')
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8')

  assert.match(lane, /RELEASE_SUMMARY_DIR=.*\.tmp\/scale\/release-summaries/u)
  assert.match(lane, /RELEASE_SUMMARY_DIR\/\$TIER\.json/u)
  assert.doesNotMatch(lane, />\s*"\$ROOT_DIR\/\.tmp\/release-evidence\/data-scale-summary\.json"/u)

  assert.match(matrix, /- id: data-scale-evidence-summary[\s\S]*?dependsOn: \[data-scale-xs, data-scale-s\]/u)
  assert.match(matrix, /- id: release-evidence[\s\S]*?dependsOn: \[[^\]]*data-scale-evidence-summary/u)
  for (const tier of ['scale-xs', 'scale-s']) {
    assert.match(matrix, new RegExp(`- id: data-${tier}[\\s\\S]*?evidence: \\[\\.tmp/scale/release-summaries/${tier}\\.json\\]`, 'u'))
    assert.match(registry, new RegExp(`"id": "${tier === 'scale-xs' ? 'scale-xs-empty-single' : 'scale-s-100-articles-1k-comments'}"[\\s\\S]*?"\\.tmp/scale/release-summaries/${tier}\\.json"`, 'u'))
  }
  assert.match(workflow, /\.\/tools\/test\.sh data-scale-evidence-summary --no-deps/u)
})

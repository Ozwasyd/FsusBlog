import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseMatrix, tierExecutionDependencies } from '../../tools/test-matrix/parse-matrix.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const matrix = parseMatrix(read('tests/matrix.yml'))
const tiers = new Map(matrix.tiers.map((tier) => [tier.id, tier]))

function dependencyClosure(id, seen = new Set()) {
  if (seen.has(id)) return seen
  const tier = tiers.get(id)
  assert.ok(tier, `missing matrix tier ${id}`)
  seen.add(id)
  for (const dependency of tierExecutionDependencies(tier)) dependencyClosure(dependency, seen)
  return seen
}

function workflowJob(source, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const marker = source.match(new RegExp(`^(?<indent>[ \\t]+)${escapedId}:[ \\t]*$`, 'mu'))
  assert.ok(marker?.groups?.indent, `missing workflow job ${id}`)
  const start = marker.index
  const bodyStart = start + marker[0].length
  const next = source
    .slice(bodyStart)
    .search(new RegExp(`^${marker.groups.indent}[A-Za-z0-9_-]+:[ \\t]*$`, 'mu'))
  return next === -1 ? source.slice(start) : source.slice(start, bodyStart + next)
}

test('matrix evidence classes make every real browser boundary explicit', () => {
  const schema = JSON.parse(read('tests/matrix.schema.json'))
  assert.deepEqual(
    schema.properties.tiers.items.properties.evidenceClass.enum,
    ['correctness', 'browser-contract', 'diagnostic']
  )

  for (const tier of matrix.tiers.filter((entry) => entry.requiresPlaywright !== 'none')) {
    assert.equal(
      tier.evidenceClass,
      tier.id === 'browser-contract' ? 'browser-contract' : 'diagnostic',
      `${tier.id} has an ambiguous browser evidence class`
    )
  }

  assert.equal(tiers.get('production-correctness')?.evidenceClass, 'correctness')
  assert.equal(tiers.get('release-final')?.evidenceClass, 'correctness')
})

test('authoritative correctness excludes diagnostics while release final adds one browser contract', () => {
  const production = dependencyClosure('production-correctness')
  assert.deepEqual(
    [...production].filter((id) => tiers.get(id)?.evidenceClass === 'diagnostic'),
    []
  )
  assert.deepEqual(
    [...production].filter((id) => tiers.get(id)?.evidenceClass === 'browser-contract'),
    []
  )

  const release = dependencyClosure('release-final')
  assert.deepEqual(
    [...release].filter((id) => tiers.get(id)?.evidenceClass === 'browser-contract'),
    ['browser-contract']
  )
  assert.deepEqual(
    [...release].filter((id) => tiers.get(id)?.evidenceClass === 'diagnostic'),
    []
  )
})

test('release evidence plan serializes the resolved evidence class', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-1151-evidence-plan-'))
  const output = path.join(directory, 'plan.json')
  try {
    const result = spawnSync(process.execPath, [
      'tools/run-test-matrix.mjs',
      'evidence-plan',
      '--out', output
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const plan = JSON.parse(fs.readFileSync(output, 'utf8'))
    const planned = new Map(plan.tiers.map((tier) => [tier.id, tier]))
    assert.equal(planned.get('production-correctness')?.evidenceClass, 'correctness')
    assert.equal(planned.get('browser-contract')?.evidenceClass, 'browser-contract')
    assert.equal(planned.get('browser-diagnostics-nightly')?.evidenceClass, 'diagnostic')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('workflow aggregates keep diagnostics outside correctness', () => {
  const qualityGate = read('.github/workflows/quality-gate.yml')
  const productionSummary = workflowJob(qualityGate, 'production-summary')
  assert.doesNotMatch(productionSummary, /- browser-contract|- browser-diagnostics/u)

  const browserContract = workflowJob(qualityGate, 'browser-contract')
  assert.doesNotMatch(browserContract, /run-flaky-governed|--retry/u)

  const diagnostics = read('.github/workflows/browser-diagnostics.yml')
  assert.match(diagnostics, /^\s+schedule:/mu)
  assert.match(diagnostics, /^\s+workflow_dispatch:/mu)
  assert.doesNotMatch(diagnostics, /^\s+(?:pull_request|push):/mu)
})

test('testing docs state the four execution boundaries without compatibility ambiguity', () => {
  const docs = `${read('docs/testing.md')}\n${read('docs/testing/browser-contract.md')}`
  for (const expected of [
    '普通 PR',
    'production-correctness',
    'release-final',
    'Browser Contract',
    'nightly/manual',
    '零浏览器'
  ]) assert.match(docs, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
})

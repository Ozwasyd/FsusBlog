import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const workflow = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8')

function jobBlock(jobId) {
  const marker = `  ${jobId}:\n`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `missing workflow job: ${jobId}`)
  const next = workflow.slice(start + marker.length).search(/^  [A-Za-z0-9_-]+:\n/mu)
  return next < 0
    ? workflow.slice(start)
    : workflow.slice(start, start + marker.length + next)
}

function downloadDestination(block, selector, value) {
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = block.match(new RegExp(
    `actions/download-artifact@[\\s\\S]*?${selector}: ${escapedValue}\\n[\\s\\S]*?path: ([^\\n]+)`,
    'u'
  ))
  assert.ok(match, `missing download selector ${selector}: ${value}`)
  return match[1].trim()
}

test('fast summary restores artifacts rooted below .tmp back into .tmp', () => {
  const block = jobBlock('fast-summary')
  for (const artifact of [
    'frontend-runtime-contracts',
    'frontend-static-governance',
    'fast-static-governance'
  ]) {
    assert.equal(downloadDestination(block, 'name', artifact), '.tmp', artifact)
  }
})

test('backend QPS aggregate restores collector artifacts back into .tmp', () => {
  const block = jobBlock('backend-qps')
  assert.equal(downloadDestination(block, 'pattern', 'backend-qps-collectors-*'), '.tmp')
  assert.match(block, /pattern: backend-qps-collectors-\*[\s\S]*?merge-multiple: true/u)
})

test('matrix validation uses the authoritative testing docs checker', () => {
  const block = jobBlock('validate-matrix')
  assert.match(block, /node tools\/docs\/generate-testing-docs\.mjs --check/u)
  assert.doesNotMatch(block, /node tools\/run-test-matrix\.mjs docs|cmp docs\/testing\.generated\.md/u)
  assert.match(block, /\.tmp\/docs\/generated-testing-docs\.json/u)
  assert.doesNotMatch(block, /\.tmp\/docs\/testing\.generated\.md/u)
})

test('aggregate artifact lookup expands single and recursive wildcard segments', async (t) => {
  const moduleUrl = pathToFileURL(path.join(root, 'tools/test-matrix/scheduler.mjs')).href
  const artifactPaths = await import(moduleUrl).catch(() => null)
  assert.equal(typeof artifactPaths?.aggregateArtifactPathExists, 'function')

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-aggregate-artifacts-'))
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
  const downloadedRoot = path.join(fixtureRoot, '.tmp/downloaded-artifacts')

  fs.mkdirSync(path.join(fixtureRoot, '.tmp/coverage/backend/special-api/run-123'), { recursive: true })
  fs.writeFileSync(path.join(fixtureRoot, '.tmp/coverage/backend/special-api/run-123/coverage.json'), '{}\n')
  fs.mkdirSync(path.join(fixtureRoot, '.tmp/results/shard-a'), { recursive: true })
  fs.writeFileSync(path.join(fixtureRoot, '.tmp/results/shard-a/result.json'), '{}\n')
  fs.mkdirSync(path.join(downloadedRoot, 'frontend-artifact/.tmp/frontend/timings'), { recursive: true })
  fs.writeFileSync(path.join(downloadedRoot, 'frontend-artifact/.tmp/frontend/timings/unit.json'), '{}\n')

  const exists = (declaration) => artifactPaths.aggregateArtifactPathExists({
    root: fixtureRoot,
    downloadedRoot,
    declaration
  })

  assert.equal(exists('.tmp/coverage/backend/special-api/**/coverage.json'), true)
  assert.equal(exists('.tmp/results/*/result.json'), true)
  assert.equal(exists('.tmp/results/*/*/result.json'), false)
  assert.equal(exists('.tmp/frontend/**/unit.json'), true)
  assert.equal(exists('.tmp/coverage/backend/special-api/**/coverage.cobertura.xml'), false)
})

test('matrix aggregate delegates artifact declarations to the wildcard-aware lookup', () => {
  const source = fs.readFileSync(path.join(root, 'tools/run-test-matrix.mjs'), 'utf8')
  assert.match(source, /import \{[\s\S]*?aggregateArtifactPathExists,[\s\S]*?\} from '\.\/test-matrix\/scheduler\.mjs'/u)
  assert.match(source, /return aggregateArtifactPathExists\(\{ root, downloadedRoot, declaration: rel \}\)/u)
})

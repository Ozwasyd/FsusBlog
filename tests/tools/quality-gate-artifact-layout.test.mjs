import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
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

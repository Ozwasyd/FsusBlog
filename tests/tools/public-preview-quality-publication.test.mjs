import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadPublicPreviewRegistry } from '../../tools/docs/public-preview-registry.mjs'
import {
  comparePublicPreviewQualityManifests,
  createPublicPreviewQualityManifest,
  validatePublicPreviewQualityManifest,
  writePublicPreviewQualityManifest
} from '../../tools/docs/public-preview-quality-publication.mjs'
import {
  createPublicPreviewQualityMatrix,
  publicPreviewQualityReportSchema,
  qualitySidecarFile
} from '../../tools/docs/public-preview-quality.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const commit = 'a'.repeat(40)

function check(status = 'pass') {
  return { status, findings: [] }
}

function report(scenario, status = 'pass') {
  return {
    schema: publicPreviewQualityReportSchema,
    id: scenario.id,
    route: scenario.route,
    viewport: scenario.viewport ?? scenario.qualityViewport,
    theme: scenario.theme,
    locale: scenario.locale,
    zoom: scenario.zoom,
    surfaceRole: scenario.surfaceRole,
    linkedIssues: scenario.linkedIssues,
    status,
    machine: {
      overflow: check(status === 'fail' ? 'fail' : 'pass'),
      overlaps: check(),
      clippedText: check(),
      hitTargets: check(),
      focusClipping: check(),
      localeCoherence: check(),
      headerStability: check(),
      primaryTask: check()
    },
    reviewer: { classification: status, reasons: [], metrics: {} }
  }
}

function seed(directory, failureId = null) {
  const registry = loadPublicPreviewRegistry(root)
  mkdirSync(directory, { recursive: true })
  for (const entry of registry.screenshots) {
    const value = report({ ...entry, viewport: entry.qualityViewport }, entry.id === failureId ? 'fail' : 'pass')
    writeFileSync(qualitySidecarFile(directory, entry.file), JSON.stringify(value))
  }
  const matrixReports = registry.qualityScenarios.map((scenario) => report(
    scenario,
    scenario.id === failureId ? 'fail' : 'pass'
  ))
  writeFileSync(path.join(directory, 'quality-matrix.json'), JSON.stringify(createPublicPreviewQualityMatrix(matrixReports)))
}

test('quality publication embeds one report per PNG plus the complete policy-bound matrix', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fsus-public-preview-quality-'))
  seed(directory)
  const output = path.join(directory, 'quality.json')
  const manifest = writePublicPreviewQualityManifest(directory, commit, root, output)
  assert.equal(manifest.status, 'pass')
  assert.equal(Object.keys(manifest.screenshots).length, 9)
  assert.equal(manifest.matrix.scenarioCount, loadPublicPreviewRegistry(root).qualityScenarios.length)
  assert.match(manifest.policyDigest, /^[a-f0-9]{64}$/u)
  assert.deepEqual(validatePublicPreviewQualityManifest(output, root), [])
})

test('quality publication rejects a stable but failed machine report', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fsus-public-preview-quality-fail-'))
  seed(directory, loadPublicPreviewRegistry(root).screenshots[0].id)
  assert.equal(createPublicPreviewQualityManifest(directory, commit, root).status, 'fail')
  assert.throws(() => writePublicPreviewQualityManifest(directory, commit, root, path.join(directory, 'quality.json')), /publication is fail/u)
})

test('quality comparison augments existing release evidence and rejects mismatched manifests', () => {
  const committed = mkdtempSync(path.join(tmpdir(), 'fsus-public-preview-quality-committed-'))
  const captured = mkdtempSync(path.join(tmpdir(), 'fsus-public-preview-quality-captured-'))
  seed(committed)
  seed(captured)
  const committedManifest = path.join(committed, 'quality.json')
  const capturedManifest = path.join(captured, 'quality.json')
  writePublicPreviewQualityManifest(committed, commit, root, committedManifest)
  writePublicPreviewQualityManifest(captured, commit, root, capturedManifest)
  const evidence = path.join(captured, 'release-evidence.json')
  writeFileSync(evidence, JSON.stringify({ schema: 'fsusblog.public-preview-screenshot-verification.v1', status: 'ok' }))
  const result = comparePublicPreviewQualityManifests(capturedManifest, committedManifest, evidence, root)
  assert.deepEqual(result.errors, [])
  assert.equal(result.evidence.qualityAudit, true)
  assert.equal(result.evidence.quality.schema, 'fsusblog.public-preview-quality-manifest.v1')

  const tampered = JSON.parse(readFileSync(capturedManifest, 'utf8'))
  tampered.sourceCommit = 'b'.repeat(40)
  writeFileSync(capturedManifest, JSON.stringify(tampered))
  const mismatch = comparePublicPreviewQualityManifests(capturedManifest, committedManifest, evidence, root)
  assert.match(mismatch.errors.join('; '), /differs/u)
  assert.equal(mismatch.evidence.status, 'failed')
})

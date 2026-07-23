import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  readBrowserCapabilityRiskCatalog,
  selectBrowserCapabilityRisk,
  validateBrowserCapabilityRiskCatalog
} from '../../tools/testing/browser-capability-risk.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalog = readBrowserCapabilityRiskCatalog()

test('catalog, Playwright projects, matrix metadata and stable test IDs agree', () => {
  assert.equal(validateBrowserCapabilityRiskCatalog(catalog), catalog)
  assert.deepEqual(catalog.engines, ['chromium', 'firefox', 'webkit'])
  assert.deepEqual(
    Object.keys(catalog.profiles),
    [
      'browser-primary-correctness',
      'browser-capability-delta',
      'browser-full-matrix'
    ]
  )
  const fullProfile = catalog.profiles['browser-full-matrix']
  assert.deepEqual(
    fullProfile.cadence,
    ['local-explicit-full', 'nightly', 'release-reliability', 'release-final']
  )
  const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/cross-browser-smoke.sh'), 'utf8')
  assert.match(lane, /browser-full-matrix/u)
  assert.match(lane, /browser-capability-delta/u)
  assert.match(lane, /browser-primary-correctness/u)
})

test('ordinary UI and business changes select only Chromium primary correctness', () => {
  const proof = selectBrowserCapabilityRisk({
    changedPaths: ['src/frontend/src/views/ArchiveView.vue'],
    catalog
  })
  assert.equal(proof.profile, 'browser-primary-correctness')
  assert.deepEqual(proof.affectedRiskIds, [])
  assert.deepEqual(proof.engines, ['chromium'])
  assert.deepEqual(proof.scenarios.map((scenario) => scenario.id), [
    'primary-public-route-navigation'
  ])
  assert.match(proof.excluded[0].reason, /Chromium canonical evidence/u)
})

test('service worker and worker changes select every required engine delta', () => {
  const proof = selectBrowserCapabilityRisk({
    changedPaths: ['src/frontend/src/workers/wasmDecode.worker.ts'],
    catalog
  })
  assert.equal(proof.profile, 'browser-capability-delta')
  assert.deepEqual(proof.engines, ['chromium', 'firefox', 'webkit'])
  assert.deepEqual(proof.scenarios.map((scenario) => scenario.id), [
    'capability-engine-delta'
  ])
  assert.deepEqual(proof.affectedRiskIds, [
    'browser-cache-storage-runtime',
    'browser-service-worker-policy'
  ])
})

test('an explicit delta profile produces a complete capability proof', () => {
  const proof = selectBrowserCapabilityRisk({
    requestedProfile: 'browser-capability-delta',
    catalog
  })
  assert.equal(proof.profile, 'browser-capability-delta')
  assert.deepEqual(proof.engines, ['chromium', 'firefox', 'webkit'])
  assert.deepEqual(proof.affectedRiskIds, catalog.risks.map((risk) => risk.id).sort())
})

test('catalog, selector, matrix or Playwright changes select the complete matrix', () => {
  for (const changedPath of [
    'tests/browser-capability-risk/catalog.json',
    'tools/testing/browser-capability-risk.mjs',
    'src/frontend/playwright.config.ts',
    'tests/matrix.yml'
  ]) {
    const proof = selectBrowserCapabilityRisk({ changedPaths: [changedPath], catalog })
    assert.equal(proof.profile, 'browser-full-matrix', changedPath)
    assert.deepEqual(proof.engines, ['chromium', 'firefox', 'webkit'])
    assert.deepEqual(
      proof.scenarios.map((scenario) => scenario.id).sort(),
      ['capability-engine-delta', 'primary-public-route-navigation']
    )
    assert.deepEqual(
      proof.affectedRiskIds,
      catalog.risks.map((risk) => risk.id).sort()
    )
    assert.deepEqual(
      proof.scenarios.flatMap((scenario) =>
        scenario.engines.map((engine) => `${scenario.id}/${engine}`)).sort(),
      [
        'capability-engine-delta/chromium',
        'capability-engine-delta/firefox',
        'capability-engine-delta/webkit',
        'primary-public-route-navigation/chromium'
      ]
    )
  }
})

test('coverage proof fails closed for unknown engines, orphan risks and missing test IDs', () => {
  assert.throws(
    () => validateBrowserCapabilityRiskCatalog({
      ...catalog,
      risks: [
        ...catalog.risks,
        {
          id: 'orphan-risk',
          triggers: ['src/frontend/src/unknown/**'],
          requiredEngines: ['servo'],
          scenarioIds: ['missing-scenario'],
          fallbackSemantics: '',
          chromiumCanonicalEvidence: ['missing-test-id'],
          profileOwner: 'missing-profile'
        }
      ]
    }),
    /unknown engine|unknown scenario|no fallback semantics|unknown Chromium evidence|unknown profile owner/u
  )
})

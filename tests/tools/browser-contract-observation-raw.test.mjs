import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { browserContractScenarios } from '../browser-contract/contract.mjs'
import {
  produceClassReceipt,
  seal
} from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import {
  bindBrowserPostRuntimeObservation,
  deriveBrowserObservedRawFacts,
  projectBrowserContractRaw,
  verifyBrowserContractRaw
} from '../../tools/test-evidence/browser-contract-observation-raw.mjs'
import { sealBrowserContractReceipt } from '../../tools/release/test-evidence-receipts.mjs'
import { root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import { createBrowserContractObservationFixture } from './support/browser-contract-observation-fixture.mjs'

const runId = 'browser-observation-test'
const fileDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`

const fixture = createBrowserContractObservationFixture

function project(value)
{
  return projectBrowserContractRaw({
    candidatePlan: value.relative(value.planFile),
    browserContractReceipt: value.relative(value.browserFile),
    repositoryRoot: value.repositoryRoot
  })
}

test('canonical Browser source seals observed facts and independently bound plan and preview bytes', (context) =>
{
  const value = fixture(context)
  assert.deepEqual(value.browser.rawFacts, deriveBrowserObservedRawFacts(value.browser, value.publicPreviewEvidence))
  assert.equal(value.browser.candidatePlanRef.fileDigest, fileDigest(value.planFile))
  assert.equal(value.browser.publicPreviewRef.fileDigest, fileDigest(value.publicPreviewFile))
  assert.equal(value.browser.publicPreviewRef.schema, 'fsusblog.public-preview-screenshot-verification.v1')
  assert.equal(value.browser.publicPreviewRef.fileDigest, value.browser.publicPreview.evidenceFileDigest)
  assert.equal(value.browser.rawFacts.state.some((entry) => entry.status !== 'success'), false)
  const substituted = structuredClone(value.browser)
  substituted.runIdentity.attemptId = 'wrong-attempt'
  assert.throws(() => bindBrowserPostRuntimeObservation({
    candidatePlan: value.relative(value.planFile), browser: substituted, repositoryRoot: value.repositoryRoot
  }), /identities do not exact-match/u)
})

test('Browser projector refuses source raw facts that disagree with retained observations', (context) =>
{
  const value = fixture(context)
  value.browser.rawFacts.state = [{ id: 'invented', status: 'success', classification: 'clean' }]
  fs.writeFileSync(value.browserFile, `${JSON.stringify(sealBrowserContractReceipt(value.browser), null, 2)}\n`)
  assert.throws(() => project(value), /raw facts do not replay/u)
})

test('browser raw projector binds exact tests, dimensions, semantics, and current candidate identities', (context) =>
{
  const value = fixture(context)
  const raw = project(value)
  assert.match(raw.independentVerifyCommand, /verify --candidate-plan .* --receipt /u)
  assert.equal(raw.schema, 'fsusblog.browser-contract-receipt.v2')
  if ('contractTestId' in raw.semanticFacts)
  {
    assert.match(raw.semanticFacts.contractTestId, /browser-contract:article-publish-persistence/u)
    assert.match(raw.semanticFacts.viewport, /390x844@1/u)
    assert.match(raw.semanticFacts.viewport, /1440x960@1/u)
    assert.equal(raw.semanticFacts.theme, 'theme:dark+light')
    assert.match(raw.semanticFacts.stateDigest, /^sha256:[a-f0-9]{64}$/u)
  }
  else
  {
    assert.deepEqual(raw.semanticFacts.requiredTestIds,
      browserContractScenarios.map(({ id }) => `browser-contract:${id}`).sort())
    assert.match(raw.semanticFacts.viewportId, /390x844@1/u)
    assert.match(raw.semanticFacts.viewportId, /1440x960@1/u)
    assert.equal(raw.semanticFacts.themeId, 'theme:dark+light')
    assert.match(raw.semanticFacts.stateId, /^clean-success:sha256:[a-f0-9]{64}$/u)
  }
  for (const field of ['interactionDigest', 'domDigest', 'a11yDigest', 'networkDigest', 'consoleDigest'])
  {
    assert.match(raw.semanticFacts[field], /^sha256:[a-f0-9]{64}$/u, field)
  }
  assert.notEqual(raw.semanticFacts.screenshotOnly, true)
  if ('contractTestId' in raw.semanticFacts)
  {
    assert.equal(raw.sourceState.browserIdentity, `${runId}:browser-contract`)
  }
  else
  {
    assert.equal(raw.sourceState.browserIdentity, `${runId}-browser-contract`)
  }
  assert.equal(raw.sourceState.runId, runId)
  assert.equal(raw.sourceState.attemptId, 'attempt-0001')

  fs.writeFileSync(path.join(value.repositoryRoot, value.rawPath), `${JSON.stringify(raw, null, 2)}\n`)
  assert.equal(verifyBrowserContractRaw(
    value.rawPath, value.repositoryRoot, value.relative(value.planFile)).contentDigest, raw.contentDigest)
  assert.equal(produceClassReceipt({
    candidatePlan: value.relative(value.planFile),
    classId: 'browser-behavior-contract',
    result: value.rawPath,
    repositoryRoot: value.repositoryRoot
  }).status, 'qualified')
})

test('quality gate keeps Browser Contract on the canonical parent run authority', () =>
{
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8')
  const browserJob = workflow.slice(workflow.indexOf('\n    browser-contract:'), workflow.indexOf('\n    resilience-runtime:'))
  assert.doesNotMatch(browserJob, /FSUSBLOG_BROWSER_CONTRACT_RUN_ID:/u)
  const lifecycle = fs.readFileSync(path.join(root, 'tests/browser-contract/fixture-lifecycle.mjs'), 'utf8')
  assert.match(lifecycle, /FSUSBLOG_TEST_RUN_ID/u)
  assert.match(lifecycle, /Browser Contract run authorities disagree/u)
})

test('browser raw projector rejects diagnostic, partial, stale, and screenshot-only-shaped receipts', (context) =>
{
  const cases = [
    ['diagnostic schema', (browser) => { browser.schema = 'fsusblog.browser-diagnostics-receipt.v2' }, /non-qualifying/u],
    ['another candidate run', (browser) => { browser.runIdentity.runId = 'other-run' }, /identities do not exact-match/u],
    ['another candidate attempt', (browser) => { browser.runIdentity.attemptId = 'attempt-0002' }, /identities do not exact-match/u],
    ['missing required test', (browser) => {
      browser.scenarios.pop()
      browser.topology.contextCount = browser.scenarios.length
    }, /required test closure/u],
    ['missing executed fields', (browser) => { browser.scenarios[0].durationMs = null }, /missing clean executed facts/u],
    ['non-terminal source', (browser) => { delete browser.finalization }, /diagnostic, recovered, retried, or not terminal/u],
    ['missing quality evidence', (_browser, evidence) => { evidence.quality.matrix.reports = [] }, /quality evidence is missing/u],
    ['missing a11y fact', (_browser, evidence) => {
      delete evidence.quality.screenshots['public-desktop-light'].machine.hitTargets
    }, /DOM\/a11y evidence is incomplete/u]
  ]
  for (const [label, mutate, pattern] of cases)
  {
    const value = fixture(context)
    const browser = structuredClone(value.browser)
    const evidence = structuredClone(value.publicPreviewEvidence)
    mutate(browser, evidence)
    if (JSON.stringify(evidence) !== JSON.stringify(value.publicPreviewEvidence))
    {
      fs.writeFileSync(value.publicPreviewFile, `${JSON.stringify(evidence, null, 2)}\n`)
      browser.publicPreview = {
        ...evidence,
        evidencePath: value.relative(value.publicPreviewFile),
        evidenceFileDigest: fileDigest(value.publicPreviewFile)
      }
    }
    fs.writeFileSync(value.browserFile, `${JSON.stringify(sealBrowserContractReceipt(browser), null, 2)}\n`)
    assert.throws(() => project(value), pattern, label)
  }
})

test('browser raw verifier reopens every dependency and rejects source or projected tamper', (context) =>
{
  const value = fixture(context)
  const raw = project(value)
  fs.writeFileSync(path.join(value.repositoryRoot, value.rawPath), `${JSON.stringify(raw, null, 2)}\n`)

  fs.appendFileSync(value.publicPreviewFile, ' ')
  assert.throws(() => verifyBrowserContractRaw(
    value.rawPath, value.repositoryRoot, value.relative(value.planFile)),
  /(?:public-preview evidence is non-qualifying|browser upstream public preview evidence file digest mismatch)/u)

  fs.writeFileSync(value.publicPreviewFile, `${JSON.stringify(value.publicPreviewEvidence, null, 2)}\n`)
  const repairedBrowser = sealBrowserContractReceipt({
    ...value.browser,
    publicPreview: {
      ...value.publicPreviewEvidence,
      evidencePath: value.relative(value.publicPreviewFile),
      evidenceFileDigest: fileDigest(value.publicPreviewFile)
    }
  })
  fs.writeFileSync(value.browserFile, `${JSON.stringify(repairedBrowser, null, 2)}\n`)
  const repaired = project(value)
  const tampered = seal({
    ...repaired,
    contentDigest: undefined,
    semanticFacts: {
      ...repaired.semanticFacts,
      ...('viewport' in repaired.semanticFacts
        ? { viewport: 'viewport:diagnostic-screenshot' }
        : { viewportId: 'viewport:diagnostic-screenshot' })
    }
  })
  fs.writeFileSync(path.join(value.repositoryRoot, value.rawPath), `${JSON.stringify(tampered, null, 2)}\n`)
  assert.throws(() => verifyBrowserContractRaw(
    value.rawPath, value.repositoryRoot, value.relative(value.planFile)), /browser raw replay mismatch/u)
})

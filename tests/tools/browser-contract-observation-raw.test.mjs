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
  projectBrowserContractRaw,
  verifyBrowserContractRaw
} from '../../tools/test-evidence/browser-contract-observation-raw.mjs'
import { sealBrowserContractReceipt } from '../../tools/release/test-evidence-receipts.mjs'
import { root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import { createPostRuntimeCandidateFixture } from './support/post-runtime-candidate-fixture.mjs'

const runId = 'browser-observation-test'
const fileDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`

function qualityReport(id, viewport, theme)
{
  return {
    schema: 'fsusblog.public-preview-quality-report.v1',
    id,
    route: id.includes('admin') ? 'ManageDashboard' : 'Home',
    viewport,
    theme,
    locale: 'zh-CN',
    zoom: 1,
    surfaceRole: id.includes('admin') ? 'task' : 'public',
    linkedIssues: [],
    status: 'pass',
    machine: {
      overflow: { status: 'pass', findings: [] },
      overlaps: { status: 'pass', checked: 1, findings: [] },
      clippedText: { status: 'pass', checked: 1, findings: [] },
      hitTargets: { status: 'pass', checked: 1, findings: [] },
      focusClipping: { status: 'pass', checked: 1, findings: [] },
      localeCoherence: { status: 'pass', expectedLocale: 'zh-CN', findings: [] },
      primaryTask: { status: 'pass', visibleInFirstViewport: true, findings: [] }
    },
    reviewer: { classification: 'pass', reasons: [] }
  }
}

function fixture(context)
{
  const candidate = createPostRuntimeCandidateFixture(context, {
    prefix: 'browser-contract-observation-raw-', runId
  })
  const { directory, commit, worktreeFingerprint: fingerprint } = candidate
  const repositoryRoot = root
  const fixtureRoot = directory
  const relative = (file) => path.relative(repositoryRoot, file).replaceAll(path.sep, '/')
  const write = (name, value) => {
    const file = path.join(fixtureRoot, name)
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
    return file
  }

  const build = candidate.build
  const buildFile = candidate.buildFile
  const reports = [
    qualityReport('public-desktop-light', { width: 1440, height: 960 }, 'light'),
    qualityReport('admin-mobile-dark', { width: 390, height: 844 }, 'dark')
  ]
  const publicPreviewEvidence = {
    schema: 'fsusblog.public-preview-screenshot-verification.v1',
    status: 'ok',
    sourceCommit: commit,
    releaseId: `20260830000000-${commit.slice(0, 12)}`,
    manifestSchema: 'fsusblog.public-preview-screenshot-manifest.v1',
    visualInputDigest: 'c'.repeat(64),
    runtimeAudit: true,
    layoutAudit: true,
    sanitizationCheck: true,
    images: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`screenshot-${index + 1}`, String(index + 1).repeat(64)])),
    differences: [],
    commandVersion: 'd'.repeat(64),
    captureContextCount: 9,
    qualityAudit: true,
    qualityPolicyDigest: 'e'.repeat(64),
    quality: {
      schema: 'fsusblog.public-preview-quality-manifest.v1',
      status: 'pass',
      sourceCommit: commit,
      policyDigest: 'e'.repeat(64),
      screenshots: Object.fromEntries(reports.map((report) => [report.id, report])),
      matrix: {
        schema: 'fsusblog.public-preview-quality-matrix.v1',
        status: 'pass',
        policyDigest: 'e'.repeat(64),
        scenarioCount: reports.length,
        reports
      }
    }
  }
  const publicPreviewFile = path.join(repositoryRoot, '.tmp', 'release-evidence', 'public-preview-screenshots.json')
  fs.mkdirSync(path.dirname(publicPreviewFile), { recursive: true })
  fs.writeFileSync(publicPreviewFile, `${JSON.stringify(publicPreviewEvidence, null, 2)}\n`)
  context.after(() => fs.rmSync(publicPreviewFile, { force: true }))
  const browserPlan = seal({
    schema: 'fsusblog.playwright-browser-identity.v1',
    executionClass: 'correctness',
    evidenceClass: 'browser-contract',
    qualificationEligible: true,
    managedExecutable: true,
    browserName: 'chromium',
    browserVersion: '140.0.0',
    revision: '123456',
    executablePath: '/managed/chromium-123456/chrome',
    executableSha256: `sha256:${'f'.repeat(64)}`,
    playwright: { package: '@playwright/test', version: '1.59.1' },
    launchOptions: { headless: true, executablePath: '/managed/chromium-123456/chrome', args: [] },
    rendering: {
      fontSetDigest: `sha256:${'1'.repeat(64)}`,
      localeDataDigest: `sha256:${'2'.repeat(64)}`,
      locale: 'zh-CN',
      deviceScaleFactor: 1,
      renderingMode: 'headless',
      colorScheme: 'light',
      gpuMode: 'software'
    }
  })
  const browserActual = seal({
    ...structuredClone(browserPlan),
    schema: 'fsusblog.playwright-browser-actual.v1',
    planDigest: browserPlan.contentDigest,
    renderingObservation: {
      locale: 'zh-CN', deviceScaleFactor: 1, colorScheme: 'light', renderer: 'SwiftShader fixture renderer'
    }
  })
  const scenarioStartedAt = '2026-08-30T00:00:00.000Z'
  const scenarioFinishedAt = '2026-08-30T00:00:01.000Z'
  const scenarios = browserContractScenarios.map(({ id, capability }) => ({
    id,
    capability,
    status: 'success',
    classification: 'clean',
    startedAt: scenarioStartedAt,
    finishedAt: scenarioFinishedAt,
    durationMs: 1_000,
    issues: [],
    artifacts: id.startsWith('public-') ? [`traces/${id}.zip`] : [],
    error: null
  }))
  const browser = sealBrowserContractReceipt({
    schema: 'fsusblog.browser-contract-receipt.v2',
    status: 'success',
    classification: 'clean',
    runIdentity: { commit, runId, attemptId: 'attempt-0001', laneId: 'browser-contract', namespace: 'browser-observation-test' },
    sourceState: { commit, worktreeFingerprint: fingerprint },
    build: {
      receipt: relative(buildFile),
      receiptContentDigest: build.contentDigest,
      sourceState: build.sourceState,
      profile: 'production-fresh'
    },
    fixture: {
      namespace: 'browser-observation-test',
      capabilities: { webAuthnRegistration: true },
      lifecycle: { identity: { commit, runId, attemptId: 'attempt-0001', laneId: 'browser-contract', namespace: 'browser-observation-test' } }
    },
    playwright: {
      chromiumRevision: '123456',
      chromiumVersion: '140.0.0',
      browserIdentity: { plan: browserPlan, actual: browserActual }
    },
    topology: {
      runner: 'playwright-library', browserType: 'chromium', managedBrowser: true,
      workerPool: false, shard: null, retries: 0, browserLaunchCount: 1,
      maxConcurrentBrowserRoots: 1, contextCount: scenarios.length
    },
    scenarios,
    publicPreview: {
      ...publicPreviewEvidence,
      evidencePath: relative(publicPreviewFile),
      evidenceFileDigest: fileDigest(publicPreviewFile)
    },
    startedAt: scenarioStartedAt,
    finishedAt: scenarioFinishedAt,
    wallClockMs: 1_000,
    error: null,
    finalization: {
      state: 'complete',
      decisionIdentity: `sha256:${'3'.repeat(64)}`,
      primary: { status: 'success', classification: 'clean', error: null },
      cleanup: { status: 'success', attemptCount: 1, error: null },
      signal: null,
      persistence: { attemptCount: 1, priorFailures: [] }
    }
  })
  const browserFile = write('browser-contract.json', browser)
  const plan = candidate.plan
  const planFile = candidate.planFile
  const rawPath = candidate.observationPaths['browser-behavior-contract']
  return {
    directory, repositoryRoot, relative, write, build, buildFile, publicPreviewEvidence, publicPreviewFile,
    browser, browserFile, plan, planFile, rawPath, candidate
  }
}

function project(value)
{
  return projectBrowserContractRaw({
    candidatePlan: value.relative(value.planFile),
    browserContractReceipt: value.relative(value.browserFile),
    repositoryRoot: value.repositoryRoot
  })
}

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

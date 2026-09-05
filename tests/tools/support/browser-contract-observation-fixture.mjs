import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { browserContractScenarios } from '../../browser-contract/contract.mjs'
import { seal } from '../../../tools/fact-extractors/post-runtime/adapter.mjs'
import { bindBrowserPostRuntimeObservation } from '../../../tools/test-evidence/browser-contract-observation-raw.mjs'
import { sealBrowserContractReceipt } from '../../../tools/release/test-evidence-receipts.mjs'
import { root } from '../../../tools/test-matrix/post-runtime-producer-registry.mjs'
import { createPostRuntimeCandidateFixture } from './post-runtime-candidate-fixture.mjs'
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

export function createBrowserContractObservationFixture(context, suppliedCandidate = null)
{
  const candidate = suppliedCandidate ?? createPostRuntimeCandidateFixture(context, {
    prefix: 'browser-contract-observation-raw-', runId: 'browser-observation-test'
  })
  const runId = candidate.plan.candidate.runId
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
  let browser = sealBrowserContractReceipt({
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
    temporalBinding: null,
    finalization: {
      state: 'complete',
      decisionIdentity: `sha256:${'3'.repeat(64)}`,
      primary: { status: 'success', classification: 'clean', error: null },
      cleanup: { status: 'success', attemptCount: 1, error: null },
      signal: null,
      persistence: { attemptCount: 1, priorFailures: [] }
    }
  })
  browser = sealBrowserContractReceipt(bindBrowserPostRuntimeObservation({
    candidatePlan: relative(candidate.planFile), browser, repositoryRoot
  }))
  const browserFile = write('browser-contract.json', browser)
  const plan = candidate.plan
  const planFile = candidate.planFile
  const rawPath = candidate.observationPaths['browser-behavior-contract']
  return {
    directory, repositoryRoot, relative, write, build, buildFile, publicPreviewEvidence, publicPreviewFile,
    browser, browserFile, plan, planFile, rawPath, candidate
  }
}

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { produceClassReceipt, seal } from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import {
  produceAotSpaHydrationSourceBundle,
  projectAotSpaHydrationRaw,
  verifyAotSpaHydrationRaw
} from '../../tools/test-evidence/aot-spa-hydration-raw.mjs'
import { sealBrowserContractReceipt } from '../../tools/release/test-evidence-receipts.mjs'
import { root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import { createPostRuntimeCandidateFixture } from './support/post-runtime-candidate-fixture.mjs'

const fileDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`

function qualityReport()
{
  return {
    schema: 'fsusblog.public-preview-quality-report.v1', id: 'public-desktop-light',
    route: 'Home', viewport: { width: 1440, height: 960 }, theme: 'light', locale: 'zh-CN', zoom: 1,
    surfaceRole: 'public', linkedIssues: [], status: 'pass',
    machine: {
      overflow: { status: 'pass', findings: [] }, overlaps: { status: 'pass', checked: 1, findings: [] },
      clippedText: { status: 'pass', checked: 1, findings: [] }, hitTargets: { status: 'pass', checked: 1, findings: [] },
      focusClipping: { status: 'pass', checked: 1, findings: [] },
      localeCoherence: { status: 'pass', expectedLocale: 'zh-CN', findings: [] },
      primaryTask: { status: 'pass', visibleInFirstViewport: true, findings: [] }
    }, reviewer: { classification: 'pass', reasons: [] }
  }
}

function browserReceipt(value)
{
  const report = qualityReport()
  const preview = {
    schema: 'fsusblog.public-preview-screenshot-verification.v1', status: 'ok',
    sourceCommit: value.commit, releaseId: `20260830000000-${value.commit.slice(0, 12)}`,
    manifestSchema: 'fsusblog.public-preview-screenshot-manifest.v1', visualInputDigest: 'c'.repeat(64),
    runtimeAudit: true, layoutAudit: true, sanitizationCheck: true,
    images: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`screenshot-${index + 1}`, String(index + 1).repeat(64)])),
    differences: [], commandVersion: 'd'.repeat(64), captureContextCount: 9,
    qualityAudit: true, qualityPolicyDigest: 'e'.repeat(64),
    quality: {
      schema: 'fsusblog.public-preview-quality-manifest.v1', status: 'pass', sourceCommit: value.commit,
      policyDigest: 'e'.repeat(64), screenshots: { [report.id]: report },
      matrix: { schema: 'fsusblog.public-preview-quality-matrix.v1', status: 'pass',
        policyDigest: 'e'.repeat(64), scenarioCount: 1, reports: [report] }
    }
  }
  const previewFile = value.write('public-preview.json', preview)
  const browserPlan = seal({
    schema: 'fsusblog.playwright-browser-identity.v1', executionClass: 'correctness',
    evidenceClass: 'browser-contract', qualificationEligible: true, managedExecutable: true,
    browserName: 'chromium', browserVersion: '140.0.0', revision: '123456',
    executablePath: '/managed/chromium-123456/chrome', executableSha256: `sha256:${'f'.repeat(64)}`,
    playwright: { package: '@playwright/test', version: '1.59.1' },
    launchOptions: { headless: true, executablePath: '/managed/chromium-123456/chrome', args: [] },
    rendering: { fontSetDigest: `sha256:${'1'.repeat(64)}`, localeDataDigest: `sha256:${'2'.repeat(64)}`,
      locale: 'zh-CN', deviceScaleFactor: 1, renderingMode: 'headless', colorScheme: 'light', gpuMode: 'software' }
  })
  const browserActual = seal({ ...structuredClone(browserPlan), schema: 'fsusblog.playwright-browser-actual.v1',
    planDigest: browserPlan.contentDigest,
    renderingObservation: { locale: 'zh-CN', deviceScaleFactor: 1, colorScheme: 'light', renderer: 'SwiftShader fixture renderer' } })
  const articlePath = '/article/42'
  const stableIdentity = { captured: true, appSame: true, shellSame: true, firstChildSame: true,
    childElementCountSame: true, hydrated: true, appCount: 1, shellCount: 1, violations: [] }
  const serverHtml = '<!doctype html><html lang="zh-CN"><head><link rel="canonical" href="https://example.test/article/42"><script type="application/json" data-fsus-seo-head-model>{}</script></head><body><div id="app"><div id="fsus-aot-shell" data-public-hydration-kind="ArticleDetail"></div></div></body></html>'
  const scenario = {
    id: 'public-hydration-history-reload', capability: 'public AOT hydration', status: 'success', classification: 'clean',
    startedAt: '2026-08-30T00:00:00.000Z', finishedAt: '2026-08-30T00:00:01.000Z', durationMs: 1_000,
    issues: [], artifacts: ['traces/public-hydration-history-reload.zip'], error: null,
    observation: {
      schema: 'fsusblog.browser-contract-public-aot-observation.v1',
      fixture: { articleId: '42', articlePath, articleTitle: 'Current article' },
      response: { url: `https://example.test${articlePath}`, status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-fsus-release-id': value.plan.candidate.releaseId }, serverHtml },
      direct: { route: articlePath, canonicalPath: articlePath, title: 'Current article', locale: 'zh-CN',
        hydrationKind: 'ArticleDetail', hydrated: true, appCount: 1, shellCount: 1,
        bootstrapText: '{"id":42}', resourceUrls: ['https://example.test/assets/app.js'] },
      spa: stableIdentity, history: stableIdentity, reload: stableIdentity
    }
  }
  return sealBrowserContractReceipt({
    schema: 'fsusblog.browser-contract-receipt.v2', status: 'success', classification: 'clean',
    runIdentity: { commit: value.commit, runId: value.plan.candidate.runId, laneId: 'browser-contract', namespace: value.plan.candidate.runId },
    sourceState: value.sourceState,
    build: { receipt: value.relative(value.buildFile), receiptContentDigest: value.build.contentDigest,
      sourceState: value.sourceState, profile: 'production-fresh' },
    fixture: { namespace: value.plan.candidate.runId, capabilities: {}, lifecycle: { identity: {
      commit: value.commit, runId: value.plan.candidate.runId, laneId: 'browser-contract', namespace: value.plan.candidate.runId
    } } },
    playwright: { chromiumRevision: '123456', chromiumVersion: '140.0.0', browserIdentity: { plan: browserPlan, actual: browserActual } },
    topology: { runner: 'playwright-library', browserType: 'chromium', managedBrowser: true,
      workerPool: false, shard: null, retries: 0, browserLaunchCount: 1, maxConcurrentBrowserRoots: 1, contextCount: 1 },
    scenarios: [scenario],
    publicPreview: { ...preview, evidencePath: '.tmp/release-evidence/public-preview-screenshots.json',
      evidenceFileDigest: fileDigest(previewFile) },
    startedAt: scenario.startedAt, finishedAt: scenario.finishedAt, wallClockMs: 1_000, error: null,
    finalization: { state: 'complete', decisionIdentity: `sha256:${'3'.repeat(64)}`,
      primary: { status: 'success', classification: 'clean', error: null },
      cleanup: { status: 'success', attemptCount: 1, error: null }, signal: null,
      persistence: { attemptCount: 1, priorFailures: [] } }
  })
}

function fixture(context)
{
  const value = createPostRuntimeCandidateFixture(context, { prefix: 'aot-spa-hydration-raw-', runId: 'run-aot-current-0001' })
  const manifestArtifact = value.build.artifacts.find(({ path: artifactPath }) => artifactPath.endsWith('/.vite/manifest.json'))
  const manifest = seal({
    schema: 'fsusblog.spa-manifest-descriptor.v1', releaseId: value.plan.candidate.releaseId,
    sourceCommit: value.commit, worktreeFingerprint: `sha256:${value.worktreeFingerprint}`,
    buildReceiptDigest: value.build.contentDigest,
    assetRoot: `/app/release-assets/${value.plan.candidate.releaseId}`,
    manifestPath: `/app/release-assets/${value.plan.candidate.releaseId}/.vite/manifest.json`,
    manifestDigest: manifestArtifact.sha256, assetInventoryDigest: `sha256:${'c'.repeat(64)}`
  })
  const manifestFile = value.write('manifest-descriptor.json', manifest)
  const browser = browserReceipt(value)
  const browserFile = value.write('browser-contract.json', browser)
  const evidence = { manifest: value.relative(manifestFile), browserContract: value.relative(browserFile) }
  const source = produceAotSpaHydrationSourceBundle({ candidatePlan: value.relative(value.planFile), evidence, repositoryRoot: root })
  const sourceFile = value.write('aot-source-bundle.json', source)
  return { ...value, evidence, source, sourceFile, browser, browserFile }
}

test('projects and independently replays canonical browser/server AOT outputs', (context) =>
{
  const value = fixture(context)
  const receipt = projectAotSpaHydrationRaw({ candidatePlan: value.relative(value.planFile),
    sourceReceipt: value.relative(value.sourceFile), repositoryRoot: root })
  const rawPath = value.observationPaths['aot-spa-hydration']
  fs.writeFileSync(path.join(root, rawPath), `${JSON.stringify(receipt, null, 2)}\n`)
  assert.equal(verifyAotSpaHydrationRaw(rawPath, root).contentDigest, receipt.contentDigest)
  assert.equal(receipt.semanticFacts.coherent, true)
  assert.equal(produceClassReceipt({ candidatePlan: value.relative(value.planFile), classId: 'aot-spa-hydration',
    result: rawPath, repositoryRoot: root }).status, 'qualified')
})

test('rejects a stale-cache style Browser Contract payload with the wrong decoded article canary', (context) =>
{
  const value = fixture(context)
  const browser = structuredClone(value.browser)
  browser.scenarios[0].observation.direct.title = 'Old cached article'
  value.write('browser-contract.json', sealBrowserContractReceipt(browser))
  const source = produceAotSpaHydrationSourceBundle({ candidatePlan: value.relative(value.planFile), evidence: value.evidence, repositoryRoot: root })
  value.write('aot-source-bundle.json', source)
  assert.throws(() => projectAotSpaHydrationRaw({ candidatePlan: value.relative(value.planFile),
    sourceReceipt: value.relative(value.sourceFile), repositoryRoot: root }), /not coherent/u)
})

test('verifier rejects canonical Browser Contract bytes changed after source bundling', (context) =>
{
  const value = fixture(context)
  const receipt = projectAotSpaHydrationRaw({ candidatePlan: value.relative(value.planFile),
    sourceReceipt: value.relative(value.sourceFile), repositoryRoot: root })
  const rawPath = value.observationPaths['aot-spa-hydration']
  fs.writeFileSync(path.join(root, rawPath), `${JSON.stringify(receipt, null, 2)}\n`)
  fs.appendFileSync(value.browserFile, ' ')
  assert.throws(() => verifyAotSpaHydrationRaw(rawPath, root), /browserContract evidence bytes changed/u)
})

test('verifier rejects immutable production manifest drift', (context) =>
{
  const value = fixture(context)
  const receipt = projectAotSpaHydrationRaw({ candidatePlan: value.relative(value.planFile),
    sourceReceipt: value.relative(value.sourceFile), repositoryRoot: root })
  const rawPath = value.observationPaths['aot-spa-hydration']
  fs.writeFileSync(path.join(root, rawPath), `${JSON.stringify(receipt, null, 2)}\n`)
  const manifest = path.join(value.artifactRoot, 'frontend-dist', '.vite', 'manifest.json')
  fs.chmodSync(manifest, 0o644)
  fs.appendFileSync(manifest, ' ')
  assert.throws(() => verifyAotSpaHydrationRaw(rawPath, root), /artifact (?:size|digest) mismatch/u)
})

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
    runIdentity: { commit: value.commit, runId: value.plan.candidate.runId, attemptId: value.plan.candidate.attemptId,
      laneId: 'browser-contract', namespace: value.plan.candidate.runId },
    sourceState: value.sourceState,
    build: { receipt: value.relative(value.buildFile), receiptContentDigest: value.build.contentDigest,
      sourceState: value.sourceState, profile: 'production-fresh' },
    fixture: { namespace: value.plan.candidate.runId, capabilities: {}, lifecycle: { identity: {
      commit: value.commit, runId: value.plan.candidate.runId, attemptId: value.plan.candidate.attemptId,
      laneId: 'browser-contract', namespace: value.plan.candidate.runId
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
  const assetRoot = path.join(value.directory, 'runtime-assets', value.plan.candidate.releaseId)
  const retainedManifest = path.join(assetRoot, '.vite', 'manifest.json')
  const assetInventory = path.join(assetRoot, 'asset-manifest.json')
  fs.mkdirSync(path.dirname(retainedManifest), { recursive: true })
  fs.copyFileSync(path.join(value.artifactRoot, manifestArtifact.path), retainedManifest)
  writeJson(assetInventory, {
    schema: 'fsusblog.release-assets.v1', releaseId: value.plan.candidate.releaseId,
    slot: 'green', frontendBuildId: value.plan.candidate.releaseId, files: [], compatibilityFile: null
  })
  const manifest = seal({
    schema: 'fsusblog.spa-manifest-descriptor.v1', releaseId: value.plan.candidate.releaseId,
    sourceCommit: value.commit, worktreeFingerprint: `sha256:${value.worktreeFingerprint}`,
    buildReceiptDigest: value.build.contentDigest,
    assetRoot,
    manifestPath: retainedManifest,
    manifestDigest: manifestArtifact.sha256, assetInventoryDigest: fileDigest(assetInventory)
  })
  const manifestFile = value.write('manifest-descriptor.json', manifest)
  const browser = browserReceipt(value)
  const browserFile = value.write('browser-contract.json', browser)
  const evidence = { manifest: value.relative(manifestFile), browserContract: value.relative(browserFile) }
  const source = produceAotSpaHydrationSourceBundle({ candidatePlan: value.relative(value.planFile), evidence, repositoryRoot: root })
  const sourceFile = value.write('aot-source-bundle.json', source)
  return { ...value, evidence, source, sourceFile, browser, browserFile }
}

function writeJson(file, value)
{
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

test('AOT source preserves observed values and rejects coordinated raw fact substitution', (context) =>
{
  const value = fixture(context)
  const observation = value.browser.scenarios.find(({ id }) => id === 'public-hydration-history-reload').observation
  assert.equal(value.source.rawFacts.serverHtml, observation.response.serverHtml)
  assert.deepEqual(value.source.rawFacts.hydratedDom, observation.direct)
  assert.deepEqual(value.source.rawFacts.networkResource, observation.direct.resourceUrls)
  const substituted = structuredClone(value.source)
  substituted.rawFacts.locale = 'forged-locale'
  value.write('aot-source-bundle.json', seal(substituted))
  assert.throws(() => projectAotSpaHydrationRaw({ candidatePlan: value.relative(value.planFile),
    sourceReceipt: value.relative(value.sourceFile), repositoryRoot: root }), /raw facts do not replay/u)
})

test('projects and independently replays canonical browser/server AOT outputs', (context) =>
{
  const value = fixture(context)
  const receipt = projectAotSpaHydrationRaw({ candidatePlan: value.relative(value.planFile),
    sourceReceipt: value.relative(value.sourceFile), repositoryRoot: root })
  assert.match(receipt.independentVerifyCommand, /verify --candidate-plan .* --receipt /u)
  const rawPath = value.observationPaths['aot-spa-hydration']
  fs.writeFileSync(path.join(root, rawPath), `${JSON.stringify(receipt, null, 2)}\n`)
  assert.equal(verifyAotSpaHydrationRaw(rawPath, root, value.relative(value.planFile)).contentDigest, receipt.contentDigest)
  assert.equal(receipt.semanticFacts.coherent ?? receipt.semanticFacts.locale !== null, true)
  assert.equal(produceClassReceipt({ candidatePlan: value.relative(value.planFile), classId: 'aot-spa-hydration',
    result: rawPath, repositoryRoot: root }).status, 'qualified')
})

test('rejects a stale-cache style Browser Contract payload with the wrong decoded article canary', (context) =>
{
  const value = fixture(context)
  const browser = structuredClone(value.browser)
  browser.scenarios[0].observation.direct.title = 'Old cached article'
  value.write('browser-contract.json', sealBrowserContractReceipt(browser))
  assert.throws(() => produceAotSpaHydrationSourceBundle({ candidatePlan: value.relative(value.planFile),
    evidence: value.evidence, repositoryRoot: root }), /not coherent/u)
})

test('verifier rejects canonical Browser Contract bytes changed after source bundling', (context) =>
{
  const value = fixture(context)
  const receipt = projectAotSpaHydrationRaw({ candidatePlan: value.relative(value.planFile),
    sourceReceipt: value.relative(value.sourceFile), repositoryRoot: root })
  const rawPath = value.observationPaths['aot-spa-hydration']
  fs.writeFileSync(path.join(root, rawPath), `${JSON.stringify(receipt, null, 2)}\n`)
  fs.appendFileSync(value.browserFile, ' ')
  assert.throws(() => verifyAotSpaHydrationRaw(rawPath, root, value.relative(value.planFile)),
    /(?:browserContract evidence bytes changed|aot upstream evidence browserContract file digest mismatch)/u)
})

test('rejects Browser Contract evidence from another current-run attempt', (context) =>
{
  const value = fixture(context)
  const browser = structuredClone(value.browser)
  browser.runIdentity.attemptId = 'attempt-0002'
  browser.fixture.lifecycle.identity.attemptId = 'attempt-0002'
  value.write('browser-contract.json', sealBrowserContractReceipt(browser))
  assert.throws(() => produceAotSpaHydrationSourceBundle({ candidatePlan: value.relative(value.planFile),
    evidence: value.evidence, repositoryRoot: root }), /identity does not match the candidate/u)
})

test('rejects a source bundle whose candidate plan byte reference was coordinated-resealed', (context) =>
{
  const value = fixture(context)
  const source = structuredClone(value.source)
  source.candidatePlanRef.fileDigest = `sha256:${'0'.repeat(64)}`
  value.write('aot-source-bundle.json', seal(source))
  assert.throws(() => projectAotSpaHydrationRaw({ candidatePlan: value.relative(value.planFile),
    sourceReceipt: value.relative(value.sourceFile), repositoryRoot: root }), /candidate binding mismatch/u)
})

test('raw verifier rejects a relocated extra result outside the candidate plan', (context) =>
{
  const value = fixture(context)
  const receipt = projectAotSpaHydrationRaw({ candidatePlan: value.relative(value.planFile),
    sourceReceipt: value.relative(value.sourceFile), repositoryRoot: root })
  const relocated = value.write('relocated-aot-raw.json', receipt)
  assert.throws(() => verifyAotSpaHydrationRaw(value.relative(relocated), root, value.relative(value.planFile)),
    /path does not exact-match candidate plan/u)
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
  assert.throws(() => verifyAotSpaHydrationRaw(rawPath, root, value.relative(value.planFile)), /artifact (?:size|digest) mismatch/u)
})

test('rejects descriptor release paths and retained inventory bytes that do not bind the candidate', (context) =>
{
  const release = fixture(context)
  const changedRelease = structuredClone(release.evidence)
  const descriptor = structuredClone(JSON.parse(fs.readFileSync(path.join(release.directory, 'manifest-descriptor.json'), 'utf8')))
  descriptor.releaseId = '20260830000000-aaaaaaaaaaaa'
  delete descriptor.contentDigest
  release.write('manifest-descriptor.json', seal(descriptor))
  assert.throws(() => produceAotSpaHydrationSourceBundle({ candidatePlan: release.relative(release.planFile),
    evidence: changedRelease, repositoryRoot: root }), /does not exact-match the candidate build/u)

  const inventory = fixture(context)
  const inventoryFile = path.join(inventory.directory, 'runtime-assets', inventory.plan.candidate.releaseId, 'asset-manifest.json')
  fs.appendFileSync(inventoryFile, ' ')
  assert.throws(() => projectAotSpaHydrationRaw({ candidatePlan: inventory.relative(inventory.planFile),
    sourceReceipt: inventory.relative(inventory.sourceFile), repositoryRoot: root }), /asset inventory bytes/u)
})

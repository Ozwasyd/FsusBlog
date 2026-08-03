#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { verifyProductionBuildReceipt } from '../../../../tools/ci/production-build-artifacts.mjs'
import { deriveLocalPublicContentFixtureSecret } from '../../../browser-contract/default-fixture-provider.mjs'
import {
  cleanupSingleBrowserContractFixture,
  prepareSingleBrowserContractFixture
} from '../../../browser-contract/prepare-fixture.mjs'
import {
  loadProductionXssCorpus,
  markdownForCorpusCase,
  resolveMetadataProbe,
  selectProductionXssCases
} from '../../support/security/productionXssCorpus.mjs'
import { evaluateSecurityObservation } from '../../support/security/productionXssObserver.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '../../../..')
const frontendRoot = path.join(repositoryRoot, 'src', 'frontend')
const require = createRequire(import.meta.url)
const playwright = require(require.resolve('@playwright/test', { paths: [frontendRoot] }))
const mode = process.argv.includes('--release') ? 'release' : 'fast'
let baseUrl = String(process.env.PLAYWRIGHT_BASE_URL ?? process.env.FSUSBLOG_PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/u, '')
let fixtureRoot = process.env.FSUSBLOG_FIXTURE_ROOT
  ? path.resolve(process.env.FSUSBLOG_FIXTURE_ROOT)
  : path.join(repositoryRoot, '.tmp', 'fixtures', process.env.FSUSBLOG_TEST_NAMESPACE ?? 'local')
const outputRoot = path.join(frontendRoot, 'test-results', 'playwright', `production-xss-${mode}`)
const reportPath = path.join(outputRoot, 'matrix.json')
const startedAt = new Date().toISOString()
const started = performance.now()

function expectedSourceState() {
  const commit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim()
  const worktreeFingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim()
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(worktreeFingerprint)) {
    throw new Error('production XSS matrix requires complete source commit and worktree fingerprint identity')
  }
  return { commit, worktreeFingerprint }
}

function verifyImmutableBuild(sourceState) {
  const receiptFile = path.resolve(
    process.env.FSUSBLOG_BROWSER_CONTRACT_BUILD_RECEIPT
      ?? path.join(repositoryRoot, '.tmp', 'ci-production-build', 'receipt.json')
  )
  const result = verifyProductionBuildReceipt({
    artifactRoot: path.dirname(receiptFile),
    receiptFile: path.basename(receiptFile),
    expectedSourceState: sourceState
  })
  const requiredDomains = ['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm']
  const domains = new Set(result.receipt.domains.map((domain) => domain.name))
  const missing = requiredDomains.filter((domain) => !domains.has(domain))
  if (missing.length) throw new Error(`immutable production build is missing XSS matrix domains: ${missing.join(', ')}`)
  return {
    receipt: path.relative(repositoryRoot, receiptFile).replaceAll(path.sep, '/'),
    receiptContentDigest: result.receipt.contentDigest,
    sourceState: result.receipt.sourceState,
    profile: result.receipt.build?.profile ?? null,
    domains: requiredDomains,
    artifactCount: result.evidence.artifactCount,
    artifactBytes: result.evidence.artifactBytes,
    verifiedAt: result.evidence.verifiedAt
  }
}

async function prepareProductionRuntime() {
  const sourceState = expectedSourceState()
  const build = verifyImmutableBuild(sourceState)
  const env = {
    ...process.env,
    FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-contract',
    FSUSBLOG_BROWSER_CONTRACT_SESSIONS: '1',
    FSUSBLOG_BROWSER_CONTRACT_CONCURRENCY: '1',
    FSUSBLOG_BROWSER_CONTRACT_RUN_ID: `${process.env.FSUSBLOG_BROWSER_CONTRACT_RUN_ID ?? `local-${process.pid}`}-production-xss-${mode}`
  }
  const prepared = await prepareSingleBrowserContractFixture({
    env,
    repoRoot: repositoryRoot,
    sourceState: build.sourceState,
    build
  })
  const providerState = JSON.parse(await readFile(path.join(prepared.root, 'provider-state.json'), 'utf8'))
  const secret = deriveLocalPublicContentFixtureSecret({
    identity: prepared.identity,
    preparation: prepared.preparation,
    sourceState: prepared.sourceState
  }, providerState.runtimeRunId)
  baseUrl = prepared.manifest.baseUrl.replace(/\/+$/u, '')
  fixtureRoot = prepared.root
  process.env.PLAYWRIGHT_BASE_URL = baseUrl
  process.env.FSUSBLOG_TEST_NAMESPACE = prepared.identity.namespace
  process.env.FSUSBLOG_TEST_RUN_ID = providerState.runtimeRunId
  process.env.FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET = secret
  process.env.FSUSBLOG_ADMIN_STORAGE_STATE = path.join(
    prepared.root,
    prepared.manifest.entities.admin.storageStateFile
  )
  return { prepared, build }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function storageStatePath() {
  const candidates = [
    process.env.FSUSBLOG_ADMIN_STORAGE_STATE,
    path.join(fixtureRoot, 'auth', 'pw-0.admin.storage-state.json'),
    path.join(fixtureRoot, 'auth', 'admin.storage-state.json')
  ].filter(Boolean)
  const selected = candidates.find((candidate) => fs.existsSync(candidate))
  if (!selected) throw new Error(`admin storage state missing under ${fixtureRoot}`)
  return selected
}

async function seed(cases, metadataText) {
  const secret = process.env.FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET
  if (!secret) throw new Error('FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET is required')
  const namespace = process.env.FSUSBLOG_TEST_NAMESPACE ?? process.env.FSUSBLOG_TEST_RUN_ID ?? 'production-xss-local'
  const response = await fetch(`${baseUrl}/api/local/public-content-fixture/prepare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Fsus-Local-Public-Content-Fixture-Secret': secret,
      'X-Fsus-Test-Namespace': namespace,
      'X-Fsus-Test-Run-Id': process.env.FSUSBLOG_TEST_RUN_ID ?? namespace
    },
    body: JSON.stringify({
      capabilities: ['public.article.published'],
      namespace,
      runId: 'production-xss',
      securityMatrix: {
        cases: cases.map((entry) => ({
          id: entry.id,
          category: entry.category,
          markdown: markdownForCorpusCase(entry)
        })),
        aboutMarkdown: cases.map((entry) => `<!-- ${entry.id} -->\n${markdownForCorpusCase(entry)}`).join('\n\n'),
        metadataText
      }
    })
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`security matrix seed failed HTTP ${response.status}: ${text.slice(0, 800)}`)
  const payload = JSON.parse(text)
  const identities = payload.entityIdentities ?? payload.EntityIdentities ?? []
  const articles = new Map()
  for (const item of identities) {
    const kind = item.kind ?? item.Kind
    const handle = item.handle ?? item.Handle ?? ''
    if (kind === 'article' && handle.endsWith(':article')) {
      articles.set(handle.slice(0, -':article'.length), Number(item.id ?? item.Id))
    }
  }
  for (const entry of cases) {
    if (!Number.isInteger(articles.get(entry.id))) throw new Error(`seed response missing article for ${entry.id}`)
  }
  return { payload, articles }
}

function createObservation() {
  return {
    dialogs: [],
    popups: [],
    downloads: [],
    externalRequests: [],
    cspViolations: [],
    trustedTypesErrors: [],
    dangerousDom: [],
    missingText: [],
    missingSelectors: [],
    executionSentinel: 0
  }
}

async function installObservers(context, page, observation) {
  await context.route('**/*', async (route) => {
    const url = route.request().url()
    if (/^(?:data|blob|about):/u.test(url) || new URL(url).origin === new URL(baseUrl).origin) {
      await route.continue()
      return
    }
    observation.externalRequests.push(url)
    await route.abort('blockedbyclient')
  })
  page.on('dialog', async (dialog) => {
    observation.dialogs.push(dialog.type())
    await dialog.dismiss()
  })
  page.on('popup', (popup) => {
    observation.popups.push(popup.url())
    void popup.close()
  })
  page.on('download', (download) => observation.downloads.push(download.suggestedFilename()))
  page.on('console', (message) => {
    if (/trusted types|content security policy|violat(?:e|ion)/iu.test(message.text())) {
      observation.trustedTypesErrors.push(message.text())
    }
  })
  await page.addInitScript(() => {
    globalThis.__FSUSBLOG_XSS_EXECUTION_SENTINEL__ = 0
    globalThis.__FSUSBLOG_XSS_CSP_VIOLATIONS__ = []
    document.addEventListener('securitypolicyviolation', (event) => {
      globalThis.__FSUSBLOG_XSS_CSP_VIOLATIONS__.push({
        blockedURI: event.blockedURI,
        directive: event.effectiveDirective
      })
    })
    for (const name of ['alert', 'confirm', 'prompt', 'open']) {
      globalThis[name] = () => {
        globalThis.__FSUSBLOG_XSS_EXECUTION_SENTINEL__ += 1
        return null
      }
    }
  })
}

async function audit(page, entry, rootSelector, observation) {
  const locator = page.locator(rootSelector).first()
  await locator.waitFor({ state: 'attached', timeout: 20_000 })
  const dom = await locator.evaluate((root, invariants) => {
    const failures = []
    for (const selector of invariants.forbidSelectors ?? []) {
      try {
        if (root.matches(selector) || root.querySelector(selector)) failures.push(`forbidden-selector:${selector}`)
      } catch {
        failures.push(`invalid-forbidden-selector:${selector}`)
      }
    }
    for (const element of [root, ...root.querySelectorAll('*')]) {
      if (!(invariants.allowedNamespaces ?? []).includes(element.namespaceURI)) {
        failures.push(`namespace:${element.namespaceURI}`)
      }
      for (const attribute of element.attributes) {
        if (/^on/iu.test(attribute.name)) failures.push(`event-attribute:${attribute.name}`)
        if (/^(?:href|src|xlink:href|action|formaction|poster)$/iu.test(attribute.name)) {
          const value = attribute.value.trim()
          if (/^(?:javascript|vbscript|data):/iu.test(value)) failures.push(`dangerous-url:${attribute.name}`)
          else if (invariants.forbidExternalUrls === true && /^https?:/iu.test(value)
            && new URL(value, location.href).origin !== location.origin) failures.push(`external-url:${attribute.name}`)
        }
      }
    }
    const text = root.textContent ?? ''
    return {
      dangerousDom: failures,
      missingSelectors: (invariants.preserveSelectors ?? []).filter((selector) => !root.querySelector(selector)),
      missingText: (invariants.preserveText ?? []).filter((value) => !text.includes(value)),
      executionSentinel: globalThis.__FSUSBLOG_XSS_EXECUTION_SENTINEL__ ?? 0,
      cspViolations: globalThis.__FSUSBLOG_XSS_CSP_VIOLATIONS__ ?? []
    }
  }, {
    ...entry.invariants,
    preserveSelectors: entry.preserve?.selectors ?? [],
    preserveText: entry.preserve?.text ?? []
  })
  observation.dangerousDom.push(...dom.dangerousDom)
  observation.missingSelectors.push(...dom.missingSelectors)
  observation.missingText.push(...dom.missingText)
  observation.executionSentinel += dom.executionSentinel
  observation.cspViolations.push(...dom.cspViolations)
  const failures = evaluateSecurityObservation(observation)
  if (failures.length) throw new Error(`${entry.id} ${rootSelector}: ${failures.join(' | ')}`)
}

async function runBrowser(browserName, browserType, cases, articles, results) {
  const browser = await browserType.launch({ headless: true })
  try {
    for (const entry of cases) {
      const articleId = articles.get(entry.id)
      const noScript = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' })
      const noScriptPage = await noScript.newPage()
      const noScriptObservation = createObservation()
      await installObservers(noScript, noScriptPage, noScriptObservation)
      await noScriptPage.goto(`${baseUrl}/article/${articleId}`, { waitUntil: 'domcontentloaded' })
      await audit(noScriptPage, entry, '.markdown-body, [data-markdown-root], article', noScriptObservation)
      results.push({ browser: browserName, caseId: entry.id, phase: 'aot-before-hydration', surface: 'public-article', status: 'ok', entityId: articleId })
      await noScript.close()

      const context = await browser.newContext({ serviceWorkers: 'block' })
      const page = await context.newPage()
      const observation = createObservation()
      await installObservers(context, page, observation)
      await page.goto(`${baseUrl}/article/${articleId}`, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle')
      await audit(page, entry, '.markdown-body, [data-markdown-root], article', observation)
      results.push({ browser: browserName, caseId: entry.id, phase: 'hydrated', surface: 'public-article', status: 'ok', entityId: articleId })
      await page.reload({ waitUntil: 'networkidle' })
      await audit(page, entry, '[aria-label*="评论"], .comment-list, main', observation)
      const toggle = page.getByRole('button', { name: /回复|展开|折叠/u }).first()
      if (await toggle.count()) await toggle.click()
      await audit(page, entry, '[aria-label*="评论"], .comment-list, main', observation)
      results.push({ browser: browserName, caseId: entry.id, phase: 'persisted-reload', surface: 'comment-thread', status: 'ok', entityId: articleId })
      await context.close()
    }

    const aboutContext = await browser.newContext({ serviceWorkers: 'block' })
    const aboutPage = await aboutContext.newPage()
    const aboutObservation = createObservation()
    await installObservers(aboutContext, aboutPage, aboutObservation)
    await aboutPage.goto(`${baseUrl}/about`, { waitUntil: 'networkidle' })
    for (const entry of cases) {
      await audit(aboutPage, entry, '.markdown-body, [data-markdown-root], main', aboutObservation)
      results.push({ browser: browserName, caseId: entry.id, phase: 'hydrated', surface: 'about-page', status: 'ok' })
    }
    await aboutContext.close()

    const spaContext = await browser.newContext({ serviceWorkers: 'block' })
    const spaPage = await spaContext.newPage()
    const spaObservation = createObservation()
    await installObservers(spaContext, spaPage, spaObservation)
    await spaPage.goto(`${baseUrl}/about`, { waitUntil: 'networkidle' })
    for (const entry of cases) {
      const target = `/article/${articles.get(entry.id)}`
      await spaPage.evaluate((url) => {
        history.pushState({}, '', url)
        dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
      }, target)
      await spaPage.waitForURL(`**${target}`)
      await spaPage.waitForLoadState('networkidle')
      await audit(spaPage, entry, '.markdown-body, [data-markdown-root], article', spaObservation)
      results.push({ browser: browserName, caseId: entry.id, phase: 'spa-navigation', surface: 'public-article', status: 'ok', entityId: articles.get(entry.id) })
    }
    await spaContext.close()

    const previewContext = await browser.newContext({ storageState: storageStatePath(), serviceWorkers: 'block' })
    const previewPage = await previewContext.newPage()
    const previewObservation = createObservation()
    await installObservers(previewContext, previewPage, previewObservation)
    await previewPage.goto(`${baseUrl}/user/manage/article/write?preview=private`, { waitUntil: 'networkidle' })
    const title = previewPage.getByPlaceholder('写下文章标题')
    const body = previewPage.locator('#article-content')
    const summary = previewPage.getByLabel('摘要')
    for (const entry of cases) {
      await title.fill(`XSS ${entry.id}`)
      await body.fill(markdownForCorpusCase(entry))
      await summary.fill(entry.id)
      const previewTab = previewPage.getByRole('button', { name: /私有预览/u }).first()
      if (await previewTab.count()) await previewTab.click()
      await previewPage.getByRole('button', { name: '生成私有预览' }).click()
      await previewPage.locator('.author-preview[data-preview-render-complete]').waitFor({ state: 'visible', timeout: 30_000 })
      await audit(previewPage, entry, '.author-preview', previewObservation)
      results.push({ browser: browserName, caseId: entry.id, phase: 'authoring-preview', surface: 'private-preview', status: 'ok' })
    }
    await previewContext.close()
  } finally {
    await browser.close()
  }
}

await mkdir(outputRoot, { recursive: true })
const results = []
let report
let runtime = null
let cleanup = null
let failure = null
try {
  runtime = await prepareProductionRuntime()
  const corpusContract = await loadProductionXssCorpus()
  const cases = selectProductionXssCases(corpusContract.corpus, mode)
  const seeded = await seed(cases, resolveMetadataProbe(cases))
  const browsers = mode === 'release'
    ? [['chromium', playwright.chromium], ['firefox', playwright.firefox], ['webkit', playwright.webkit]]
    : [['chromium', playwright.chromium]]
  await Promise.all(browsers.map(([name, type]) => runBrowser(name, type, cases, seeded.articles, results)))
  report = {
    schema: 'fsusblog.production-xss-browser-matrix.v1',
    status: 'ok',
    mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    source: {
      corpus: corpusContract.source,
      corpusDigest: `sha256:${corpusContract.digest}`,
      corpusManifest: corpusContract.manifest,
      fsusUiRootDigest: sha256(corpusContract.fsusUiRoot),
      testOnlyContractPath: path.relative(repositoryRoot, corpusContract.contractPath)
    },
    browsers: browsers.map(([name]) => name),
    caseCount: cases.length,
    entries: results,
    runtime: {
      namespace: runtime.prepared.identity.namespace,
      baseUrl,
      backendUrl: runtime.prepared.manifest.backendUrl,
      build: runtime.build
    }
  }
} catch (error) {
  failure = error
  report = {
    schema: 'fsusblog.production-xss-browser-matrix.v1',
    status: 'failed',
    mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    entries: results
  }
} finally {
  cleanup = await cleanupSingleBrowserContractFixture(runtime?.prepared, {
    reason: failure ? 'production-xss-failure' : 'completed'
  })
  report.cleanup = cleanup
  if (cleanup.status !== 'success') {
    report.status = 'failed'
    failure ??= new Error(`production XSS cleanup failed: ${cleanup.error?.message ?? cleanup.status}`)
  }
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
if (failure) throw failure
console.log(`[production-xss] ${mode} OK cases=${report.caseCount} browsers=${report.browsers.join(',')} duration=${(report.durationMs / 1000).toFixed(2)}s report=${reportPath}`)

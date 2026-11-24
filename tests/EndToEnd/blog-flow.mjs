import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeArticleSummary } from '../../src/Contracts/article-summary.ts'
import { api } from '../../src/Contracts/client.ts'
import { decodePropertyValueBatchReceipt } from '../../src/Contracts/property-values.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import { selectOption, sha256Hex } from './admin-workspace-fixture.mjs'
import { exerciseArticleRights } from './article-rights-flow.mjs'
import { exerciseArticleSchedule } from './article-schedule-flow.mjs'
import * as authoring from './browser-authoring-fixture.mjs'
import { exerciseCanvas } from './canvas-flow.mjs'
import { exerciseCanvasHistory } from './canvas-history-flow.mjs'
import { exerciseDocumentExportTasks } from './document-export-task-flow.mjs'
import { exerciseInspector, exerciseInspectorDate } from './inspector-flow.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import * as exportFlow from './markdown-export-flow.mjs'
import { exerciseMarkdownImport } from './markdown-import-flow.mjs'
import { exerciseArticleOutline } from './outline-flow.mjs'
import { exerciseRelatedReading, verifyRelatedWithdrawal } from './related-reading-flow.mjs'
import { assertFields, assertStatus, pollHotRanking, readFrame } from './response-status-fixture.mjs'
import { retainAedsBody, waitForPathResponse } from './response-wait-fixture.mjs'
import { exerciseDraftRevision } from './revision-flow.mjs'
import * as loc from './role-locators.mjs'
import { exerciseSearchWorkerReuse } from './search-worker-reuse-flow.mjs'
import { requireWebPackage } from './web-package-fixture.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'
import { exerciseWorkspace } from './workspace-flow.mjs'

const { expect } = authoring
const { FrameType, WireLimits, WireRoutes } = wire

const config = {
  origin: process.env.FSUSBLOG_TEST_URL,
  bootstrap: process.env.FSUSBLOG_TEST_AUTHOR_BOOTSTRAP,
  evidence: resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/browser'),
  requireNative: process.env.FSUSBLOG_TEST_REQUIRE_NATIVE === '1',
  publicFixture: process.env.FSUSBLOG_TEST_PUBLIC_FIXTURE === '1',
  pdfEnabled: Boolean(process.env.FSUSBLOG_PDF_TOOL_ROOT && process.env.FSUSBLOG_PDF_TOOL_SHA256),
  pdfFixture: process.env.FSUSBLOG_TEST_PDF_FIXTURE,
}
assert(config.origin && config.bootstrap, 'Provide FSUSBLOG_TEST_URL and FSUSBLOG_TEST_AUTHOR_BOOTSTRAP for an isolated server fixture.')
if (config.pdfFixture) {
  assert(config.pdfEnabled, 'Provide the pinned PDF toolchain to capture the PDF fixture.')
  assert(isAbsolute(config.pdfFixture), 'The PDF fixture path must be absolute.')
}

const token = `fsusv2${Date.now()}`
const title = `Browser flow ${token}`
const bodyTerm = `publicationneedle${Date.now()}`
const padding = 'Padding paragraph. '.repeat(15)
const pdfPagination = config.pdfFixture ? '\n## 中文分页验收首段\n\n' + Array.from({ length: 72 }, (_, index) =>
  `第 ${index + 1} 段记录离线文档中的中文排版。每一页都应保留清晰的文字。\n\n`).join('') + '中文分页验收末段。\n' : ''
const body = `## Draft milestone\n\nThis release note contains ${token}.\n${padding}\n${bodyTerm} 博客搜索.\n${pdfPagination}`
const origin = new URL(config.origin).origin
const nativeFetch = globalThis.fetch
const repository = fileURLToPath(new URL('../../', import.meta.url))
const git = (...args) => spawnSync('git', args, { cwd: repository, encoding: 'utf8' }).stdout.trim()
const artifactDigests = Object.fromEntries(await Promise.all(
  ['src/Web/pnpm-lock.yaml', 'src/Server/packages.lock.json'].map(async path =>
    [path, sha256Hex(await readFile(join(repository, path)))]),
))
if (process.env.FSUSBLOG_WEB_DIST) {
  artifactDigests['web/index.html'] = sha256Hex(await readFile(join(process.env.FSUSBLOG_WEB_DIST, 'index.html')))
}
assert.equal((await nativeFetch(`${origin}/health/ready`)).status, 204, 'The isolated V2 server is not ready.')
const serverHome = await nativeFetch(`${origin}/`).then(async response => {
  assert.equal(response.status, 200)
  return response.text()
})
artifactDigests['GET /'] = sha256Hex(serverHome)
const asset = serverHome.match(/<script type="module"[^>]+src="([^"]+)"/)?.[1]
assert(asset, 'Server did not serve a Web production entry point.')
const servedBuild = await nativeFetch(new URL(asset, origin))
assert.equal(servedBuild.status, 200)
artifactDigests[asset] = sha256Hex(Buffer.from(await servedBuild.arrayBuffer()))
globalThis.fetch = (path, init) => nativeFetch(new URL(path, origin), init)

const browser = await isolated.launchChrome()
const observations = []
const diagnostics = []
const responses = []
const startedAt = new Date().toISOString()
const author = authoring.authorFixture(origin, diagnostics)
const desktop = await isolated.openLocaleContext(browser, origin, { viewport: { width: 1280, height: 800 }, colorScheme: 'light' })
const mobile = await isolated.openLocaleContext(browser, origin, { viewport: { width: 375, height: 850 }, colorScheme: 'light' })
let publisher = await desktop.newPage()
const visitor = await mobile.newPage()
function monitor(page, name) {
  page.on('pageerror', error => diagnostics.push({ name, kind: 'uncaught', message: error.message }))
  page.on('console', info => {
    if (info.type() === 'error' && !info.text().startsWith('Failed to load resource:')) {
      diagnostics.push({ name, kind: 'console', message: info.text() })
    }
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin === origin && url.pathname.startsWith('/assets/') && response.status() >= 400) {
      diagnostics.push({ name, kind: 'asset', path: url.pathname, status: response.status() })
    }
    if (url.origin === origin && url.pathname.startsWith('/api/')) {
      responses.push({ name, method: response.request().method(), path: url.pathname, status: response.status() })
      if (response.status() >= 500) {
        diagnostics.push({ name, kind: 'server', path: url.pathname, status: response.status() })
      }
    }
  })
}
monitor(publisher, 'publisher')
monitor(visitor, 'visitor')
const visible = locator => locator.waitFor({ state: 'visible' })
const hidden = locator => locator.waitFor({ state: 'hidden' })
const screen = (page, name) => isolated.saveShot(page, config.evidence, `${name}.png`, {})
const closeInspector = () => loc.exactButton(publisher.getByRole('complementary', { name: 'Article inspector' }), 'Close').click()

async function waitForHotRanking(generation) {
  if (!serverHome.includes('<meta name="fsus-public-hot-articles" content="1">')) return
  const { generation: observed } = await pollHotRanking(origin, nativeFetch)
  if (generation !== undefined) assert.equal(observed, String(generation))
}

async function search(page, value) {
  await page.goto(`${origin}/search`)
  await page.getByRole('textbox', { name: 'Search articles' }).fill(value)
  await loc.exactButton(page.locator('form.search-form'), 'Search').click()
}

async function exercisePublicFragments() {
  const spacer = Array.from({ length: 45 }, (_, index) => `Reading paragraph ${index + 1} before the next target.`).join('\n\n')
  const source = [spacer, '## Heading witness ^harbor', '[Jump to paragraph](#detail)', '[Jump to code](#sample)', spacer,
    'An explicit *paragraph* ^detail', spacer,
    '```typescript\nconst answer = 42\n```\n^sample',
    'First ^collision', 'Second ^collision', spacer].join('\n\n')
  const draft = await author.createDraft(publisher, 'Public fragment witness', source)
  const published = await author.publishDraft(publisher, draft)
  const url = `${origin}/article/${draft.id}`
  const reader = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' })
  monitor(reader, 'desktop-public-fragments')
  const inView = locator => expect(locator).toBeInViewport({ ratio: 0.1 })
  async function verifyLinkedTab(page, linkText, monitorName, hash, selector, checkShiki) {
    const [linked] = await Promise.all([page.context().waitForEvent('page'), loc.exactLink(page, linkText).click()])
    try {
      monitor(linked, monitorName)
      await expect(linked).toHaveURL(url + hash)
      const target = linked.locator(selector)
      if (checkShiki) await expect(target).toHaveAttribute('data-code-highlighted', 'shiki')
      await inView(target)
    } finally { await linked.close() }
  }
  try {
    for (const page of [reader, visitor]) {
      assertStatus(await page.goto(url + '#harbor'), 200)
      const heading = loc.exactHeading(page, 'Heading witness')
      await expect(heading).toHaveAttribute('id', 'harbor')
      await inView(heading)
      const code = page.locator('pre#sample')
      await expect(code).toHaveAttribute('data-code-highlighted', 'shiki')
      await verifyLinkedTab(page, 'Jump to paragraph', 'linked-public-fragment', '#detail', 'p#detail', false)
      await verifyLinkedTab(page, 'Jump to code', 'linked-public-code-fragment', '#sample', 'pre#sample', true)
      const detail = page.locator('p#detail')
      for (const [hash, target] of [['#detail', detail], ['#sample', code]]) {
        assert.equal(await page.goto(url + hash), null)
        if (target === code) await expect(code).toHaveAttribute('data-code-highlighted', 'shiki')
        await inView(target)
      }
      for (const [hash, target] of [['#detail', detail], ['#harbor', heading]]) {
        await page.goBack()
        await expect(page).toHaveURL(url + hash)
        await inView(target)
      }
      assert.equal(await page.goto(url + '#collision'), null)
      await expect(heading).toBeAttached()
      await expect(page.locator('#collision')).toHaveCount(0)
    }
    observations.push('Public Markdown heading, paragraph, and Shiki-highlighted fenced code fragments scroll into view on desktop and mobile. Back returns to previous targets and duplicate anchors have no target.')
  } finally {
    await reader.close()
    await author.retractDraft(publisher, published)
  }
}

async function exercisePropertyBatch(publisher, observations) {
  const article = await author.createDraft(publisher, 'Independent property batch draft', 'The batch changes properties only.')
  const page = await publisher.context().newPage()
  monitor(page, 'property-batch')
  const panel = loc.exactRegion(page, 'Properties')
  const control = name => loc.exactButton(panel, name)
  const textLabel = 'Article subtitle'
  const numberLabel = 'Editorial score'
  const booleanLabel = 'Editorial approval'
  const committedText = 'Batch subtitle 漢字 🧭'
  const committedNumber = '9876543210987654321.12345678'
  const staleText = 'Uncommitted batch subtitle'
  const staleNumber = '0.12345678901234567898765432'
  const requests = []

  const isValueBatch = request => request.method() === 'POST' && new URL(request.url()).pathname === WireRoutes.PropertyValueCommand &&
    decodeFrame(request.postDataBuffer()).type === FrameType.PropertyValueBatchCommand
  page.on('request', request => { if (isValueBatch(request)) requests.push(request) })

  async function read() {
    const workspace = await author.readPropertyEditor(page, { articleId: article.id, articleRevision: article.revision })
    assertFields(workspace, { articleId: article.id, articleRevision: article.revision })
    return workspace
  }

  const values = workspace => ['article-subtitle', 'editorial-score', 'editorial-approval'].map(key => {
    const field = workspace.fields.find(item => item.machineKey === key)
    assert(field, `Fixture lacks ${key}`)
    return field.value
  })

  async function openPanel(reload = false) {
    if (reload) await page.reload()
    await loc.exactButton(page, 'Inspector').click()
    await control('Edit multiple properties').waitFor()
  }

  async function stageText(label, content) {
    await control(`Edit ${label}`).click()
    await loc.exactLabel(panel, `${label} value`).fill(content)
    await control('Stage property').click()
  }

  async function stagePair(text, number) {
    await control('Edit multiple properties').click()
    await stageText(textLabel, text)
    await stageText(numberLabel, number)
  }

  async function expectState(expectedRevision, expectedValues) {
    const state = await read()
    if (expectedRevision !== undefined) assert.equal(state.valueRevision, expectedRevision)
    assert.deepEqual(values(state), expectedValues)
    return state
  }

  const staged = loc.exactText(panel, '2 staged changes')
  async function saveBatch(previous, count) {
    await staged.waitFor()
    const [reply] = await Promise.all([page.waitForResponse(res => isValueBatch(res.request())).then(retainAedsBody), control('Save property changes').click()])
    const receipt = await readFrame(reply, FrameType.PropertyValueBatchReceipt, decodePropertyValueBatchReceipt)
    assertFields(receipt, { articleId: article.id, schemaRevision: previous.schemaRevision, valueRevision: previous.valueRevision + 1n })
    assert.equal(requests.length, count)
    await loc.exactText(panel, 'Property changes saved.').waitFor()
    return receipt
  }

  try {
    await page.goto(author.editPath(article.id))
    await openPanel()
    const missing = { kind: 'missing' }
    const start = await expectState(undefined, [missing, missing, missing])
    await stagePair(committedText, committedNumber)
    assert.equal(requests.length, 0)
    assert.deepEqual(values(await read()), [missing, missing, missing], 'Staging cannot change stored values')
    const success = await saveBatch(start, 1)
    const text = { kind: 'text', value: committedText }
    const number = { kind: 'number', value: committedNumber }
    await openPanel(true)
    await loc.exactText(panel, committedText).waitFor()
    await loc.exactText(panel, committedNumber).waitFor()
    const current = await expectState(success.valueRevision, [text, number, missing])

    await stagePair(staleText, staleNumber)
    await staged.waitFor()
    await page.setViewportSize({ width: 375, height: 850 })
    await loc.exactDialog(page, 'Article inspector').waitFor()
    await staged.waitFor()
    await isolated.assertScrollWidth(page, 375)
    const stagedValues = panel.getByRole('list', { name: 'Staged property changes' })
    async function expectStagedValues() {
      await loc.exactText(stagedValues, `${textLabel} · ${staleText}`).waitFor()
      await loc.exactText(stagedValues, `${numberLabel} · ${staleNumber}`).waitFor()
    }
    await expectStagedValues()
    const boolean = current.fields.find(field => field.machineKey === 'editorial-approval')
    assert(boolean)
    const concurrent = await author.savePropertyValue(page, {
      articleId: article.id, articleRevision: article.revision, schemaRevision: current.schemaRevision,
      valueRevision: current.valueRevision, definitionId: boolean.definitionId, definitionRevision: boolean.definitionRevision,
      value: { kind: 'boolean', value: false },
    })
    assert.equal(concurrent.revision, current.valueRevision + 1n)

    let conflict
    await authoring.withHeldResponse(page, `${origin}${WireRoutes.PropertyValueCommand}`, async () => {
      conflict = page.waitForResponse(response => isValueBatch(response.request()))
      await control('Save property changes').click()
    }, async held => {
      assert.equal(await held.status(), 409)
      assert.equal(requests.length, 2)
      assert.equal(await control('Save property changes').isDisabled(), true)
      await staged.waitFor()
    }, { timeout: 5_000 })
    assertStatus(await conflict, 409)
    await panel.getByRole('alert').waitFor()
    await staged.waitFor()
    await expectStagedValues()
    assert.equal(requests.length, 2)
    const witnessed = await expectState(concurrent.revision, [text, number, { kind: 'boolean', value: false }])
    await control('Discard staged changes').click()
    await staged.waitFor({ state: 'hidden' })
    await control('Edit multiple properties').click()
    await control(`Edit ${textLabel}`).click()
    await control('Stage removal').click()
    await control(`Edit ${booleanLabel}`).click()
    await loc.exactText(panel.getByRole('radiogroup', { name: `${booleanLabel} value` }), 'True').click()
    await control('Stage property').click()
    const removal = await saveBatch(witnessed, 3)
    await openPanel(true)
    await loc.exactText(panel, 'True').waitFor()
    const final = await expectState(removal.valueRevision, [missing, number, { kind: 'boolean', value: true }])
    assert.equal(await loc.exactText(panel, committedText).count(), 0)

    // Append to the test owner's schema after the other blog scenarios finished using it.
    let schemaRevision = final.schemaRevision
    const added = Math.max(1, WireLimits.PropertyPageSize + 1 - final.fields.length)
    for (let index = 1; index <= added; ++index) {
      const receipt = await author.savePropertySchema(page, {
        operation: 1, definitionId: randomUUID(), definitionRevision: 0n, schemaRevision,
        machineKey: `zz-page-${String(index).padStart(2, '0')}`, label: `Paged property ${index}`, kind: 'text',
      })
      assert.equal(receipt.schemaRevision, ++schemaRevision)
    }
    await openPanel(true)
    assert.equal(await panel.locator('dt').count(), WireLimits.PropertyPageSize)
    await control('Edit multiple properties').click()
    await stageText(textLabel, staleText)
    await control('More properties').click()
    await loc.exactText(panel, 'Property page 2').waitFor()
    assert.equal(await panel.locator('dt').count() <= WireLimits.PropertyPageSize, true)
    assert.equal(await control(`Edit ${textLabel}`).count(), 0)
    await stageText(`Paged property ${added}`, 'On the next page')
    await control('Previous properties').click()
    await loc.exactText(panel, 'Property page 1').waitFor()
    await staged.waitFor()
    assert.equal(await panel.locator('dt').count(), WireLimits.PropertyPageSize)
    await page.waitForFunction(() => document.activeElement?.id === 'article-properties-title')
    assert.equal(requests.length, 3)
    await control('Discard staged changes').click()
    assert.equal((await read()).valueRevision, final.valueRevision)

    observations.push('One property batch saves Unicode and exact decimal values under one revision. A real concurrent 409 in the rehosted 375px Inspector keeps both staged changes and stores neither. After explicit discard, a fresh batch removes text and updates a Boolean without changing the article revision. Previous and More keep at most one page mounted while staged values span both pages.')
  } finally {
    try { await page.close() } finally { await author.deleteDraft(publisher, article) }
  }
}

let writtenId
let stalePageUrl

await isolated.withBrowserEvidence(
  browser,
  config.evidence,
  'browser-result.json',
  failure => ({
    origin, writtenId, startedAt, completedAt: new Date().toISOString(), exitCode: failure ? 1 : 0,
    commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain'), artifactDigests, node: process.version,
    fixture: { articleTitle: title, initialBodyDigest: sha256Hex(body) },
    chromium: browser.version(), playWright: requireWebPackage('@playwright/test/package.json').version,
    requireNative: config.requireNative, publicFixture: config.publicFixture, observations, diagnostics, responses,
    failure: failure ? String(failure) : undefined,
    cleanup: 'Playwright browser closed. Database and server fixture are owned by the caller.',
  }),
  async () => {
    if (config.publicFixture) {
      await waitForHotRanking()
      await visitor.goto(`${origin}/`)
      await visible(loc.exactLink(visitor, 'Browser fixture 12'))
      await loc.exactLink(visitor, 'Next').click()
      await visible(loc.exactText(visitor, 'Page 2'))
      await visible(loc.exactLink(visitor, 'Browser fixture 2'))
      stalePageUrl = visitor.url()
      assert(new URL(stalePageUrl).searchParams.get('cursor'), 'Page 2 needs the server-issued cursor')
      await loc.exactLink(visitor, 'Previous').click()
      await visible(loc.exactLink(visitor, 'Browser fixture 12'))
      await loc.exactLink(visitor, 'Web engineering').click()
      await visible(loc.exactHeading(visitor, 'Web engineering'))
      await visible(loc.exactText(visitor, 'Published implementation notes.'))
      await visible(loc.exactLink(visitor, 'Browser fixture 12'))
      await hidden(loc.exactLink(visitor, 'Browser fixture 11'))
      await screen(visitor, 'taxonomy-mobile')
      await visitor.goto(`${origin}/category/2`)
      await visible(loc.exactHeading(visitor, 'Empty category'))
      await visible(loc.exactText(visitor, 'There are no published articles here yet.'))
      const alias = await nativeFetch(`${origin}/tag/ancienne`, { redirect: 'manual' })
      assert.equal(alias.status, 301)
      assert.equal(alias.headers.get('location'), '/tag/4')
      await visitor.goto(`${origin}/tag/ancienne`)
      await visitor.waitForURL(`${origin}/tag/4`)
      await visible(loc.exactHeading(visitor, 'Café'))
      await visible(loc.exactLink(visitor, 'Browser fixture 12'))
      observations.push('Signed home cursor traverses forward and back. Category data and empty state render. The old tag URL redirects to the numeric page.')
    }
    await visitor.goto(`${origin}/admin/articles/write`)
    await visible(visitor.getByText('Log in with an author account to write an article.'))
    await hidden(loc.exactLabel(visitor, 'Title'))
    observations.push('Anonymous write route hides the draft and exposes login.')

    await signInFreshAdmin(publisher, origin, config.bootstrap, page => screen(page, 'login-desktop'))
    await publisher.goto(`${origin}/admin/articles/write`)
    await visible(publisher.getByRole('heading', { name: 'New article' }))
    await loc.exactLabel(publisher, 'Title').fill(title)
    await loc.exactLabel(publisher, 'Body').fill(body)
    if (config.requireNative) {
      await visible(publisher.locator('.el-markdown-editor'))
      await hidden(publisher.getByText('Rich editing unavailable.', { exact: false }))
    }

    // Try leaving once; the registered draft should survive the cancel.
    await loc.exactLink(publisher, 'Back').click()
    await visible(loc.exactText(publisher, 'Discard unsaved changes?'))
    await loc.exactButton(publisher, 'Keep writing').click()
    assert.equal(await loc.exactLabel(publisher, 'Title').inputValue(), title)

    await loc.exactButton(publisher, 'Save draft').click()
    await publisher.waitForURL(/\/admin\/articles\/edit\/\d+$/)
    writtenId = Number(new URL(publisher.url()).pathname.split('/').at(-1))
    await visible(loc.exactText(publisher, 'Draft saved.'))
    await loc.exactButton(publisher, 'Inspector').click()
    const initialExport = await exportFlow.readMarkdownDownload(publisher, loc.exactButton(publisher, 'Download saved Markdown'), body)
    assert.equal(initialExport.title, title)
    if (process.env.FSUSBLOG_TEST_DOCUMENT_EXPORT_TASKS === '1') {
      await exerciseDocumentExportTasks(publisher, writtenId, initialExport.revision, token, config.pdfEnabled)
      observations.push('The author creates a document export task and downloads its exact private result after reloading the editor.')
    }
    const wordExport = await exportFlow.readWordDownload(publisher, loc.exactButton(publisher, 'Download saved Word'))
    if (process.env.FSUSBLOG_TEST_DOCX_RENDER_FIXTURE)
      await wordExport.saveAs(process.env.FSUSBLOG_TEST_DOCX_RENDER_FIXTURE)
    const epub = await exportFlow.readEpubDownload(publisher, loc.exactButton(publisher, 'Download saved EPUB'))
    if (process.env.FSUSBLOG_TEST_EPUB_FIXTURE)
      await epub.saveAs(process.env.FSUSBLOG_TEST_EPUB_FIXTURE)
    const savedPdf = loc.exactButton(publisher, 'Download saved PDF')
    if (config.pdfEnabled) {
      await exportFlow.readPdfDownload(publisher, savedPdf, writtenId, initialExport.revision, initialExport.revision)
      observations.push('The saved draft downloads the same private PDF bytes returned by the exact revision endpoint.')
    } else assert.equal(await savedPdf.count(), 0)
    await exportFlow.verifyOfflineHtmlDownload(publisher, loc.exactButton(publisher, 'Download saved HTML'), title, bodyTerm)
    await closeInspector()
    observations.push('The saved editor downloads byte-exact Markdown and an HTML attachment that renders offline without resource requests.')
    observations.push('The saved editor downloads an EPUB whose bytes and first uncompressed mimetype entry match the private attachment.')
    assert(!(await api.publicIndex()).items.some(item => item.id === writtenId))
    await screen(publisher, 'editor-desktop')
    observations.push('Login, draft navigation protection, durable save, and unpublished omission from index.')

    const unsavedRecovery = `Recovery text ${token}`
    const editorUrl = publisher.url()
    // Wait for the author-only scope and its storage connection before creating the recovery copy.
    assertStatus(await publisher.request.get(`${origin}${WireRoutes.DraftRecoveryScope}`), 200)
    await loc.exactLabel(publisher, 'Body').fill(unsavedRecovery)
    await authoring.journalContains(publisher, unsavedRecovery)
    // Release the old editor page without taking its explicit discard route.
    await publisher.close({ runBeforeUnload: false })
    publisher = await desktop.newPage()
    monitor(publisher, 'publisher-recovered')
    await publisher.goto(editorUrl)
    await visible(publisher.getByRole('heading', { name: 'Recover an unsaved draft' }))
    assert.equal(await loc.exactLabel(publisher, 'Body').inputValue(), body)
    await loc.exactButton(publisher, 'Restore draft').click()
    await publisher.waitForFunction(source => document.querySelector('#article-body')?.value === source, unsavedRecovery)
    await loc.exactLabel(publisher, 'Body').fill(body)
    await loc.exactButton(publisher, 'Save draft').click()
    await visible(loc.exactText(publisher, 'Draft saved.'))
    assert.equal(await authoring.hasRecoveryCopy(publisher, writtenId), false)
    observations.push('The author inspects and restores an unconfirmed IndexedDB draft in a new page. Server acknowledgement purges it.')

    const createDraft = (name, content) => author.createDraft(publisher, name, content)
    await exerciseWorkspace({ page: publisher, origin, article: { id: writtenId, title, body }, screenshot: screen, monitor, token, observations })
    await exerciseArticleOutline({ page: publisher, origin, createDraft, screenshot: screen, monitor, observations })
    await exerciseInspector({ page: publisher, screenshot: screen, token, observations })
    await exerciseArticleSchedule(publisher, screen, observations)
    await exerciseArticleRights(publisher, observations)

    if (config.publicFixture) {
      await selectOption(publisher, publisher, 'Category', 'Web engineering')
      await loc.exactHeading(publisher, 'Classification').click()
      await loc.exactCombobox(publisher, 'Tags').and(publisher.locator(':not([readonly])')).click()
      await loc.exactOption(publisher, 'Café').click()
      await loc.exactHeading(publisher, 'Classification').click()
      await loc.exactButton(publisher, 'Save classification').click()
      await visible(loc.exactText(publisher, 'Classification saved.'))
      assert(!(await api.publicIndex()).items.some(item => item.id === writtenId))
      observations.push('Save classification commits against the current article revision and remains private until publication.')
    }

    async function addPropertyAndSave(label, key, type, setValue, displayed) {
      await loc.exactButton(publisher, 'Add property').click()
      await publisher.getByLabel('Property label').fill(label)
      await publisher.getByLabel('Property key').fill(key)
      if (type) await selectOption(publisher, publisher, 'Property type', type)
      await loc.exactButton(publisher, 'Create property').click()
      await loc.exactButton(publisher, `Edit ${label}`).click()
      if (typeof setValue === 'function') await setValue()
      else await publisher.getByLabel(`${label} value`).fill(setValue)
      await loc.exactButton(publisher, 'Save property').click()
      await visible(loc.exactText(publisher, displayed ?? setValue))
    }

    await addPropertyAndSave('Article subtitle', 'article-subtitle', undefined, `Private subtitle ${token}`)
    const exactScore = '12345678901234567890.12345678'
    await addPropertyAndSave('Editorial score', 'editorial-score', 'Number', exactScore)
    await addPropertyAndSave('Editorial approval', 'editorial-approval', 'Boolean', async () => {
      const approval = publisher.getByRole('radiogroup', { name: 'Editorial approval value' })
      await loc.exactText(approval, 'False').click()
      assert.equal(await loc.exactRadio(approval, 'False').isChecked(), true)
    }, 'False')
    await exerciseInspectorDate(publisher, observations)

    await publisher.reload()
    await loc.exactButton(publisher, 'Inspector').click()
    for (const value of [`Private subtitle ${token}`, exactScore, 'False', '2024-02-29T17:06:01.150Z']) {
      await visible(loc.exactText(publisher, value))
    }
    await screen(publisher, 'editor-properties')
    observations.push('The editor reloads a private text value, an exact decimal and a false Boolean without coercion.')
    await closeInspector()

    const summaryTerm = `summaryprobe${token}`
    const firstSummary = `摘要 🧭 Cafe\u0301\nDraft ${summaryTerm}`
    const publishedSummary = `This release note has a manual summary ${token}.`
    const summaryPath = WireRoutes.ArticleSummary.replace('{id:int}', String(writtenId))
    const summaryInput = loc.exactLabel(publisher, 'Summary text')
    async function inspectSummary() {
      const disclosure = loc.exactText(publisher, 'Article summary')
      await visible(loc.exactButton(publisher, 'Inspector'))
      if (!await disclosure.isVisible()) await loc.exactButton(publisher, 'Inspector').click()
      await visible(disclosure)
      if (!await summaryInput.isVisible()) await disclosure.click()
      await visible(summaryInput)
    }
    async function saveSummary(text) {
      const [response, receipt] = await Promise.all([
        waitForPathResponse(publisher, () => WireRoutes.ArticleSummarySave, 'POST'),
        waitForPathResponse(publisher, () => summaryPath, 'GET'),
        loc.exactButton(publisher, 'Save summary').click(),
      ])
      decodeFrame(response.request().postDataBuffer(), FrameType.ArticleSummaryCommand)
      const draft = await authoring.readDraft(response)
      assertFields(draft, { id: writtenId, body })
      assert.equal(new URL(receipt.url()).searchParams.get('revision'), String(draft.revision))
      assert.deepEqual(await readFrame(receipt, FrameType.ArticleSummary, decodeArticleSummary), { id: writtenId, revision: draft.revision, text })
      await visible(summaryInput)
      assert.equal(await summaryInput.inputValue(), text)
      await visible(loc.exactText(publisher, 'Summary saved.'))
      return draft
    }
    await inspectSummary()
    await summaryInput.fill(firstSummary)
    assert(await loc.exactButton(publisher, 'Publish article').isDisabled())
    await saveSummary(firstSummary)
    const privatePage = await nativeFetch(`${origin}/article/${writtenId}`)
    assert.equal(privatePage.status, 404)
    assert(!(await privatePage.text()).includes(firstSummary))
    await publisher.reload()
    await inspectSummary()
    assert.equal(await summaryInput.inputValue(), firstSummary)
    await loc.exactButton(publisher, 'Clear summary').click()
    await saveSummary('')
    await summaryInput.fill(publishedSummary)
    await saveSummary(publishedSummary)
    await closeInspector()

    await loc.exactButton(publisher, 'Publish article').click()
    await visible(publisher.getByText('Article published.', { exact: false }))
    const published = await api.publicIndex()
    const indexEntry = published.items.find(item => item.id === writtenId)
    assert(indexEntry)
    const publicArticle = await api.publicArticle(writtenId)
    assertFields(publicArticle, { title, body, summary: publishedSummary })
    assert.equal(indexEntry.summary, publishedSummary)
    const articleHtml = await nativeFetch(`${origin}/article/${writtenId}`)
    assert.equal(articleHtml.status, 200)
    const publicMarkup = await articleHtml.text()
    assert(publicMarkup.includes(`content="${publishedSummary}"`))
    assert(!publicMarkup.includes(firstSummary))
    observations.push('The Inspector saved and cleared a private revision summary, reopened it across navigation, and published only the final manual text in AEDS and HTML metadata.')
    assert.equal(publicArticle.rights?.copyrightHolder, 'Browser fixture owner & Co')
    assert.equal(indexEntry.publication, publicArticle.publication)
    if (config.publicFixture) {
      assert.equal(publicArticle.category.id, 1)
      assert(publicArticle.tags.some(tag => tag.id === 4))
    }

    await waitForHotRanking(published.generation)
    if (stalePageUrl) {
      await visitor.goto(stalePageUrl)
      await visible(visitor.getByText('This page link has expired.', { exact: false }))
      await loc.exactLink(visitor, 'First page').click()
      await visible(loc.exactLink(visitor, title))
      observations.push('Public generation changes invalidate old page cursors and offer a working first-page recovery link.')
    }

    const homeHtml = await nativeFetch(`${origin}/`).then(response => response.text())
    assert(homeHtml.includes(title))
    assert(!homeHtml.includes(`Private subtitle ${token}`))
    await visitor.goto(`${origin}/`)
    await visible(visitor.getByRole('heading', { name: 'Latest posts' }))
    await visible(loc.exactLink(visitor, title))
    assert.equal(await visitor.locator('vite-error-overlay').count(), 0)
    await loc.exactButton(visitor, 'Menu').click()
    const theme = loc.roleWithExactName(visitor, 'radiogroup', 'Theme mode').filter({ visible: true })
    await loc.exactText(theme, 'Dark').click()
    assert.equal(await loc.exactRadio(theme, 'Dark').isChecked(), true)
    await loc.exactButton(visitor, 'Menu').click()
    await visitor.waitForFunction(() => document.documentElement.classList.contains('dark'))
    await isolated.assertScrollWidth(visitor, 375)
    await screen(visitor, 'home-mobile-dark')
    await loc.exactLink(visitor, title).click()
    await visible(loc.exactHeading(visitor, title))
    await hidden(visitor.getByRole('complementary', { name: 'Article rights' }))
    await hidden(loc.exactButton(visitor, 'Verify publication'))
    await hidden(loc.exactText(visitor, `Private subtitle ${token}`))
    if (config.requireNative) {
      await visible(loc.exactHeading(visitor, 'Draft milestone'))
      await hidden(visitor.getByText('Formatted view unavailable.', { exact: false }))
    } else {
      await visible(visitor.getByText(token, { exact: false }))
    }
    assert.match(await visitor.title(), new RegExp(title))
    await isolated.assertScrollWidth(visitor, 375)
    let relatedPrevious
    if (config.publicFixture) {
      relatedPrevious = await exerciseRelatedReading(visitor, writtenId, title, origin)
      observations.push('Related reading ranks shared public taxonomy and navigates previous and next articles with the keyboard and links.')
    }
    await screen(visitor, 'article-mobile-dark')

    const corpusResponse = mobile.waitForEvent('response', response =>
      new URL(response.url()).pathname === WireRoutes.PublicSearchCorpus && response.request().method() === 'GET').then(retainAedsBody)
    await search(visitor, 'release note')
    await visible(loc.exactLink(visitor, title))
    const corpus = await corpusResponse
    assertStatus(corpus, 200)
    assert.equal((await corpus.body()).subarray(0, 4).toString('ascii'), 'FSPK')
    assert(!indexEntry.summary.includes(bodyTerm), 'The full-text term must fall outside the index summary')
    const generationCheck = waitForPathResponse(visitor, () => WireRoutes.PublicSearchCorpus, 'HEAD')
    await search(visitor, bodyTerm)
    await visible(loc.exactLink(visitor, title))
    assertStatus(await generationCheck, 204)
    assert.equal((await api.search(bodyTerm)).items[0].id, writtenId)
    await screen(visitor, 'search-mobile-dark')
    observations.push('Published snapshot visible in HTML, AEDS public detail, and local full-text search on a dark 375px viewport. A body-only term passed through the FSPK worker and generation recheck.')

    const reversedTitle = `Reverse order ${token}`
    const comparison = await author.publishDraft(publisher, await createDraft(reversedTitle,
      `## Draft milestone\n\nThis release note contains ${token}.\n${padding}\n搜索博客 ${bodyTerm}.\n${pdfPagination}`))
    const orderedLinks = visitor.locator('ol.article-list h2 a')
    const normalizedTerm = [...bodyTerm].map(letter => String.fromCodePoint(letter.codePointAt(0) + 0xfee0)).join('')
    await search(visitor, `${normalizedTerm}　博客搜索`)
    await visible(loc.exactText(orderedLinks, title))
    await visible(loc.exactText(orderedLinks, reversedTitle))
    assert.equal(await orderedLinks.first().textContent(), title)
    await search(visitor, `搜索博客 ${bodyTerm}`)
    await visible(loc.exactText(orderedLinks, reversedTitle))
    assert.equal(await orderedLinks.first().textContent(), reversedTitle)
    await author.deleteDraft(publisher, comparison)
    observations.push('The local worker normalizes fullwidth Latin and ranks mixed Latin/CJK dictionary phrases by stored word widths. Reversing query order reverses the order of otherwise equivalent articles.')

    const stale = await desktop.newPage()
    monitor(stale, 'stale-editor')
    await stale.goto(publisher.url())
    await visible(loc.exactLabel(stale, 'Body'))
    await loc.exactLabel(stale, 'Body').fill(`${body}\nStale edit.`)
    await loc.exactLabel(publisher, 'Body').fill(`${body}\nNewer saved revision.`)
    await loc.exactButton(publisher, 'Save draft').click()
    await visible(publisher.getByText('Draft saved.', { exact: false }))
    assert.equal((await api.publicArticle(writtenId)).body, body)
    await loc.exactButton(stale, 'Save draft').click()
    await visible(stale.getByText('The server has a newer revision.', { exact: false }))
    assert.match(await loc.exactLabel(stale, 'Body').inputValue(), /Stale edit/)
    await loc.exactButton(stale, 'Load latest revision').click()
    await loc.exactButton(stale, 'Discard changes').click()
    await stale.waitForFunction(() => document.querySelector('#article-body')?.value?.includes('Newer saved revision.'))
    await stale.close()

    await exerciseDraftRevision({
      page: publisher, origin, articleId: writtenId, sourceRevision: publicArticle.revision,
      originalBody: body, publicArticle: api.publicArticle, screenshot: screen, observations, pdfEnabled: config.pdfEnabled,
      pdfFixture: config.pdfFixture,
    })
    await exerciseCanvas({ page: publisher, origin, targetArticle: publicArticle, screenshot: screen, monitor, observations, createDraft })
    await exerciseCanvasHistory({ page: publisher, origin, screenshot: screen, monitor, observations })
    await isolated.withTempContext(browser, { viewport: { width: 375, height: 850 }, colorScheme: 'dark' }, async searchContext => {
      await searchContext.addCookies([{ name: 'fsus_locale', value: 'en', url: origin }])
      const isolatedSearch = await searchContext.newPage()
      monitor(isolatedSearch, 'fresh-search-corpus')
      await exerciseSearchWorkerReuse({
        page: isolatedSearch, origin, articleTitle: title, firstQuery: bodyTerm, repeatQuery: bodyTerm.toUpperCase(),
        withdraw: async () => {
          await loc.exactButton(publisher, 'More actions').click()
          await loc.exactMenuItem(publisher, 'Withdraw').click()
          await visible(loc.exactText(publisher, 'Article withdrawn.'))
        },
        observations,
      })
    })
    const withdrawn = await api.publicIndex()
    assert.notEqual(withdrawn.generation, published.generation)
    assert(!withdrawn.items.some(item => item.id === writtenId))
    await assert.rejects(api.publicArticle(writtenId), { status: 404 })
    const absent = await visitor.goto(`${origin}/article/${writtenId}`)
    assertStatus(absent, 404)
    assert(!(await absent.text()).includes(token))
    await verifyRelatedWithdrawal(visitor, writtenId, relatedPrevious, origin)
    const priorSearchGeneration = corpus.headers()['x-fsus-search-index-generation']
    assert(priorSearchGeneration)
    assert.equal((await nativeFetch(`${origin}${WireRoutes.PublicSearchCorpus}?generation=${priorSearchGeneration}`, { method: 'HEAD' })).status, 409)
    await search(visitor, bodyTerm)
    await visible(loc.exactText(visitor, 'No articles match your search.'))
    if (process.env.FSUSBLOG_TEST_MARKDOWN_IMPORT === '1') {
      await isolated.withTempContext(browser, { viewport: { width: 375, height: 850 }, storageState: await desktop.storageState() }, async importer => {
        const importPage = await importer.newPage()
        monitor(importPage, 'markdown-import')
        await importPage.goto(`${origin}/admin/articles/write`)
        const imported = await exerciseMarkdownImport({ page: importPage, origin, bytes: initialExport.bytes, title, body })
        assert.notEqual(imported.id, writtenId)
        await assert.rejects(api.publicArticle(imported.id), { status: 404 })
        await author.deleteDraft(publisher, imported)
        observations.push('On a 375px viewport, a byte-exact Markdown export loaded locally, saved as a new private draft, and survived reload. Invalid UTF-8 and an invalid named header left the draft blank.')
      })
    }
    await exercisePropertyBatch(publisher, observations)
    if (config.requireNative) await exercisePublicFragments()
    await publisher.goto(`${origin}/admin/identity`)
    const signOut = waitForPathResponse(publisher, () => WireRoutes.AdminSignOut)
    await loc.exactButton(publisher, 'Log out of administrator session').click()
    assertStatus(await signOut, 200)
    await visible(loc.exactHeading(publisher, 'Administrator access'))
    assertStatus(await publisher.request.get(`${origin}${WireRoutes.AuthoringSession}`), 401)
    observations.push('CAS rejects stale edit, reload reads the durable winner, withdrawal removes public access and index entry, logout returns to anonymous shell.')
    assert(responses.some(response => response.path === WireRoutes.Save && response.status === 409))
    assert.deepEqual(diagnostics, [])
  },
  {
    mkdir: true,
    onError: async () => {
      await screen(publisher, 'publisher-failed').catch(() => {})
      await screen(visitor, 'visitor-failed').catch(() => {})
    },
  },
)
console.log(observations.join('\n'))

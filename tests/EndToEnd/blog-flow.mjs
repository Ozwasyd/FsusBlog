import { holdResponse, journalContains } from './browser-authoring-fixture.mjs'
import assert from 'node:assert/strict'
import { requireWebPackage } from './web-package-fixture.mjs'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { api } from '../../src/Contracts/client.ts'
import { exerciseRelatedReading, verifyRelatedWithdrawal } from './related-reading-flow.mjs'
import { exerciseSearchWorkerReuse } from './search-worker-reuse-flow.mjs'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeArticleSummary } from '../../src/Contracts/article-summary.ts'
import { decodePropertyEditor, decodePropertyValueBatchReceipt, encodePropertySchemaCommand, encodePropertyValueCommand } from '../../src/Contracts/property-values.ts'
import { decodeDraft, decodePropertyCommandReceipt, encodeArticleCommand, encodePropertyWorkspaceRequest,
  FrameType, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { exerciseWorkspace } from './workspace-flow.mjs'
import { exerciseArticleOutline } from './outline-flow.mjs'
import { exerciseInspector, exerciseInspectorDate } from './inspector-flow.mjs'
import { exerciseDraftRevision } from './revision-flow.mjs'
import { exerciseCanvas } from './canvas-flow.mjs'
import { exerciseCanvasHistory } from './canvas-history-flow.mjs'
import { exerciseArticleSchedule } from './article-schedule-flow.mjs'
import { exerciseArticleRights } from './article-rights-flow.mjs'
import { exercisePropertyFilter } from './property-filter-flow.mjs'
import { exerciseAuthorTextSearch, exerciseSummarySearchReveal } from './author-text-search-flow.mjs'
import { exerciseAuthorTextPropertyFacet } from './author-text-property-facet-flow.mjs'
import { readEpubDownload, readMarkdownDownload, readPdfDownload, readWordDownload, verifyOfflineHtmlDownload } from './markdown-export-flow.mjs'
import { exerciseMarkdownImport } from './markdown-import-flow.mjs'
import { exerciseDocumentExportTasks } from './document-export-task-flow.mjs'
import { exactButton as button, roleWithExactName } from './role-locators.mjs'

const { chromium } = requireWebPackage('@playwright/test')

const config = {
  origin: process.env.FSUSBLOG_TEST_URL,
  ticket: process.env.FSUSBLOG_TEST_TICKET,
  evidence: resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/browser'),
  browserPath: process.env.FSUSBLOG_TEST_CHROME,
  requireNative: process.env.FSUSBLOG_TEST_REQUIRE_NATIVE === '1',
  publicFixture: process.env.FSUSBLOG_TEST_PUBLIC_FIXTURE === '1',
  pdfEnabled: Boolean(process.env.FSUSBLOG_PDF_TOOL_ROOT && process.env.FSUSBLOG_PDF_TOOL_SHA256),
  pdfFixture: process.env.FSUSBLOG_TEST_PDF_FIXTURE,
}
assert(config.origin && config.ticket, 'Provide FSUSBLOG_TEST_URL and FSUSBLOG_TEST_TICKET for an isolated server fixture.')
if (config.pdfFixture) {
  assert(config.pdfEnabled, 'Provide the pinned PDF toolchain to capture the PDF fixture.')
  assert(isAbsolute(config.pdfFixture), 'The PDF fixture path must be absolute.')
}
await mkdir(config.evidence, { recursive: true })

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
const sha256 = input => createHash('sha256').update(input).digest('hex')
const artifactDigests = Object.fromEntries(await Promise.all(
  ['src/Web/pnpm-lock.yaml', 'src/Server/packages.lock.json'].map(async path =>
    [path, sha256(await readFile(join(repository, path)))]),
))
if (process.env.FSUSBLOG_WEB_DIST) {
  artifactDigests['web/index.html'] = sha256(await readFile(join(process.env.FSUSBLOG_WEB_DIST, 'index.html')))
}
const served = await nativeFetch(`${origin}/health/ready`)
assert.equal(served.status, 204, 'The isolated V2 server is not ready.')
const serverHome = await nativeFetch(`${origin}/`).then(async response => {
  assert.equal(response.status, 200)
  return response.text()
})
artifactDigests['GET /'] = sha256(serverHome)
const asset = serverHome.match(/<script type="module"[^>]+src="([^"]+)"/)?.[1]
assert(asset, 'Server did not serve a Web production entry point.')
const servedBuild = await nativeFetch(new URL(asset, origin))
assert.equal(servedBuild.status, 200)
artifactDigests[asset] = sha256(Buffer.from(await servedBuild.arrayBuffer()))
globalThis.fetch = (path, init) => nativeFetch(new URL(path, origin), init)

const browser = await chromium.launch({
  executablePath: config.browserPath,
  headless: true,
})
const observations = []
const diagnostics = []
const responses = []
const startedAt = new Date().toISOString()
const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' })
const mobile = await browser.newContext({ viewport: { width: 375, height: 850 }, colorScheme: 'light' })
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
const visible = async locator => locator.waitFor({ state: 'visible' })
const hidden = async locator => locator.waitFor({ state: 'hidden' })
const screen = (page, name) => page.screenshot({ path: join(config.evidence, `${name}.png`) })

async function search(page, value) {
  await page.goto(`${origin}/search`)
  await page.getByRole('textbox', { name: 'Search articles' }).fill(value)
  await button(page.locator('form.search-form'), 'Search').click()
}

async function articleCommand(path, id, revision, title = '', body = '', expected = FrameType.Draft) {
  const input = encodeArticleCommand({ id, expectedRevision: revision, idempotencyKey: randomUUID(), title, body })
  const response = await publisher.request.post(`${origin}${path}`, {
    data: Buffer.from(encodeFrame(FrameType.ArticleCommand, input)),
    headers: { 'Content-Type': 'application/octet-stream' },
  })
  assert.equal(response.status(), 200)
  const frame = decodeFrame(await response.body(), expected)
  return expected === FrameType.Draft ? decodeDraft(frame.payload) : undefined
}

async function exercisePropertyBatch(publisher, observations) {
  const article = await articleCommand(WireRoutes.Save, 0, 0n, 'Independent property batch draft', 'The batch changes properties only.')
  const page = await publisher.context().newPage()
  monitor(page, 'property-batch')
  const editor = `${origin}/user/manage/article/edit/${article.id}`
  const panel = roleWithExactName(page, 'region', 'Properties')
  const control = name => button(panel, name)
  const textLabel = 'Article subtitle'
  const numberLabel = 'Editorial score'
  const booleanLabel = 'Editorial approval'
  const committedText = 'Batch subtitle 漢字 🧭'
  const committedNumber = '9876543210987654321.12345678'
  const staleText = 'Uncommitted batch subtitle'
  const staleNumber = '0.12345678901234567898765432'
  const requests = []

  function isValueBatch(request) {
    return request.method() === 'POST' && new URL(request.url()).pathname === WireRoutes.PropertyValueCommand &&
      decodeFrame(request.postDataBuffer()).type === FrameType.PropertyValueBatchCommand
  }
  page.on('request', request => {
    if (isValueBatch(request)) requests.push(request)
  })

  async function nativeProperty(path, type, payload, expected) {
    const receipt = await page.request.post(`${origin}${path}`, { data: Buffer.from(encodeFrame(type, payload)),
      headers: { 'Content-Type': 'application/octet-stream' } })
    assert.equal(receipt.status(), 200)
    return decodeFrame(await receipt.body(), expected).payload
  }

  async function read() {
    const payload = encodePropertyWorkspaceRequest({ articleId: article.id, articleRevision: article.revision,
      schemaRevision: 0n, valueRevision: 0n, afterKey: '' })
    const workspace = decodePropertyEditor(await nativeProperty(WireRoutes.PropertyEditor,
      FrameType.PropertyWorkspaceRequest, payload, FrameType.PropertyEditor))
    assert.equal(workspace.articleId, article.id)
    assert.equal(workspace.articleRevision, article.revision)
    return workspace
  }

  function values(workspace) {
    return ['article-subtitle', 'editorial-score', 'editorial-approval'].map(key => {
      const field = workspace.fields.find(item => item.machineKey === key)
      assert(field, `Fixture lacks ${key}`)
      return field.value
    })
  }

  async function openPanel() {
    await button(page, 'Inspector').click()
    await control('Edit multiple properties').waitFor()
  }

  async function stageText(label, content) {
    await control(`Edit ${label}`).click()
    await panel.getByLabel(`${label} value`, { exact: true }).fill(content)
    await control('Stage property').click()
  }

  const staged = panel.getByText('2 staged changes', { exact: true })
  async function saveBatch(previous, count) {
    await staged.waitFor()
    const pending = page.waitForResponse(response => isValueBatch(response.request()))
    await control('Save property changes').click()
    const reply = await pending
    assert.equal(reply.status(), 200)
    const receipt = decodePropertyValueBatchReceipt(decodeFrame(await reply.body(), FrameType.PropertyValueBatchReceipt).payload)
    assert.equal(receipt.articleId, article.id)
    assert.equal(receipt.schemaRevision, previous.schemaRevision)
    assert.equal(receipt.valueRevision, previous.valueRevision + 1n)
    assert.equal(requests.length, count)
    await panel.getByText('Property changes saved.', { exact: true }).waitFor()
    return receipt
  }

  try {
    await page.goto(editor)
    await openPanel()
    const start = await read()
    const missing = { kind: 'missing' }
    assert.deepEqual(values(start), [missing, missing, missing])
    await control('Edit multiple properties').click()
    await stageText(textLabel, committedText)
    await stageText(numberLabel, committedNumber)
    assert.equal(requests.length, 0)
    assert.deepEqual(values(await read()), [missing, missing, missing], 'Staging cannot change stored values')
    const success = await saveBatch(start, 1)
    const text = { kind: 'text', value: committedText }
    const number = { kind: 'number', value: committedNumber }
    await page.reload()
    await openPanel()
    await panel.getByText(committedText, { exact: true }).waitFor()
    await panel.getByText(committedNumber, { exact: true }).waitFor()
    const current = await read()
    assert.equal(current.valueRevision, success.valueRevision)
    assert.deepEqual(values(current), [text, number, missing])

    await control('Edit multiple properties').click()
    await stageText(textLabel, staleText)
    await stageText(numberLabel, staleNumber)
    await staged.waitFor()
    await page.setViewportSize({ width: 375, height: 850 })
    await roleWithExactName(page, 'dialog', 'Article inspector').waitFor()
    await staged.waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375)
    const stagedValues = panel.getByRole('list', { name: 'Staged property changes' })
    async function expectStagedValues() {
      await stagedValues.getByText(`${textLabel} · ${staleText}`, { exact: true }).waitFor()
      await stagedValues.getByText(`${numberLabel} · ${staleNumber}`, { exact: true }).waitFor()
    }
    await expectStagedValues()
    const boolean = current.fields.find(field => field.machineKey === 'editorial-approval')
    assert(boolean)
    const update = encodePropertyValueCommand({ articleId: article.id, articleRevision: article.revision,
      schemaRevision: current.schemaRevision, valueRevision: current.valueRevision, definitionId: boolean.definitionId,
      definitionRevision: boolean.definitionRevision, requestId: randomUUID(), value: { kind: 'boolean', value: false } })
    const concurrent = decodePropertyCommandReceipt(await nativeProperty(WireRoutes.PropertyValueCommand,
      FrameType.PropertyValueCommand, update, FrameType.PropertyCommandReceipt))
    assert.equal(concurrent.revision, current.valueRevision + 1n)

    const held = await holdResponse(page, `${origin}${WireRoutes.PropertyValueCommand}`, { timeout: 5_000 })
    try {
      const conflict = page.waitForResponse(response => isValueBatch(response.request()))
      await control('Save property changes').click()
      assert.equal(await held.status(), 409)
      assert.equal(requests.length, 2)
      assert.equal(await control('Save property changes').isDisabled(), true)
      await staged.waitFor()
      held.release()
      assert.equal((await conflict).status(), 409)
      const routeError = await held.done
      if (routeError) throw routeError
    } finally {
      held.release()
    }
    await panel.getByRole('alert').waitFor()
    await staged.waitFor()
    await expectStagedValues()
    assert.equal(requests.length, 2)
    const witnessed = await read()
    assert.equal(witnessed.valueRevision, concurrent.revision)
    assert.deepEqual(values(witnessed), [text, number, { kind: 'boolean', value: false }])
    await control('Discard staged changes').click()
    await staged.waitFor({ state: 'hidden' })
    await control('Edit multiple properties').click()
    await control(`Edit ${textLabel}`).click()
    await control('Stage removal').click()
    await control(`Edit ${booleanLabel}`).click()
    await panel.getByRole('radiogroup', { name: `${booleanLabel} value` }).getByText('True', { exact: true }).click()
    await control('Stage property').click()
    const removal = await saveBatch(witnessed, 3)
    await page.reload()
    await openPanel()
    await panel.getByText('True', { exact: true }).waitFor()
    const final = await read()
    assert.equal(final.valueRevision, removal.valueRevision)
    assert.deepEqual(values(final), [missing, number, { kind: 'boolean', value: true }])
    assert.equal(await panel.getByText(committedText, { exact: true }).count(), 0)

    // Append to the test owner's schema after the other blog scenarios finished using it.
    let schemaRevision = final.schemaRevision
    const added = Math.max(1, WireLimits.PropertyPageSize + 1 - final.fields.length)
    for (let index = 1; index <= added; ++index) {
      const key = `zz-page-${String(index).padStart(2, '0')}`
      const command = encodePropertySchemaCommand({ operation: 1, definitionId: randomUUID(), definitionRevision: 0n,
        schemaRevision, requestId: randomUUID(), machineKey: key, label: `Paged property ${index}`, kind: 'text' })
      const receipt = decodePropertyCommandReceipt(await nativeProperty(WireRoutes.PropertySchemaCommand,
        FrameType.PropertySchemaCommand, command, FrameType.PropertyCommandReceipt))
      assert.equal(receipt.schemaRevision, ++schemaRevision)
    }
    await page.reload()
    await openPanel()
    assert.equal(await panel.locator('dt').count(), WireLimits.PropertyPageSize)
    await control('Edit multiple properties').click()
    await stageText(textLabel, staleText)
    await control('More properties').click()
    await panel.getByText('Property page 2', { exact: true }).waitFor()
    assert.equal(await panel.locator('dt').count() <= WireLimits.PropertyPageSize, true)
    assert.equal(await control(`Edit ${textLabel}`).count(), 0)
    await stageText(`Paged property ${added}`, 'On the next page')
    await control('Previous properties').click()
    await panel.getByText('Property page 1', { exact: true }).waitFor()
    await staged.waitFor()
    assert.equal(await panel.locator('dt').count(), WireLimits.PropertyPageSize)
    await page.waitForFunction(() => document.activeElement?.id === 'article-properties-title')
    assert.equal(requests.length, 3)
    await control('Discard staged changes').click()
    assert.equal((await read()).valueRevision, final.valueRevision)

    observations.push('One property batch saves Unicode and exact decimal values under one revision. A real concurrent 409 in the rehosted 375px Inspector keeps both staged changes and stores neither. After explicit discard, a fresh batch removes text and updates a Boolean without changing the article revision. Previous and More keep at most one page mounted while staged values span both pages.')
  } finally {
    try { await page.close() } finally {
      await articleCommand(WireRoutes.Delete, article.id, article.revision, '', '', FrameType.EmptySuccess)
    }
  }
}

let writtenId
let stalePageUrl
let failure
try {
  if (config.publicFixture) {
    await visitor.goto(`${origin}/`)
    await visible(roleWithExactName(visitor, 'link', 'Browser fixture 12'))
    await roleWithExactName(visitor, 'link', 'Next').click()
    await visible(visitor.getByText('Page 2', { exact: true }))
    await visible(roleWithExactName(visitor, 'link', 'Browser fixture 2'))
    stalePageUrl = visitor.url()
    const cursor = new URL(stalePageUrl).searchParams.get('cursor')
    assert(cursor, 'Page 2 needs the server-issued cursor')
    await roleWithExactName(visitor, 'link', 'Previous').click()
    await visible(roleWithExactName(visitor, 'link', 'Browser fixture 12'))
    await roleWithExactName(visitor, 'link', 'Web engineering').click()
    await visible(roleWithExactName(visitor, 'heading', 'Web engineering'))
    await visible(visitor.getByText('Published implementation notes.', { exact: true }))
    await visible(roleWithExactName(visitor, 'link', 'Browser fixture 12'))
    await hidden(roleWithExactName(visitor, 'link', 'Browser fixture 11'))
    await screen(visitor, 'taxonomy-mobile')
    await visitor.goto(`${origin}/category/2`)
    await visible(roleWithExactName(visitor, 'heading', 'Empty category'))
    await visible(visitor.getByText('There are no published articles here yet.', { exact: true }))
    const alias = await nativeFetch(`${origin}/tag/ancienne`, { redirect: 'manual' })
    assert.equal(alias.status, 301)
    assert.equal(alias.headers.get('location'), '/tag/4')
    await visitor.goto(`${origin}/tag/ancienne`)
    await visitor.waitForURL(`${origin}/tag/4`)
    await visible(roleWithExactName(visitor, 'heading', 'Café'))
    await visible(roleWithExactName(visitor, 'link', 'Browser fixture 12'))
    observations.push('Signed home cursor traverses forward and back. Category data and empty state render. The old tag URL redirects to the numeric page.')
  }
  await visitor.goto(`${origin}/user/manage/article/write`)
  await visible(visitor.getByText('Log in with an author account to write an article.'))
  await hidden(visitor.getByLabel('Title', { exact: true }))
  observations.push('Anonymous write route hides the draft and exposes login.')

  await publisher.goto(`${origin}/login`)
  await visible(roleWithExactName(publisher, 'heading', 'Log in'))
  assert.match(await publisher.title(), /Log in/)
  await screen(publisher, 'login-desktop')
  await publisher.getByLabel('Owner access key').fill(config.ticket)
  await button(publisher, 'Log in').click()
  await visible(publisher.getByRole('heading', { name: 'New article' }))
  await publisher.getByLabel('Title', { exact: true }).fill(title)
  await publisher.getByLabel('Body', { exact: true }).fill(body)
  if (config.requireNative) {
    await visible(publisher.locator('.el-markdown-editor'))
    await hidden(publisher.getByText('Rich editing unavailable.', { exact: false }))
  }

  // Try leaving once; the registered draft should survive the cancel.
  await roleWithExactName(publisher, 'link', 'Back').click()
  await visible(publisher.getByText('Discard unsaved changes?', { exact: true }))
  await button(publisher, 'Keep writing').click()
  assert.equal(await publisher.getByLabel('Title', { exact: true }).inputValue(), title)

  await button(publisher, 'Save draft').click()
  await publisher.waitForURL(/\/user\/manage\/article\/edit\/\d+$/)
  writtenId = Number(new URL(publisher.url()).pathname.split('/').at(-1))
  await visible(publisher.getByText('Draft saved.', { exact: true }))
  await button(publisher, 'Inspector').click()
  const initialExport = await readMarkdownDownload(publisher, button(publisher, 'Download saved Markdown'), body)
  assert.equal(initialExport.title, title)
  if (process.env.FSUSBLOG_TEST_DOCUMENT_EXPORT_TASKS === '1') {
    await exerciseDocumentExportTasks(publisher, writtenId, initialExport.revision, token, config.pdfEnabled)
    observations.push('The author creates a document export task and downloads its exact private result after reloading the editor.')
  }
  const wordExport = await readWordDownload(publisher, button(publisher, 'Download saved Word'))
  if (process.env.FSUSBLOG_TEST_DOCX_RENDER_FIXTURE)
    await wordExport.saveAs(process.env.FSUSBLOG_TEST_DOCX_RENDER_FIXTURE)
  const epub = await readEpubDownload(publisher, button(publisher, 'Download saved EPUB'))
  if (process.env.FSUSBLOG_TEST_EPUB_FIXTURE)
    await epub.saveAs(process.env.FSUSBLOG_TEST_EPUB_FIXTURE)
  const savedPdf = button(publisher, 'Download saved PDF')
  if (config.pdfEnabled) {
    await readPdfDownload(publisher, savedPdf, writtenId, initialExport.revision, initialExport.revision)
    observations.push('The saved draft downloads the same private PDF bytes returned by the exact revision endpoint.')
  } else assert.equal(await savedPdf.count(), 0)
  await verifyOfflineHtmlDownload(publisher, button(publisher, 'Download saved HTML'), title, bodyTerm)
  await button(publisher.getByRole('complementary', { name: 'Article inspector' }), 'Close').click()
  observations.push('The saved editor downloads byte-exact Markdown and an HTML attachment that renders offline without resource requests.')
  observations.push('The saved editor downloads an EPUB whose bytes and first uncompressed mimetype entry match the private attachment.')
  assert(!(await api.publicIndex()).items.some(item => item.id === writtenId))
  await screen(publisher, 'editor-desktop')
  observations.push('Login, draft navigation protection, durable save, and unpublished omission from index.')

  const unsavedRecovery = `Recovery text ${token}`
  const editorUrl = publisher.url()
  const durableRecords = () => publisher.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('fsusblog-v2-draft-recovery')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('recovery')
      const read = transaction.objectStore('recovery').getAll()
      read.onerror = () => reject(read.error)
      read.onsuccess = () => resolve(read.result.map(item => ({ document: item.document, body: item.body })))
      transaction.oncomplete = () => database.close()
    }
  }))
  // Wait for the author-only scope and its storage connection before creating the recovery copy.
  const scopeLoaded = await publisher.request.get(`${origin}${WireRoutes.DraftRecoveryScope}`)
  assert.equal(scopeLoaded.status(), 200)
  await publisher.getByLabel('Body', { exact: true }).fill(unsavedRecovery)
  await journalContains(publisher, unsavedRecovery)
  // Release the old editor page without taking its explicit discard route.
  await publisher.close({ runBeforeUnload: false })
  publisher = await desktop.newPage()
  monitor(publisher, 'publisher-recovered')
  await publisher.goto(editorUrl)
  await visible(publisher.getByRole('heading', { name: 'Recover an unsaved draft' }))
  assert.equal(await publisher.getByLabel('Body', { exact: true }).inputValue(), body)
  await button(publisher, 'Restore draft').click()
  await publisher.waitForFunction(source => document.querySelector('#article-body')?.value === source, unsavedRecovery)
  await publisher.getByLabel('Body', { exact: true }).fill(body)
  await button(publisher, 'Save draft').click()
  await visible(publisher.getByText('Draft saved.', { exact: true }))
  assert(!(await durableRecords()).some(item => item.document === `article:${writtenId}`))
  observations.push('The author inspects and restores an unconfirmed IndexedDB draft in a new page. Server acknowledgement purges it.')

  await exerciseWorkspace({ page: publisher, origin, article: { id: writtenId, title, body }, screenshot: screen, monitor, token, observations })
  await exerciseArticleOutline({ page: publisher, origin, createDraft: (title, body) => articleCommand(WireRoutes.Save, 0, 0n, title, body),
    screenshot: screen, monitor, observations })
  await exerciseInspector({ page: publisher, screenshot: screen, token, observations })
  await exerciseArticleSchedule(publisher, screen, observations)
  await exerciseArticleRights(publisher, observations)

  if (config.publicFixture) {
    await roleWithExactName(publisher, 'combobox', 'Category').click()
    await roleWithExactName(publisher, 'option', 'Web engineering').click()
    await roleWithExactName(publisher, 'heading', 'Classification').click()
    await roleWithExactName(publisher, 'combobox', 'Tags').and(publisher.locator(':not([readonly])')).click()
    await roleWithExactName(publisher, 'option', 'Café').click()
    await roleWithExactName(publisher, 'heading', 'Classification').click()
    await button(publisher, 'Save classification').click()
    await visible(publisher.getByText('Classification saved.', { exact: true }))
    assert(!(await api.publicIndex()).items.some(item => item.id === writtenId))
    observations.push('Save classification commits against the current article revision and remains private until publication.')
  }

  await button(publisher, 'Add property').click()
  await publisher.getByLabel('Property label').fill('Article subtitle')
  await publisher.getByLabel('Property key').fill('article-subtitle')
  await button(publisher, 'Create property').click()
  await button(publisher, 'Edit Article subtitle').click()
  await publisher.getByLabel('Article subtitle value').fill(`Private subtitle ${token}`)
  await button(publisher, 'Save property').click()
  await visible(publisher.getByText(`Private subtitle ${token}`, { exact: true }))

  await button(publisher, 'Add property').click()
  await publisher.getByLabel('Property label').fill('Editorial score')
  await publisher.getByLabel('Property key').fill('editorial-score')
  await publisher.getByRole('combobox', { name: 'Property type' }).click()
  await roleWithExactName(publisher, 'option', 'Number').click()
  await button(publisher, 'Create property').click()
  await button(publisher, 'Edit Editorial score').click()
  const exactScore = '12345678901234567890.12345678'
  await publisher.getByLabel('Editorial score value').fill(exactScore)
  await button(publisher, 'Save property').click()
  await visible(publisher.getByText(exactScore, { exact: true }))

  await button(publisher, 'Add property').click()
  await publisher.getByLabel('Property label').fill('Editorial approval')
  await publisher.getByLabel('Property key').fill('editorial-approval')
  await publisher.getByRole('combobox', { name: 'Property type' }).click()
  await roleWithExactName(publisher, 'option', 'Boolean').click()
  await button(publisher, 'Create property').click()
  await button(publisher, 'Edit Editorial approval').click()
  const approval = publisher.getByRole('radiogroup', { name: 'Editorial approval value' })
  await approval.getByText('False', { exact: true }).click()
  assert.equal(await roleWithExactName(approval, 'radio', 'False').isChecked(), true)
  await button(publisher, 'Save property').click()
  await visible(publisher.getByText('False', { exact: true }))
  await exerciseInspectorDate(publisher, observations)

  await publisher.reload()
  await button(publisher, 'Inspector').click()
  await visible(publisher.getByText(`Private subtitle ${token}`, { exact: true }))
  await visible(publisher.getByText(exactScore, { exact: true }))
  await visible(publisher.getByText('False', { exact: true }))
  await visible(publisher.getByText('2024-02-29T17:06:01.150Z', { exact: true }))
  await screen(publisher, 'editor-properties')
  observations.push('The editor reloads a private text value, an exact decimal and a false Boolean without coercion.')

  await button(publisher.getByRole('complementary', { name: 'Article inspector' }), 'Close').click()
  await exercisePropertyFilter(publisher, origin, { id: writtenId, title }, exactScore, observations, articleCommand)
  await exerciseAuthorTextSearch({ publisher, origin, article: { id: writtenId, title }, bodyTerm, monitor, observations, articleCommand,
    publicFixture: config.publicFixture })
  await exerciseAuthorTextPropertyFacet({ publisher, origin, monitor, observations, articleCommand })

  const summaryTerm = `summaryprobe${token}`
  const firstSummary = `摘要 🧭 Cafe\u0301\nDraft ${summaryTerm}`
  const publishedSummary = `This release note has a manual summary ${token}.`
  const summaryPath = WireRoutes.ArticleSummary.replace('{id:int}', String(writtenId))
  const summaryInput = publisher.getByLabel('Summary text', { exact: true })
  const readSummary = response => new URL(response.url()).pathname === summaryPath && response.request().method() === 'GET'
  async function inspectSummary() {
    const disclosure = publisher.getByText('Article summary', { exact: true })
    await visible(button(publisher, 'Inspector'))
    if (!await disclosure.isVisible()) await button(publisher, 'Inspector').click()
    await visible(disclosure)
    if (!await summaryInput.isVisible()) await disclosure.click()
    await visible(summaryInput)
  }
  async function saveSummary(text) {
    const saved = publisher.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.ArticleSummarySave &&
      response.request().method() === 'POST')
    const reread = publisher.waitForResponse(readSummary)
    await button(publisher, 'Save summary').click()
    const response = await saved
    assert.equal(response.status(), 200)
    decodeFrame(response.request().postDataBuffer(), FrameType.ArticleSummaryCommand)
    const draft = decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload)
    assert.equal(draft.id, writtenId)
    assert.equal(draft.body, body)
    const receipt = await reread
    assert.equal(receipt.status(), 200)
    assert.equal(new URL(receipt.url()).searchParams.get('revision'), String(draft.revision))
    assert.deepEqual(decodeArticleSummary(decodeFrame(await receipt.body(), FrameType.ArticleSummary).payload),
      { id: writtenId, revision: draft.revision, text })
    await visible(summaryInput)
    assert.equal(await summaryInput.inputValue(), text)
    await visible(publisher.getByText('Summary saved.', { exact: true }))
    return draft
  }
  await inspectSummary()
  await summaryInput.fill(firstSummary)
  assert(await button(publisher, 'Publish article').isDisabled())
  const savedSummaryDraft = await saveSummary(firstSummary)
  await exerciseSummarySearchReveal({ publisher, origin, draft: savedSummaryDraft, source: firstSummary,
    word: summaryTerm, monitor, observations })
  const privatePage = await nativeFetch(`${origin}/article/${writtenId}`)
  assert.equal(privatePage.status, 404)
  assert(!(await privatePage.text()).includes(firstSummary))
  await publisher.reload()
  await inspectSummary()
  assert.equal(await summaryInput.inputValue(), firstSummary)
  await button(publisher, 'Clear summary').click()
  await saveSummary('')
  await summaryInput.fill(publishedSummary)
  await saveSummary(publishedSummary)
  await button(publisher.getByRole('complementary', { name: 'Article inspector' }), 'Close').click()

  await button(publisher, 'Publish article').click()
  await visible(publisher.getByText('Article published.', { exact: false }))
  const published = await api.publicIndex()
  const indexEntry = published.items.find(item => item.id === writtenId)
  assert(indexEntry)
  const publicArticle = await api.publicArticle(writtenId)
  assert.equal(publicArticle.title, title)
  assert.equal(publicArticle.body, body)
  assert.equal(publicArticle.summary, publishedSummary)
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

  if (stalePageUrl) {
    await visitor.goto(stalePageUrl)
    await visible(visitor.getByText('This page link has expired.', { exact: false }))
    await roleWithExactName(visitor, 'link', 'First page').click()
    await visible(roleWithExactName(visitor, 'link', title))
    observations.push('Public generation changes invalidate old page cursors and offer a working first-page recovery link.')
  }

  const homeHtml = await nativeFetch(`${origin}/`).then(response => response.text())
  assert(homeHtml.includes(title))
  assert(!homeHtml.includes(`Private subtitle ${token}`))
  await visitor.goto(`${origin}/`)
  await visible(visitor.getByRole('heading', { name: 'Latest posts' }))
  await visible(roleWithExactName(visitor, 'link', title))
  assert.equal(await visitor.locator('vite-error-overlay').count(), 0)
  await button(visitor, 'Menu').click()
  await visitor.getByRole('button', { name: /Theme mode/ }).click()
  await roleWithExactName(visitor, 'menuitemradio', 'Dark').click()
  await visitor.waitForFunction(() => document.documentElement.classList.contains('dark'))
  assert.equal(await visitor.evaluate(() => document.documentElement.scrollWidth), 375)
  await screen(visitor, 'home-mobile-dark')
  await roleWithExactName(visitor, 'link', title).click()
  await visible(roleWithExactName(visitor, 'heading', title))
  await hidden(visitor.getByRole('complementary', { name: 'Article rights' }))
  await hidden(button(visitor, 'Verify publication'))
  await hidden(visitor.getByText(`Private subtitle ${token}`, { exact: true }))
  if (config.requireNative) {
    await visible(roleWithExactName(visitor, 'heading', 'Draft milestone'))
    await hidden(visitor.getByText('Formatted view unavailable.', { exact: false }))
  } else {
    await visible(visitor.getByText(token, { exact: false }))
  }
  assert.match(await visitor.title(), new RegExp(title))
  assert.equal(await visitor.evaluate(() => document.documentElement.scrollWidth), 375)
  let relatedPrevious
  if (config.publicFixture) {
    relatedPrevious = await exerciseRelatedReading(visitor, writtenId, title, origin)
    observations.push('Related reading ranks shared public taxonomy and navigates previous and next articles with the keyboard and links.')
  }
  await screen(visitor, 'article-mobile-dark')

  await search(visitor, 'release note')
  await visible(roleWithExactName(visitor, 'link', title))
  assert(!indexEntry.summary.includes(bodyTerm), 'The full-text term must fall outside the index summary')
  const corpusResponse = mobile.waitForEvent('response', response => new URL(response.url()).pathname === WireRoutes.PublicSearchCorpus && response.request().method() === 'GET')
  const generationCheck = visitor.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.PublicSearchCorpus && response.request().method() === 'HEAD')
  await search(visitor, bodyTerm)
  await visible(roleWithExactName(visitor, 'link', title))
  const corpus = await corpusResponse
  assert.equal(corpus.status(), 200)
  const corpusBytes = await nativeFetch(corpus.url()).then(response => response.arrayBuffer())
  assert.equal(Buffer.from(corpusBytes, 0, 4).toString('ascii'), 'FSPK')
  assert.equal((await generationCheck).status(), 204)
  assert.equal((await api.search(bodyTerm)).items[0].id, writtenId)
  await screen(visitor, 'search-mobile-dark')
  observations.push('Published snapshot visible in HTML, AEDS public detail, and local full-text search on a dark 375px viewport. A body-only term passed through the FSPK worker and generation recheck.')

  const reversedTitle = `Reverse order ${token}`
  const reversed = await articleCommand(WireRoutes.Save, 0, 0n, reversedTitle,
    `## Draft milestone\n\nThis release note contains ${token}.\n${padding}\n搜索博客 ${bodyTerm}.\n${pdfPagination}`)
  const comparison = await articleCommand(WireRoutes.Publish, reversed.id, reversed.revision)
  const orderedLinks = visitor.locator('ol.article-list h2 a')
  const normalizedTerm = [...bodyTerm].map(letter => String.fromCodePoint(letter.codePointAt(0) + 0xfee0)).join('')
  await search(visitor, `${normalizedTerm}　博客搜索`)
  await visible(orderedLinks.getByText(title, { exact: true }))
  await visible(orderedLinks.getByText(reversedTitle, { exact: true }))
  assert.equal(await orderedLinks.first().textContent(), title)
  await search(visitor, `搜索博客 ${bodyTerm}`)
  await visible(orderedLinks.getByText(reversedTitle, { exact: true }))
  assert.equal(await orderedLinks.first().textContent(), reversedTitle)
  await articleCommand(WireRoutes.Delete, comparison.id, comparison.revision, '', '', FrameType.EmptySuccess)
  observations.push('The local worker normalizes fullwidth Latin and ranks mixed Latin/CJK dictionary phrases by stored word widths. Reversing query order reverses the order of otherwise equivalent articles.')

  const stale = await desktop.newPage()
  monitor(stale, 'stale-editor')
  await stale.goto(publisher.url())
  await visible(stale.getByLabel('Body', { exact: true }))
  await stale.getByLabel('Body', { exact: true }).fill(`${body}\nStale edit.`)
  await publisher.getByLabel('Body', { exact: true }).fill(`${body}\nNewer saved revision.`)
  await button(publisher, 'Save draft').click()
  await visible(publisher.getByText('Draft saved.', { exact: false }))
  assert.equal((await api.publicArticle(writtenId)).body, body)
  await button(stale, 'Save draft').click()
  await visible(stale.getByText('The server has a newer revision.', { exact: false }))
  assert.match(await stale.getByLabel('Body', { exact: true }).inputValue(), /Stale edit/)
  await button(stale, 'Load latest revision').click()
  await button(stale, 'Discard changes').click()
  await stale.waitForFunction(() => document.querySelector('#article-body')?.value?.includes('Newer saved revision.'))
  await stale.close()

  await exerciseDraftRevision({
    page: publisher, origin, articleId: writtenId, sourceRevision: publicArticle.revision,
    originalBody: body, publicArticle: api.publicArticle, screenshot: screen, observations, pdfEnabled: config.pdfEnabled,
    pdfFixture: config.pdfFixture,
  })
  await exerciseCanvas({
    page: publisher, origin, targetArticle: publicArticle, screenshot: screen, monitor, observations,
    createDraft: (title, body) => articleCommand(WireRoutes.Save, 0, 0n, title, body),
  })
  await exerciseCanvasHistory({ page: publisher, origin, screenshot: screen, monitor, observations })
  await exerciseSearchWorkerReuse({
    page: visitor, origin, articleTitle: title, firstQuery: bodyTerm, repeatQuery: bodyTerm.toUpperCase(),
    withdraw: async () => {
      await button(publisher, 'More actions').click()
      await roleWithExactName(publisher, 'menuitem', 'Withdraw').click()
      await visible(publisher.getByText('Article withdrawn.', { exact: true }))
    },
    observations,
  })
  const withdrawn = await api.publicIndex()
  assert.notEqual(withdrawn.generation, published.generation)
  assert(!withdrawn.items.some(item => item.id === writtenId))
  await assert.rejects(api.publicArticle(writtenId), { status: 404 })
  const absent = await visitor.goto(`${origin}/article/${writtenId}`)
  assert.equal(absent.status(), 404)
  assert(!(await absent.text()).includes(token))
  await verifyRelatedWithdrawal(visitor, writtenId, relatedPrevious, origin)
  const priorSearchGeneration = corpus.headers()['x-fsus-search-index-generation']
  assert(priorSearchGeneration)
  const priorSearch = await nativeFetch(`${origin}${WireRoutes.PublicSearchCorpus}?generation=${priorSearchGeneration}`, { method: 'HEAD' })
  assert.equal(priorSearch.status, 409)
  await search(visitor, bodyTerm)
  await visible(visitor.getByText('No articles match your search.', { exact: true }))
  if (process.env.FSUSBLOG_TEST_MARKDOWN_IMPORT === '1') {
    const importer = await browser.newContext({ viewport: { width: 375, height: 850 }, storageState: await desktop.storageState() })
    try {
      const importPage = await importer.newPage()
      monitor(importPage, 'markdown-import')
      await importPage.goto(`${origin}/user/manage/article/write`)
      const imported = await exerciseMarkdownImport({ page: importPage, origin, bytes: initialExport.bytes, title, body })
      assert.notEqual(imported.id, writtenId)
      await assert.rejects(api.publicArticle(imported.id), { status: 404 })
      await articleCommand(WireRoutes.Delete, imported.id, imported.revision, '', '', FrameType.EmptySuccess)
      observations.push('On a 375px viewport, a byte-exact Markdown export loaded locally, saved as a new private draft, and survived reload. Invalid UTF-8 and an invalid named header left the draft blank.')
    } finally {
      await importer.close()
    }
  }
  await exercisePropertyBatch(publisher, observations)
  const signOut = publisher.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.SignOut)
  await button(publisher, 'Log out').click()
  assert.equal((await signOut).status(), 200)
  await publisher.waitForURL(`${origin}/`)
  await visible(roleWithExactName(publisher, 'link', 'Log in'))
  assert.equal((await publisher.request.get(`${origin}${WireRoutes.Session}`)).status(), 401)
  observations.push('CAS rejects stale edit, reload reads the durable winner, withdrawal removes public access and index entry, logout returns to anonymous shell.')
  assert(responses.some(response => response.path === WireRoutes.Save && response.status === 409))
  assert.deepEqual(diagnostics, [])
} catch (error) {
  failure = error
  await screen(publisher, 'publisher-failed').catch(() => {})
  await screen(visitor, 'visitor-failed').catch(() => {})
} finally {
  await browser.close()
  await writeFile(join(config.evidence, 'browser-result.json'), JSON.stringify({
    origin, writtenId, startedAt, completedAt: new Date().toISOString(), exitCode: failure ? 1 : 0,
    commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain'),
    artifactDigests,
    node: process.version,
    fixture: { articleTitle: title, initialBodyDigest: sha256(body) },
    chromium: browser.version(), playWright: requireWebPackage('@playwright/test/package.json').version,
    requireNative: config.requireNative, publicFixture: config.publicFixture, observations, diagnostics, responses,
    failure: failure ? String(failure) : undefined,
    cleanup: 'Playwright browser closed. Database and server fixture are owned by the caller.',
  }, null, 2))
}
if (failure) throw failure
console.log(observations.join('\n'))

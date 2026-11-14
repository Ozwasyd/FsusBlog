import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import {
  decodeAuthoringWorkspaceSnapshot, decodeDraft, encodeAuthoringWorkspaceCommand, encodeArticleCommand,
  encodeSignIn, FrameType, WireHeaders, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'

const { chromium, expect } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const workspaceUrl = `${origin}/user/manage/article/workspace`
const editUrl = article => `${origin}/user/manage/article/edit/${article.id}`
const route = WireRoutes.AuthoringWorkspace
const binary = { 'Content-Type': 'application/octet-stream' }
const launch = () => chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME })
const tabList = page => page.getByRole('tablist', { name: 'Open articles' })
const tab = (page, article, status) => tabList(page).getByRole('tab', { name: `${article.title} · ${status}`, exact: true })
const button = (page, name) => page.getByRole('button', { name, exact: true })
const bodyInput = page => page.getByLabel('Body', { exact: true })
const observations = []
const diagnostics = []
await mkdir(evidence, { recursive: true })

const signIn = async (context, ticket) => {
  const data = Buffer.from(encodeFrame(FrameType.OperatorSignIn, encodeSignIn({ ticket })))
  const response = await context.request.post(`${origin}${WireRoutes.SignIn}`, { data, headers: binary })
  assert.equal(response.status(), 200)
  return response.headers()[WireHeaders.CurrentSession.toLowerCase()]
}

function monitor(page) {
  page.on('pageerror', error => diagnostics.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) diagnostics.push(message.text())
  })
  return page
}

function layoutResponse(response) {
  return response.url() === `${origin}${route}` && response.request().method() === 'POST'
}

async function layout(context, session, command, status = 200) {
  const request = context.request
  const headers = { ...binary, [WireHeaders.CurrentSession]: session }
  const response = command
    ? await request.post(`${origin}${route}`, { headers, data: Buffer.from(encodeFrame(FrameType.AuthoringWorkspaceCommand,
      encodeAuthoringWorkspaceCommand({ schemaVersion: 1, ...command }))) })
    : await request.get(`${origin}${route}`, { headers })
  assert.equal(response.status(), status)
  return status === 200 ? decodeAuthoringWorkspaceSnapshot(decodeFrame(await response.body(), FrameType.AuthoringWorkspaceSnapshot).payload) : undefined
}

async function create(context, title) {
  const body = `Saved private draft for ${title}`
  const response = await context.request.post(`${origin}${WireRoutes.Save}`, { headers: binary,
    data: Buffer.from(encodeFrame(FrameType.ArticleCommand, encodeArticleCommand({ id: 0, expectedRevision: 0n,
      idempotencyKey: randomUUID(), title, body }))) })
  assert.equal(response.status(), 200)
  return decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload)
}

async function open(page, article) {
  await page.getByLabel('Article ID', { exact: true }).fill(String(article.id))
  await button(page, 'Open article').click()
  await expect(page).toHaveURL(editUrl(article))
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(article.title)
}

async function journalContains(page, body) {
  await page.waitForFunction(source => new Promise(resolve => {
    const request = indexedDB.open('fsusblog-v2-draft-recovery')
    request.onerror = () => resolve(false)
    request.onsuccess = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('recovery')) {
        database.close()
        resolve(false)
        return
      }
      const tx = database.transaction('recovery')
      const rows = tx.objectStore('recovery').getAll()
      rows.onsuccess = () => resolve(rows.result.some(row => row.body === source))
      rows.onerror = () => resolve(false)
      tx.oncomplete = () => database.close()
    }
  }), body)
}

let failure
let browser = await launch()
try {
  const originContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const outsider = await browser.newContext()
  const session = await signIn(originContext, process.env.FSUSBLOG_TEST_TICKET)
  const outsiderSession = await signIn(outsider, process.env.FSUSBLOG_TEST_OUTSIDER_TICKET)
  const first = await create(originContext, 'Pinned private article')
  const second = await create(originContext, 'Active private article')
  const removed = await create(originContext, 'Article deleted before restart')
  const privateOutside = await create(outsider, 'Private to the other author')
  const preview = await create(originContext, 'Retained preview article')

  const original = monitor(await originContext.newPage())
  await original.goto(workspaceUrl)
  await expect(original.getByRole('heading', { name: 'Article workspace', exact: true })).toBeVisible()
  await open(original, first)
  await button(original, `Pin ${first.title}`).click()
  await open(original, second)
  await button(original, `Pin ${second.title}`).click()
  await open(original, removed)
  await button(original, `Pin ${removed.title}`).click()
  await open(original, preview)
  await tab(original, second, 'Pinned').click()
  await expect(original).toHaveURL(editUrl(second))
  const workingBody = 'Unsaved manuscript surviving a terminated renderer.'
  await bodyInput(original).fill(workingBody)
  await journalContains(original, workingBody)
  await expect.poll(async () => {
    const saved = await layout(originContext, session)
    return [saved.activeArticleId, ...saved.tabs]
  }).toEqual([second.id, first.id, second.id, removed.id, -preview.id])

  const deletion = await originContext.request.post(`${origin}${WireRoutes.Delete}`, { headers: binary,
    data: Buffer.from(encodeFrame(FrameType.ArticleCommand, encodeArticleCommand({ id: removed.id, expectedRevision: removed.revision,
      idempotencyKey: randomUUID(), title: '', body: '' }))) })
  assert.equal(deletion.status(), 200)
  const rendererCrashed = original.waitForEvent('crash', { timeout: 10_000 })
  const renderer = await originContext.newCDPSession(original)
  void renderer.send('Page.crash').catch(() => {})
  await rendererCrashed
  assert.equal((await layout(outsider, outsiderSession)).revision, 0n)
  await layout(outsider, session, undefined, 409)

  // A different browser process reopens layout from PostgreSQL with the same live author session.
  const state = await originContext.storageState()
  const reopenedBrowser = await launch()
  try {
    const reopened = await reopenedBrowser.newContext({ storageState: state, viewport: { width: 1280, height: 800 } })
    const page = monitor(await reopened.newPage())
    await page.goto(workspaceUrl)
    await expect(page).toHaveURL(editUrl(second))
    await expect(tabList(page).getByRole('tab')).toHaveCount(3)
    await expect(tab(page, second, 'Pinned')).toHaveAttribute('aria-selected', 'true')
    await expect(tab(page, preview, 'Preview')).toBeVisible()
    await expect(page.getByText('Some articles from the saved workspace are unavailable.')).toBeVisible()
    await expect(bodyInput(page)).toHaveValue(second.body)
    assert.equal(await page.locator('#article-body').count(), 1)
    await page.reload()
    await expect(tabList(page).getByRole('tab')).toHaveCount(3)
    await page.screenshot({ path: join(evidence, 'workspace-reopened.png') })

    const activeCopy = monitor(await originContext.newPage())
    await activeCopy.goto(workspaceUrl)
    await expect(activeCopy).toHaveURL(editUrl(second))
    await expect(activeCopy.getByRole('heading', { name: 'Recover an unsaved draft' })).toBeVisible()
    await expect(bodyInput(activeCopy)).toHaveValue(second.body)
    await button(activeCopy, 'Restore draft').click()
    await expect(bodyInput(activeCopy)).toHaveValue(workingBody)
    observations.push({ restoredAfterRendererCrash: true, separateProcessRestored: true, filteredDeleted: true, recoveredSeparateJournal: true })

    const selectFirst = Promise.all([page.waitForResponse(layoutResponse), tab(page, first, 'Pinned').click()])
    await expect(page).toHaveURL(editUrl(first))
    assert.equal((await selectFirst)[0].status(), 200)
    const third = await create(originContext, 'Unconfirmed competing layout')
    const conflict = activeCopy.waitForResponse(layoutResponse)
    await open(activeCopy, third)
    assert.equal((await conflict).status(), 409)
    await expect(activeCopy.getByText('The saved workspace changed elsewhere. Reload the workspace to use that layout.')).toBeVisible()
    const winner = await layout(reopened, session)
    assert.deepEqual(winner.tabs, [first.id, second.id, -preview.id])
    assert.equal(winner.activeArticleId, first.id)
    const filtered = await layout(reopened, session, { expectedRevision: winner.revision, activeArticleId: privateOutside.id,
      tabs: [first.id, privateOutside.id] })
    assert.deepEqual(filtered.tabs, [first.id])
    assert.equal(filtered.activeArticleId, 0)
    assert.equal(filtered.skipped, 1)
    await layout(reopened, session, { expectedRevision: filtered.revision, activeArticleId: 0, tabs: [first.id, -first.id] }, 400)
    observations.push({ competingBrowserCannotOverwrite: true, wrongSessionDenied: true, wrongOwnerFiltered: true, duplicateRejected: true })
  } finally {
    await reopenedBrowser.close()
  }
  assert.deepEqual(diagnostics, [])
} catch (error) {
  failure = error
} finally {
  await browser.close()
  await writeFile(join(evidence, 'workspace-recovery-result.json'), JSON.stringify({ observations, diagnostics,
    ...(failure && { failure: String(failure) }) }, null, 2))
}

if (failure) throw failure

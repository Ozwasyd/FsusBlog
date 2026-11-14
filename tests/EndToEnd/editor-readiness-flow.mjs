import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeDraft, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const { chromium, expect } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const ticket = process.env.FSUSBLOG_TEST_TICKET
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
assert(ticket && evidence)
await mkdir(evidence, { recursive: true })

const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME })
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const diagnostics = []
const observations = []
const writeUrl = `${origin}/user/manage/article/write`
const heading = page => page.getByRole('heading', { name: 'New article', exact: true })
const titleInput = page => page.getByLabel('Title', { exact: true })
const bodyInput = page => page.getByLabel('Body', { exact: true })
const checking = page => page.getByText('Checking local draft recovery…', { exact: true })
const button = (page, name) => page.getByRole('button', { name, exact: true })
let currentPage
let releaseResponse
let failure

async function openPage() {
  const page = await context.newPage()
  page.on('pageerror', error => diagnostics.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) diagnostics.push(message.text())
  })
  currentPage = page
  return page
}

async function holdScopeResponse(page) {
  const received = Promise.withResolvers()
  const release = Promise.withResolvers()
  const completed = Promise.withResolvers()
  releaseResponse = release.resolve
  await page.route(`${origin}${WireRoutes.DraftRecoveryScope}`, async route => {
    try {
      const response = await route.fetch()
      received.resolve(response.status())
      await release.promise
      await route.fulfill({ response })
    } catch (error) {
      received.reject(error)
      completed.resolve(String(error))
    } finally {
      completed.resolve('delivered')
    }
  }, { times: 1 })
  return { received: received.promise, release: release.resolve, completed: completed.promise }
}

async function saveAndVerify(page, title, body) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === WireRoutes.Save),
    button(page, 'Save draft').click(),
  ])
  assert.equal(response.status(), 200)
  const draft = decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload)
  assert.deepEqual({ title: draft.title, body: draft.body }, { title, body })
  await expect(page).toHaveURL(`${origin}/user/manage/article/edit/${draft.id}`)
  return draft.id
}

try {
  const desktop = await openPage()
  const scope = await holdScopeResponse(desktop)
  await desktop.goto(`${origin}/login`)
  await desktop.getByLabel('Owner access key').fill(ticket)
  await button(desktop, 'Log in').click()
  await expect(heading(desktop)).toBeVisible()
  assert.equal(await scope.received, 200)
  assert.equal(await titleInput(desktop).isEnabled(), false, 'The title became editable before the verified local recovery scan')
  assert.equal(await bodyInput(desktop).isEnabled(), false, 'The body became editable before the verified local recovery scan')
  await expect(checking(desktop)).toBeVisible()

  scope.release()
  assert.equal(await scope.completed, 'delivered')
  await expect(checking(desktop)).toBeHidden()
  const title = 'Draft kept after cancelled navigation'
  const body = '## Recovery is settled\n\nThe title and body stay together.\n'
  await titleInput(desktop).fill(title)
  await bodyInput(desktop).fill(body)
  await expect(titleInput(desktop)).toHaveValue(title)
  await expect(bodyInput(desktop)).toHaveValue(body)
  await desktop.getByRole('link', { name: 'Back', exact: true }).click()
  const confirmation = desktop.getByText('Discard unsaved changes?', { exact: true })
  await expect(confirmation).toBeVisible()
  await desktop.screenshot({ path: join(evidence, 'editor-readiness-cancel.png') })
  await button(desktop, 'Keep writing').click()
  await expect(confirmation).toBeHidden()
  await expect(desktop).toHaveURL(writeUrl)
  await expect(titleInput(desktop)).toHaveValue(title)
  await expect(bodyInput(desktop)).toHaveValue(body)
  const firstId = await saveAndVerify(desktop, title, body)
  observations.push({ path: 'delayed scope', firstId, titleAndBodyPreserved: true })

  const originalCopy = await openPage()
  await originalCopy.goto(writeUrl)
  const copyTitle = 'Recovery copy retained across a timeout'
  const copyBody = 'This draft still exists on this browser.'
  await titleInput(originalCopy).fill(copyTitle)
  await bodyInput(originalCopy).fill(copyBody)
  await originalCopy.waitForFunction(({ title, body }) => new Promise(resolve => {
    const request = indexedDB.open('fsusblog-v2-draft-recovery')
    request.onerror = () => resolve(false)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('recovery')
      const rows = transaction.objectStore('recovery').getAll()
      rows.onsuccess = () => resolve(rows.result.some(row => row.title === title && row.body === body))
      rows.onerror = () => resolve(false)
      transaction.oncomplete = () => database.close()
    }
  }), { title: copyTitle, body: copyBody })
  await originalCopy.close({ runBeforeUnload: false })

  const mobile = await openPage()
  await mobile.setViewportSize({ width: 375, height: 850 })
  const late = await holdScopeResponse(mobile)
  await mobile.goto(writeUrl)
  await expect(heading(mobile)).toBeVisible()
  assert.equal(await late.received, 200)
  await expect(checking(mobile)).toBeVisible()
  await expect(mobile.getByText('Local draft recovery is unavailable. Save to keep your changes on the server.', { exact: true })).toBeVisible()
  const lateTitle = 'Save after recovery scope timeout'
  const lateBody = 'The server can still save this draft.'
  await titleInput(mobile).fill(lateTitle)
  late.release()
  await late.completed
  await expect(bodyInput(mobile)).toBeEditable()
  await expect(titleInput(mobile)).toHaveValue(lateTitle)
  await bodyInput(mobile).fill(lateBody)
  await mobile.screenshot({ path: join(evidence, 'editor-readiness-timeout.png') })
  const secondId = await saveAndVerify(mobile, lateTitle, lateBody)
  const restored = await openPage()
  await restored.goto(writeUrl)
  await expect(restored.getByRole('heading', { name: 'Recover an unsaved draft' })).toBeVisible()
  await expect(restored.getByRole('heading', { name: copyTitle })).toBeVisible()
  await button(restored, 'Restore draft').click()
  await expect(titleInput(restored)).toHaveValue(copyTitle)
  await expect(bodyInput(restored)).toHaveValue(copyBody)
  observations.push({ path: 'scope timeout with late original response', secondId, serverSaveAvailable: true,
    existingRecoveryPreserved: true,
  })
  assert.deepEqual(diagnostics, [])
} catch (error) {
  failure = error
  if (currentPage) await currentPage.screenshot({ path: join(evidence, 'editor-readiness-failed.png') }).catch(() => {})
} finally {
  releaseResponse?.()
  await browser.close()
  await writeFile(join(evidence, 'editor-readiness-result.json'), JSON.stringify({ observations, diagnostics,
    ...(failure && { failure: String(failure) }),
  }, null, 2))
}

if (failure) throw failure

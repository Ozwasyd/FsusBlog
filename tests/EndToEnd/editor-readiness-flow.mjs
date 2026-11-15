import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { button, chromium, expect, observePageErrors, readDraft } from './browser-authoring-fixture.mjs'
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const ticket = process.env.FSUSBLOG_TEST_TICKET
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
assert(ticket && evidence)
await mkdir(evidence, { recursive: true })

const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME })
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true })
const diagnostics = []
const observations = []
const writeUrl = `${origin}/user/manage/article/write`
const heading = page => page.getByRole('heading', { name: 'New article', exact: true })
const titleInput = page => page.getByLabel('Title', { exact: true })
const bodyInput = page => page.getByLabel('Body', { exact: true })
const checking = page => page.getByText('Checking local draft recovery…', { exact: true })
let currentPage
let releaseResponse
let failure

async function openPage() {
  const page = observePageErrors(await context.newPage(), diagnostics)
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
  const draft = await readDraft(response)
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
  const find = button(mobile, 'Find in body')
  await expect(find).toBeDisabled()
  await expect(mobile.getByText('Local draft recovery is unavailable. Save to keep your changes on the server.', { exact: true })).toBeVisible()
  const lateTitle = 'Save after recovery scope timeout'
  const lateBody = 'The server can still save this 🧭 draft.'
  await titleInput(mobile).fill(lateTitle)
  late.release()
  await late.completed
  await expect(bodyInput(mobile)).toBeEditable()
  await expect(titleInput(mobile)).toHaveValue(lateTitle)
  const editor = bodyInput(mobile)
  await editor.fill(lateBody)
  await editor.press('Shift+ArrowLeft')
  const selection = () => editor.evaluate(input => [input.selectionStart, input.selectionEnd])
  const original = await selection()
  assert(original[0] < original[1])
  await find.press('Space')
  const query = mobile.getByRole('textbox', { name: '在文档中查找', exact: true })
  await expect(query).toBeFocused()
  await query.press('Escape')
  await expect(editor).toBeFocused()
  assert.deepEqual(await selection(), original)

  await find.tap()
  await expect(query).toBeFocused()
  await query.fill('🧭')
  await button(mobile, '切换替换').tap()
  await mobile.getByRole('textbox', { name: '替换为', exact: true }).fill('中文')
  await button(mobile, '替换').tap()
  await query.press('Escape')
  await expect(editor).toBeFocused()
  const replacedBody = lateBody.replace('🧭', '中文')
  await expect(editor).toHaveValue(replacedBody)
  await mobile.screenshot({ path: join(evidence, 'editor-readiness-timeout.png') })
  const secondId = await saveAndVerify(mobile, lateTitle, replacedBody)
  const restored = await openPage()
  await restored.goto(writeUrl)
  await expect(restored.getByRole('heading', { name: 'Recover an unsaved draft' })).toBeVisible()
  await expect(restored.getByRole('heading', { name: copyTitle })).toBeVisible()
  await button(restored, 'Restore draft').click()
  await expect(titleInput(restored)).toHaveValue(copyTitle)
  await expect(bodyInput(restored)).toHaveValue(copyBody)
  observations.push({ path: 'scope timeout with late original response', secondId, serverSaveAvailable: true,
    existingRecoveryPreserved: true, bodyFindKeyboardAndTouch: true, nativeSelectionRetained: true, replacementSaved: true,
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

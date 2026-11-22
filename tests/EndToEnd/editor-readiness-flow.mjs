import { roleWithExactName, exactLabel, exactText } from './role-locators.mjs'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { signInFreshAdmin } from './webauthn-fixture.mjs'
import { button, chromium, expect, holdResponse, observePageErrors, readDraft } from './browser-authoring-fixture.mjs'
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const bootstrap = process.env.FSUSBLOG_TEST_AUTHOR_BOOTSTRAP
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
assert(bootstrap && evidence)
await mkdir(evidence, { recursive: true })

const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME })
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true })
const diagnostics = []
const observations = []
const writeUrl = `${origin}/admin/articles/write`
const heading = page => roleWithExactName(page, 'heading', 'New article')
const titleInput = page => exactLabel(page, 'Title')
const bodyInput = page => exactLabel(page, 'Body')
const checking = page => exactText(page, 'Checking local draft recovery…')
let currentPage
let releaseResponse
let failure

async function openPage() {
  const page = observePageErrors(await context.newPage(), diagnostics)
  currentPage = page
  return page
}

async function holdScopeResponse(page) {
  const held = await holdResponse(page, `${origin}${WireRoutes.DraftRecoveryScope}`)
  releaseResponse = held.release
  return held
}

async function saveAndVerify(page, title, body) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === WireRoutes.Save),
    button(page, 'Save draft').click(),
  ])
  const draft = await readDraft(response)
  assert.deepEqual({ title: draft.title, body: draft.body }, { title, body })
  await expect(page).toHaveURL(`${origin}/admin/articles/edit/${draft.id}`)
  return draft.id
}

try {
  const desktop = await openPage()
  await signInFreshAdmin(desktop, origin, bootstrap)
  const scope = await holdScopeResponse(desktop)
  await desktop.goto(writeUrl)
  await expect(heading(desktop)).toBeVisible()
  assert.equal(await scope.status(), 200)
  assert.equal(await titleInput(desktop).isEnabled(), false, 'The title became editable before the verified local recovery scan')
  assert.equal(await bodyInput(desktop).isEnabled(), false, 'The body became editable before the verified local recovery scan')
  await expect(checking(desktop)).toBeVisible()

  scope.release()
  assert.equal(await scope.done, undefined)
  await expect(checking(desktop)).toBeHidden()
  const title = 'Draft kept after cancelled navigation'
  const body = '## Recovery is settled\n\nThe title and body stay together.\n'
  await titleInput(desktop).fill(title)
  await bodyInput(desktop).fill(body)
  await expect(titleInput(desktop)).toHaveValue(title)
  await expect(bodyInput(desktop)).toHaveValue(body)
  await roleWithExactName(desktop, 'link', 'Back').click()
  const confirmation = exactText(desktop, 'Discard unsaved changes?')
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
  assert.equal(await late.status(), 200)
  await expect(checking(mobile)).toBeVisible()
  const find = button(mobile, 'Find in body')
  await expect(find).toBeDisabled()
  await expect(exactText(mobile, 'Local draft recovery is unavailable. Save to keep your changes on the server.')).toBeVisible()
  const lateTitle = 'Save after recovery scope timeout'
  const lateBody = 'The server can still save this 🧭 draft.'
  await titleInput(mobile).fill(lateTitle)
  late.release()
  await late.done
  await expect(bodyInput(mobile)).toBeEditable()
  await expect(titleInput(mobile)).toHaveValue(lateTitle)
  const editor = bodyInput(mobile)
  await editor.fill(lateBody)
  await editor.press('Shift+ArrowLeft')
  const selection = () => editor.evaluate(input => [input.selectionStart, input.selectionEnd])
  const original = await selection()
  assert(original[0] < original[1])
  await find.press('Space')
  const query = roleWithExactName(mobile, 'textbox', '在文档中查找')
  await expect(query).toBeFocused()
  await query.press('Escape')
  await expect(editor).toBeFocused()
  assert.deepEqual(await selection(), original)

  await find.tap()
  await expect(query).toBeFocused()
  await query.fill('🧭')
  await button(mobile, '切换替换').tap()
  await roleWithExactName(mobile, 'textbox', '替换为').fill('中文')
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

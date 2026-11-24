import assert from 'node:assert/strict'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import * as authoring from './browser-authoring-fixture.mjs'
import { launchChrome, saveShot, withBrowserEvidence } from './isolated-browser-fixture.mjs'
import * as loc from './role-locators.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

const { button, expect, holdResponse, journalContains, observePageErrors, readDraft } = authoring
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const bootstrap = process.env.FSUSBLOG_TEST_AUTHOR_BOOTSTRAP
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
assert(bootstrap && evidence)

const browser = await launchChrome()
const diagnostics = []
const observations = []
const writeUrl = `${origin}/admin/articles/write`
const heading = page => loc.exactHeading(page, 'New article')
const titleInput = page => loc.exactLabel(page, 'Title')
const bodyInput = page => loc.exactLabel(page, 'Body')
const checking = page => loc.exactText(page, 'Checking local draft recovery…')
const expectValues = async (page, title, body) => {
  await expect(titleInput(page)).toHaveValue(title)
  await expect(bodyInput(page)).toHaveValue(body)
}
let currentPage, releaseResponse

await withBrowserEvidence(browser, evidence, 'editor-readiness-result.json', { observations, diagnostics }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true })
  const openPage = async () => (currentPage = observePageErrors(await context.newPage(), diagnostics))
  async function holdScopeResponse(page) {
    const held = await holdResponse(page, `${origin}${WireRoutes.DraftRecoveryScope}`)
    releaseResponse = held.release
    return held
  }
  async function saveAndVerify(page, title, body) {
    const [response] = await Promise.all([
      page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === WireRoutes.Save),
      button(page, 'Save draft').click(),
    ])
    const draft = await readDraft(response)
    assert.deepEqual({ title: draft.title, body: draft.body }, { title, body })
    await expect(page).toHaveURL(`${origin}/admin/articles/edit/${draft.id}`)
    return draft.id
  }

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
  await expectValues(desktop, title, body)
  await loc.exactLink(desktop, 'Back').click()
  const confirmation = loc.exactText(desktop, 'Discard unsaved changes?')
  await expect(confirmation).toBeVisible()
  await saveShot(desktop, evidence, 'editor-readiness-cancel.png', {})
  await button(desktop, 'Keep writing').click()
  await expect(confirmation).toBeHidden()
  await expect(desktop).toHaveURL(writeUrl)
  await expectValues(desktop, title, body)
  const firstId = await saveAndVerify(desktop, title, body)
  observations.push({ path: 'delayed scope', firstId, titleAndBodyPreserved: true })

  const originalCopy = await openPage()
  await originalCopy.goto(writeUrl)
  const copyTitle = 'Recovery copy retained across a timeout'
  const copyBody = 'This draft still exists on this browser.'
  await titleInput(originalCopy).fill(copyTitle)
  await bodyInput(originalCopy).fill(copyBody)
  await journalContains(originalCopy, copyBody, { title: copyTitle })
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
  await expect(loc.exactText(mobile, 'Local draft recovery is unavailable. Save to keep your changes on the server.')).toBeVisible()
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
  const query = loc.roleWithExactName(mobile, 'textbox', 'Find in document')
  await expect(query).toBeFocused()
  await query.press('Escape')
  await expect(editor).toBeFocused()
  assert.deepEqual(await selection(), original)

  await find.tap()
  await expect(query).toBeFocused()
  await query.fill('🧭')
  await button(mobile, 'Toggle replace').tap()
  await loc.roleWithExactName(mobile, 'textbox', 'Replace with').fill('中文')
  await button(mobile, 'Replace').tap()
  await query.press('Escape')
  await expect(editor).toBeFocused()
  const replacedBody = lateBody.replace('🧭', '中文')
  await expect(editor).toHaveValue(replacedBody)
  await saveShot(mobile, evidence, 'editor-readiness-timeout.png', {})
  const secondId = await saveAndVerify(mobile, lateTitle, replacedBody)
  const restored = await openPage()
  await restored.goto(writeUrl)
  await expect(restored.getByRole('heading', { name: 'Recover an unsaved draft' })).toBeVisible()
  await expect(restored.getByRole('heading', { name: copyTitle })).toBeVisible()
  await button(restored, 'Restore draft').click()
  await expectValues(restored, copyTitle, copyBody)
  observations.push({ path: 'scope timeout with late original response', secondId, serverSaveAvailable: true,
    existingRecoveryPreserved: true, bodyFindKeyboardAndTouch: true, nativeSelectionRetained: true, replacementSaved: true })
  assert.deepEqual(diagnostics, [])
}, {
  mkdir: true,
  onError: () => currentPage && saveShot(currentPage, evidence, 'editor-readiness-failed.png', {}).catch(() => {}),
  after: () => releaseResponse?.(),
})

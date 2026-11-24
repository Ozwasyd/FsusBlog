import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import * as authoring from './browser-authoring-fixture.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import * as status from './response-status-fixture.mjs'
import { waitForUrlResponse } from './response-wait-fixture.mjs'
import * as loc from './role-locators.mjs'

const { FrameType, WireHeaders, WireRoutes } = wire
const { button, chromium, expect, pressKey: press, readDraft, openWorkspaceDialog, hasRecoveryCopy, withHeldResponse } = authoring
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const workspacePath = `${origin}/admin/articles/workspace`
const groupsPath = `${origin}${WireRoutes.AuthoringWorkspaceGroups}`
const body = scope => loc.roleWithExactName(scope, 'textbox', 'Body')
const title = scope => loc.roleWithExactName(scope, 'textbox', 'Title')
const group = (page, name) => loc.exactRegion(page.getByRole('main'), `${name} article group`)
const tabList = page => page.getByRole('tablist', { name: 'Open articles' })
const openTabs = page => tabList(page).getByRole('tab')
const tab = (page, draft, state) => loc.exactTab(tabList(page), `${draft.title} · ${state}`)
const editors = page => page.locator('.el-markdown-editor')
const selection = locator => locator.evaluate(element => [element.selectionStart, element.selectionEnd])
const isConnected = handle => handle.evaluate(element => element.isConnected)
const separator = page => loc.roleWithExactName(page, 'separator', 'Resize article groups')
const workspaceDialog = page => loc.exactDialog(page, 'Workspace & open article')
const closeDialog = page => loc.exactDialog(page, 'Close tabs with unsaved edits?')
const recoveryHeading = page => loc.exactHeading(page, 'Recover an unsaved draft')
const expectSelected = (locator, selected = true) => expect(locator).toHaveAttribute('aria-selected', String(selected))
const expectWorkspaceMessage = (page, message) => expect(loc.exactText(page.locator('main'), message)).toBeVisible()
const observations = []
const diagnostics = []

const fx = authoring.authorFixture(origin, diagnostics)
const { createDraft, saveDraft, deleteDraft, readSession, monitor, signInWithPasskey, draftPath, editPath } = fx

async function editorNode(locator) {
  const node = await locator.elementHandle()
  assert(node)
  return node
}

async function selectLastChar(locator, length, moveEnd = true) {
  if (moveEnd) await locator.press('End')
  await locator.press('Shift+ArrowLeft')
  const range = await selection(locator)
  assert.deepEqual(range, [length - 1, length])
  return range
}

async function expectStoredDraft(request, draft, text = draft.body, revision = draft.revision) {
  const stored = await readDraft(await request.get(draftPath(draft.id)))
  assert.deepEqual(stored, { ...draft, body: text, revision })
  return stored
}

async function closeWorkspaceDialog(page) {
  const dialog = workspaceDialog(page)
  if (await dialog.isVisible()) {
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  }
}

async function pinArticle(page, draft) {
  const direct = button(page, `Pin ${draft.title}`)
  if (await direct.isVisible()) return direct.click()
  const dialog = await openWorkspaceDialog(page)
  await button(dialog, `Pin ${draft.title}`).click()
  await closeWorkspaceDialog(page)
}

async function openById(page, id, command = 'Open in other group') {
  const main = page.getByRole('main')
  const scope = await loc.exactLabel(main, 'Article ID').isVisible() ? main : await openWorkspaceDialog(page)
  await loc.exactLabel(scope, 'Article ID').fill(String(id))
  await button(scope, command).click()
  await expect(workspaceDialog(page)).toBeHidden()
}

async function openDraft(page, draft, command) {
  await openById(page, draft.id, command)
  await expect(page).toHaveURL(editPath(draft.id))
}

async function editInGroup(page, pane, draft) {
  await press(page, button(pane, 'Edit in this group'))
  await expect(page).toHaveURL(editPath(draft.id))
}

async function reopenDraft(page, draft) {
  await openWorkspaceDialog(page)
  await button(workspaceDialog(page), `Reopen Article ${draft.id}`).click()
  await expect(workspaceDialog(page)).toBeHidden()
  await expect(page).toHaveURL(editPath(draft.id))
}

async function selectTab(page, draft, state, useClick = false) {
  const target = tab(page, draft, state)
  if (useClick) await target.click()
  else await press(page, target)
  await expect(page).toHaveURL(editPath(draft.id))
}

async function confirmCloseOption(dialog, option) {
  await loc.exactText(dialog, option).click()
  await expect(loc.exactRadio(dialog, option)).toBeChecked()
  await button(dialog, 'Close tabs').click()
}

async function expectPane(pane, draft, source, writable) {
  await expect(pane).toBeVisible()
  await expect(title(pane)).toHaveValue(draft.title)
  await expect(body(pane)).toHaveValue(source)
  for (const field of [title(pane), body(pane)]) await (writable ? expect(field) : expect(field).not).toBeEditable()
}

async function expectSameEditor(locator, original) {
  assert.equal(await locator.evaluate((current, previous) => current === previous && current instanceof HTMLTextAreaElement,
    original), true, 'The same native FsusUI textarea must remain mounted for that session')
}

async function pageWidths(page) {
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth, client: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
  }))
  const viewport = page.viewportSize()
  if (viewport) assert.equal(widths.viewport, viewport.width)
  assert(widths.document <= widths.client && widths.body <= widths.client, 'The workspace must not overflow the page horizontally')
  return widths
}

async function splitGeometry(page, primary, secondary) {
  const [left, divider, right] = await Promise.all([primary.boundingBox(), separator(page).boundingBox(), secondary.boundingBox()])
  assert(left && divider && right)
  const rem = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize))
  const minimumPane = 29 * rem
  const available = left.width + right.width
  const track = right.x - left.x - left.width
  assert(Math.abs(track - rem) <= 1, 'The visible groups must reserve exactly the divider track')
  assert(Math.abs(divider.x + divider.width / 2 - (right.x - track / 2)) <= 1, 'The interactive divider must be centered in its track')
  assert(left.width >= minimumPane - 1 && right.width >= minimumPane - 1, 'The divider must preserve both 29rem minimums')
  const attributes = await separator(page).evaluate(element => Object.fromEntries(
    ['min', 'now', 'max'].map(name => [name, element.getAttribute('aria-value' + name)])))
  for (const value of Object.values(attributes)) assert.match(value, /^[0-9]+$/)
  const values = { min: Number(attributes.min), now: Number(attributes.now), max: Number(attributes.max) }
  assert(values.min <= values.now && values.now <= values.max)
  assert(Math.abs(values.now - Math.round(100 * left.width / available)) <= 1, 'The reported position must match the effective pane width')
  assert(Math.abs(values.min - Math.round(100 * minimumPane / available)) <= 1)
  assert(Math.abs(values.max - Math.round(100 * (available - minimumPane) / available)) <= 1)
  return { left, divider, right, values, available, track, minimumPane }
}

async function exerciseSplitter(page, primary, secondary) {
  const handle = separator(page)
  await expect(handle).toBeVisible()
  const controlledPane = await primary.getAttribute('id')
  assert(controlledPane)
  for (const [attr, val] of [['aria-orientation', 'vertical'], ['aria-controls', controlledPane], ['aria-valuetext', 'Primary group 50%']])
    await expect(handle).toHaveAttribute(attr, val)
  const measure = () => splitGeometry(page, primary, secondary)
  const stepKey = async key => { await page.keyboard.press(key); return measure() }
  const initial = await measure()
  assert.equal(initial.values.now, 50)
  assert(initial.values.min < 50 && initial.values.max > 50)

  await press(page, handle, 'ArrowRight')
  const increased = await measure()
  assert(increased.left.width > initial.left.width)
  assert.equal(increased.values.now, initial.values.now + 1)
  const returned = await stepKey('ArrowLeft')
  assert.equal(returned.values.now, initial.values.now)
  assert(Math.abs(returned.left.width - initial.left.width) <= 1)
  const home = await stepKey('Home')
  assert.equal(home.values.now, home.values.min)
  const end = await stepKey('End')
  assert.equal(end.values.now, end.values.max)
  assert(home.left.width < returned.left.width && returned.left.width < end.left.width)
  assert(home.right.width > returned.right.width && returned.right.width > end.right.width)

  const equalize = button(page, 'Equalize group widths')
  await press(page, button(page, 'Group actions'))
  await press(page, equalize, 'Space')
  await expect(equalize).toBeFocused()
  const equal = await measure()
  assert.equal(equal.values.now, 50)
  assert(Math.abs(equal.left.width - equal.right.width) <= 1)
  await closeWorkspaceDialog(page)
  await press(page, handle, 'End')
  await handle.scrollIntoViewIfNeeded()
  const box = await handle.boundingBox()
  assert(box)
  const startX = box.x + box.width / 2
  const visibleTop = Math.max(1, box.y)
  const visibleBottom = Math.min(page.viewportSize().height - 1, box.y + box.height)
  assert(visibleBottom > visibleTop)
  const y = (visibleTop + visibleBottom) / 2
  const preferred = Math.round(home.values.min + (end.values.max - home.values.min) * 0.3)
  const targetX = end.left.x + end.track / 2 + end.available * preferred / 100
  await handle.evaluate(element => {
    element.addEventListener('pointerdown', event => { element.dataset.testPointer = String(event.pointerId) }, { once: true })
  })
  await page.mouse.move(startX, y)
  await page.mouse.down()
  try {
    assert.equal(await handle.evaluate(element => element.hasPointerCapture(Number(element.dataset.testPointer))), true)
    assert.equal((await measure()).values.now, end.values.now)
    await page.mouse.move(targetX, y, { steps: 4 })
    await expect(handle).toHaveAttribute('aria-valuenow', String(preferred))
  } finally {
    await page.mouse.up()
  }
  const pointer = await measure()
  assert(Math.abs(pointer.left.width - end.available * preferred / 100) <= end.available / 100)
  await page.mouse.move(startX, y)
  await expect(handle).toHaveAttribute('aria-valuenow', String(preferred))
  return { initialPercent: initial.values.now, equalizedPercent: equal.values.now, keyboardIncreasedPercent: increased.values.now,
    minPercent: home.values.now, maxPercent: end.values.now, pointerPercent: preferred, minimumPaneWidth: initial.minimumPane,
    lowerBoundPaneWidths: [home.left.width, home.right.width], upperBoundPaneWidths: [end.left.width, end.right.width],
    pointerPaneWidths: [pointer.left.width, pointer.right.width], dividerTrackWidth: pointer.track }
}

async function exerciseNativePageZoom(author, first, second) {
  const cookies = (await author.storageState()).cookies
  const checks = []
  for (const factor of [1, 1.5, 2]) {
    await isolated.withZoomedContext(chromium, 'fsus-workspace-page-zoom-', factor, cookies, async context => {
      const page = monitor(context.pages()[0] ?? await context.newPage())
      await page.goto(editPath(first.id))
      await expectPane(group(page, 'Primary'), first, first.body, true)
      await openDraft(page, second)
      const primary = group(page, 'Primary'), secondary = group(page, 'Secondary')
      await expectPane(secondary, second, second.body, true)
      if (factor === 1) {
        await expectPane(primary, first, first.body, false)
        await splitGeometry(page, primary, secondary)
      } else {
        await expect(primary).toBeHidden()
        await expect(separator(page)).toHaveCount(0)
        await expect(editors(page)).toHaveCount(2)
        await press(page, button(page, 'Focus primary group'), 'Space')
        await expect(page).toHaveURL(editPath(first.id))
        await expectPane(primary, first, first.body, true)
        await expect(secondary).toBeHidden()
        await expect(body(primary)).toBeFocused()
      }
      const widths = await pageWidths(page)
      const { outer, dpr, visualScale } = await page.evaluate(() => ({
        outer: window.outerWidth, dpr: window.devicePixelRatio, visualScale: window.visualViewport.scale,
      }))
      const firstCheck = checks[0] ?? { outer, dpr, viewport: widths.viewport }
      assert.equal(outer, firstCheck.outer)
      assert.equal(visualScale, 1)
      assert(Math.abs(dpr / firstCheck.dpr - factor) < .01)
      assert(Math.abs(widths.viewport * factor - firstCheck.viewport) <= 2)
      checks.push({ factor, outer, dpr, visualScale, ...widths, groups: factor === 1 ? 2 : 1 })
    })
  }
  return checks
}

async function withHeldDraft(page, id, trigger, whileHeld) {
  await withHeldResponse(page, draftPath(id), trigger, async held => {
    const expiry = new AbortController()
    try {
      const code = await Promise.race([held.status().catch(error => error), delay(8_000, 'draft request did not arrive', { signal: expiry.signal })])
      await whileHeld(code)
    } finally { expiry.abort() }
  }, { maxRetries: 0, maxRedirects: 0 })
}

async function openAndPinAnchor(page, anchor) {
  await page.goto(editPath(anchor.id))
  await expect(body(page)).toBeEditable()
  await pinArticle(page, anchor)
}

async function capture(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await isolated.saveShot(page, evidence, `${name}.png`, {})
}

async function decodeSavedGroups(response) {
  const snapshot = await status.readFrame(response, FrameType.AuthoringWorkspaceGroups, wire.decodeAuthoringWorkspaceGroups)
  assert.equal(snapshot.schemaVersion, 3)
  return snapshot
}

const savedGroups = async (context, session) =>
  decodeSavedGroups(await context.request.get(groupsPath, { headers: { [WireHeaders.CurrentSession]: session } }))

const coordinates = snapshot => ({
  primary: snapshot.tabs, secondary: snapshot.secondaryTabs, primaryActive: snapshot.activeArticleId,
  secondaryActive: snapshot.secondaryActiveArticleId, focusedGroup: snapshot.focusedGroup,
})

const pollLayout = (read, expected) => expect.poll(async () => coordinates(await read())).toEqual(expected)

async function enterSavedWorkspace(page) {
  const response = waitForUrlResponse(page, () => groupsPath, 'GET')
  await page.goto(workspacePath)
  return decodeSavedGroups(await response)
}

async function expectRestored(page, primary, primaryPreview, secondary, secondaryPreview) {
  await expect(page).toHaveURL(editPath(secondary.id))
  await expectPane(group(page, 'Primary'), primary, primary.body, false)
  await expectPane(group(page, 'Secondary'), secondary, secondary.body, true)
  await expect(editors(page)).toHaveCount(2)
  const tabs = openTabs(page)
  await expect(tabs).toHaveCount(4)
  assert.deepEqual(await tabs.evaluateAll(items => items.map(item => item.getAttribute('aria-label'))),
    [`${primary.title} · Pinned`, `${primaryPreview.title} · Preview`, `${secondary.title} · Pinned`, `${secondaryPreview.title} · Preview`])
  await expectSelected(tab(page, secondary, 'Pinned'))
}

function abortRecoveryIdb(page, id) {
  return page.evaluate(targetId => {
    const isDelete = targetId !== undefined
    const proto = isDelete ? IDBObjectStore.prototype : IDBDatabase.prototype
    const method = isDelete ? 'delete' : 'transaction'
    const original = proto[method]
    proto[method] = function (...args) {
      const result = original.apply(this, args)
      const match = isDelete
        ? this.name === 'recovery' && Array.isArray(args[0]) && args[0][2] === `article:${targetId}`
        : this.name === 'fsusblog-v2-draft-recovery' && args[1] === 'readonly'
      if (match) {
        proto[method] = original
        const tx = isDelete ? this.transaction : result
        const flag = isDelete ? 'saveCleanupAborted' : 'recoveryReadAborted'
        tx.addEventListener('abort', () => { document.documentElement.dataset[flag] = '1' }, { once: true })
        queueMicrotask(() => tx.abort())
      }
      return result
    }
  }, id)
}

async function exerciseTabClose({ page, first, localSource, alternate, tail, second, secondNode }) {
  const primary = group(page, 'Primary'), secondary = group(page, 'Secondary')
  const tabs = openTabs(page)
  const recovery = recoveryHeading(page)
  const recentlyClosed = loc.exactHeading(workspaceDialog(page), 'Recently closed')
  await selectTab(page, alternate, 'Preview')
  await button(page, `Pin ${alternate.title}`).click()
  await expect(tab(page, alternate, 'Pinned')).toBeVisible()
  await openDraft(page, tail, 'Open article')
  await selectTab(page, alternate, 'Pinned')
  await expectPane(primary, alternate, alternate.body, true)
  const alternateNode = await editorNode(body(primary))
  try {
    const others = button(page, 'Close other tabs')
    const right = button(page, 'Close tabs to the right')
    const dialog = closeDialog(page)
    const discard = loc.exactRadio(dialog, 'Discard unsaved edits from this browser')
    const listedTabs = loc.roleWithExactName(dialog, 'list', 'Tabs to close').getByRole('listitem')
    const confirmedTargets = [`${first.title} (unsaved changes) · Article ${first.id}`, `${tail.title} (up to date) · Article ${tail.id}`]
    async function expectClosedToAlternate() {
      await expectWorkspaceMessage(page, 'Closed 2 tabs.')
      await expect(workspaceDialog(page)).toBeHidden()
      await expect(tabs).toHaveCount(2)
      await expect(tab(page, alternate, 'Pinned')).toBeFocused()
      await expectSameEditor(body(secondary), secondNode)
    }
    async function expectReopenEntry(draft) {
      await openWorkspaceDialog(page)
      await expect(button(workspaceDialog(page), `Reopen Article ${draft.id}`)).toBeVisible()
      await closeWorkspaceDialog(page)
    }
    async function promptCloseOthers(openDialog = true) {
      if (openDialog) await openWorkspaceDialog(page)
      await press(page, others)
      await expect(listedTabs).toHaveText(confirmedTargets)
    }

    await button(page, 'Group actions').click()
    await promptCloseOthers(false)
    await expect(discard).not.toBeChecked()
    await button(dialog, 'Keep writing').click()
    await expect(dialog).toBeHidden()
    await expect(others).toBeFocused()
    await expect(tabs).toHaveCount(4)
    for (const [draft, state] of [[first, 'Unsaved'], [tail, 'Preview'], [second, 'Pinned']]) await expect(tab(page, draft, state)).toBeVisible()
    await expect(recentlyClosed).toHaveCount(0)

    await promptCloseOthers(false)
    await abortRecoveryIdb(page)
    await button(dialog, 'Close tabs').click()
    await expect(page.locator('html')).toHaveAttribute('data-recovery-read-aborted', '1')
    await expectWorkspaceMessage(page, 'Could not verify recovery copies. Save the drafts before closing these tabs.')
    await expect(others).toBeFocused()
    await expect(tabs).toHaveCount(4)
    await expect(recentlyClosed).toHaveCount(0)

    await press(page, right)
    await expect(tab(page, tail, 'Preview')).toHaveCount(0)
    await expectWorkspaceMessage(page, 'Closed 1 tab.')
    await expect(tab(page, alternate, 'Pinned')).toBeFocused()
    await expect(tab(page, first, 'Unsaved')).toBeVisible()
    await openWorkspaceDialog(page)
    await expect(right).toBeDisabled()
    await expect(page).toHaveURL(editPath(alternate.id))
    await expectSameEditor(body(primary), alternateNode)
    await expectSameEditor(body(secondary), secondNode)
    await expect(button(workspaceDialog(page), `Reopen Article ${tail.id}`)).toBeVisible()
    await closeWorkspaceDialog(page)

    await selectTab(page, first, 'Unsaved')
    await expectPane(primary, first, localSource, true)
    const activeNode = await editorNode(body(primary))
    try {
      await isolated.withViewport(page, 375, 850, async () => {
        const switcher = button(page, 'Switch article tab')
        await expect(switcher).toBeVisible()
        await openWorkspaceDialog(page)
        await press(page, others)
        await expect(workspaceDialog(page)).toBeHidden()
        await expect(switcher).toBeFocused()
        await expect(page).toHaveURL(editPath(first.id))
        await expect(body(primary)).toHaveValue(localSource)
        await expectSameEditor(body(primary), activeNode)
        await expectReopenEntry(alternate)
      })
      await expect(tabs).toHaveCount(2)
      await expect(tab(page, second, 'Pinned')).toBeVisible()
      await expectSameEditor(body(secondary), secondNode)
    } finally { await activeNode.dispose() }

    await reopenDraft(page, alternate)
    await reopenDraft(page, tail)
    await selectTab(page, alternate, 'Pinned')
    await expectPane(primary, alternate, alternate.body, true)
    await promptCloseOthers()
    await button(dialog, 'Close tabs').click()
    await expectClosedToAlternate()
    await expect(tab(page, first, 'Unsaved')).toHaveCount(0)
    await expect(tab(page, tail, 'Preview')).toHaveCount(0)
    await reopenDraft(page, first)
    await expect(body(primary)).toHaveValue(first.body)
    await expect(recovery).toBeVisible()
    await button(page, 'Restore draft').click()
    await expect(body(primary)).toHaveValue(localSource)
    await expect(recovery).toHaveCount(0)

    await reopenDraft(page, tail)
    await selectTab(page, alternate, 'Pinned')
    await promptCloseOthers()
    await expect(discard).not.toBeChecked()
    await confirmCloseOption(dialog, 'Discard unsaved edits from this browser')
    await expectClosedToAlternate()
    await reopenDraft(page, first)
    await expectPane(primary, first, first.body, true)
    await expect(recovery).toHaveCount(0)
  } finally { await alternateNode.dispose() }
  observations.push({ cancelPreservesMixedBatch: true, abortedRecoveryReadPreservesMixedBatch: true,
    desktopCloseRightPreservesEarlierTabs: true, compactCloseOthersKeepsActiveDraft: true, closeBatchPreservesOtherGroup: true,
    confirmedMixedCloseRestoresRealRecoveryCopy: true, explicitMixedDiscardReopensDurableDraft: true })
}

async function exerciseSaveAndClose(author) {
  const anchor = await createDraft(author, 'Save and close anchor', 'Current source remains open.')
  let first = await createDraft(author, 'First recovery cleanup draft', 'First original source.')
  let second = await createDraft(author, 'Second recovery cleanup draft', 'Second original source.')
  const interrupted = await createDraft(author, 'Draft with a lost receipt', 'Original source before the lost receipt.')
  const conflicting = await createDraft(author, 'Draft with a later conflict', 'Original source before the conflict.')
  const localText = draft => `${draft.body} Local edit.`
  const savePath = `${origin}${WireRoutes.Save}`
  const page = monitor(await author.newPage())
  const releaseLostReply = Promise.withResolvers()
  const others = button(page, 'Close other tabs')
  const anchorTab = tab(page, anchor, 'Pinned')
  const tabs = openTabs(page)
  const expectStored = (draft, text, revision) => expectStoredDraft(author.request, draft, text, revision)

  async function editPairAndReturn(firstDraft, secondDraft) {
    for (const draft of [firstDraft, secondDraft]) {
      await openDraft(page, draft, 'Open article')
      await expect(body(page)).toBeEditable()
      await body(page).fill(localText(draft))
      await expect(tab(page, draft, 'Unsaved')).toBeVisible()
    }
    await selectTab(page, anchor, 'Pinned')
  }

  async function chooseSave() {
    const dialog = closeDialog(page)
    await expect(dialog).toHaveCount(0)
    if (!await others.isVisible()) await loc.exactText(page, 'Tab actions').click()
    await press(page, others)
    await confirmCloseOption(dialog, 'Save drafts before closing')
  }

  async function expectPairClosed() {
    await expectWorkspaceMessage(page, 'Closed 2 tabs.')
    await expect(workspaceDialog(page)).toBeHidden()
    await expect(tabs).toHaveCount(1)
    await expect(anchorTab).toBeFocused()
    await expect(page).toHaveURL(editPath(anchor.id))
    first = await expectStored(first, localText(first), first.revision + 1n)
    second = await expectStored(second, localText(second), second.revision + 1n)
  }

  async function expectBatchKeptOpen(message, [a, stateA, textA, revA], [b, stateB, textB, revB], focusOthers = true) {
    await expectWorkspaceMessage(page, message)
    await expect(page).toHaveURL(editPath(anchor.id))
    if (focusOthers) await expect(others).toBeFocused()
    await expect(tabs).toHaveCount(3)
    await expect(tab(page, a, stateA)).toBeVisible()
    await expect(tab(page, b, stateB)).toBeVisible()
    await expectStored(a, textA, revA)
    await expectStored(b, textB, revB)
  }

  const hasFirstRecoveryCopy = () => hasRecoveryCopy(page, first.id, localText(first))

  try {
    await openAndPinAnchor(page, anchor)
    await editPairAndReturn(first, second)
    await chooseSave()
    await expectPairClosed()

    await editPairAndReturn(first, second)
    await expect.poll(hasFirstRecoveryCopy).toBe(true)
    await abortRecoveryIdb(page, first.id)
    await chooseSave()
    await expect(page.locator('html')).toHaveAttribute('data-save-cleanup-aborted', '1')
    await expectBatchKeptOpen(`Saved ${first.title}. Recovery cleanup for ${first.title} could not be confirmed. The tabs are still open.`,
      [first, 'Recovery needed', localText(first), first.revision + 1n], [second, 'Unsaved', second.body, second.revision])
    assert.equal(await hasFirstRecoveryCopy(), true)

    await chooseSave()
    await expectPairClosed()
    assert.equal(await hasFirstRecoveryCopy(), false)

    await editPairAndReturn(interrupted, conflicting)
    const requests = []
    let lostReplyStatus
    await page.route(savePath, async route => {
      requests.push(route.request().postDataBuffer())
      if (requests.length === 1) {
        const real = await route.fetch({ maxRetries: 0, maxRedirects: 0 })
        lostReplyStatus = real.status()
        await real.dispose()
        await releaseLostReply.promise
        await route.abort('failed')
      } else await route.continue()
    })
    await chooseSave()
    await expect.poll(() => lostReplyStatus).toBe(200)
    await expect(body(page)).not.toBeEditable()
    await expect(button(page, `Close ${anchor.title}`)).toBeDisabled()
    await expect(tabs).toHaveCount(3)
    releaseLostReply.resolve()
    await expect(body(page)).toBeEditable()
    await expectBatchKeptOpen(`Could not confirm the save for ${interrupted.title}. Retry the same save from its tab. The tabs are still open.`,
      [interrupted, 'Recovery needed', localText(interrupted), interrupted.revision + 1n], [conflicting, 'Unsaved', conflicting.body, conflicting.revision], false)
    assert.equal(requests.length, 1)

    const remote = await saveDraft(author, conflicting, 'A newer server edit.')
    const [conflict] = await Promise.all([
      page.waitForResponse(response => response.url() === savePath && response.status() === 409),
      chooseSave(),
    ])
    const command = bytes => wire.decodeArticleCommand(decodeFrame(bytes, FrameType.ArticleCommand).payload)
    assert.equal(command(conflict.request().postDataBuffer()).id, conflicting.id)
    assert.equal(command(requests[0]).id, interrupted.id)
    assert.equal(requests.length, 3)
    assert.deepEqual(requests[1], requests[0], 'A lost receipt must replay the identical command and idempotency key')
    await expectBatchKeptOpen(`Saved ${interrupted.title}. ${conflicting.title} changed on the server. Reload its revision before saving. The tabs are still open.`,
      [interrupted, 'Pinned', localText(interrupted), interrupted.revision + 1n], [conflicting, 'Conflict', remote.body, conflicting.revision + 1n])
    observations.push({ abortedSaveCleanupPreservesRecoveryCopy: true, twoDirtyDraftsSaveAndClose: true,
      lostSaveReplyReplaysExactCommand: true, laterSaveConflictLeavesAllTabsOpen: true })
  } finally {
    releaseLostReply.resolve()
    await page.close()
  }
}

async function exerciseSingleDirtyClose(author) {
  const anchor = await createDraft(author, 'Single close anchor', 'The fallback editor remains open.')
  const victim = await createDraft(author, 'Single dirty close draft', 'Original persisted source.')
  const local = 'Only the recovery journal contains these changes.'
  const savedSource = 'This exact source must be confirmed before closing.'
  const page = monitor(await author.newPage())
  const close = button(page, `Close ${victim.title}`)
  const anchorTab = tab(page, anchor, 'Pinned')
  const dialog = closeDialog(page)
  const draftCopy = value => hasRecoveryCopy(page, victim.id, value)
  const recent = button(page, `Reopen Article ${victim.id}`)

  async function openCloseDialog() {
    await expect(dialog).toHaveCount(0)
    await press(page, close)
    await expect(dialog).toBeVisible()
  }

  async function confirmClose(option) {
    await openCloseDialog()
    await confirmCloseOption(dialog, option)
  }

  async function assertStillOpen(state, value) {
    await expect(page).toHaveURL(editPath(victim.id))
    await expectSelected(tab(page, victim, state))
    await expect(body(page)).toHaveValue(value)
    await expect(close).toBeFocused()
    await expect(openTabs(page)).toHaveCount(2)
    assert.equal(await draftCopy(value), true)
  }

  async function assertClosedToAnchor() {
    await expect(page).toHaveURL(editPath(anchor.id))
    await expect(anchorTab).toBeFocused()
    await expect(openTabs(page)).toHaveCount(1)
  }

  try {
    await openAndPinAnchor(page, anchor)
    await openDraft(page, victim, 'Open article')
    await expect(body(page)).toBeEditable()
    await body(page).fill(local)
    await expect.poll(() => draftCopy(local)).toBe(true)

    await openCloseDialog()
    await button(dialog, 'Keep writing').click()
    await expect(dialog).toHaveCount(0)
    await assertStillOpen('Unsaved', local)

    await abortRecoveryIdb(page, victim.id)
    const discard = 'Discard unsaved edits from this browser'
    await confirmClose(discard)
    await expect(page.locator('html')).toHaveAttribute('data-save-cleanup-aborted', '1')
    await expectWorkspaceMessage(page, 'Could not discard the recovery copies. The tabs are still open.')
    await assertStillOpen('Unsaved', local)

    await confirmClose(discard)
    await assertClosedToAnchor()
    assert.equal(await draftCopy(local), false)
    await reopenDraft(page, victim)
    await expect(body(page)).toBeEditable()
    await expect(body(page)).toHaveValue(victim.body)

    await title(page).fill(`  ${victim.title}  `)
    await body(page).fill(savedSource)
    await expect.poll(() => draftCopy(savedSource)).toBe(true)
    const saves = []
    const savePath = `${origin}${WireRoutes.Save}`
    await page.route(savePath, async route => {
      saves.push(route.request().postDataBuffer())
      if (saves.length > 2) return route.continue()
      const real = await route.fetch({ maxRetries: 0, maxRedirects: 0 })
      const stored = await readDraft(real)
      status.assertFields(stored, { title: victim.title, body: savedSource, revision: victim.revision + 1n })
      const wrong = saves.length === 1 ? { ...stored, title: `${stored.title} incorrect` } : { ...stored, body: 'Incorrect source.' }
      const headers = real.headers()
      delete headers['content-length']
      delete headers['content-encoding']
      await route.fulfill({ response: real, headers, body: Buffer.from(encodeFrame(FrameType.Draft, wire.encodeDraft(wrong))) })
      await real.dispose()
    })
    const option = 'Save drafts before closing'
    const failure = `Could not confirm the save for ${victim.title}. Retry the same save from its tab. The tabs are still open.`
    for (const expected of [1, 2]) {
      const [reply] = await Promise.all([waitForUrlResponse(page, () => savePath, 'POST'), confirmClose(option)])
      assert.deepEqual(await readDraft(reply), { ...victim, revision: victim.revision + 1n,
        title: expected === 1 ? `${victim.title} incorrect` : victim.title,
        body: expected === 1 ? savedSource : 'Incorrect source.' })
      assert.equal(saves.length, expected)
      await expectWorkspaceMessage(page, failure)
      await assertStillOpen('Recovery needed', savedSource)
    }
    await confirmClose(option)
    await assertClosedToAnchor()
    assert.equal(saves.length, 3)
    assert.deepEqual(saves[1], saves[0])
    assert.deepEqual(saves[2], saves[0])
    assert.equal(await draftCopy(savedSource), false)
    await expectStoredDraft(author.request, victim, savedSource, victim.revision + 1n)
    await reopenDraft(page, victim)
    await expect(title(page)).toHaveValue(victim.title)
    await expect(body(page)).toHaveValue(savedSource)
    await expect(recoveryHeading(page)).toHaveCount(0)
    await press(page, close)
    await expect(page).toHaveURL(editPath(anchor.id))
    await deleteDraft(author, { ...victim, revision: victim.revision + 1n })
    if (!await recent.isVisible()) await openWorkspaceDialog(page)
    const denied = waitForUrlResponse(page, () => draftPath(victim.id))
    await press(page, recent)
    status.assertStatus(await denied, 404)
    await expectWorkspaceMessage(page, 'The article is unavailable.')
    await expect(recent).toHaveCount(0)
    await expect(page).toHaveURL(editPath(anchor.id))
    await expect(body(page)).toHaveValue(anchor.body)
    await expect(body(page)).toBeFocused()
    observations.push({ deletedRecentEntryRemoved: true, failedReopenPreservesEditorAndFocus: true,
      singleDirtyCloseCancelPreservesRouteAndFocus: true, singleDiscardAbortPreservesRecoveryCopy: true,
      confirmedSingleDiscardReopensDurableDraft: true, singleCloseRejectsChangedSaveReplySource: true,
      verifiedSingleSaveClosesBeforeRouting: true })
  } finally {
    await page.close()
  }
}

async function verifyLayoutCommit(readLayout, pending, revision, expected) {
  const receipt = await decodeSavedGroups(await pending)
  assert.equal(receipt.revision, revision + 1n)
  assert.deepEqual(coordinates(receipt), expected)
  assert.deepEqual(await readLayout(), receipt)
  return receipt
}

async function changeGroupLayout(page, readLayout, before, command, expected) {
  const action = button(page, command)
  if (!await action.isVisible()) await openWorkspaceDialog(page)
  const sameGroup = before.focusedGroup === 0 ? 'Move to primary group' : 'Move to secondary group'
  await expect(button(page, sameGroup)).toBeDisabled()
  await expect(action).toBeEnabled()
  const pending = waitForUrlResponse(page, () => groupsPath, 'POST')
  await press(page, action)
  return verifyLayoutCommit(readLayout, pending, before.revision, expected)
}

async function expectHiddenEditor(handle) {
  assert.deepEqual(await handle.evaluate(element => ({ connected: element.isConnected, hidden: element.getClientRects().length === 0 })),
    { connected: true, hidden: true })
}

async function exerciseGroupActions({ page, readLayout, first, alternate, second, secondaryPreview }) {
  const primary = group(page, 'Primary'), secondary = group(page, 'Secondary')
  const mainSlots = [first.id, -alternate.id]
  const movedSlots = [second.id, secondaryPreview.id]

  async function activate(draft, state, currentGroup, slots) {
    await selectTab(page, draft, state, true)
    await expectPane(currentGroup, draft, draft.body, true)
    await pollLayout(readLayout, slots)
    return readLayout()
  }

  async function moveActive(before, command, slots, target, draft, activeNode, hiddenNode) {
    const next = await changeGroupLayout(page, readLayout, before, command, slots)
    await expect(page).toHaveURL(editPath(draft.id))
    await expectPane(target, draft, draft.body, true)
    await expectSameEditor(body(target), activeNode)
    if (hiddenNode) await expectHiddenEditor(hiddenNode)
    return next
  }

  const initial = { primary: mainSlots, secondary: [second.id, -secondaryPreview.id], secondaryActive: second.id, focusedGroup: 0 }
  await activate(alternate, 'Preview', primary, { ...initial, primaryActive: alternate.id })
  await activate(first, 'Pinned', primary, { ...initial, primaryActive: first.id })
  let saved = await activate(secondaryPreview, 'Preview', secondary, {
    primary: mainSlots, secondary: [second.id, -secondaryPreview.id],
    primaryActive: first.id, secondaryActive: secondaryPreview.id, focusedGroup: 1,
  })
  await expectPane(primary, first, first.body, false)
  const firstEditor = await editorNode(body(primary))
  const movingEditor = await editorNode(body(secondary))
  saved = await moveActive(saved, 'Move to primary group', {
    primary: [...mainSlots, secondaryPreview.id], secondary: [second.id],
    primaryActive: secondaryPreview.id, secondaryActive: 0, focusedGroup: 0,
  }, primary, secondaryPreview, movingEditor, firstEditor)
  await expect(body(primary)).toBeFocused()
  await expectSelected(tab(page, secondaryPreview, 'Pinned'))
  await capture(page, 'workspace-split-moved')

  const bothSelected = {
    primary: mainSlots, secondary: movedSlots, primaryActive: first.id, secondaryActive: secondaryPreview.id, focusedGroup: 1,
  }
  saved = await moveActive(saved, 'Move to secondary group', bothSelected, secondary, secondaryPreview, movingEditor)
  await expect(body(secondary)).toBeFocused()
  await expectPane(primary, first, first.body, false)
  await expectSameEditor(body(primary), firstEditor)
  const caret = await selectLastChar(body(secondary), secondaryPreview.body.length)
  const overflow = loc.exactRegion(page, 'Article tabs')
  async function moveBackground(to, slots, compact = false) {
    const chooser = button(page, compact ? 'Switch article tab' : 'More tabs (4)')
    await press(page, chooser)
    if (compact) await isolated.assertScrollWidth(page, 375)
    const action = button(overflow, `Move ${alternate.title} to ${to} group`)
    await expect(action).toBeEnabled()
    const pending = waitForUrlResponse(page, () => groupsPath, 'POST')
    await press(page, action)
    const receipt = await verifyLayoutCommit(readLayout, pending, saved.revision, slots)
    await expect(chooser).toHaveAttribute('aria-expanded', 'false')
    await expect(chooser).toBeFocused()
    await expect(page).toHaveURL(editPath(secondaryPreview.id))
    if (compact) await expectHiddenEditor(firstEditor)
    else {
      await expectSelected(tab(page, secondaryPreview, 'Pinned'))
      await expectSelected(tab(page, alternate, 'Preview'), false)
      await expectSameEditor(body(primary), firstEditor)
    }
    await expectSameEditor(body(secondary), movingEditor)
    assert.deepEqual(await selection(body(secondary)), caret)
    return receipt
  }
  saved = await moveBackground('secondary', { ...bothSelected, primary: [first.id], secondary: [...movedSlots, -alternate.id] })
  saved = await isolated.withViewport(page, 375, 850, () => moveBackground('primary', bothSelected, true))
  await expectPane(primary, first, first.body, false)
  await expectSameEditor(body(primary), firstEditor)
  observations.push({ backgroundPreviewMovesBothWays: true, backgroundMovePreservesOpenEditorsAndSelection: true,
    backgroundMoveRevision: saved.revision.toString() })
  await body(secondary).press('ArrowRight')
  assert.deepEqual(await selection(body(secondary)), [secondaryPreview.body.length, secondaryPreview.body.length])
  await firstEditor.dispose()

  const firstPreviewSelected = { ...bothSelected, primaryActive: alternate.id, focusedGroup: 0 }
  saved = await activate(alternate, 'Preview', primary, firstPreviewSelected)
  const previewEditor = await editorNode(body(primary))
  saved = await moveActive(saved, 'Move to secondary group', {
    primary: [first.id], secondary: [...movedSlots, -alternate.id],
    primaryActive: 0, secondaryActive: alternate.id, focusedGroup: 1,
  }, secondary, alternate, previewEditor, movingEditor)
  await expectSelected(tab(page, alternate, 'Preview'))
  saved = await moveActive(saved, 'Move to primary group', firstPreviewSelected, primary, alternate, previewEditor)

  saved = await activate(secondaryPreview, 'Pinned', secondary, { ...firstPreviewSelected, focusedGroup: 1 })
  await expectPane(primary, alternate, alternate.body, false)
  await expectSameEditor(body(primary), previewEditor)
  await expectSameEditor(body(secondary), movingEditor)
  const beforeUnpin = saved.revision
  await button(page, `Unpin ${second.title}`).click()
  await expect(tab(page, second, 'Preview')).toBeVisible()
  await pollLayout(readLayout, { ...firstPreviewSelected, secondary: [-second.id, secondaryPreview.id], focusedGroup: 1 })
  saved = await readLayout()
  assert.equal(saved.revision, beforeUnpin + 1n)
  const suffix = ' Local draft across group merge.'
  await body(secondary).press('End')
  await page.keyboard.insertText(suffix)
  const unsavedSource = secondaryPreview.body + suffix
  await expect(body(secondary)).toHaveValue(unsavedSource)
  const selectedBeforeMerge = await selectLastChar(body(secondary), unsavedSource.length, false)
  const merged = await changeGroupLayout(page, readLayout, saved, 'Merge groups', {
    primary: [...mainSlots, ...movedSlots], secondary: [],
    primaryActive: secondaryPreview.id, secondaryActive: 0, focusedGroup: 0,
  })
  await expect(page).toHaveURL(editPath(secondaryPreview.id))
  await expectSelected(tab(page, secondaryPreview, 'Unsaved'))
  await expect(tab(page, alternate, 'Preview')).toBeVisible()
  await expect(tab(page, second, 'Pinned')).toBeVisible()
  await expectPane(primary, secondaryPreview, unsavedSource, true)
  await expect(body(primary)).toBeFocused()
  assert.deepEqual(await selection(body(primary)), selectedBeforeMerge)
  await expect(secondary).toHaveCount(0)
  await expect(editors(page)).toHaveCount(2)
  await expectSameEditor(body(primary), movingEditor)
  await expectHiddenEditor(previewEditor)
  await expectStoredDraft(page.request, secondaryPreview)
  await capture(page, 'workspace-split-merged')
  await previewEditor.dispose()
  await movingEditor.dispose()

  observations.push({ movesPreserveExactRouteAndEditors: true, occupiedPreviewPromoted: true, emptyPreviewSlotKeepsPreview: true,
    mergePromotesIncomingPreview: true, mergePreservesFocusAndUnsavedSource: true, mergeKeepsOtherEditorMounted: true,
    groupChangesPersistAtomically: true, mergedRevision: merged.revision.toString() })
}

async function exerciseSavedWorkspace({ author, session, outsider, outsiderSession, first, alternate, second }) {
  const viewport = { width: 1366, height: 900 }
  const cookies = await author.cookies()
  const secondaryPreview = await createDraft(author, 'Another secondary workspace draft', 'Another secondary server source.')
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ viewport })))
  const [writerContext, reopenedContext, verificationContext] = contexts
  try {
    for (const context of contexts) await context.addCookies(cookies)
    const writer = monitor(await writerContext.newPage())
    await writer.goto(workspacePath)
    await expectWorkspaceMessage(writer, 'Open an article or start a new draft.')
    for (const [pinned, preview, command] of [[first, alternate, 'Open article'], [second, secondaryPreview]]) {
      await openDraft(writer, pinned, command)
      await button(writer, `Pin ${pinned.title}`).click()
      await openDraft(writer, preview, 'Open article')
      await selectTab(writer, pinned, 'Pinned', true)
    }

    await pollLayout(() => savedGroups(writerContext, session), {
      primary: [first.id, -alternate.id], secondary: [second.id, -secondaryPreview.id],
      primaryActive: first.id, secondaryActive: second.id, focusedGroup: 1,
    })
    const persisted = await savedGroups(writerContext, session)
    assert(persisted.revision > 0n && persisted.updatedAtUnixMs > 0n)

    // Fresh storage contexts have only cookies. The exact layout must be read from PostgreSQL.
    const reopened = monitor(await reopenedContext.newPage())
    await withHeldDraft(reopened, second.id, async () => assert.deepEqual(await enterSavedWorkspace(reopened), persisted), async code => {
      assert.equal(code, 200)
      await expect(reopened).toHaveURL(workspacePath)
      await expect(editors(reopened)).toHaveCount(0)
    })
    await expectRestored(reopened, first, alternate, second, secondaryPreview)
    await capture(reopened, 'workspace-split-persisted')

    const offlinePosts = []
    const layoutPaths = [WireRoutes.AuthoringWorkspace, WireRoutes.AuthoringWorkspaceLayout, WireRoutes.AuthoringWorkspaceGroups]
    reopened.on('request', request => {
      if (request.method() === 'POST' && layoutPaths.includes(new URL(request.url()).pathname)) offlinePosts.push(request.url())
    })
    await reopenedContext.setOffline(true)
    await reopened.waitForFunction(() => !navigator.onLine)
    await button(reopened, `Close ${secondaryPreview.title}`).click()
    await expect(tab(reopened, secondaryPreview, 'Preview')).toHaveCount(0)
    await expectWorkspaceMessage(reopened, 'Layout changes stay in this tab while offline. Reload the workspace to resume saving layouts.')
    assert.deepEqual(await savedGroups(writerContext, session), persisted)
    await reopenedContext.setOffline(false)
    await reopened.waitForFunction(() => navigator.onLine)
    await expect(tab(reopened, secondaryPreview, 'Preview')).toHaveCount(0)
    // The normal router leave awaits the layout flush after the network has returned.
    await button(reopened, 'More actions').click()
    await loc.exactMenuItem(reopened, 'Canvases').click()
    await expect(reopened).toHaveURL(`${origin}/admin/canvas`)
    assert.deepEqual(offlinePosts, [], 'Reconnection and route flush must never replay a local offline layout change')
    assert.deepEqual(await savedGroups(writerContext, session), persisted)
    const verified = monitor(await verificationContext.newPage())
    assert.deepEqual(await enterSavedWorkspace(verified), persisted)
    await expectRestored(verified, first, alternate, second, secondaryPreview)

    const other = monitor(await outsider.newPage())
    status.assertStatus(await outsider.request.get(groupsPath, { headers: { [WireHeaders.CurrentSession]: session } }), 409)
    const otherLayout = await savedGroups(outsider, outsiderSession)
    assert.equal(otherLayout.revision, 0n)
    assert.deepEqual(coordinates(otherLayout), { primary: [], secondary: [], primaryActive: 0, secondaryActive: 0, focusedGroup: 0 })
    assert.deepEqual(await enterSavedWorkspace(other), otherLayout)
    await expect(other).toHaveURL(workspacePath)
    await expectWorkspaceMessage(other, 'Open an article or start a new draft.')
    await expect(editors(other)).toHaveCount(0)
    await expect(tabList(other)).toHaveCount(0)
    await other.close()
    observations.push({ persistedWorkspaceFromEmptyBrowserStorage: true, exactStoredGroupOrderAndFocus: true, restoreWaitsForRealDraft: true,
      offlineChangesDoNotReplay: true, otherAuthorHasIndependentWorkspace: true, storedRevision: persisted.revision.toString() })
    await exerciseGroupActions({ page: verified, readLayout: () => savedGroups(writerContext, session), first, alternate, second, secondaryPreview })
  } finally {
    for (const context of contexts.reverse()) await context.close()
  }
}

const browser = await isolated.launchChrome()
await isolated.withBrowserEvidence(browser, evidence, 'workspace-split-result.json', { observations, diagnostics }, async () => {
  const author = await browser.newContext({ viewport: { width: 1366, height: 900 } })
  const outsider = await browser.newContext()
  const session = await signInWithPasskey(author, process.env.FSUSBLOG_TEST_AUTHOR_BOOTSTRAP)
  const outsiderSession = await signInWithPasskey(outsider, process.env.FSUSBLOG_TEST_OUTSIDER_BOOTSTRAP)
  const first = await createDraft(author, 'Primary workspace draft', 'Primary server source.')
  const second = await createDraft(author, 'Secondary workspace draft', '# Secondary first heading\n\nSecondary server source.\n\n## Secondary last heading')
  const nativePageZoom = await exerciseNativePageZoom(author, first, second)
  const alternate = await createDraft(author, 'Another primary workspace draft', 'Another primary server source.')
  const unavailable = await createDraft(outsider, 'Draft from another administrator', 'Private source before deletion.')
  await isolated.withTempContext(browser, visitor => status.assertGetStatus(visitor.request, draftPath(unavailable.id), 401))
  assert.equal((await readDraft(await author.request.get(draftPath(unavailable.id)))).body, unavailable.body)
  await deleteDraft(outsider, unavailable)
  const localSuffix = ' Local unsaved source.'
  const localSource = first.body + localSuffix
  const page = monitor(await author.newPage())
  await page.goto(editPath(first.id))
  await expect(loc.exactHeading(page, 'Edit article')).toBeVisible()
  await expect(editors(page)).toBeVisible()
  await expect(body(page)).toHaveValue(first.body)
  await expect(body(page)).toBeEditable()
  const firstNode = await editorNode(body(page))
  await body(page).press('End')
  await page.keyboard.insertText(localSuffix)
  await expect(body(page)).toHaveValue(localSource)
  const firstSelection = await selectLastChar(body(page), localSource.length, false)

  const primary = group(page, 'Primary'), secondary = group(page, 'Secondary')
  const expectSingleFirst = async () => {
    await expect(page).toHaveURL(editPath(first.id))
    await expect(secondary).toHaveCount(0)
    await expect(editors(page)).toHaveCount(1)
    await expect(body(page)).toHaveValue(localSource)
  }
  const denied = waitForUrlResponse(page, () => draftPath(unavailable.id))
  await openById(page, unavailable.id)
  status.assertStatus(await denied, 404)
  await expectWorkspaceMessage(page, 'The article is unavailable.')
  await expect(separator(page)).toHaveCount(0)
  await expectSingleFirst()
  await expectSameEditor(body(page), firstNode)

  await withHeldDraft(page, second.id, () => openById(page, second.id), async code => {
    assert.equal(code, 200, 'The suspended response must be a real authorized draft receipt')
    await expectSingleFirst()
  })
  await expect(page).toHaveURL(editPath(second.id))
  await expectPane(primary, first, localSource, false)
  await expectPane(secondary, second, second.body, true)
  await expect(editors(page)).toHaveCount(2)
  await expectSameEditor(body(primary), firstNode)
  const secondNode = await editorNode(body(secondary))
  async function expectBothPanes(primaryWritable, secondDraft = second) {
    await expectPane(primary, first, localSource, primaryWritable)
    await expectPane(secondary, secondDraft, secondDraft.body, !primaryWritable)
    await expectSameEditor(body(primary), firstNode)
    await expectSameEditor(body(secondary), secondNode)
  }
  async function focusGroupAndVerify(pane, draft, expectedSelection) {
    await editInGroup(page, pane, draft)
    await expect(body(pane)).toBeFocused()
    assert.deepEqual(await selection(body(pane)), expectedSelection)
  }
  const [left, right] = await Promise.all([primary.boundingBox(), secondary.boundingBox()])
  assert(left && right)
  assert(left.width > 360 && right.width > 360, 'Both desktop groups must have usable widths')
  assert(left.x + left.width <= right.x + 2, 'Desktop groups must be side by side')
  const secondSelection = await selectLastChar(body(secondary), second.body.length)
  const splitter = await exerciseSplitter(page, primary, secondary)
  const checkedViewports = [{ ...await pageWidths(page), groups: 2, primaryPercent: splitter.pointerPercent }]
  await expect(page).toHaveURL(editPath(second.id))
  await expectSameEditor(body(primary), firstNode)
  await expectSameEditor(body(secondary), secondNode)
  assert.deepEqual(await selection(body(secondary)), secondSelection)
  await capture(page, 'workspace-split-desktop')

  // A group keeps its own open outline and roving heading without moving focus on return.
  await press(page, button(secondary, 'Outline'))
  const headings = page.getByRole('navigation', { name: 'Article headings' })
  const lastHeading = button(headings, 'Secondary last heading')
  await expect(button(headings, 'Secondary first heading')).toBeVisible()
  await page.keyboard.press('End')
  await expect(lastHeading).toBeFocused()
  await editInGroup(page, primary, first)
  await expect(headings).toBeHidden()
  await expect(button(primary, 'Outline')).toHaveAttribute('aria-expanded', 'false')
  await editInGroup(page, secondary, second)
  await expect(lastHeading).toBeVisible()
  await expect(lastHeading).toHaveAttribute('tabindex', '0')
  await expect(body(secondary)).toBeFocused()
  await press(page, button(page.getByRole('complementary', { name: 'Article outline' }), 'Close'))
  await expect(headings).toBeHidden()
  await expect(button(secondary, 'Outline')).toHaveAttribute('aria-expanded', 'false')
  await expect(button(secondary, 'Outline')).toBeFocused()
  observations.push({ mountedGroupOutlineAndHeadingRetained: true, groupActivationKeepsEditorFocus: true })

  await focusGroupAndVerify(primary, first, firstSelection)
  await expectBothPanes(true)

  let minimum = splitter.pointerPercent + 1
  for (const width of [1040, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(async () => Number(await separator(page).getAttribute('aria-valuemin'))).toBeGreaterThanOrEqual(minimum)
    await expectBothPanes(true)
    const clamped = await splitGeometry(page, primary, secondary)
    assert(clamped.values.min >= minimum)
    assert.equal(clamped.values.now, clamped.values.min)
    minimum = clamped.values.min
    checkedViewports.push({ ...await pageWidths(page), groups: 2, primaryPercent: clamped.values.now })
  }
  await separator(page).focus()
  await expect(separator(page)).toBeFocused()

  for (const [width, height] of [[768, 900], [375, 850]]) {
    await page.setViewportSize({ width, height })
    await expectPane(primary, first, localSource, true)
    await expect(secondary).toBeHidden()
    await expect(separator(page)).toHaveCount(0)
    await expect(loc.exactText(page, 'Equalize group widths')).toHaveCount(0)
    await expect(body(primary)).toBeFocused()
    await expectSameEditor(body(primary), firstNode)
    assert.equal(await isConnected(secondNode), true, `Collapse at ${width}px must retain the second editor`)
    assert.deepEqual(await selection(body(primary)), firstSelection)
    checkedViewports.push({ ...await pageWidths(page), groups: 1 })
  }
  await press(page, button(page, 'Focus secondary group'), 'Space')
  await expect(page).toHaveURL(editPath(second.id))
  await expect(primary).toBeHidden()
  await expectPane(secondary, second, second.body, true)
  await expect(body(secondary)).toBeFocused()
  assert.equal(await isConnected(firstNode), true, 'Changing mobile focus must retain the first editor')
  await expectSameEditor(body(secondary), secondNode)
  await capture(page, 'workspace-split-mobile')

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', 'dark')
  await expectBothPanes(false)
  assert.deepEqual(await selection(body(secondary)), secondSelection)
  const at1440 = await splitGeometry(page, primary, secondary)
  assert.equal(at1440.values.now, splitter.pointerPercent)
  checkedViewports.push({ ...await pageWidths(page), groups: 2, primaryPercent: at1440.values.now, theme: 'dark', reducedMotion: true })
  await capture(page, 'workspace-split-dark-1440')
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })

  await page.setViewportSize({ width: 1366, height: 900 })
  await expectBothPanes(false)
  await expect(separator(page)).toHaveAttribute('aria-valuenow', String(splitter.pointerPercent))
  const restored = await splitGeometry(page, primary, secondary)
  for (const [index, width] of [restored.left.width, restored.right.width].entries())
    assert(Math.abs(width - splitter.pointerPaneWidths[index]) <= 1)
  assert.deepEqual(await selection(body(secondary)), secondSelection)

  await focusGroupAndVerify(primary, first, firstSelection)
  await body(primary).press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect(body(primary)).toHaveValue(first.body)
  await body(primary).press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z')
  await expect(body(primary)).toHaveValue(localSource)
  await expect(body(secondary)).toHaveValue(second.body)
  await focusGroupAndVerify(secondary, second, secondSelection)

  const savedSecondSuffix = ' Saved in the secondary group.'
  await body(secondary).press('ArrowRight')
  await expect.poll(() => selection(body(secondary))).toEqual([second.body.length, second.body.length])
  await page.keyboard.insertText(savedSecondSuffix)
  await expect(body(secondary)).toHaveValue(second.body + savedSecondSuffix)
  const save = waitForUrlResponse(page, () => `${origin}${WireRoutes.Save}`, 'POST')
  await button(page, 'Save draft').click()
  const savedSecond = await readDraft(await save)
  status.assertFields(savedSecond, { id: second.id, body: second.body + savedSecondSuffix })
  assert(savedSecond.revision > second.revision)
  await expectBothPanes(false, savedSecond)
  await expectStoredDraft(author.request, first)

  // An inactive tab already owned by the primary group must reopen there despite the opposite target.
  await editInGroup(page, primary, first)
  await openDraft(page, alternate, 'Open article')
  await expectPane(primary, alternate, alternate.body, true)
  await expectPane(secondary, savedSecond, savedSecond.body, false)
  await openDraft(page, first)
  await expectPane(primary, first, localSource, true)
  await expectPane(secondary, savedSecond, savedSecond.body, false)
  await expectSameEditor(body(secondary), secondNode)
  await expect(body(page.getByRole('main'))).toHaveCount(2)
  const tail = await createDraft(author, 'Last primary workspace draft', 'Last primary server source.')
  await exerciseTabClose({ page, first, localSource, alternate, tail, second: savedSecond, secondNode })
  const reopenedFirstNode = await editorNode(body(primary))

  await exerciseSavedWorkspace({ author, session, outsider, outsiderSession, first, alternate, second: savedSecond })
  await exerciseSaveAndClose(author)
  await exerciseSingleDirtyClose(author)

  // An administrator can reopen the saved draft, but the old session's editors and local recovery are private.
  await body(primary).fill(localSource)
  await expect.poll(() => hasRecoveryCopy(page, first.id, localSource)).toBe(true)
  await author.addCookies(await outsider.cookies())
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')))
  await expect.poll(() => isConnected(reopenedFirstNode)).toBe(false)
  await expect.poll(() => isConnected(secondNode)).toBe(false)
  const currentBodies = body(page.getByRole('main'))
  await expect(currentBodies).toHaveCount(1)
  await expect(currentBodies).toHaveValue(first.body)
  await expect(recoveryHeading(page)).toHaveCount(0)
  assert.equal(await readSession(author), outsiderSession)
  for (const node of [firstNode, reopenedFirstNode, secondNode]) await node.dispose()

  observations.push({ realDeniedDraft: true, waitsForRealReceipt: true, twoDistinctSourceEditors: true,
    exactEditorNodesAcrossFocusAndCollapse: true, focusedOnlyWrites: true, selectionAndIndependentUndo: true,
    exactFocusedSaveReceipt: true, duplicateKeepsOwningGroup: true, keyboardCompactSwitch: true,
    identityInvalidatesBothEditors: true, replacementSessionReadsOnlySavedDraft: true,
    wideViewport: 1366, compactViewport: 375, paneWidths: [left.width, right.width],
    splitter: { ...splitter, clampedPercentAt1040: checkedViewports.find(check => check.viewport === 1040).primaryPercent,
      restoredPaneWidths: [restored.left.width, restored.right.width], checkedViewports, nativePageZoom } })
  assert.deepEqual(diagnostics, [])
})

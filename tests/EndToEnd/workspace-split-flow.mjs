import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import {
  decodeArticleCommand, decodeAuthoringWorkspaceGroups, decodeDraft, encodeDraft, FrameType, WireHeaders, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'
import { authorFixture, button, chromium, expect, holdResponse, readDraft, submitArticle } from './browser-authoring-fixture.mjs'

const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const workspacePath = `${origin}/user/manage/article/workspace`
const groupsPath = `${origin}${WireRoutes.AuthoringWorkspaceGroups}`
const editPath = id => `${origin}/user/manage/article/edit/${id}`
const draftPath = id => `${origin}${WireRoutes.Draft.replace('{id:int}', String(id))}`
const body = scope => scope.getByRole('textbox', { name: 'Body', exact: true })
const title = scope => scope.getByRole('textbox', { name: 'Title', exact: true })
const group = (page, name) => page.getByRole('main').getByRole('region', { name: `${name} article group`, exact: true })
const tabList = page => page.getByRole('tablist', { name: 'Open articles' })
const tab = (page, draft, state) => tabList(page).getByRole('tab', { name: `${draft.title} · ${state}`, exact: true })
const selection = locator => locator.evaluate(element => [element.selectionStart, element.selectionEnd])
const observations = []
const diagnostics = []

const { signIn: issueSession, createDraft, saveDraft, monitor } = authorFixture(origin, diagnostics)

async function signIn(context, ticket) {
  assert(ticket, 'A scratch author ticket is required')
  const session = await issueSession(context, ticket)
  assert(session, 'Sign-in must bind workspace reads to the issued authoring session')
  return session
}

const workspaceDialog = page => page.getByRole('dialog', { name: 'Workspace & open article', exact: true })

async function openWorkspaceDialog(page) {
  const dialog = workspaceDialog(page)
  if (await dialog.isVisible()) return dialog
  await button(page, 'More actions').click()
  await page.getByRole('menuitem', { name: 'Workspace & open…', exact: true }).click()
  await expect(dialog).toBeVisible()
  return dialog
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
  if (await direct.isVisible()) {
    await direct.click()
    return
  }
  const dialog = await openWorkspaceDialog(page)
  await button(dialog, `Pin ${draft.title}`).click()
  await closeWorkspaceDialog(page)
}

async function openById(page, id, command = 'Open in other group') {
  const inlineInput = page.getByLabel('Article ID', { exact: true })
  const scope = await inlineInput.isVisible() ? page : await openWorkspaceDialog(page)
  await scope.getByLabel('Article ID', { exact: true }).fill(String(id))
  await button(scope, command).click()
}

async function expectPane(pane, draft, source, writable) {
  await expect(pane).toBeVisible()
  await expect(title(pane)).toHaveValue(draft.title)
  await expect(body(pane)).toHaveValue(source)
  if (writable) {
    await expect(title(pane)).toBeEditable()
    await expect(body(pane)).toBeEditable()
  } else {
    await expect(title(pane)).not.toBeEditable()
    await expect(body(pane)).not.toBeEditable()
  }
}

async function expectSameEditor(locator, original) {
  assert.equal(await locator.evaluate((current, previous) => current === previous && current instanceof HTMLTextAreaElement,
    original), true, 'The same native FsusUI textarea must remain mounted for that session')
}

const separator = page => page.getByRole('separator', { name: 'Resize article groups', exact: true })

async function pageWidths(page) {
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    client: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
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
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical')
  const controlledPane = await primary.getAttribute('id')
  assert(controlledPane)
  await expect(handle).toHaveAttribute('aria-controls', controlledPane)
  await expect(handle).toHaveAttribute('aria-valuetext', 'Primary group 50%')
  const initial = await splitGeometry(page, primary, secondary)
  assert.equal(initial.values.now, 50)
  assert(initial.values.min < 50 && initial.values.max > 50)

  await press(page, handle, 'ArrowRight')
  const increased = await splitGeometry(page, primary, secondary)
  assert(increased.left.width > initial.left.width)
  assert.equal(increased.values.now, initial.values.now + 1)
  await page.keyboard.press('ArrowLeft')
  const returned = await splitGeometry(page, primary, secondary)
  assert.equal(returned.values.now, initial.values.now)
  assert(Math.abs(returned.left.width - initial.left.width) <= 1)
  await page.keyboard.press('Home')
  const home = await splitGeometry(page, primary, secondary)
  assert.equal(home.values.now, home.values.min)
  await page.keyboard.press('End')
  const end = await splitGeometry(page, primary, secondary)
  assert.equal(end.values.now, end.values.max)
  assert(home.left.width < returned.left.width && returned.left.width < end.left.width)
  assert(home.right.width > returned.right.width && returned.right.width > end.right.width)

  const actions = button(page, 'Group actions')
  const equalize = button(page, 'Equalize group widths')
  await press(page, actions)
  await press(page, equalize, 'Space')
  await expect(equalize).toBeFocused()
  const equal = await splitGeometry(page, primary, secondary)
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
    assert.equal((await splitGeometry(page, primary, secondary)).values.now, end.values.now)
    await page.mouse.move(targetX, y, { steps: 4 })
    await expect(handle).toHaveAttribute('aria-valuenow', String(preferred))
  } finally {
    await page.mouse.up()
  }
  const pointer = await splitGeometry(page, primary, secondary)
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
    const directory = await mkdtemp(join(tmpdir(), 'fsus-workspace-page-zoom-'))
    try {
      const profile = join(directory, 'Default')
      await mkdir(profile)
      // Chrome reads default page zoom from the root storage partition of this temporary profile.
      await writeFile(join(profile, 'Preferences'), JSON.stringify({
        partition: { default_zoom_level: { x: Math.log(factor) / Math.log(1.2) } },
      }))
      const context = await chromium.launchPersistentContext(directory, {
        executablePath: process.env.FSUSBLOG_TEST_CHROME, viewport: null, args: ['--window-size=1440,900'],
      })
      try {
        await context.addCookies(cookies)
        const page = context.pages()[0] ?? await context.newPage()
        monitor(page)
        await page.goto(editPath(first.id))
        await expectPane(group(page, 'Primary'), first, first.body, true)
        await openById(page, second.id)
        await expect(page).toHaveURL(editPath(second.id))
        await expectPane(group(page, 'Secondary'), second, second.body, true)
        const primary = group(page, 'Primary')
        if (factor === 1) {
          await expectPane(primary, first, first.body, false)
          await splitGeometry(page, primary, group(page, 'Secondary'))
        } else {
          await expect(primary).toBeHidden()
          await expect(separator(page)).toHaveCount(0)
          await expect(page.locator('.el-markdown-editor')).toHaveCount(2)
          await press(page, button(page, 'Focus primary group'), 'Space')
          await expect(page).toHaveURL(editPath(first.id))
          await expectPane(primary, first, first.body, true)
          await expect(group(page, 'Secondary')).toBeHidden()
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
      } finally {
        await context.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  return checks
}

async function holdDraft(page, id) {
  const held = await holdResponse(page, draftPath(id), { maxRetries: 0, maxRedirects: 0 })
  return {
    async status() {
      const expiry = new AbortController()
      try { return await Promise.race([held.status().catch(error => error), delay(8_000, 'draft request did not arrive', { signal: expiry.signal })]) }
      finally { expiry.abort() }
    },
    async release() {
      held.release()
      if (held.started) await held.done
    },
  }
}

async function press(page, control, key = 'Enter') {
  await control.focus()
  await expect(control).toBeFocused()
  await page.keyboard.press(key)
}

async function capture(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: join(evidence, `${name}.png`) })
}

async function decodeSavedGroups(response) {
  assert.equal(response.status(), 200)
  const snapshot = decodeAuthoringWorkspaceGroups(decodeFrame(await response.body(), FrameType.AuthoringWorkspaceGroups).payload)
  assert.equal(snapshot.schemaVersion, 3)
  return snapshot
}

async function savedGroups(context, session) {
  return decodeSavedGroups(await context.request.get(groupsPath, { headers: { [WireHeaders.CurrentSession]: session } }))
}

function coordinates(snapshot) {
  return { primary: snapshot.tabs, secondary: snapshot.secondaryTabs, primaryActive: snapshot.activeArticleId,
    secondaryActive: snapshot.secondaryActiveArticleId, focusedGroup: snapshot.focusedGroup }
}

async function enterSavedWorkspace(page) {
  await page.goto(`${origin}/user/manage/article/list`)
  const response = page.waitForResponse(receipt => receipt.url() === groupsPath && receipt.request().method() === 'GET')
  await page.getByRole('link', { name: '工作区', exact: true }).click()
  return decodeSavedGroups(await response)
}

async function expectRestored(page, primary, primaryPreview, secondary, secondaryPreview) {
  await expect(page).toHaveURL(editPath(secondary.id))
  await expectPane(group(page, 'Primary'), primary, primary.body, false)
  await expectPane(group(page, 'Secondary'), secondary, secondary.body, true)
  await expect(page.locator('.el-markdown-editor')).toHaveCount(2)
  const tabs = tabList(page).getByRole('tab')
  await expect(tabs).toHaveCount(4)
  assert.deepEqual(await tabs.evaluateAll(items => items.map(item => item.getAttribute('aria-label'))),
    [`${primary.title} · Pinned`, `${primaryPreview.title} · Preview`, `${secondary.title} · Pinned`, `${secondaryPreview.title} · Preview`])
  await expect(tab(page, secondary, 'Pinned')).toHaveAttribute('aria-selected', 'true')
}

async function exerciseTabClose({ page, first, localSource, alternate, tail, second, secondNode }) {
  const primary = group(page, 'Primary')
  const secondary = group(page, 'Secondary')
  await press(page, tab(page, alternate, 'Preview'))
  await expect(page).toHaveURL(editPath(alternate.id))
  await button(page, `Pin ${alternate.title}`).click()
  await expect(tab(page, alternate, 'Pinned')).toBeVisible()
  await openById(page, tail.id, 'Open article')
  await expect(page).toHaveURL(editPath(tail.id))
  await press(page, tab(page, alternate, 'Pinned'))
  await expect(page).toHaveURL(editPath(alternate.id))
  await expectPane(primary, alternate, alternate.body, true)
  const alternateNode = await body(primary).elementHandle()
  assert(alternateNode)
  try {
    const others = button(page, 'Close other tabs')
    const right = button(page, 'Close tabs to the right')
    const dialog = page.getByRole('dialog', { name: 'Close tabs with unsaved edits?', exact: true })
    const discard = dialog.getByRole('radio', { name: 'Discard unsaved edits from this browser', exact: true })
    const listedTabs = dialog.getByRole('list', { name: 'Tabs to close', exact: true }).getByRole('listitem')
    const confirmedTargets = [`${first.title} (unsaved changes) · Article ${first.id}`, `${tail.title} (up to date) · Article ${tail.id}`]
    await button(page, 'Group actions').click()
    await press(page, others)
    await expect(listedTabs).toHaveText(confirmedTargets)
    await expect(discard).not.toBeChecked()
    await button(dialog, 'Keep writing').click()
    await expect(dialog).toBeHidden()
    await expect(others).toBeFocused()
    await expect(tabList(page).getByRole('tab')).toHaveCount(4)
    await expect(tab(page, first, 'Unsaved')).toBeVisible()
    await expect(tab(page, tail, 'Preview')).toBeVisible()
    await expect(tab(page, second, 'Pinned')).toBeVisible()
    await expect(workspaceDialog(page).getByRole('heading', { name: 'Recently closed', exact: true })).toHaveCount(0)

    await press(page, others)
    await expect(listedTabs).toHaveText(confirmedTargets)
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = original.apply(this, args)
        if (this.name === 'fsusblog-v2-draft-recovery' && args[1] === 'readonly') {
          IDBDatabase.prototype.transaction = original
          tx.addEventListener('abort', () => { document.documentElement.dataset.recoveryReadAborted = '1' }, { once: true })
          queueMicrotask(() => tx.abort())
        }
        return tx
      }
    })
    await button(dialog, 'Close tabs').click()
    await expect(page.locator('html')).toHaveAttribute('data-recovery-read-aborted', '1')
    await expect(page.getByText('Could not verify recovery copies. Save the drafts before closing these tabs.', { exact: true })).toBeVisible()
    await expect(others).toBeFocused()
    await expect(tabList(page).getByRole('tab')).toHaveCount(4)
    await expect(workspaceDialog(page).getByRole('heading', { name: 'Recently closed', exact: true })).toHaveCount(0)

    await press(page, right)
    await expect(tab(page, tail, 'Preview')).toHaveCount(0)
    await expect(page.getByText('Closed 1 tab.', { exact: true })).toBeVisible()
    await expect(tab(page, alternate, 'Pinned')).toBeFocused()
    await expect(tab(page, first, 'Unsaved')).toBeVisible()
    await openWorkspaceDialog(page)
    await expect(right).toBeDisabled()
    await expect(page).toHaveURL(editPath(alternate.id))
    await expectSameEditor(body(primary), alternateNode)
    await expectSameEditor(body(secondary), secondNode)
    await expect(button(workspaceDialog(page), `Reopen Article ${tail.id}`)).toBeVisible()
    await closeWorkspaceDialog(page)

    await press(page, tab(page, first, 'Unsaved'))
    await expect(page).toHaveURL(editPath(first.id))
    await expectPane(primary, first, localSource, true)
    const activeNode = await body(primary).elementHandle()
    assert(activeNode)
    try {
      await page.setViewportSize({ width: 375, height: 850 })
      const switcher = button(page, 'Switch article tab')
      await expect(switcher).toBeVisible()
      await openWorkspaceDialog(page)
      await press(page, others)
      await expect(switcher).toBeFocused()
      await expect(page).toHaveURL(editPath(first.id))
      await expect(body(primary)).toHaveValue(localSource)
      await expectSameEditor(body(primary), activeNode)
      await openWorkspaceDialog(page)
      await expect(button(workspaceDialog(page), `Reopen Article ${alternate.id}`)).toBeVisible()
      await closeWorkspaceDialog(page)
      await page.setViewportSize({ width: 1366, height: 900 })
      await expect(tabList(page).getByRole('tab')).toHaveCount(2)
      await expect(tab(page, second, 'Pinned')).toBeVisible()
      await expectSameEditor(body(secondary), secondNode)
    } finally { await activeNode.dispose() }

    await openWorkspaceDialog(page)
    await button(workspaceDialog(page), `Reopen Article ${alternate.id}`).click()
    await expect(page).toHaveURL(editPath(alternate.id))
    await openWorkspaceDialog(page)
    await button(workspaceDialog(page), `Reopen Article ${tail.id}`).click()
    await expect(page).toHaveURL(editPath(tail.id))
    await press(page, tab(page, alternate, 'Pinned'))
    await expect(page).toHaveURL(editPath(alternate.id))
    await expectPane(primary, alternate, alternate.body, true)
    await openWorkspaceDialog(page)
    await press(page, others)
    await expect(listedTabs).toHaveText(confirmedTargets)
    await button(dialog, 'Close tabs').click()
    await expect(page.getByText('Closed 2 tabs.', { exact: true })).toBeVisible()
    await expect(tabList(page).getByRole('tab')).toHaveCount(2)
    await expect(tab(page, first, 'Unsaved')).toHaveCount(0)
    await expect(tab(page, tail, 'Preview')).toHaveCount(0)
    await expect(tab(page, alternate, 'Pinned')).toBeFocused()
    await expectSameEditor(body(secondary), secondNode)
    await openWorkspaceDialog(page)
    const reopenFirst = button(workspaceDialog(page), `Reopen Article ${first.id}`)
    await expect(reopenFirst).toBeVisible()
    await reopenFirst.click()
    await expect(page).toHaveURL(editPath(first.id))
    await expect(body(primary)).toHaveValue(first.body)
    await expect(page.getByRole('heading', { name: 'Recover an unsaved draft', exact: true })).toBeVisible()
    await button(page, 'Restore draft').click()
    await expect(body(primary)).toHaveValue(localSource)
    await expect(page.getByRole('heading', { name: 'Recover an unsaved draft', exact: true })).toHaveCount(0)

    await openWorkspaceDialog(page)
    await button(workspaceDialog(page), `Reopen Article ${tail.id}`).click()
    await expect(page).toHaveURL(editPath(tail.id))
    await press(page, tab(page, alternate, 'Pinned'))
    await expect(page).toHaveURL(editPath(alternate.id))
    await openWorkspaceDialog(page)
    await press(page, others)
    await expect(listedTabs).toHaveText(confirmedTargets)
    await expect(discard).not.toBeChecked()
    await dialog.getByText('Discard unsaved edits from this browser', { exact: true }).click()
    await expect(discard).toBeChecked()
    await button(dialog, 'Close tabs').click()
    await expect(page.getByText('Closed 2 tabs.', { exact: true })).toBeVisible()
    await expect(tabList(page).getByRole('tab')).toHaveCount(2)
    await expect(tab(page, alternate, 'Pinned')).toBeFocused()
    await expectSameEditor(body(secondary), secondNode)
    await openWorkspaceDialog(page)
    await button(workspaceDialog(page), `Reopen Article ${first.id}`).click()
    await expect(page).toHaveURL(editPath(first.id))
    await expectPane(primary, first, first.body, true)
    await expect(page.getByRole('heading', { name: 'Recover an unsaved draft', exact: true })).toHaveCount(0)
  } finally { await alternateNode.dispose() }
  observations.push({ cancelPreservesMixedBatch: true, abortedRecoveryReadPreservesMixedBatch: true,
    desktopCloseRightPreservesEarlierTabs: true, compactCloseOthersKeepsActiveDraft: true, closeBatchPreservesOtherGroup: true,
    confirmedMixedCloseRestoresRealRecoveryCopy: true, explicitMixedDiscardReopensDurableDraft: true })
}

function hasRecoveryCopy(page, id, body) {
  return page.evaluate(({ id, body }) => new Promise((resolve, reject) => {
    const open = indexedDB.open('fsusblog-v2-draft-recovery')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const get = db.transaction('recovery').objectStore('recovery').getAll()
      get.onerror = () => { db.close(); reject(get.error) }
      get.onsuccess = () => {
        const found = get.result.some(record => record.document === `article:${id}` && record.body === body)
        db.close()
        resolve(found)
      }
    }
  }), { id, body })
}

function abortDraftCopyDelete(page, id) {
  return page.evaluate(id => {
    const original = IDBObjectStore.prototype.delete
    IDBObjectStore.prototype.delete = function (key) {
      const result = original.call(this, key)
      if (this.name === 'recovery' && Array.isArray(key) && key[2] === `article:${id}`) {
        IDBObjectStore.prototype.delete = original
        const transaction = this.transaction
        transaction.addEventListener('abort', () => { document.documentElement.dataset.saveCleanupAborted = '1' }, { once: true })
        queueMicrotask(() => transaction.abort())
      }
      return result
    }
  }, id)
}

async function exerciseSaveAndClose(author) {
  const anchor = await createDraft(author, 'Save and close anchor', 'Current source remains open.')
  let first = await createDraft(author, 'First recovery cleanup draft', 'First original source.')
  let second = await createDraft(author, 'Second recovery cleanup draft', 'Second original source.')
  const interrupted = await createDraft(author, 'Draft with a lost receipt', 'Original source before the lost receipt.')
  const conflicting = await createDraft(author, 'Draft with a later conflict', 'Original source before the conflict.')
  const localText = draft => `${draft.body} Local edit.`
  const savePath = `${origin}${WireRoutes.Save}`
  const page = await author.newPage()
  monitor(page)
  const releaseLostReply = Promise.withResolvers()
  const others = button(page, 'Close other tabs')
  const anchorTab = tab(page, anchor, 'Pinned')
  const tabs = tabList(page).getByRole('tab')

  async function edit(draft) {
    await openById(page, draft.id, 'Open article')
    await expect(page).toHaveURL(editPath(draft.id))
    await expect(body(page)).toBeEditable()
    await body(page).fill(localText(draft))
    await expect(tab(page, draft, 'Unsaved')).toBeVisible()
  }

  async function chooseSave() {
    const dialog = page.getByRole('dialog', { name: 'Close tabs with unsaved edits?', exact: true })
    await expect(dialog).toHaveCount(0)
    if (!await others.isVisible()) await page.getByText('Tab actions', { exact: true }).click()
    await press(page, others)
    const option = 'Save drafts before closing'
    await dialog.getByText(option, { exact: true }).click()
    await expect(dialog.getByRole('radio', { name: option, exact: true })).toBeChecked()
    await button(dialog, 'Close tabs').click()
  }

  async function expectStored(draft, body, revision) {
    const stored = await readDraft(await author.request.get(draftPath(draft.id)))
    assert.deepEqual(stored, { ...draft, body, revision })
    return stored
  }

  const hasFirstRecoveryCopy = () => hasRecoveryCopy(page, first.id, localText(first))

  try {
    await page.goto(editPath(anchor.id))
    await expect(body(page)).toBeEditable()
    await pinArticle(page, anchor)
    await edit(first)
    await edit(second)
    await press(page, anchorTab)
    await expect(page).toHaveURL(editPath(anchor.id))
    await chooseSave()
    await expect(page.getByText('Closed 2 tabs.', { exact: true })).toBeVisible()
    await expect(tabs).toHaveCount(1)
    await expect(anchorTab).toBeFocused()
    await expect(page).toHaveURL(editPath(anchor.id))
    first = await expectStored(first, localText(first), first.revision + 1n)
    second = await expectStored(second, localText(second), second.revision + 1n)

    await edit(first)
    await edit(second)
    await press(page, anchorTab)
    await expect(page).toHaveURL(editPath(anchor.id))
    await expect.poll(hasFirstRecoveryCopy).toBe(true)
    await abortDraftCopyDelete(page, first.id)

    await chooseSave()
    await expect(page.locator('html')).toHaveAttribute('data-save-cleanup-aborted', '1')
    await expect(page.getByText(`Saved ${first.title}. Recovery cleanup for ${first.title} could not be confirmed. The tabs are still open.`,
      { exact: true })).toBeVisible()
    await expect(page).toHaveURL(editPath(anchor.id))
    await expect(others).toBeFocused()
    await expect(tabs).toHaveCount(3)
    await expect(tab(page, first, 'Recovery needed')).toBeVisible()
    await expect(tab(page, second, 'Unsaved')).toBeVisible()
    assert.equal(await hasFirstRecoveryCopy(), true)
    await expectStored(first, localText(first), first.revision + 1n)
    await expectStored(second, second.body, second.revision)

    await chooseSave()
    await expect(page.getByText('Closed 2 tabs.', { exact: true })).toBeVisible()
    await expect(tabs).toHaveCount(1)
    await expect(anchorTab).toBeFocused()
    await expect(page).toHaveURL(editPath(anchor.id))
    assert.equal(await hasFirstRecoveryCopy(), false)
    await expectStored(first, localText(first), first.revision + 1n)
    await expectStored(second, localText(second), second.revision + 1n)

    await edit(interrupted)
    await edit(conflicting)
    await press(page, anchorTab)
    await expect(page).toHaveURL(editPath(anchor.id))
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
    await expect(page.getByText(`Could not confirm the save for ${interrupted.title}. Retry the same save from its tab. The tabs are still open.`,
      { exact: true })).toBeVisible()
    await expect(body(page)).toBeEditable()
    await expect(page).toHaveURL(editPath(anchor.id))
    await expect(tab(page, interrupted, 'Recovery needed')).toBeVisible()
    await expect(tab(page, conflicting, 'Unsaved')).toBeVisible()
    assert.equal(requests.length, 1)
    await expectStored(interrupted, localText(interrupted), interrupted.revision + 1n)
    await expectStored(conflicting, conflicting.body, conflicting.revision)

    const remote = await saveDraft(author, conflicting, 'A newer server edit.')
    const [conflict] = await Promise.all([
      page.waitForResponse(response => response.url() === savePath && response.status() === 409),
      chooseSave(),
    ])
    const command = bytes => decodeArticleCommand(decodeFrame(bytes, FrameType.ArticleCommand).payload)
    assert.equal(command(conflict.request().postDataBuffer()).id, conflicting.id)
    assert.equal(command(requests[0]).id, interrupted.id)
    assert.equal(requests.length, 3)
    assert.deepEqual(requests[1], requests[0], 'A lost receipt must replay the identical command and idempotency key')
    await expect(page.getByText(`Saved ${interrupted.title}. ${conflicting.title} changed on the server. Reload its revision before saving. The tabs are still open.`,
      { exact: true })).toBeVisible()
    await expect(page).toHaveURL(editPath(anchor.id))
    await expect(others).toBeFocused()
    await expect(tabs).toHaveCount(3)
    await expect(tab(page, interrupted, 'Pinned')).toBeVisible()
    await expect(tab(page, conflicting, 'Conflict')).toBeVisible()
    await expectStored(interrupted, localText(interrupted), interrupted.revision + 1n)
    await expectStored(conflicting, remote.body, conflicting.revision + 1n)
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
  const page = await author.newPage()
  monitor(page)
  const close = button(page, `Close ${victim.title}`)
  const anchorTab = tab(page, anchor, 'Pinned')
  const dialog = page.getByRole('dialog', { name: 'Close tabs with unsaved edits?', exact: true })
  const draftCopy = value => hasRecoveryCopy(page, victim.id, value)
  const recent = button(page, `Reopen Article ${victim.id}`)

  async function openCloseDialog() {
    await expect(dialog).toHaveCount(0)
    await press(page, close)
    await expect(dialog).toBeVisible()
  }

  async function confirmClose(option) {
    await openCloseDialog()
    await dialog.getByText(option, { exact: true }).click()
    await expect(dialog.getByRole('radio', { name: option, exact: true })).toBeChecked()
    await button(dialog, 'Close tabs').click()
  }

  async function assertStillOpen(state, value) {
    await expect(page).toHaveURL(editPath(victim.id))
    await expect(tab(page, victim, state)).toHaveAttribute('aria-selected', 'true')
    await expect(body(page)).toHaveValue(value)
    await expect(close).toBeFocused()
    await expect(tabList(page).getByRole('tab')).toHaveCount(2)
    assert.equal(await draftCopy(value), true)
  }

  try {
    await page.goto(editPath(anchor.id))
    await expect(body(page)).toBeEditable()
    await pinArticle(page, anchor)
    await openById(page, victim.id, 'Open article')
    await expect(page).toHaveURL(editPath(victim.id))
    await expect(body(page)).toBeEditable()
    await body(page).fill(local)
    await expect.poll(() => draftCopy(local)).toBe(true)

    await openCloseDialog()
    await button(dialog, 'Keep writing').click()
    await expect(dialog).toHaveCount(0)
    await assertStillOpen('Unsaved', local)

    await abortDraftCopyDelete(page, victim.id)
    const discard = 'Discard unsaved edits from this browser'
    await confirmClose(discard)
    await expect(page.locator('html')).toHaveAttribute('data-save-cleanup-aborted', '1')
    await expect(page.getByText('Could not discard the recovery copies. The tabs are still open.', { exact: true })).toBeVisible()
    await assertStillOpen('Unsaved', local)

    await confirmClose(discard)
    await expect(page).toHaveURL(editPath(anchor.id))
    await expect(anchorTab).toBeFocused()
    await expect(tabList(page).getByRole('tab')).toHaveCount(1)
    assert.equal(await draftCopy(local), false)
    await openWorkspaceDialog(page)
    await recent.click()
    await expect(page).toHaveURL(editPath(victim.id))
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
      assert.equal(real.status(), 200)
      const stored = decodeDraft(decodeFrame(await real.body(), FrameType.Draft).payload)
      assert.equal(stored.title, victim.title)
      assert.equal(stored.body, savedSource)
      assert.equal(stored.revision, victim.revision + 1n)
      const wrong = saves.length === 1 ? { ...stored, title: `${stored.title} incorrect` } : { ...stored, body: 'Incorrect source.' }
      const headers = real.headers()
      delete headers['content-length']
      delete headers['content-encoding']
      await route.fulfill({ response: real, headers, body: Buffer.from(encodeFrame(FrameType.Draft, encodeDraft(wrong))) })
      await real.dispose()
    })
    const option = 'Save drafts before closing'
    const failure = `Could not confirm the save for ${victim.title}. Retry the same save from its tab. The tabs are still open.`
    for (const expected of [1, 2]) {
      const [reply] = await Promise.all([
        page.waitForResponse(response => response.url() === savePath && response.request().method() === 'POST'),
        confirmClose(option),
      ])
      assert.equal(reply.status(), 200)
      const returned = decodeDraft(decodeFrame(await reply.body(), FrameType.Draft).payload)
      assert.deepEqual(returned, { ...victim, revision: victim.revision + 1n,
        title: expected === 1 ? `${victim.title} incorrect` : victim.title,
        body: expected === 1 ? savedSource : 'Incorrect source.' })
      assert.equal(saves.length, expected)
      await expect(page.getByText(failure, { exact: true })).toBeVisible()
      await assertStillOpen('Recovery needed', savedSource)
    }
    await confirmClose(option)
    await expect(page).toHaveURL(editPath(anchor.id))
    await expect(anchorTab).toBeFocused()
    await expect(tabList(page).getByRole('tab')).toHaveCount(1)
    assert.equal(saves.length, 3)
    assert.deepEqual(saves[1], saves[0])
    assert.deepEqual(saves[2], saves[0])
    assert.equal(await draftCopy(savedSource), false)
    assert.deepEqual(await readDraft(await author.request.get(draftPath(victim.id))), {
      ...victim, body: savedSource, revision: victim.revision + 1n,
    })
    if (!await recent.isVisible()) await openWorkspaceDialog(page)
    await recent.click()
    await expect(page).toHaveURL(editPath(victim.id))
    await expect(title(page)).toHaveValue(victim.title)
    await expect(body(page)).toHaveValue(savedSource)
    await expect(page.getByRole('heading', { name: 'Recover an unsaved draft', exact: true })).toHaveCount(0)
    await press(page, close)
    await expect(page).toHaveURL(editPath(anchor.id))
    const removed = await submitArticle(author.request, origin + WireRoutes.Delete, {
      id: victim.id, expectedRevision: victim.revision + 1n, title: '', body: '',
    })
    assert.equal(removed.status(), 200)
    decodeFrame(await removed.body(), FrameType.EmptySuccess)
    if (!await recent.isVisible()) await openWorkspaceDialog(page)
    const denied = page.waitForResponse(response => response.url() === draftPath(victim.id))
    await press(page, recent)
    assert.equal((await denied).status(), 404)
    await expect(page.getByText('The article is unavailable.', { exact: true })).toBeVisible()
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

async function changeGroupLayout(page, readLayout, before, command, expected) {
  const action = button(page, command)
  if (!await action.isVisible()) await openWorkspaceDialog(page)
  const sameGroup = before.focusedGroup === 0 ? 'Move to primary group' : 'Move to secondary group'
  await expect(button(page, sameGroup)).toBeDisabled()
  await expect(action).toBeEnabled()
  const receiptPromise = page.waitForResponse(response => response.url() === groupsPath && response.request().method() === 'POST')
  await press(page, action)
  const receipt = await decodeSavedGroups(await receiptPromise)
  assert.equal(receipt.revision, before.revision + 1n)
  assert.deepEqual(coordinates(receipt), expected)
  assert.deepEqual(await readLayout(), receipt)
  return receipt
}

async function expectHiddenEditor(handle) {
  assert.deepEqual(await handle.evaluate(element => ({ connected: element.isConnected, hidden: element.getClientRects().length === 0 })),
    { connected: true, hidden: true })
}

async function exerciseGroupActions({ page, readLayout, first, alternate, second, secondaryPreview }) {
  const primary = group(page, 'Primary')
  const secondary = group(page, 'Secondary')
  const mainSlots = [first.id, -alternate.id]
  const movedSlots = [second.id, secondaryPreview.id]

  async function activate(draft, state, currentGroup, slots) {
    await tab(page, draft, state).click()
    await expect(page).toHaveURL(editPath(draft.id))
    await expectPane(currentGroup, draft, draft.body, true)
    await expect.poll(async () => coordinates(await readLayout())).toEqual(slots)
    return readLayout()
  }

  const initial = { primary: mainSlots, secondary: [second.id, -secondaryPreview.id], secondaryActive: second.id, focusedGroup: 0 }
  await activate(alternate, 'Preview', primary, { ...initial, primaryActive: alternate.id })
  await activate(first, 'Pinned', primary, { ...initial, primaryActive: first.id })
  let saved = await activate(secondaryPreview, 'Preview', secondary, {
    primary: mainSlots, secondary: [second.id, -secondaryPreview.id],
    primaryActive: first.id, secondaryActive: secondaryPreview.id, focusedGroup: 1,
  })
  await expectPane(primary, first, first.body, false)
  const firstEditor = await body(primary).elementHandle()
  const movingEditor = await body(secondary).elementHandle()
  assert(firstEditor && movingEditor)
  saved = await changeGroupLayout(page, readLayout, saved, 'Move to primary group', {
    primary: [...mainSlots, secondaryPreview.id], secondary: [second.id],
    primaryActive: secondaryPreview.id, secondaryActive: 0, focusedGroup: 0,
  })
  await expect(page).toHaveURL(editPath(secondaryPreview.id))
  await expectPane(primary, secondaryPreview, secondaryPreview.body, true)
  await expect(body(primary)).toBeFocused()
  await expect(tab(page, secondaryPreview, 'Pinned')).toHaveAttribute('aria-selected', 'true')
  await expectSameEditor(body(primary), movingEditor)
  await expectHiddenEditor(firstEditor)
  await capture(page, 'workspace-split-moved')

  const bothSelected = {
    primary: mainSlots, secondary: movedSlots, primaryActive: first.id, secondaryActive: secondaryPreview.id, focusedGroup: 1,
  }
  saved = await changeGroupLayout(page, readLayout, saved, 'Move to secondary group', bothSelected)
  await expect(page).toHaveURL(editPath(secondaryPreview.id))
  await expectPane(secondary, secondaryPreview, secondaryPreview.body, true)
  await expect(body(secondary)).toBeFocused()
  await expectPane(primary, first, first.body, false)
  await expectSameEditor(body(secondary), movingEditor)
  await expectSameEditor(body(primary), firstEditor)
  await body(secondary).press('End')
  await body(secondary).press('Shift+ArrowLeft')
  const caret = await selection(body(secondary))
  assert.deepEqual(caret, [secondaryPreview.body.length - 1, secondaryPreview.body.length])
  const wide = page.viewportSize()
  assert(wide)
  const overflow = page.getByRole('region', { name: 'Article tabs', exact: true })
  async function moveBackground(to, slots, compact = false) {
    const chooser = button(page, compact ? 'Switch article tab' : 'More tabs (4)')
    await press(page, chooser)
    if (compact) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375)
    const action = button(overflow, `Move ${alternate.title} to ${to} group`)
    await expect(action).toBeEnabled()
    const pending = page.waitForResponse(response => response.url() === groupsPath && response.request().method() === 'POST')
    await press(page, action)
    const receipt = await decodeSavedGroups(await pending)
    assert.equal(receipt.revision, saved.revision + 1n)
    assert.deepEqual(coordinates(receipt), slots)
    assert.deepEqual(await readLayout(), receipt)
    await expect(chooser).toHaveAttribute('aria-expanded', 'false')
    await expect(chooser).toBeFocused()
    await expect(page).toHaveURL(editPath(secondaryPreview.id))
    if (compact) await expectHiddenEditor(firstEditor)
    else {
      await expect(tab(page, secondaryPreview, 'Pinned')).toHaveAttribute('aria-selected', 'true')
      await expect(tab(page, alternate, 'Preview')).toHaveAttribute('aria-selected', 'false')
      await expectSameEditor(body(primary), firstEditor)
    }
    await expectSameEditor(body(secondary), movingEditor)
    assert.deepEqual(await selection(body(secondary)), caret)
    return receipt
  }
  saved = await moveBackground('secondary', { ...bothSelected, primary: [first.id], secondary: [...movedSlots, -alternate.id] })
  await page.setViewportSize({ width: 375, height: 850 })
  saved = await moveBackground('primary', bothSelected, true)
  await page.setViewportSize(wide)
  await expectPane(primary, first, first.body, false)
  await expectSameEditor(body(primary), firstEditor)
  observations.push({ backgroundPreviewMovesBothWays: true, backgroundMovePreservesOpenEditorsAndSelection: true,
    backgroundMoveRevision: saved.revision.toString() })
  await body(secondary).press('ArrowRight')
  assert.deepEqual(await selection(body(secondary)), [secondaryPreview.body.length, secondaryPreview.body.length])
  await firstEditor.dispose()

  const firstPreviewSelected = { ...bothSelected, primaryActive: alternate.id, focusedGroup: 0 }
  saved = await activate(alternate, 'Preview', primary, firstPreviewSelected)
  const previewEditor = await body(primary).elementHandle()
  assert(previewEditor)
  saved = await changeGroupLayout(page, readLayout, saved, 'Move to secondary group', {
    primary: [first.id], secondary: [...movedSlots, -alternate.id],
    primaryActive: 0, secondaryActive: alternate.id, focusedGroup: 1,
  })
  await expect(page).toHaveURL(editPath(alternate.id))
  await expectPane(secondary, alternate, alternate.body, true)
  await expect(tab(page, alternate, 'Preview')).toHaveAttribute('aria-selected', 'true')
  await expectSameEditor(body(secondary), previewEditor)
  await expectHiddenEditor(movingEditor)
  saved = await changeGroupLayout(page, readLayout, saved, 'Move to primary group', firstPreviewSelected)
  await expect(page).toHaveURL(editPath(alternate.id))
  await expectPane(primary, alternate, alternate.body, true)
  await expectSameEditor(body(primary), previewEditor)

  saved = await activate(secondaryPreview, 'Pinned', secondary, { ...firstPreviewSelected, focusedGroup: 1 })
  await expectPane(primary, alternate, alternate.body, false)
  await expectSameEditor(body(primary), previewEditor)
  await expectSameEditor(body(secondary), movingEditor)
  const beforeUnpin = saved.revision
  await button(page, `Unpin ${second.title}`).click()
  await expect(tab(page, second, 'Preview')).toBeVisible()
  await expect.poll(async () => coordinates(await readLayout())).toEqual({
    ...firstPreviewSelected, secondary: [-second.id, secondaryPreview.id], focusedGroup: 1,
  })
  saved = await readLayout()
  assert.equal(saved.revision, beforeUnpin + 1n)
  const suffix = ' Local draft across group merge.'
  await body(secondary).press('End')
  await page.keyboard.insertText(suffix)
  const unsavedSource = secondaryPreview.body + suffix
  await expect(body(secondary)).toHaveValue(unsavedSource)
  await body(secondary).press('Shift+ArrowLeft')
  const selectedBeforeMerge = await selection(body(secondary))
  assert.deepEqual(selectedBeforeMerge, [unsavedSource.length - 1, unsavedSource.length])
  const merged = await changeGroupLayout(page, readLayout, saved, 'Merge groups', {
    primary: [...mainSlots, ...movedSlots], secondary: [],
    primaryActive: secondaryPreview.id, secondaryActive: 0, focusedGroup: 0,
  })
  await expect(page).toHaveURL(editPath(secondaryPreview.id))
  await expect(tab(page, secondaryPreview, 'Unsaved')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, alternate, 'Preview')).toBeVisible()
  await expect(tab(page, second, 'Pinned')).toBeVisible()
  await expectPane(primary, secondaryPreview, unsavedSource, true)
  await expect(body(primary)).toBeFocused()
  assert.deepEqual(await selection(body(primary)), selectedBeforeMerge)
  await expect(secondary).toHaveCount(0)
  await expect(page.locator('.el-markdown-editor')).toHaveCount(2)
  await expectSameEditor(body(primary), movingEditor)
  await expectHiddenEditor(previewEditor)
  const storedDraft = await page.request.get(draftPath(secondaryPreview.id))
  assert.equal(storedDraft.status(), 200)
  assert.deepEqual(decodeDraft(decodeFrame(await storedDraft.body(), FrameType.Draft).payload), secondaryPreview)
  await capture(page, 'workspace-split-merged')
  await previewEditor.dispose()
  await movingEditor.dispose()

  observations.push({ movesPreserveExactRouteAndEditors: true, occupiedPreviewPromoted: true, emptyPreviewSlotKeepsPreview: true,
    mergePromotesIncomingPreview: true, mergePreservesFocusAndUnsavedSource: true, mergeKeepsOtherEditorMounted: true,
    groupChangesPersistAtomically: true,
    mergedRevision: merged.revision.toString() })
}

async function exerciseSavedWorkspace({ author, session, outsider, outsiderSession, first, alternate, second }) {
  const viewport = { width: 1366, height: 900 }
  const cookies = await author.cookies()
  const secondaryPreview = await createDraft(author, 'Another secondary workspace draft', 'Another secondary server source.')
  const writerContext = await browser.newContext({ viewport })
  const reopenedContext = await browser.newContext({ viewport })
  const verificationContext = await browser.newContext({ viewport })
  try {
    for (const context of [writerContext, reopenedContext, verificationContext]) await context.addCookies(cookies)
    const writer = await writerContext.newPage()
    monitor(writer)
    await writer.goto(workspacePath)
    await expect(writer.getByText('Open an article or start a new draft.', { exact: true })).toBeVisible()
    await openById(writer, first.id, 'Open article')
    await expect(writer).toHaveURL(editPath(first.id))
    await button(writer, `Pin ${first.title}`).click()
    await openById(writer, alternate.id, 'Open article')
    await expect(writer).toHaveURL(editPath(alternate.id))
    await tab(writer, first, 'Pinned').click()
    await expect(writer).toHaveURL(editPath(first.id))
    await openById(writer, second.id)
    await expect(writer).toHaveURL(editPath(second.id))
    await button(writer, `Pin ${second.title}`).click()
    await openById(writer, secondaryPreview.id, 'Open article')
    await expect(writer).toHaveURL(editPath(secondaryPreview.id))
    await tab(writer, second, 'Pinned').click()
    await expect(writer).toHaveURL(editPath(second.id))

    await expect.poll(async () => coordinates(await savedGroups(writerContext, session))).toEqual({
      primary: [first.id, -alternate.id], secondary: [second.id, -secondaryPreview.id],
      primaryActive: first.id, secondaryActive: second.id, focusedGroup: 1,
    })
    const persisted = await savedGroups(writerContext, session)
    assert(persisted.revision > 0n && persisted.updatedAtUnixMs > 0n)

    // Fresh storage contexts have only cookies. The exact layout must be read from PostgreSQL.
    const reopened = await reopenedContext.newPage()
    monitor(reopened)
    const lateDraft = await holdDraft(reopened, second.id)
    try {
      assert.deepEqual(await enterSavedWorkspace(reopened), persisted)
      assert.equal(await lateDraft.status(), 200)
      await expect(reopened).toHaveURL(workspacePath)
      await expect(reopened.locator('.el-markdown-editor')).toHaveCount(0)
    } finally {
      await lateDraft.release()
    }
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
    await expect(reopened.getByText('Layout changes stay in this tab while offline. Reload the workspace to resume saving layouts.',
      { exact: true })).toBeVisible()
    assert.deepEqual(await savedGroups(writerContext, session), persisted)
    await reopenedContext.setOffline(false)
    await reopened.waitForFunction(() => navigator.onLine)
    await expect(tab(reopened, secondaryPreview, 'Preview')).toHaveCount(0)
    // The normal router leave awaits the layout flush after the network has returned.
    await button(reopened, 'More actions').click()
    await reopened.getByRole('menuitem', { name: 'Canvases', exact: true }).click()
    await expect(reopened).toHaveURL(`${origin}/user/manage/canvas`)
    assert.deepEqual(offlinePosts, [], 'Reconnection and route flush must never replay a local offline layout change')
    assert.deepEqual(await savedGroups(writerContext, session), persisted)
    const verified = await verificationContext.newPage()
    monitor(verified)
    assert.deepEqual(await enterSavedWorkspace(verified), persisted)
    await expectRestored(verified, first, alternate, second, secondaryPreview)

    const other = await outsider.newPage()
    monitor(other)
    const wrongSession = await outsider.request.get(groupsPath, { headers: { [WireHeaders.CurrentSession]: session } })
    assert.equal(wrongSession.status(), 409)
    const otherLayout = await savedGroups(outsider, outsiderSession)
    assert.equal(otherLayout.revision, 0n)
    assert.deepEqual(coordinates(otherLayout), { primary: [], secondary: [], primaryActive: 0, secondaryActive: 0, focusedGroup: 0 })
    assert.deepEqual(await enterSavedWorkspace(other), otherLayout)
    await expect(other).toHaveURL(workspacePath)
    await expect(other.getByText('Open an article or start a new draft.', { exact: true })).toBeVisible()
    await expect(other.locator('.el-markdown-editor')).toHaveCount(0)
    await expect(tabList(other)).toHaveCount(0)
    await other.close()
    observations.push({ persistedWorkspaceFromEmptyBrowserStorage: true, exactStoredGroupOrderAndFocus: true, restoreWaitsForRealDraft: true,
      offlineChangesDoNotReplay: true, otherAuthorHasIndependentWorkspace: true, storedRevision: persisted.revision.toString() })
    await exerciseGroupActions({ page: verified, readLayout: () => savedGroups(writerContext, session), first, alternate, second, secondaryPreview })
  } finally {
    await verificationContext.close()
    await reopenedContext.close()
    await writerContext.close()
  }
}

let failure
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME })
try {
  const author = await browser.newContext({ viewport: { width: 1366, height: 900 } })
  const outsider = await browser.newContext()
  const session = await signIn(author, process.env.FSUSBLOG_TEST_TICKET)
  const outsiderSession = await signIn(outsider, process.env.FSUSBLOG_TEST_OUTSIDER_TICKET)
  const first = await createDraft(author, 'Primary workspace draft', 'Primary server source.')
  const second = await createDraft(author, 'Secondary workspace draft', '# Secondary first heading\n\nSecondary server source.\n\n## Secondary last heading')
  const nativePageZoom = await exerciseNativePageZoom(author, first, second)
  const alternate = await createDraft(author, 'Another primary workspace draft', 'Another primary server source.')
  const foreign = await createDraft(outsider, 'Private draft from another author', 'Private source from another author.')
  const localSuffix = ' Local unsaved source.'
  const localSource = first.body + localSuffix
  const page = await author.newPage()
  monitor(page)
  await page.goto(editPath(first.id))
  await expect(page.getByRole('heading', { name: 'Edit article', exact: true })).toBeVisible()
  await expect(page.locator('.el-markdown-editor')).toBeVisible()
  await expect(body(page)).toHaveValue(first.body)
  await expect(body(page)).toBeEditable()
  const firstNode = await body(page).elementHandle()
  assert(firstNode)
  await body(page).press('End')
  await page.keyboard.insertText(localSuffix)
  await expect(body(page)).toHaveValue(localSource)
  await body(page).press('Shift+ArrowLeft')
  const firstSelection = await selection(body(page))
  assert.deepEqual(firstSelection, [localSource.length - 1, localSource.length])

  const primary = group(page, 'Primary')
  const secondary = group(page, 'Secondary')
  const denied = page.waitForResponse(response => response.url() === draftPath(foreign.id))
  await openById(page, foreign.id)
  assert.equal((await denied).status(), 404)
  await expect(page.getByText('The article is unavailable.', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(editPath(first.id))
  await expect(secondary).toHaveCount(0)
  await expect(separator(page)).toHaveCount(0)
  await expect(page.locator('.el-markdown-editor')).toHaveCount(1)
  await expect(body(page)).toHaveValue(localSource)
  await expectSameEditor(body(page), firstNode)

  const pending = await holdDraft(page, second.id)
  try {
    await openById(page, second.id)
    assert.equal(await pending.status(), 200, 'The suspended response must be a real authorized draft receipt')
    await expect(page).toHaveURL(editPath(first.id))
    await expect(secondary).toHaveCount(0)
    await expect(page.locator('.el-markdown-editor')).toHaveCount(1)
    await expect(body(page)).toHaveValue(localSource)
  } finally {
    await pending.release()
  }
  await expect(page).toHaveURL(editPath(second.id))
  await expectPane(primary, first, localSource, false)
  await expectPane(secondary, second, second.body, true)
  await expect(page.locator('.el-markdown-editor')).toHaveCount(2)
  await expectSameEditor(body(primary), firstNode)
  const secondNode = await body(secondary).elementHandle()
  assert(secondNode)
  const left = await primary.boundingBox()
  const right = await secondary.boundingBox()
  assert(left && right)
  assert(left.width > 360 && right.width > 360, 'Both desktop groups must have usable widths')
  assert(left.x + left.width <= right.x + 2, 'Desktop groups must be side by side')
  await body(secondary).press('End')
  await body(secondary).press('Shift+ArrowLeft')
  const secondSelection = await selection(body(secondary))
  assert.deepEqual(secondSelection, [second.body.length - 1, second.body.length])
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
  await press(page, button(primary, 'Edit in this group'))
  await expect(page).toHaveURL(editPath(first.id))
  await expect(headings).toBeHidden()
  await expect(button(primary, 'Outline')).toHaveAttribute('aria-expanded', 'false')
  await press(page, button(secondary, 'Edit in this group'))
  await expect(page).toHaveURL(editPath(second.id))
  await expect(lastHeading).toBeVisible()
  await expect(lastHeading).toHaveAttribute('tabindex', '0')
  await expect(body(secondary)).toBeFocused()
  await press(page, button(page.getByRole('complementary', { name: 'Article outline' }), 'Close'))
  await expect(headings).toBeHidden()
  await expect(button(secondary, 'Outline')).toHaveAttribute('aria-expanded', 'false')
  observations.push({ mountedGroupOutlineAndHeadingRetained: true, groupActivationKeepsEditorFocus: true })

  await press(page, button(primary, 'Edit in this group'))
  await expect(page).toHaveURL(editPath(first.id))
  await expectPane(primary, first, localSource, true)
  await expectPane(secondary, second, second.body, false)
  await expect(body(primary)).toBeFocused()
  await expectSameEditor(body(primary), firstNode)
  assert.deepEqual(await selection(body(primary)), firstSelection)
  await expectSameEditor(body(secondary), secondNode)

  let minimum = splitter.pointerPercent + 1
  for (const width of [1040, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(async () => Number(await separator(page).getAttribute('aria-valuemin'))).toBeGreaterThanOrEqual(minimum)
    await expectPane(primary, first, localSource, true)
    await expectPane(secondary, second, second.body, false)
    await expectSameEditor(body(primary), firstNode)
    await expectSameEditor(body(secondary), secondNode)
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
    await expect(page.getByText('Equalize group widths', { exact: true })).toHaveCount(0)
    await expect(body(primary)).toBeFocused()
    await expectSameEditor(body(primary), firstNode)
    assert.equal(await secondNode.evaluate(element => element.isConnected), true, `Collapse at ${width}px must retain the second editor`)
    assert.deepEqual(await selection(body(primary)), firstSelection)
    checkedViewports.push({ ...await pageWidths(page), groups: 1 })
  }
  await press(page, button(page, 'Focus secondary group'), 'Space')
  await expect(page).toHaveURL(editPath(second.id))
  await expect(primary).toBeHidden()
  await expectPane(secondary, second, second.body, true)
  await expect(body(secondary)).toBeFocused()
  assert.equal(await firstNode.evaluate(element => element.isConnected), true, 'Changing mobile focus must retain the first editor')
  await expectSameEditor(body(secondary), secondNode)
  await capture(page, 'workspace-split-mobile')

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', 'dark')
  await expectPane(primary, first, localSource, false)
  await expectPane(secondary, second, second.body, true)
  await expectSameEditor(body(primary), firstNode)
  await expectSameEditor(body(secondary), secondNode)
  assert.deepEqual(await selection(body(secondary)), secondSelection)
  const at1440 = await splitGeometry(page, primary, secondary)
  assert.equal(at1440.values.now, splitter.pointerPercent)
  checkedViewports.push({ ...await pageWidths(page), groups: 2, primaryPercent: at1440.values.now, theme: 'dark', reducedMotion: true })
  await capture(page, 'workspace-split-dark-1440')
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })

  await page.setViewportSize({ width: 1366, height: 900 })
  await expectPane(primary, first, localSource, false)
  await expectPane(secondary, second, second.body, true)
  await expectSameEditor(body(primary), firstNode)
  await expectSameEditor(body(secondary), secondNode)
  await expect(separator(page)).toHaveAttribute('aria-valuenow', String(splitter.pointerPercent))
  const restored = await splitGeometry(page, primary, secondary)
  for (const [index, width] of [restored.left.width, restored.right.width].entries())
    assert(Math.abs(width - splitter.pointerPaneWidths[index]) <= 1)
  assert.deepEqual(await selection(body(secondary)), secondSelection)

  await press(page, button(primary, 'Edit in this group'))
  await expect(page).toHaveURL(editPath(first.id))
  await expect(body(primary)).toBeFocused()
  assert.deepEqual(await selection(body(primary)), firstSelection)
  await body(primary).press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect(body(primary)).toHaveValue(first.body)
  await body(primary).press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z')
  await expect(body(primary)).toHaveValue(localSource)
  await expect(body(secondary)).toHaveValue(second.body)
  await press(page, button(secondary, 'Edit in this group'))
  await expect(page).toHaveURL(editPath(second.id))
  await expect(body(secondary)).toBeFocused()
  assert.deepEqual(await selection(body(secondary)), secondSelection)

  const savedSecondSuffix = ' Saved in the secondary group.'
  await body(secondary).press('ArrowRight')
  await expect.poll(() => selection(body(secondary))).toEqual([second.body.length, second.body.length])
  await page.keyboard.insertText(savedSecondSuffix)
  await expect(body(secondary)).toHaveValue(second.body + savedSecondSuffix)
  const save = page.waitForResponse(response => response.url() === `${origin}${WireRoutes.Save}` &&
    response.request().method() === 'POST')
  await button(page, 'Save draft').click()
  const receipt = await save
  assert.equal(receipt.status(), 200)
  const savedSecond = decodeDraft(decodeFrame(await receipt.body(), FrameType.Draft).payload)
  assert.equal(savedSecond.id, second.id)
  assert(savedSecond.revision > second.revision)
  assert.equal(savedSecond.body, second.body + savedSecondSuffix)
  await expectPane(primary, first, localSource, false)
  await expectPane(secondary, savedSecond, savedSecond.body, true)
  await expectSameEditor(body(secondary), secondNode)
  const storedFirst = await author.request.get(draftPath(first.id))
  assert.equal(storedFirst.status(), 200)
  assert.deepEqual(decodeDraft(decodeFrame(await storedFirst.body(), FrameType.Draft).payload), first)

  // An inactive tab already owned by the primary group must reopen there despite the opposite target.
  await press(page, button(primary, 'Edit in this group'))
  await expect(page).toHaveURL(editPath(first.id))
  await openById(page, alternate.id, 'Open article')
  await expect(page).toHaveURL(editPath(alternate.id))
  await expectPane(primary, alternate, alternate.body, true)
  await expectPane(secondary, savedSecond, savedSecond.body, false)
  await openById(page, first.id)
  await expect(page).toHaveURL(editPath(first.id))
  await expectPane(primary, first, localSource, true)
  await expectPane(secondary, savedSecond, savedSecond.body, false)
  await expectSameEditor(body(secondary), secondNode)
  await expect(page.getByRole('main').getByRole('textbox', { name: 'Body', exact: true })).toHaveCount(2)
  const tail = await createDraft(author, 'Last primary workspace draft', 'Last primary server source.')
  await exerciseTabClose({ page, first, localSource, alternate, tail, second: savedSecond, secondNode })
  const reopenedFirstNode = await body(primary).elementHandle()
  assert(reopenedFirstNode)

  await exerciseSavedWorkspace({ author, session, outsider, outsiderSession, first, alternate, second: savedSecond })
  await exerciseSaveAndClose(author)
  await exerciseSingleDirtyClose(author)

  // Replacing the current credential must invalidate both hosts, including the unfocused one.
  await author.addCookies(await outsider.cookies())
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')))
  await expect.poll(() => reopenedFirstNode.evaluate(element => element.isConnected)).toBe(false)
  await expect.poll(() => secondNode.evaluate(element => element.isConnected)).toBe(false)
  await expect(page.getByRole('main').getByRole('textbox', { name: 'Body', exact: true })).toHaveCount(0)
  await firstNode.dispose()
  await reopenedFirstNode.dispose()
  await secondNode.dispose()

  observations.push({ realDeniedDraft: true, waitsForRealReceipt: true, twoDistinctSourceEditors: true,
    exactEditorNodesAcrossFocusAndCollapse: true, focusedOnlyWrites: true, selectionAndIndependentUndo: true,
    exactFocusedSaveReceipt: true, duplicateKeepsOwningGroup: true, keyboardCompactSwitch: true, identityInvalidatesBothEditors: true,
    wideViewport: 1366, compactViewport: 375, paneWidths: [left.width, right.width],
    splitter: { ...splitter, clampedPercentAt1040: checkedViewports.find(check => check.viewport === 1040).primaryPercent,
      restoredPaneWidths: [restored.left.width, restored.right.width], checkedViewports, nativePageZoom } })
  assert.deepEqual(diagnostics, [])
} catch (error) {
  failure = error
} finally {
  await browser.close()
  await writeFile(join(evidence, 'workspace-split-result.json'), JSON.stringify({ observations, diagnostics,
    ...(failure && { failure: String(failure) }) }, null, 2))
}
if (failure) throw failure

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import {
  decodeAuthoringWorkspaceGroups, decodeDraft, encodeArticleCommand, encodeSignIn, FrameType, WireHeaders, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'

const { chromium, expect } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const workspacePath = `${origin}/user/manage/article/workspace`
const groupsPath = `${origin}${WireRoutes.AuthoringWorkspaceGroups}`
const editPath = id => `${origin}/user/manage/article/edit/${id}`
const draftPath = id => `${origin}${WireRoutes.Draft.replace('{id:int}', String(id))}`
const binary = { 'Content-Type': 'application/octet-stream' }
const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const body = scope => scope.getByRole('textbox', { name: 'Body', exact: true })
const title = scope => scope.getByRole('textbox', { name: 'Title', exact: true })
const group = (page, name) => page.getByRole('main').getByRole('region', { name: `${name} article group`, exact: true })
const tabList = page => page.getByRole('tablist', { name: 'Open articles' })
const tab = (page, draft, state) => tabList(page).getByRole('tab', { name: `${draft.title} · ${state}`, exact: true })
const selection = locator => locator.evaluate(element => [element.selectionStart, element.selectionEnd])
const observations = []
const diagnostics = []

async function signIn(context, ticket) {
  assert(ticket, 'A scratch author ticket is required')
  const response = await context.request.post(`${origin}${WireRoutes.SignIn}`, { headers: binary,
    data: Buffer.from(encodeFrame(FrameType.OperatorSignIn, encodeSignIn({ ticket }))) })
  assert.equal(response.status(), 200)
  const session = response.headers()[WireHeaders.CurrentSession.toLowerCase()]
  assert(session, 'Sign-in must bind workspace reads to the issued authoring session')
  return session
}

async function createDraft(context, title, body) {
  const response = await context.request.post(`${origin}${WireRoutes.Save}`, { headers: binary,
    data: Buffer.from(encodeFrame(FrameType.ArticleCommand, encodeArticleCommand({ id: 0, expectedRevision: 0n,
      idempotencyKey: randomUUID(), title, body }))) })
  assert.equal(response.status(), 200)
  return decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload)
}

async function openById(page, id, command = 'Open in other group') {
  await page.getByLabel('Article ID', { exact: true }).fill(String(id))
  await button(page, command).click()
}

function monitor(page) {
  page.on('pageerror', error => diagnostics.push(error.message))
  page.on('console', entry => {
    if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) diagnostics.push(entry.text())
  })
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

async function holdDraft(page, id) {
  const reached = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const finished = Promise.withResolvers()
  let started = false
  await page.route(draftPath(id), async route => {
    started = true
    try {
      const real = await route.fetch({ maxRetries: 0, maxRedirects: 0 })
      reached.resolve(real.status())
      await resume.promise
      await route.fulfill({ response: real })
    } catch (error) {
      reached.resolve(error)
    } finally {
      finished.resolve()
    }
  }, { times: 1 })
  return {
    async status() {
      const expiry = new AbortController()
      try { return await Promise.race([reached.promise, delay(8_000, 'draft request did not arrive', { signal: expiry.signal })]) }
      finally { expiry.abort() }
    },
    async release() {
      resume.resolve()
      if (started) await finished.promise
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

    const coordinates = snapshot => ({ primary: snapshot.tabs, secondary: snapshot.secondaryTabs,
      primaryActive: snapshot.activeArticleId, secondaryActive: snapshot.secondaryActiveArticleId, focusedGroup: snapshot.focusedGroup })
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
    await reopened.getByRole('link', { name: 'Canvases', exact: true }).click()
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
  const second = await createDraft(author, 'Secondary workspace draft', 'Secondary server source.')
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
  await capture(page, 'workspace-split-desktop')

  await press(page, button(primary, 'Edit in this group'))
  await expect(page).toHaveURL(editPath(first.id))
  await expectPane(primary, first, localSource, true)
  await expectPane(secondary, second, second.body, false)
  await expect(body(primary)).toBeFocused()
  await expectSameEditor(body(primary), firstNode)
  assert.deepEqual(await selection(body(primary)), firstSelection)
  await expectSameEditor(body(secondary), secondNode)
  await body(primary).press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect(body(primary)).toHaveValue(first.body)
  await body(primary).press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z')
  await expect(body(primary)).toHaveValue(localSource)
  await expect(body(secondary)).toHaveValue(second.body)

  await page.setViewportSize({ width: 375, height: 850 })
  await expect(primary).toBeVisible()
  await expect(secondary).toBeHidden()
  assert.equal(await secondNode.evaluate(element => element.isConnected), true, 'Responsive collapse must retain the second editor')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375)
  await press(page, button(page, 'Focus secondary group'), 'Space')
  await expect(page).toHaveURL(editPath(second.id))
  await expect(primary).toBeHidden()
  await expectPane(secondary, second, second.body, true)
  await expect(body(secondary)).toBeFocused()
  assert.equal(await firstNode.evaluate(element => element.isConnected), true, 'Changing mobile focus must retain the first editor')
  await expectSameEditor(body(secondary), secondNode)
  await capture(page, 'workspace-split-mobile')

  await page.setViewportSize({ width: 1366, height: 900 })
  await expectPane(primary, first, localSource, false)
  await expectPane(secondary, second, second.body, true)
  await expectSameEditor(body(primary), firstNode)
  await expectSameEditor(body(secondary), secondNode)

  const savedSecondSuffix = ' Saved in the secondary group.'
  await body(secondary).press('End')
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
  const reopenedFirstNode = await body(primary).elementHandle()
  assert(reopenedFirstNode)

  await exerciseSavedWorkspace({ author, session, outsider, outsiderSession, first, alternate, second: savedSecond })

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
    wideViewport: 1366, compactViewport: 375, paneWidths: [left.width, right.width] })
  assert.deepEqual(diagnostics, [])
} catch (error) {
  failure = error
} finally {
  await browser.close()
  await writeFile(join(evidence, 'workspace-split-result.json'), JSON.stringify({ observations, diagnostics,
    ...(failure && { failure: String(failure) }) }, null, 2))
}
if (failure) throw failure

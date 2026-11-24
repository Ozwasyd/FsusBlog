import assert from 'node:assert/strict'
import * as wire from '../../src/Contracts/wire.generated.ts'
import { clickForResponse } from './admin-workspace-fixture.mjs'
import * as authoring from './browser-authoring-fixture.mjs'
import { launchChrome, saveShot, withBrowserEvidence } from './isolated-browser-fixture.mjs'
import { assertStatus, getFrame, readFrame } from './response-status-fixture.mjs'
import { exactButton, exactHeading, exactLabel, exactTab, exactText } from './role-locators.mjs'
import { openById } from './workspace-flow.mjs'

const { FrameType, WireHeaders, WireRoutes } = wire
const { binary, button, expect, journalContains, postFrame, readDraft } = authoring
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const workspaceUrl = `${origin}/admin/articles/workspace`
const tabList = page => page.getByRole('tablist', { name: 'Open articles' })
const tab = (page, article, status) => exactTab(tabList(page), `${article.title} · ${status}`)
const bodyInput = page => exactLabel(page, 'Body')
const observations = []
const diagnostics = []

const fx = authoring.authorFixture(origin, diagnostics)
const { createDraft, deleteDraft, monitor, signInWithPasskey, editPath } = fx
const editUrl = article => editPath(article.id)
const create = (context, title) => createDraft(context, title, `Saved private draft for ${title}`)
const layoutResponse = response => response.url() === `${origin}${WireRoutes.AuthoringWorkspaceGroups}` && response.request().method() === 'POST'

const inspectorLayout = (context, session) => getFrame(context.request, `${origin}${WireRoutes.AuthoringWorkspaceLayout}`,
  FrameType.AuthoringWorkspaceLayout, wire.decodeAuthoringWorkspaceLayout, { headers: { [WireHeaders.CurrentSession]: session } })

const updateInspectorLayout = async (context, session, input) => readFrame(
  await postFrame(context.request, `${origin}${WireRoutes.AuthoringWorkspaceLayout}`, FrameType.AuthoringWorkspaceLayoutCommand,
    wire.encodeAuthoringWorkspaceLayoutCommand(input), { ...binary, [WireHeaders.CurrentSession]: session }),
  FrameType.AuthoringWorkspaceLayout, wire.decodeAuthoringWorkspaceLayout)

async function layout(context, session, command, status = 200) {
  const headers = { ...binary, [WireHeaders.CurrentSession]: session }
  const response = command
    ? await postFrame(context.request, `${origin}${WireRoutes.AuthoringWorkspace}`, FrameType.AuthoringWorkspaceCommand,
      wire.encodeAuthoringWorkspaceCommand({ schemaVersion: 1, ...command }), headers)
    : await context.request.get(`${origin}${WireRoutes.AuthoringWorkspace}`, { headers })
  if (status !== 200) { assertStatus(response, status); return undefined }
  return readFrame(response, FrameType.AuthoringWorkspaceSnapshot, wire.decodeAuthoringWorkspaceSnapshot)
}

async function open(page, article) {
  const dialog = await openById(page, article.id)
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(editUrl(article))
  await expect(exactLabel(page, 'Title')).toHaveValue(article.title)
}

async function saveBesideInspector(page, width, article) {
  await page.setViewportSize({ width, height: 800 })
  const pane = page.getByRole('complementary', { name: 'Article inspector' })
  await expect(pane).toBeVisible()
  const value = `Editable body beside Inspector at ${width}px.`
  await bodyInput(page).fill(value)
  const save = button(page, 'Save draft')
  await expect(save).toBeEnabled()
  await save.scrollIntoViewIfNeeded()
  const hit = await save.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    const top = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    return { acceptsPointer: !!top && element.contains(top), hit: top?.closest('aside')?.getAttribute('aria-labelledby') ?? top?.tagName }
  })
  assert.equal(hit.acceptsPointer, true, `Save draft is overlaid at ${width}px by ${hit.hit}`)
  const saved = await readDraft(await clickForResponse(page, `${origin}${WireRoutes.Save}`, save, 'POST'))
  assert.equal(saved.id, article.id)
  assert.equal(saved.body, value)
  await expect(exactText(page, 'Draft saved.')).toBeVisible()
  await expect(pane).toBeVisible()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width)
  await saveShot(page, evidence, `workspace-inspector-save-${width}.png`, {})
  const list = tabList(page)
  if (await list.isVisible()) {
    await list.getByRole('tab', { selected: true }).focus()
    await page.keyboard.press('Home')
    await expect(list.getByRole('tab').first()).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(editUrl(article))
  }
}

const browser = await launchChrome()
await withBrowserEvidence(browser, evidence, 'workspace-recovery-result.json', { observations, diagnostics }, async () => {
  const originContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const outsider = await browser.newContext()
  const session = await signInWithPasskey(originContext, process.env.FSUSBLOG_TEST_AUTHOR_BOOTSTRAP)
  const outsiderSession = await signInWithPasskey(outsider, process.env.FSUSBLOG_TEST_OUTSIDER_BOOTSTRAP)
  const first = await create(originContext, 'Pinned private article')
  const second = await create(originContext, 'Active private article')
  const removed = await create(originContext, 'Article deleted before restart')
  const privateOutside = await create(outsider, 'Private to the other author')
  const preview = await create(originContext, 'Retained preview article')

  const original = monitor(await originContext.newPage())
  await original.goto(workspaceUrl)
  await expect(exactHeading(original, 'Article workspace')).toBeVisible()
  for (const draft of [first, second, removed]) {
    await open(original, draft)
    await button(tabList(original), `Pin ${draft.title}`).click()
  }
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

  await deleteDraft(originContext, removed)
  const rendererCrashed = original.waitForEvent('crash', { timeout: 10_000 })
  const renderer = await originContext.newCDPSession(original)
  void renderer.send('Page.crash').catch(() => {})
  await rendererCrashed
  assert.equal((await layout(outsider, outsiderSession)).revision, 0n)
  await layout(outsider, session, undefined, 409)

  // A different browser process reopens layout from PostgreSQL with the same live author session.
  const state = await originContext.storageState()
  const reopenedBrowser = await launchChrome()
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
    await saveShot(page, evidence, 'workspace-reopened.png', {})

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
    assertStatus((await selectFirst)[0], 200)
    const third = await create(originContext, 'Unconfirmed competing layout')
    const conflict = activeCopy.waitForResponse(layoutResponse)
    await open(activeCopy, third)
    assertStatus(await conflict, 409)
    await expect(activeCopy.getByText('The saved workspace changed elsewhere. Reload the workspace to use that layout.')).toBeVisible()
    const winner = await layout(reopened, session)
    assert.deepEqual(winner.tabs, [first.id, second.id, -preview.id])
    assert.equal(winner.activeArticleId, first.id)
    const filtered = await layout(reopened, session, { expectedRevision: winner.revision, activeArticleId: privateOutside.id,
      tabs: [first.id, privateOutside.id] })
    assert.deepEqual([filtered.tabs, filtered.activeArticleId, filtered.skipped], [[first.id], 0, 1])
    await layout(reopened, session, { expectedRevision: filtered.revision, activeArticleId: 0, tabs: [first.id, -first.id] }, 400)
    observations.push({ competingBrowserCannotOverwrite: true, wrongSessionDenied: true, wrongOwnerFiltered: true, duplicateRejected: true })

    const desktopInspector = monitor(await reopened.newPage())
    const readLayout = desktopInspector.waitForResponse(response => response.url() === `${origin}${WireRoutes.AuthoringWorkspaceGroups}` &&
      response.request().method() === 'GET')
    await desktopInspector.goto(workspaceUrl)
    assertStatus(await readLayout, 200)
    await expect(exactText(desktopInspector, 'Open an article or start a new draft.')).toBeVisible()
    await open(desktopInspector, first)
    await button(desktopInspector, 'Inspector').click()
    await expect(desktopInspector.getByRole('complementary', { name: 'Article inspector' })).toBeVisible()
    await expect.poll(async () => (await inspectorLayout(reopened, session)).inspectorOpen).toBe(true)
    await saveBesideInspector(desktopInspector, 1280, first)
    await saveBesideInspector(desktopInspector, 1024, first)
    const beforeLegacy = await inspectorLayout(reopened, session)
    const legacy = await layout(reopened, session, { expectedRevision: beforeLegacy.revision, activeArticleId: first.id, tabs: [first.id] })
    const afterLegacy = await inspectorLayout(reopened, session)
    assert.deepEqual([afterLegacy.revision, afterLegacy.inspectorOpen], [legacy.revision, true])

    const mobileInspector = monitor(await originContext.newPage())
    await mobileInspector.setViewportSize({ width: 375, height: 850 })
    await mobileInspector.goto(workspaceUrl)
    await expect(mobileInspector).toHaveURL(editUrl(first))
    const drawer = mobileInspector.getByRole('dialog', { name: 'Article inspector' })
    await expect(drawer).toBeVisible()
    await saveShot(mobileInspector, evidence, 'workspace-inspector-mobile.png', {})
    await mobileInspector.setViewportSize({ width: 1280, height: 800 })
    const pane = mobileInspector.getByRole('complementary', { name: 'Article inspector' })
    await expect(pane).toBeVisible()
    await exactButton(pane, 'Close').click()
    await expect(button(mobileInspector, 'Inspector')).toBeFocused()
    await expect.poll(async () => (await inspectorLayout(reopened, session)).inspectorOpen).toBe(false)
    assert.equal((await inspectorLayout(reopened, session)).revision, afterLegacy.revision + 1n)
    await mobileInspector.setViewportSize({ width: 375, height: 850 })
    await mobileInspector.reload()
    await expect(button(mobileInspector, 'Inspector')).toHaveAttribute('aria-expanded', 'false')
    await expect(drawer).toBeHidden()
    const closed = await inspectorLayout(reopened, session)
    const maximumTabs = [first.id, ...Array.from({ length: 99 }, (_, index) => 2_000_000_000 + index)]
    const maximum = await layout(reopened, session, { expectedRevision: closed.revision, activeArticleId: first.id, tabs: maximumTabs })
    assert.deepEqual([maximum.skipped, maximum.tabs], [99, [first.id]])
    const extendedMaximum = await updateInspectorLayout(reopened, session, { schemaVersion: 2, expectedRevision: maximum.revision,
      activeArticleId: first.id, tabs: maximumTabs, inspectorOpen: true })
    assert.deepEqual([extendedMaximum.tabs, extendedMaximum.skipped, extendedMaximum.inspectorOpen], [[first.id], 99, true])
    observations.push({ inspectorRestoredAcrossViewports: true, breakpointDoesNotWrite: true, legacyWritePreservesInspector: true,
      inspectorCloseSurvivesReload: true, maximumWorkspaceFrames: true })
  } finally {
    await reopenedBrowser.close()
  }
  assert.deepEqual(diagnostics, [])
}, { mkdir: true })

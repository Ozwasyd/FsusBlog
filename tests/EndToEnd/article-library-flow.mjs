import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAuthorArticlePage } from '../../src/Contracts/author-articles.ts'
import { decodeRecentOpens } from '../../src/Contracts/author-recent-opens.ts'
import { PodReader, PodWriter } from '../../src/Contracts/binary.ts'
import { decodePropertyMatches, encodePropertyQuery } from '../../src/Contracts/property-query.ts'
import { encodePropertySchemaCommand, encodePropertyValueCommand } from '../../src/Contracts/property-values.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import * as authoring from './browser-authoring-fixture.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import { assertStatus, readFrame } from './response-status-fixture.mjs'
import * as loc from './role-locators.mjs'

const { FrameType, WireHeaders, WireLimits, WireRoutes } = wire
const { button, expect, pressKey, withHeldResponse } = authoring
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const workspace = `${origin}/admin/articles/workspace`
const inventory = `${origin}${WireRoutes.AuthorArticles}`
const recentPath = `${origin}${WireRoutes.AuthorRecentOpens}`
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const list = scope => scope.getByRole('list', { name: 'Article results' })
const selected = scope => list(scope).locator('button[aria-current="true"]')
const body = page => loc.exactLabel(page, 'Body')
const diagnostics = []
const observations = []

const fx = authoring.authorFixture(origin, diagnostics)
const { signInWithPasskey, saveDraft: save, createDraft, monitor, draftPath, editPath: editor } = fx
const create = (context, title, content = `Saved source: ${title}`) => createDraft(context, title, content)

async function recentOpens(context, handle) {
  return readFrame(await context.request.get(recentPath, { headers: { [WireHeaders.CurrentSession]: handle } }),
    FrameType.AuthorRecentOpenPage, decodeRecentOpens)
}

const recentIds = (context, handle) => recentOpens(context, handle).then(page => page.items.map(row => row.articleId))

async function openMobileMenuItem(page, name) {
  await button(page, 'More actions').click()
  await loc.exactMenuItem(page, name).click()
}

async function verifyPinnedView({ browser, page, author, outsider, handle, article }) {
  const id = randomUUID(), view = randomUUID(), name = 'Pinned library witness'
  const post = (path, frame, input, receipt = FrameType.PropertyCommandReceipt) =>
    authoring.postReceipt(author, origin, path, frame, input, receipt, handle)
  await post(WireRoutes.PropertySchemaCommand, FrameType.PropertySchemaCommand, encodePropertySchemaCommand({
    operation: 1, definitionId: id, requestId: randomUUID(), schemaRevision: 0n, definitionRevision: 0n,
    machineKey: 'library-witness', label: 'Library witness', kind: 'text',
  }))
  const value = { kind: 'text', value: 'Pinned result' }
  await post(WireRoutes.PropertyValueCommand, FrameType.PropertyValueCommand, encodePropertyValueCommand({
    articleId: article.id, articleRevision: article.revision, schemaRevision: 1n, valueRevision: 0n,
    definitionId: id, definitionRevision: 1n, requestId: randomUUID(), value,
  }))
  await post(WireRoutes.PropertyFilterability, FrameType.PropertyFilterabilityCommand, wire.encodePropertyFilterabilityCommand({
    definitionId: id, requestId: randomUUID(), schemaRevision: 1n, definitionRevision: 1n, enabled: true,
  }))
  const saved = new PodWriter()
  saved.i32(1)
  saved.uuid(view)
  saved.i64(0n)
  saved.i64(0n)
  saved.uuid(randomUUID())
  saved.text(name, WireLimits.SavedViewNameBytes)
  saved.bytes(encodePropertyQuery({
    schema: 2n, conditions: [{ field: { id, revision: 2n, kind: 'text' }, comparison: 'equal', value }], cursor: '',
  }))
  await post(WireRoutes.SavedViews, FrameType.SavedViewCommand, saved.finish(), FrameType.SavedViewReceipt)
  const pin = new PodWriter()
  pin.i32(4)
  pin.uuid(view)
  pin.i64(1n)
  pin.i64(1n)
  pin.uuid(randomUUID())
  pin.uuid('00000000-0000-0000-0000-000000000000')
  await post(WireRoutes.SavedViewPlacement, FrameType.SavedViewPlacementCommand, pin.finish(), FrameType.SavedViewReceipt)

  const path = `/admin/articles?view=${view}&viewSchema=1`
  const results = target => loc.exactRegion(target, 'Saved view results')
  await page.setViewportSize({ width: 375, height: 850 })
  await page.goto(editor(article.id))
  await expect(body(page)).toHaveValue(article.body)
  const dirty = article.body + ' Unsaved before opening a pinned view.'
  await body(page).fill(dirty)
  await openMobileMenuItem(page, 'Article library')
  const library = loc.exactDialog(page, 'Article library')
  await button(library, 'Pinned views').click()
  const link = loc.exactLink(library, name)
  await expect(link).toHaveAttribute('href', path)
  const executions = []
  page.on('request', sent => {
    if (new URL(sent.url()).pathname === WireRoutes.SavedViewExecute) executions.push(sent)
  })
  await link.click()
  await button(page, 'Keep writing').click()
  await expect(page).toHaveURL(editor(article.id))
  await expect(body(page)).toHaveValue(dirty)
  assert.equal(executions.length, 0)
  await link.click()
  const execution = page.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.SavedViewExecute)
  await button(page, 'Discard changes').click()
  await expect(page).toHaveURL(origin + path)
  const response = await execution
  const matches = await readFrame(response, FrameType.PropertyArticlePage, decodePropertyMatches)
  assert.equal(executions.length, 1)
  assert.equal(response.request().headers()[WireHeaders.CurrentSession.toLowerCase()], handle)
  const input = new PodReader(decodeFrame(response.request().postDataBuffer(), FrameType.SavedViewExecute).payload)
  assert.equal(input.uuid(), view)
  assert.equal(input.i64(), 1n)
  assert.equal(input.text(WireLimits.PropertyQueryCursorChars), '')
  input.finish()
  assert.deepEqual(matches.rows.map(row => row.id), [article.id])
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-fsusblog-transitioning'))
  await expect(loc.roleWithExactName(results(page), 'heading', name)).toBeFocused()
  await expect(loc.exactLink(results(page), article.title)).toHaveAttribute('href', `/admin/articles/edit/${article.id}`)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375)
  await isolated.saveShot(page, evidence, 'pinned-view-mobile.png')

  await isolated.withTempContext(browser, {
    storageState: await author.storageState(), viewport: { width: 1280, height: 850 }, colorScheme: 'dark',
  }, async context => {
    const direct = monitor(await context.newPage())
    await direct.goto(origin + path)
    await expect(loc.exactLink(results(direct), article.title)).toBeVisible()
    await expect(direct.locator('html')).toHaveAttribute('data-theme-resolved', 'dark')
    await isolated.saveShot(direct, evidence, 'pinned-view-desktop-dark.png')
    await direct.goto(origin + path.replace('viewSchema=1', 'viewSchema=2'))
    await expect(loc.exactText(direct, 'Invalid saved-view link.')).toBeVisible()
    await expect(results(direct)).toHaveCount(0)
    await loc.exactLink(direct, 'Back to all views').click()
    await expect(direct).toHaveURL(origin + '/admin/articles')
    await expect(loc.roleWithExactName(direct, 'textbox', 'Title or summary')).toBeVisible()
  })
  const peer = monitor(await outsider.newPage())
  try {
    const foreignRead = peer.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.SavedViewPlacement)
    await peer.goto(origin + path)
    assertStatus(await foreignRead, 404)
    await expect(peer.getByRole('alert')).toBeVisible()
    await expect(results(peer)).toHaveCount(0)
  } finally {
    await peer.close()
  }
  observations.push({ pinnedViewLink: true, guardedDirtyDraft: true, exactSavedQuery: true,
    directLink: true, invalidAndForeignLinksRejected: true })
}

const withHeld = (page, pattern, trigger, whileHeld) => withHeldResponse(page, pattern, trigger, async held => {
  assert.equal(await held.status(), 200)
  await whileHeld()
})

const assertSameBody = async (scope, saved) => assert.equal(await body(scope).evaluate((node, prev) => node === prev, saved), true)

async function exerciseQuickSwitcher({ page, author, active, foreign, handle }) {
  const launcher = button(page, 'Quick switch articles')
  const dialog = loc.exactDialog(page, 'Quick switch articles')
  const input = loc.exactCombobox(dialog, 'Search draft titles')
  const options = loc.roleWithExactName(dialog, 'listbox', 'Articles').getByRole('option')
  const openOther = button(dialog, 'Open in other group')
  const groups = name => loc.exactRegion(page.getByRole('main'), `${name} article group`)
  const primary = groups('Primary'), secondary = groups('Secondary')
  const selection = scope => body(scope).evaluate(control => [control.selectionStart, control.selectionEnd])
  const original = await body(page).elementHandle()
  assert(original)

  async function ready() {
    await expect(dialog).toBeVisible()
    await expect(input).toBeFocused()
  }

  async function search(keyword) {
    const received = page.waitForResponse(response => {
      const url = new URL(response.url())
      return response.request().method() === 'GET' && url.pathname === new URL(inventory).pathname &&
        url.searchParams.get('keyword') === keyword
    })
    await input.fill(keyword)
    const response = await received
    assert.equal(response.request().headers()[WireHeaders.CurrentSession.toLowerCase()], handle)
    return readFrame(response, FrameType.AuthorArticlePage, decodeAuthorArticlePage)
  }

  async function openSearch(term, { mobile = false } = {}) {
    if (mobile) await openMobileMenuItem(page, 'Quick switch articles')
    else await launcher.click()
    await ready()
    return search(term)
  }

  async function expectActive(option) {
    const id = await option.getAttribute('id')
    assert(id)
    await expect(input).toHaveAttribute('aria-activedescendant', id)
    await expect(option).toHaveAttribute('aria-selected', 'true')
    await expect(input).toBeFocused()
  }

  async function openSingle(draft) {
    const pageData = await openSearch(draft.title)
    assert.deepEqual(pageData.items.map(item => [item.id, item.revision]), [[draft.id, draft.revision]])
    await expect(options).toHaveCount(1)
    await input.press('Home')
    await expectActive(options.first())
  }

  async function closeQuick(expectedFocus) {
    await input.press('Escape')
    await expect(dialog).toBeHidden()
    if (expectedFocus) await expect(expectedFocus).toBeFocused()
  }

  await page.setViewportSize({ width: 1280, height: 800 })
  await body(page).press('End')
  const suffix = ' Local dirty switcher source.'
  const dirty = active.body + suffix
  await page.keyboard.insertText(suffix)
  await expect(body(page)).toHaveValue(dirty)
  await body(page).press('Shift+ArrowLeft')
  const selectedRange = await selection(page)
  assert.deepEqual(selectedRange, [dirty.length - 1, dirty.length])
  await page.keyboard.press(`${mod}+o`)
  await ready()
  await expect(options).toHaveCount(1)
  await expect(options.first()).toContainText(active.title)
  const duplicates = await search('重复标题')
  assert.equal(duplicates.items.length, 2)
  assert.equal(duplicates.items[0].id, active.id)
  await expect(options).toHaveCount(2)
  for (const [key, firstItem] of [['Home', 1], ['End', 0], ['ArrowUp', 1], ['ArrowDown', 0], ['PageUp', 1], ['PageDown', 0]]) {
    await input.press(key)
    await expectActive(firstItem ? options.first() : options.last())
  }
  await closeQuick(body(page))
  assert.deepEqual(await selection(page), selectedRange)
  await assertSameBody(page, original)

  await isolated.withViewport(page, 375, 850, async () => {
    const denied = await openSearch(foreign.title, { mobile: true })
    await isolated.assertScrollWidth(page, 375)
    assert.deepEqual(denied, { total: 0, nextId: null, items: [] })
    await expect(options).toHaveCount(0)
    await expect(openOther).toBeDisabled()
    await closeQuick(button(page, 'More actions'))
  })

  const candidate = await create(author, 'Exact switcher target')
  await openSingle(candidate)
  const changed = await save(author, candidate, 'Revised source at the same title.')
  assert.equal(changed.revision, candidate.revision + 1n)
  await openOther.click()
  await expect(dialog.getByRole('alert')).toHaveText('This article changed. Search again to continue.')
  await expect(page).toHaveURL(editor(active.id))
  assert.equal(await body(page).inputValue(), dirty)

  await closeQuick()
  await openSingle(changed)
  const opened = author.waitForEvent('page')
  await input.press(`${mod}+Enter`)
  const independent = monitor(await opened)
  try {
    await expect(independent).toHaveURL(editor(changed.id))
    await expect(body(independent)).toHaveValue(changed.body)
    assert.equal(await independent.evaluate(() => window.opener === null), true)
    await expect(page).toHaveURL(editor(active.id))
    await expect(body(page)).toHaveValue(dirty)
    assert.deepEqual(await recentIds(author, handle), [active.id])
  } finally {
    await independent.close()
  }
  if (await dialog.isVisible()) await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  const alreadyOpen = await openSearch(active.title)
  assert.equal(alreadyOpen.items[0]?.id, active.id)
  await expect(options.first()).toContainText(active.title)
  await openOther.click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(editor(active.id))
  await expect(secondary).toHaveCount(0)
  await assertSameBody(page, original)

  await isolated.withViewport(page, 375, 850, async () => {
    await openSearch(changed.title, { mobile: true })
    await expect(options).toHaveCount(1)
    await pressKey(page, openOther)
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(editor(changed.id))
    await expect(button(page, 'Focus primary group')).toBeVisible()
    await expect(body(secondary)).toHaveValue(changed.body)
    await expect(body(secondary)).toBeFocused()
    await expect(primary).toBeHidden()
  })
  await expect(body(primary)).toHaveValue(dirty)
  await expect(body(secondary)).toHaveValue(changed.body)
  const other = await body(secondary).elementHandle()
  assert(other)
  try {
    await button(primary, 'Edit in this group').click()
    await expect(page).toHaveURL(editor(active.id))
    await expect(body(primary)).toBeEditable()
    await expect(body(secondary)).not.toBeEditable()
    await openSingle(changed)
    await withHeld(page, draftPath(changed.id), () => input.press('Enter'), async () => {
      await input.press('Escape')
      await expect(dialog).toBeHidden()
    })
    await expect(loc.exactText(page, 'Opening article…')).toHaveCount(0)
    await expect(page).toHaveURL(editor(active.id))
    await expect(body(primary)).toHaveValue(dirty)
    await openSearch(changed.title)
    await expect(options).toHaveCount(1)
    await withHeld(page, draftPath(changed.id), () => input.press('Enter'), async () => {
      await expect(page).toHaveURL(editor(active.id))
      assert.deepEqual(await selection(primary), selectedRange)
      assert.equal(await body(primary).inputValue(), dirty)
    })
    await expect(page).toHaveURL(editor(changed.id))
    await expect(dialog).toBeHidden()
    await expect(body(secondary)).toBeEditable()
    await expect(body(primary)).not.toBeEditable()
    await assertSameBody(primary, original)
    await assertSameBody(secondary, other)
    await expect(loc.roleWithExactName(page.getByRole('main'), 'textbox', 'Body')).toHaveCount(2)
    await expect(body(primary)).toHaveValue(dirty)
    await expect(body(secondary)).toHaveValue(changed.body)
    await expect.poll(() => recentIds(author, handle)).toEqual([changed.id, active.id])
  } finally {
    await original.dispose()
    await other.dispose()
  }

  await loc.exactLink(page, 'Back').click()
  await loc.exactText(page, 'Discard unsaved changes?').waitFor()
  await button(page, 'Discard changes').click()
  await expect(page).toHaveURL(`${origin}/admin/articles`)
  observations.push({ quickSwitcher: { nativeShortcut: true, keyboardActiveDescendant: true, mobileLauncher: true,
    exactEscapeFocusAndSelection: true, foreignSearchDenied: true, staleRevisionRejected: true, separateBrowserTab: true,
    waitsForOwnedDraft: true, canceledPendingActivation: true, activatesExistingGroup: true, preservesDirtyEditorHost: true, recentAuthority: true,
    explicitOtherGroupAt375: true, explicitOtherGroupKeepsExistingOwnership: true } })
  return [changed.id, active.id]
}

const browser = await isolated.launchChrome()
await isolated.withBrowserEvidence(browser, evidence, 'article-library-result.json', { observations, diagnostics }, async () => {
  const author = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const outsider = await browser.newContext()
  const handle = await signInWithPasskey(author, process.env.FSUSBLOG_TEST_AUTHOR_BOOTSTRAP)
  const outsideHandle = await signInWithPasskey(outsider, process.env.FSUSBLOG_TEST_OUTSIDER_BOOTSTRAP)
  const first = await create(author, 'Library exact active article')
  const title = '重复标题 · Article library'
  const previousDuplicate = await create(author, title)
  const duplicate = await create(author, title)
  for (let i = 0; i < WireLimits.AuthorArticlePageSize; i++) await create(author, `Library collection ${i + 1}`)
  const foreign = await create(outsider, 'Forbidden article title from other account')
  const taxonomyFixture = process.env.FSUSBLOG_TEST_PUBLIC_FIXTURE === '1'
  if (taxonomyFixture) {
    for (const [context, article, tagIds] of [[author, previousDuplicate, []], [outsider, foreign, [4]]])
      await fx.assignTaxonomy(context, article, 1, tagIds)
  }
  const outside = await readFrame(await author.request.get(`${inventory}?article=${foreign.id}`,
    { headers: { [WireHeaders.CurrentSession]: handle } }), FrameType.AuthorArticlePage, decodeAuthorArticlePage)
  assert.deepEqual(outside, { total: 0, nextId: null, items: [] })
  assertStatus(await author.request.get(inventory, { headers: { [WireHeaders.CurrentSession]: outsideHandle } }), 409)

  const page = monitor(await author.newPage())
  await page.goto(editor(first.id))
  await expect(body(page)).toHaveValue(first.body)
  const field = await body(page).elementHandle()
  assert(field)
  const width = await body(page).evaluate(element => element.getBoundingClientRect().width)
  const launcher = button(page, 'Article library')
  await launcher.click()
  const pane = page.getByRole('complementary', { name: 'Article library' })
  await expect(pane).toBeVisible()
  await button(pane, 'Recent opens').click()
  await expect(loc.exactText(pane, 'No recent opens.')).toBeVisible()
  await button(pane, 'All articles').click()
  await expect(selected(pane)).toHaveText(/Library exact active article/)
  await expect(list(pane).getByRole('button')).toHaveCount(WireLimits.AuthorArticlePageSize + 1)
  const openWidth = await body(page).evaluate(element => element.getBoundingClientRect().width)
  assert(Math.abs(openWidth - width) <= 8, `Opening the library changed editor width from ${width} to ${openWidth}`)
  await assertSameBody(page, field)
  await expect(loc.exactText(pane, foreign.title)).toHaveCount(0)
  await button(pane, 'Next articles').click()
  await expect(list(pane).getByRole('button', { name: /重复标题/ })).toHaveCount(2)
  await button(pane, 'Previous articles').click()
  await expect(list(pane).getByRole('button')).toHaveCount(WireLimits.AuthorArticlePageSize + 1)
  if (taxonomyFixture) for (const [category, tag, suffix] of [['Web engineering', 'Café', '&category=1&tag=4'], ['All categories', 'All tags', '']]) {
    for (const [label, value] of [['Category', category], ['Tag', tag]]) {
      await loc.exactCombobox(pane, label).click()
      await loc.exactOption(page, value).click()
    }
    const response = page.waitForResponse(`${inventory}?scope=active${suffix}`)
    await button(pane, 'Filter articles').click()
    assertStatus(await response, 200)
    await expect(list(pane).getByRole('button')).toHaveCount(suffix ? 2 : WireLimits.AuthorArticlePageSize + 1)
    if (suffix) await expect(loc.exactText(pane, 'Browser fixture 12')).toBeVisible()
    await expect(selected(pane)).toHaveText(/Library exact active article/)
    observations.push(suffix ? { exactCategoryAndTagQuery: true } : { taxonomyClearRestoresUnfilteredPage: true })
  }
  await pane.getByLabel('Search article titles').fill('重复标题')
  await loc.exactLabel(pane, 'Status').selectOption('draft')
  await button(pane, 'Filter articles').click()
  const duplicates = list(pane).getByRole('button', { name: /重复标题/ })
  await expect(duplicates).toHaveCount(2)
  await expect(selected(pane)).toHaveCount(1)
  await selected(pane).focus()
  await page.keyboard.press('End')
  await expect(duplicates.last()).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(duplicates.first()).toBeFocused()

  await withHeld(page, draftPath(duplicate.id), () => page.keyboard.press('Enter'), async () => {
    await expect(page).toHaveURL(editor(first.id))
    await expect(selected(pane)).toHaveText(/Library exact active article/)
    assert.equal((await recentOpens(author, handle)).revision, 0n)
  })
  await expect(page).toHaveURL(editor(duplicate.id))
  await expect(body(page)).toHaveValue(duplicate.body)
  await expect(duplicates.first()).toHaveAttribute('aria-current', 'true')
  await expect(duplicates.last()).not.toHaveAttribute('aria-current', 'true')
  await expect.poll(() => recentIds(author, handle)).toEqual([duplicate.id])
  await button(pane, 'Recent opens').click()
  const recent = pane.getByRole('region', { name: 'Recent article opens' })
  await expect(recent.getByRole('button', { name: /重复标题/ })).toHaveAttribute('aria-current', 'true')
  await button(pane, 'All articles').click()
  await duplicates.last().focus()
  const independent = author.waitForEvent('page')
  await page.keyboard.press(`${mod}+Enter`)
  const separate = await independent
  await expect(separate).toHaveURL(editor(previousDuplicate.id))
  await expect(page).toHaveURL(editor(duplicate.id))
  await separate.close()
  assert.deepEqual(await recentIds(author, handle), [duplicate.id])
  await isolated.saveShot(page, evidence, 'article-library-desktop.png', {})
  await page.keyboard.press('Escape')
  await expect(launcher).toBeFocused()

  await page.setViewportSize({ width: 375, height: 850 })
  await openMobileMenuItem(page, 'Article library')
  const drawer = page.getByRole('dialog', { name: 'Article library' })
  await expect(drawer).toBeVisible()
  await expect(selected(drawer)).toHaveText(/重复标题/)
  await isolated.assertScrollWidth(page, 375)
  const drawerNode = await drawer.elementHandle()
  assert(drawerNode)
  await page.waitForFunction(element => {
    const bounds = element.getBoundingClientRect()
    return Math.abs(bounds.left) < 1 && Math.abs(bounds.right - window.innerWidth) < 1
  }, drawerNode)
  await drawerNode.dispose()
  await isolated.saveShot(page, evidence, 'article-library-mobile.png', {})
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(button(page, 'More actions')).toBeFocused()
  await expect(body(page)).toHaveValue(duplicate.body)

  const expectedRecents = await exerciseQuickSwitcher({ page, author, active: duplicate, foreign, handle })

  // A response from the old authenticated read cannot appear after the account changes.
  await page.setViewportSize({ width: 375, height: 850 })
  await page.goto(workspace)
  const ownerState = await author.storageState()
  const peerCookies = await outsider.cookies()
  async function switchAccount(cookies, targetDialog = drawer) {
    await author.addCookies(cookies)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')))
    await expect(targetDialog).toBeHidden()
  }
  assert.deepEqual(await recentIds(author, handle), expectedRecents)
  await withHeld(page, url => url.pathname === new URL(inventory).pathname && !url.searchParams.has('article'),
    () => openMobileMenuItem(page, 'Article library'), () => switchAccount(peerCookies))
  await openMobileMenuItem(page, 'Article library')
  await expect(loc.exactText(drawer, foreign.title)).toBeVisible()
  await expect(loc.exactText(drawer, title)).toHaveCount(0)
  await button(drawer, 'Recent opens').click()
  await expect(loc.exactText(drawer, 'No recent opens.')).toBeVisible()

  await switchAccount(ownerState.cookies)
  await isolated.withTempContext(browser, { storageState: ownerState }, async seeding => {
    const keyword = 'Identity return witness'
    const staleTitle = `${keyword} before`, freshTitle = `${keyword} after`
    const witness = await create(seeding, staleTitle)
    const quick = loc.exactDialog(page, 'Quick switch articles')
    const searchInput = loc.exactCombobox(quick, 'Search draft titles')
    async function mobileQuickSearch(term, expectedTitle) {
      await openMobileMenuItem(page, 'Quick switch articles')
      await searchInput.fill(term)
      if (expectedTitle) await expect(quick.getByRole('option', { name: new RegExp(expectedTitle) })).toBeVisible()
    }
    await page.evaluate(({ path, keyword }) => {
      const fetch = window.fetch.bind(window)
      let first = true
      window.fetch = async (input, options) => {
        const url = new URL(input, location.href)
        if (!first || url.pathname !== path || url.searchParams.get('keyword') !== keyword) return fetch(input, options)
        first = false
        // Deliver the actual old HTTP body even if the UI aborts its original waiter.
        const response = await fetch(input, { ...options, signal: undefined })
        window.oldAuthorQueryStatus = response.status
        return response
      }
    }, { path: WireRoutes.AuthorArticles, keyword })
    await withHeld(page, url => url.pathname === WireRoutes.AuthorArticles && url.searchParams.get('keyword') === keyword,
      () => mobileQuickSearch(keyword), async () => {
        await switchAccount(peerCookies, quick)
        await mobileQuickSearch(foreign.title, foreign.title)
        await save(seeding, { ...witness, title: freshTitle }, witness.body)
        await switchAccount(ownerState.cookies, quick)
        await mobileQuickSearch(keyword, freshTitle)
      })
    await page.waitForFunction(() => window.oldAuthorQueryStatus === 200)
    await expect(quick.getByRole('option', { name: new RegExp(freshTitle) })).toBeVisible()
    await expect(quick.getByRole('option', { name: new RegExp(staleTitle) })).toHaveCount(0)
  })
  observations.push({ sameCredentialOwnerPeerOwner: true, delayedRealQueryReachedBrowserDespiteAbort: true, staleQuerySuppressed: true })
  await verifyPinnedView({ browser, page, author, outsider, handle, article: first })
  observations.push({ ownerAndCredentialFence: true, exactActiveRevealOutsidePage: true, distinctDuplicateArticleIds: true,
    boundedPages: true, routeWaitsForOwnedDraft: true, separateBrowserTab: true, editorWidthBefore: width, editorWidthAfter: openWidth,
    mobileDrawerAndFocusReturn: true, latePreviousAccountReadSuppressed: true, exactDurableRecentOpens: true })
  assert.deepEqual(diagnostics, [])
})

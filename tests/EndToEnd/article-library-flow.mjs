import { withBrowserEvidence } from './isolated-browser-fixture.mjs'
import { assertStatus } from './response-status-fixture.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAuthorArticlePage } from '../../src/Contracts/author-articles.ts'
import { decodeRecentOpens } from '../../src/Contracts/author-recent-opens.ts'
import { encodeTaxonomyAssignment, FrameType, WireHeaders, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { authorFixture, button, chromium, expect, holdResponse, postReceipt } from './browser-authoring-fixture.mjs'
import { roleWithExactName, exactLabel, exactText } from './role-locators.mjs'

const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const workspace = `${origin}/admin/articles/workspace`
const editor = id => `${origin}/admin/articles/edit/${id}`
const inventory = `${origin}${WireRoutes.AuthorArticles}`
const recentPath = `${origin}${WireRoutes.AuthorRecentOpens}`
const draftPath = id => `${origin}${WireRoutes.Draft.replace('{id:int}', String(id))}`
const list = scope => scope.getByRole('list', { name: 'Article results' })
const selected = scope => list(scope).locator('button[aria-current="true"]')
const body = page => exactLabel(page, 'Body')
const diagnostics = []
const observations = []

const { signInWithPasskey, saveDraft: save, createDraft, monitor } = authorFixture(origin, diagnostics)
const create = (context, title, content = `Saved source: ${title}`) => createDraft(context, title, content)

async function recentOpens(context, handle) {
  const response = await context.request.get(recentPath, { headers: { [WireHeaders.CurrentSession]: handle } })
  assertStatus(response, 200)
  return decodeRecentOpens(decodeFrame(await response.body(), FrameType.AuthorRecentOpenPage).payload)
}

async function openMobileMenuItem(page, name) {
  await button(page, 'More actions').click()
  await roleWithExactName(page, 'menuitem', name).click()
}

async function exerciseQuickSwitcher({ page, author, active, foreign, handle }) {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const launcher = button(page, 'Quick switch articles')
  const dialog = roleWithExactName(page, 'dialog', 'Quick switch articles')
  const input = roleWithExactName(dialog, 'combobox', 'Search draft titles')
  const listbox = roleWithExactName(dialog, 'listbox', 'Articles')
  const options = listbox.getByRole('option')
  const openOther = button(dialog, 'Open in other group')
  const groups = name => roleWithExactName(page.getByRole('main'), 'region', `${name} article group`)
  const primary = groups('Primary')
  const secondary = groups('Secondary')
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
    assertStatus(response, 200)
    assert.equal(response.request().headers()[WireHeaders.CurrentSession.toLowerCase()], handle)
    return decodeAuthorArticlePage(decodeFrame(await response.body(), FrameType.AuthorArticlePage).payload)
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
  await input.press('Home')
  await expectActive(options.first())
  await input.press('End')
  await expectActive(options.last())
  await input.press('ArrowUp')
  await expectActive(options.first())
  await input.press('ArrowDown')
  await expectActive(options.last())
  await input.press('PageUp')
  await expectActive(options.first())
  await input.press('PageDown')
  await expectActive(options.last())
  await input.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(body(page)).toBeFocused()
  assert.deepEqual(await selection(page), selectedRange)
  assert.equal(await body(page).evaluate((node, saved) => node === saved, original), true)

  await page.setViewportSize({ width: 375, height: 850 })
  await openMobileMenuItem(page, 'Quick switch articles')
  await ready()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375)
  const denied = await search(foreign.title)
  assert.deepEqual(denied, { total: 0, nextId: null, items: [] })
  await expect(options).toHaveCount(0)
  await expect(openOther).toBeDisabled()
  await input.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(button(page, 'More actions')).toBeFocused()

  await page.setViewportSize({ width: 1280, height: 800 })
  const candidate = await create(author, 'Exact switcher target')
  const before = await openSearch(candidate.title)
  assert.deepEqual(before.items.map(item => [item.id, item.revision]), [[candidate.id, candidate.revision]])
  await expect(options).toHaveCount(1)
  await input.press('Home')
  await expectActive(options.first())
  const changed = await save(author, candidate, 'Revised source at the same title.')
  assert.equal(changed.revision, candidate.revision + 1n)
  await openOther.click()
  await expect(dialog.getByRole('alert')).toHaveText('This article changed. Search again to continue.')
  await expect(page).toHaveURL(editor(active.id))
  assert.equal(await body(page).inputValue(), dirty)

  await input.press('Escape')
  await expect(dialog).toBeHidden()
  const current = await openSearch(changed.title)
  assert.deepEqual(current.items.map(item => [item.id, item.revision]), [[changed.id, changed.revision]])
  await expect(options).toHaveCount(1)
  await input.press('Home')
  await expectActive(options.first())
  const opened = author.waitForEvent('page')
  await input.press(`${mod}+Enter`)
  const independent = await opened
  monitor(independent)
  try {
    await expect(independent).toHaveURL(editor(changed.id))
    await expect(body(independent)).toHaveValue(changed.body)
    assert.equal(await independent.evaluate(() => window.opener === null), true)
    await expect(page).toHaveURL(editor(active.id))
    await expect(body(page)).toHaveValue(dirty)
    assert.deepEqual((await recentOpens(author, handle)).items.map(row => row.articleId), [active.id])
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
  assert.equal(await body(page).evaluate((node, saved) => node === saved, original), true)

  await page.setViewportSize({ width: 375, height: 850 })
  await openSearch(changed.title, { mobile: true })
  await expect(options).toHaveCount(1)
  await openOther.focus()
  await expect(openOther).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(editor(changed.id))
  await expect(button(page, 'Focus primary group')).toBeVisible()
  await expect(body(secondary)).toHaveValue(changed.body)
  await expect(body(secondary)).toBeFocused()
  await expect(primary).toBeHidden()
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(body(primary)).toHaveValue(dirty)
  await expect(body(secondary)).toHaveValue(changed.body)
  const other = await body(secondary).elementHandle()
  assert(other)
  try {
    await button(primary, 'Edit in this group').click()
    await expect(page).toHaveURL(editor(active.id))
    await expect(body(primary)).toBeEditable()
    await expect(body(secondary)).not.toBeEditable()
    await openSearch(changed.title)
    await expect(options).toHaveCount(1)
    await input.press('Home')
    await expectActive(options.first())
    const canceled = await holdResponse(page, draftPath(changed.id))
    try {
      await input.press('Enter')
      assert.equal(await canceled.status(), 200)
      await input.press('Escape')
      await expect(dialog).toBeHidden()
    } finally {
      canceled.release()
    }
    await canceled.done
    await expect(exactText(page, 'Opening article…')).toHaveCount(0)
    await expect(page).toHaveURL(editor(active.id))
    await expect(body(primary)).toHaveValue(dirty)
    await openSearch(changed.title)
    await expect(options).toHaveCount(1)
    const delayed = await holdResponse(page, draftPath(changed.id))
    try {
      await input.press('Enter')
      assert.equal(await delayed.status(), 200)
      await expect(page).toHaveURL(editor(active.id))
      assert.deepEqual(await selection(primary), selectedRange)
      assert.equal(await body(primary).inputValue(), dirty)
    } finally {
      delayed.release()
    }
    await delayed.done
    await expect(page).toHaveURL(editor(changed.id))
    await expect(dialog).toBeHidden()
    await expect(body(secondary)).toBeEditable()
    await expect(body(primary)).not.toBeEditable()
    assert.equal(await body(primary).evaluate((node, saved) => node === saved, original), true)
    assert.equal(await body(secondary).evaluate((node, saved) => node === saved, other), true)
    await expect(roleWithExactName(page.getByRole('main'), 'textbox', 'Body')).toHaveCount(2)
    await expect(body(primary)).toHaveValue(dirty)
    await expect(body(secondary)).toHaveValue(changed.body)
    await expect.poll(async () => (await recentOpens(author, handle)).items.map(row => row.articleId))
      .toEqual([changed.id, active.id])
  } finally {
    await original.dispose()
    await other.dispose()
  }

  await roleWithExactName(page, 'link', 'Back').click()
  await exactText(page, 'Discard unsaved changes?').waitFor()
  await button(page, 'Discard changes').click()
  await expect(page).toHaveURL(`${origin}/admin/articles`)
  observations.push({ quickSwitcher: { nativeShortcut: true, keyboardActiveDescendant: true, mobileLauncher: true,
    exactEscapeFocusAndSelection: true, foreignSearchDenied: true, staleRevisionRejected: true, separateBrowserTab: true,
    waitsForOwnedDraft: true, canceledPendingActivation: true, activatesExistingGroup: true, preservesDirtyEditorHost: true, recentAuthority: true,
    explicitOtherGroupAt375: true, explicitOtherGroupKeepsExistingOwnership: true } })
  return [changed.id, active.id]
}

const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME })
await withBrowserEvidence(browser, evidence, 'article-library-result.json', { observations, diagnostics }, async () => {
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
  if (taxonomyFixture) for (const [context, article, tagIds] of [[author, previousDuplicate, []], [outsider, foreign, [4]]]) {
    await postReceipt(context, origin, WireRoutes.TaxonomyAssignment, FrameType.TaxonomyAssignment, encodeTaxonomyAssignment({
      id: article.id, expectedRevision: article.revision, idempotencyKey: randomUUID(), categoryId: 1, tagIds,
    }), FrameType.DraftTaxonomy)
  }
  const outside = await author.request.get(`${inventory}?article=${foreign.id}`, { headers: { [WireHeaders.CurrentSession]: handle } })
  assertStatus(outside, 200)
  assert.deepEqual(decodeAuthorArticlePage(decodeFrame(await outside.body(), FrameType.AuthorArticlePage).payload), { total: 0, nextId: null, items: [] })
  assertStatus(await author.request.get(inventory, { headers: { [WireHeaders.CurrentSession]: outsideHandle } }), 409)

  const page = await author.newPage()
  monitor(page)
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
  await expect(exactText(pane, 'No recent opens.')).toBeVisible()
  await button(pane, 'All articles').click()
  await expect(selected(pane)).toHaveText(/Library exact active article/)
  await expect(list(pane).getByRole('button')).toHaveCount(WireLimits.AuthorArticlePageSize + 1)
  const openWidth = await body(page).evaluate(element => element.getBoundingClientRect().width)
  assert(Math.abs(openWidth - width) <= 8, `Opening the library changed editor width from ${width} to ${openWidth}`)
  assert.equal(await body(page).evaluate((current, previous) => current === previous, field), true)
  await expect(exactText(pane, foreign.title)).toHaveCount(0)
  await button(pane, 'Next articles').click()
  await expect(list(pane).getByRole('button', { name: /重复标题/ })).toHaveCount(2)
  await button(pane, 'Previous articles').click()
  await expect(list(pane).getByRole('button')).toHaveCount(WireLimits.AuthorArticlePageSize + 1)
  if (taxonomyFixture) for (const [category, tag, suffix] of [['Web engineering', 'Café', '&category=1&tag=4'], ['All categories', 'All tags', '']]) {
    for (const [label, value] of [['Category', category], ['Tag', tag]]) {
      await roleWithExactName(pane, 'combobox', label).click()
      await roleWithExactName(page, 'option', value).click()
    }
    const response = page.waitForResponse(`${inventory}?scope=active${suffix}`)
    await button(pane, 'Filter articles').click()
    assertStatus(await response, 200)
    await expect(list(pane).getByRole('button')).toHaveCount(suffix ? 2 : WireLimits.AuthorArticlePageSize + 1)
    if (suffix) await expect(exactText(pane, 'Browser fixture 12')).toBeVisible()
    await expect(selected(pane)).toHaveText(/Library exact active article/)
    observations.push(suffix ? { exactCategoryAndTagQuery: true } : { taxonomyClearRestoresUnfilteredPage: true })
  }
  await pane.getByLabel('Search article titles').fill('重复标题')
  await exactLabel(pane, 'Status').selectOption('draft')
  await button(pane, 'Filter articles').click()
  const duplicates = list(pane).getByRole('button', { name: /重复标题/ })
  await expect(duplicates).toHaveCount(2)
  await expect(selected(pane)).toHaveCount(1)
  await selected(pane).focus()
  await page.keyboard.press('End')
  await expect(duplicates.last()).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(duplicates.first()).toBeFocused()

  const delayed = await holdResponse(page, draftPath(duplicate.id))
  await page.keyboard.press('Enter')
  try {
    assert.equal(await delayed.status(), 200)
    await expect(page).toHaveURL(editor(first.id))
    await expect(selected(pane)).toHaveText(/Library exact active article/)
    assert.equal((await recentOpens(author, handle)).revision, 0n)
  } finally { delayed.release() }
  await delayed.done
  await expect(page).toHaveURL(editor(duplicate.id))
  await expect(body(page)).toHaveValue(duplicate.body)
  await expect(duplicates.first()).toHaveAttribute('aria-current', 'true')
  await expect(duplicates.last()).not.toHaveAttribute('aria-current', 'true')
  await expect.poll(async () => (await recentOpens(author, handle)).items.map(row => row.articleId)).toEqual([duplicate.id])
  await button(pane, 'Recent opens').click()
  const recent = pane.getByRole('region', { name: 'Recent article opens' })
  await expect(recent.getByRole('button', { name: /重复标题/ })).toHaveAttribute('aria-current', 'true')
  await button(pane, 'All articles').click()
  await duplicates.last().focus()
  const independent = author.waitForEvent('page')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  const separate = await independent
  await expect(separate).toHaveURL(editor(previousDuplicate.id))
  await expect(page).toHaveURL(editor(duplicate.id))
  await separate.close()
  assert.deepEqual((await recentOpens(author, handle)).items.map(row => row.articleId), [duplicate.id])
  await page.screenshot({ path: join(evidence, 'article-library-desktop.png') })
  await page.keyboard.press('Escape')
  await expect(launcher).toBeFocused()

  await page.setViewportSize({ width: 375, height: 850 })
  await openMobileMenuItem(page, 'Article library')
  const drawer = page.getByRole('dialog', { name: 'Article library' })
  await expect(drawer).toBeVisible()
  await expect(selected(drawer)).toHaveText(/重复标题/)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375)
  const drawerNode = await drawer.elementHandle()
  assert(drawerNode)
  await page.waitForFunction(element => {
    const bounds = element.getBoundingClientRect()
    return Math.abs(bounds.left) < 1 && Math.abs(bounds.right - window.innerWidth) < 1
  }, drawerNode)
  await drawerNode.dispose()
  await page.screenshot({ path: join(evidence, 'article-library-mobile.png') })
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
  async function switchAccount(cookies) {
    await author.addCookies(cookies)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')))
  }
  assert.deepEqual((await recentOpens(author, handle)).items.map(row => row.articleId), expectedRecents)
  const delayedResults = await holdResponse(page, url => url.pathname === new URL(inventory).pathname && !url.searchParams.has('article'))
  await openMobileMenuItem(page, 'Article library')
  try {
    assert.equal(await delayedResults.status(), 200)
    await switchAccount(peerCookies)
    await expect(page.getByRole('dialog', { name: 'Article library' })).toBeHidden()
  } finally { delayedResults.release() }
  await delayedResults.done
  await openMobileMenuItem(page, 'Article library')
  await expect(exactText(drawer, foreign.title)).toBeVisible()
  await expect(exactText(drawer, title)).toHaveCount(0)
  await button(drawer, 'Recent opens').click()
  await expect(exactText(drawer, 'No recent opens.')).toBeVisible()

  await switchAccount(ownerState.cookies)
  await expect(drawer).toBeHidden()
  const seeding = await browser.newContext({ storageState: ownerState })
  const keyword = 'Identity return witness'
  const staleTitle = `${keyword} before`, freshTitle = `${keyword} after`
  const witness = await create(seeding, staleTitle)
  const quick = roleWithExactName(page, 'dialog', 'Quick switch articles')
  const searchInput = roleWithExactName(quick, 'combobox', 'Search draft titles')
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
  const old = await holdResponse(page, url => url.pathname === WireRoutes.AuthorArticles && url.searchParams.get('keyword') === keyword)
  try {
    await openMobileMenuItem(page, 'Quick switch articles')
    await searchInput.fill(keyword)
    assert.equal(await old.status(), 200)
    await switchAccount(peerCookies)
    await expect(quick).toBeHidden()
    await openMobileMenuItem(page, 'Quick switch articles')
    await searchInput.fill(foreign.title)
    await expect(quick.getByRole('option', { name: new RegExp(foreign.title) })).toBeVisible()
    await save(seeding, { ...witness, title: freshTitle }, witness.body)
    await switchAccount(ownerState.cookies)
    await expect(quick).toBeHidden()
    await openMobileMenuItem(page, 'Quick switch articles')
    await searchInput.fill(keyword)
    await expect(quick.getByRole('option', { name: new RegExp(freshTitle) })).toBeVisible()
  } finally {
    old.release()
    await seeding.close()
  }
  await old.done
  await page.waitForFunction(() => window.oldAuthorQueryStatus === 200)
  await expect(quick.getByRole('option', { name: new RegExp(freshTitle) })).toBeVisible()
  await expect(quick.getByRole('option', { name: new RegExp(staleTitle) })).toHaveCount(0)
  observations.push({ sameCredentialOwnerPeerOwner: true, delayedRealQueryReachedBrowserDespiteAbort: true, staleQuerySuppressed: true })
  observations.push({ ownerAndCredentialFence: true, exactActiveRevealOutsidePage: true, distinctDuplicateArticleIds: true,
    boundedPages: true, routeWaitsForOwnedDraft: true, separateBrowserTab: true, editorWidthBefore: width, editorWidthAfter: openWidth,
    mobileDrawerAndFocusReturn: true, latePreviousAccountReadSuppressed: true, exactDurableRecentOpens: true })
  assert.deepEqual(diagnostics, [])
})

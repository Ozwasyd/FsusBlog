import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAuthorArticlePage } from '../../src/Contracts/author-articles.ts'
import { decodeDraft, encodeArticleCommand, encodeSignIn, FrameType, WireHeaders, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const { chromium, expect } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const workspace = `${origin}/user/manage/article/workspace`
const editor = id => `${origin}/user/manage/article/edit/${id}`
const inventory = `${origin}${WireRoutes.AuthorArticles}`
const draftPath = id => `${origin}${WireRoutes.Draft.replace('{id:int}', String(id))}`
const binary = { 'Content-Type': 'application/octet-stream' }
const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const list = scope => scope.getByRole('list', { name: 'Article results' })
const selected = scope => list(scope).locator('button[aria-current="true"]')
const body = page => page.getByLabel('Body', { exact: true })
const diagnostics = []
const observations = []

async function signIn(context, ticket) {
  const response = await context.request.post(`${origin}${WireRoutes.SignIn}`, { headers: binary,
    data: Buffer.from(encodeFrame(FrameType.OperatorSignIn, encodeSignIn({ ticket }))) })
  assert.equal(response.status(), 200)
  return response.headers()[WireHeaders.CurrentSession.toLowerCase()]
}

async function create(context, title, content = `Saved source: ${title}`) {
  const data = Buffer.from(encodeFrame(FrameType.ArticleCommand, encodeArticleCommand({ id: 0, expectedRevision: 0n,
    idempotencyKey: randomUUID(), title, body: content })))
  const response = await context.request.post(`${origin}${WireRoutes.Save}`, { headers: binary, data })
  assert.equal(response.status(), 200)
  return decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload)
}

function monitor(page) {
  page.on('pageerror', error => diagnostics.push(error.message))
  page.on('console', entry => {
    if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) diagnostics.push(entry.text())
  })
}

async function hold(page, pattern) {
  const reached = Promise.withResolvers()
  const done = Promise.withResolvers()
  const release = Promise.withResolvers()
  await page.route(pattern, async route => {
    try {
      const actual = await route.fetch()
      reached.resolve(actual.status())
      await release.promise
      await route.fulfill({ response: actual })
    } catch (error) { reached.reject(error) }
    finally { done.resolve() }
  }, { times: 1 })
  return { reached: reached.promise, release: release.resolve, done: done.promise }
}

let failure
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME })
try {
  const author = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const outsider = await browser.newContext()
  const handle = await signIn(author, process.env.FSUSBLOG_TEST_TICKET)
  const outsideHandle = await signIn(outsider, process.env.FSUSBLOG_TEST_OUTSIDER_TICKET)
  const first = await create(author, 'Library exact active article')
  const title = '重复标题 · Article library'
  const previousDuplicate = await create(author, title)
  const duplicate = await create(author, title)
  for (let i = 0; i < WireLimits.AuthorArticlePageSize; i++) await create(author, `Library collection ${i + 1}`)
  const foreign = await create(outsider, 'Forbidden article title from other account')
  const outside = await author.request.get(`${inventory}?article=${foreign.id}`, { headers: { [WireHeaders.CurrentSession]: handle } })
  assert.equal(outside.status(), 200)
  assert.deepEqual(decodeAuthorArticlePage(decodeFrame(await outside.body(), FrameType.AuthorArticlePage).payload), { total: 0, nextId: null, items: [] })
  assert.equal((await author.request.get(inventory, { headers: { [WireHeaders.CurrentSession]: outsideHandle } })).status(), 409)

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
  await expect(selected(pane)).toHaveText(/Library exact active article/)
  await expect(list(pane).getByRole('button')).toHaveCount(WireLimits.AuthorArticlePageSize + 1)
  const openWidth = await body(page).evaluate(element => element.getBoundingClientRect().width)
  assert(Math.abs(openWidth - width) <= 8, `Opening the library changed editor width from ${width} to ${openWidth}`)
  assert.equal(await body(page).evaluate((current, previous) => current === previous, field), true)
  await expect(pane.getByText(foreign.title, { exact: true })).toHaveCount(0)
  await button(pane, 'Next articles').click()
  await expect(list(pane).getByRole('button', { name: /重复标题/ })).toHaveCount(2)
  await button(pane, 'Previous articles').click()
  await expect(list(pane).getByRole('button')).toHaveCount(WireLimits.AuthorArticlePageSize + 1)
  await pane.getByLabel('Search article titles').fill('重复标题')
  await pane.getByLabel('Status', { exact: true }).selectOption('draft')
  await button(pane, 'Filter articles').click()
  const duplicates = list(pane).getByRole('button', { name: /重复标题/ })
  await expect(duplicates).toHaveCount(2)
  await expect(selected(pane)).toHaveCount(1)
  await selected(pane).focus()
  await page.keyboard.press('End')
  await expect(duplicates.last()).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(duplicates.first()).toBeFocused()

  const delayed = await hold(page, draftPath(duplicate.id))
  await page.keyboard.press('Enter')
  try {
    assert.equal(await delayed.reached, 200)
    await expect(page).toHaveURL(editor(first.id))
    await expect(selected(pane)).toHaveText(/Library exact active article/)
  } finally { delayed.release() }
  await delayed.done
  await expect(page).toHaveURL(editor(duplicate.id))
  await expect(body(page)).toHaveValue(duplicate.body)
  await expect(duplicates.first()).toHaveAttribute('aria-current', 'true')
  await expect(duplicates.last()).not.toHaveAttribute('aria-current', 'true')
  await duplicates.last().focus()
  const independent = author.waitForEvent('page')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  const separate = await independent
  await expect(separate).toHaveURL(editor(previousDuplicate.id))
  await expect(page).toHaveURL(editor(duplicate.id))
  await separate.close()
  await page.screenshot({ path: join(evidence, 'article-library-desktop.png') })
  await page.keyboard.press('Escape')
  await expect(launcher).toBeFocused()

  await page.setViewportSize({ width: 375, height: 850 })
  await launcher.click()
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
  await expect(launcher).toBeFocused()
  await expect(body(page)).toHaveValue(duplicate.body)

  // A response from the old authenticated read cannot appear after the account changes.
  await page.goto(workspace)
  const delayedResults = await hold(page, url => url.pathname === new URL(inventory).pathname && !url.searchParams.has('article'))
  await button(page, 'Article library').click()
  try {
    assert.equal(await delayedResults.reached, 200)
    const cookies = await outsider.cookies()
    await author.addCookies(cookies)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')))
    await expect(page.getByRole('dialog', { name: 'Article library' })).toBeHidden()
  } finally { delayedResults.release() }
  await delayedResults.done
  await button(page, 'Article library').click()
  await expect(drawer.getByText(foreign.title, { exact: true })).toBeVisible()
  await expect(drawer.getByText(title, { exact: true })).toHaveCount(0)
  observations.push({ ownerAndCredentialFence: true, exactActiveRevealOutsidePage: true, distinctDuplicateArticleIds: true,
    boundedPages: true, routeWaitsForOwnedDraft: true, separateBrowserTab: true, editorWidthBefore: width, editorWidthAfter: openWidth,
    mobileDrawerAndFocusReturn: true, latePreviousAccountReadSuppressed: true })
  assert.deepEqual(diagnostics, [])
} catch (error) {
  failure = error
} finally {
  await browser.close()
  await writeFile(join(evidence, 'article-library-result.json'), JSON.stringify({ observations, diagnostics, ...(failure && { failure: String(failure) }) }, null, 2))
}
if (failure) throw failure

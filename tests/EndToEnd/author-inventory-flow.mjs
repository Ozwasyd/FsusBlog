import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeDraft, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { chromium, submitArticle } from './browser-authoring-fixture.mjs'

const origin = process.env.FSUSBLOG_TEST_URL
const firstTicket = process.env.FSUSBLOG_TEST_TICKET
const secondTicket = process.env.FSUSBLOG_TEST_MOBILE_TICKET
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
assert(origin && firstTicket && secondTicket && evidence, 'Use an isolated fixture with two author accounts, a test URL and a new evidence directory.')
const inventoryPath = '/user/manage/article/list'
const trashPath = '/user/manage/article/trash'
const ownerNeedle = `Inventory browser ${Date.now()}`
const secondTitle = `Second author ${ownerNeedle}`
const started = new Date().toISOString()
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME })
await mkdir(evidence, { recursive: true })

const submitCommand = (context, path, article) => submitArticle(context.request, new URL(path, origin).href, article,
  { 'content-type': 'application/octet-stream' })

async function command(context, path, article, expected = FrameType.Draft) {
  const response = await submitCommand(context, path, article)
  assert.equal(response.status(), 200, `Article command ${path}`)
  const wire = decodeFrame(await response.body())
  assert.equal(wire.type, expected)
  return expected === FrameType.Draft ? decodeDraft(wire.payload) : null
}

async function draft(context, title, body = 'Private browser fixture body.') {
  return command(context, WireRoutes.Save, { id: 0, expectedRevision: 0n, title, body })
}

function monitor(page) {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  return errors
}

async function signIn(page, ticket) {
  await page.goto(new URL('/login', origin).href)
  const accepted = page.waitForResponse(response => response.url() === new URL(WireRoutes.SignIn, origin).href && response.request().method() === 'POST')
  await page.getByLabel('Owner access key').fill(ticket)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  assert.equal((await accepted).status(), 200)
  await page.waitForURL(url => url.pathname !== '/login')
}

async function readyInventory(page, path, title) {
  const response = await page.goto(new URL(path, origin).href)
  assert.equal(response.status(), 200)
  await page.getByRole('heading', { name: title, exact: true }).waitFor()
  assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex')
}

function mutationResponse(page, path) {
  return page.waitForResponse(response => response.url() === new URL(path, origin).href && response.request().method() === 'POST')
}

try {
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  const mobile = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block' })
  const anonymous = await browser.newPage()
  const owner = await desktop.newPage()
  const second = await mobile.newPage()
  const errors = [monitor(owner), monitor(second), monitor(anonymous)]
  await readyInventory(anonymous, inventoryPath, '文章管理')
  await anonymous.getByText('请先登录作者账号', { exact: true }).waitFor()
  assert.equal(await anonymous.getByRole('form', { name: '筛选文章' }).count(), 0)
  assert.equal((await anonymous.request.get(new URL(`${WireRoutes.AuthorArticles}?scope=active`, origin).href)).status(), 401)
  await signIn(owner, firstTicket)
  await signIn(second, secondTicket)

  const articles = []
  const summaryNeedle = 'Inventory summary only marker'
  for (let i = 1; i <= 21; i++) {
    articles.push(await draft(desktop, `${ownerNeedle} ${String(i).padStart(2, '0')}`, i === 13 ? summaryNeedle : undefined))
  }
  const toPublish = await draft(desktop, `${ownerNeedle} recovery`)
  const published = await command(desktop, WireRoutes.Publish,
    { id: toPublish.id, expectedRevision: toPublish.revision, title: '', body: '' })
  const publicUrl = new URL(`/article/${published.id}`, origin).href
  const publicApi = new URL(WireRoutes.PublicArticle.replace('{id}', String(published.id)), origin).href
  assert.equal((await anonymous.request.get(publicUrl)).status(), 200)
  assert.equal((await anonymous.request.get(publicApi)).status(), 200)
  await draft(mobile, secondTitle, summaryNeedle)

  await readyInventory(owner, inventoryPath, '文章管理')
  await owner.getByText('共 22 篇', { exact: true }).waitFor()
  await owner.getByRole('heading', { name: articles.at(-1).title, exact: true }).waitFor()
  assert.equal(await owner.getByRole('heading', { name: articles[0].title, exact: true }).count(), 0)
  assert.equal(await owner.getByText(secondTitle, { exact: true }).count(), 0)
  await owner.getByRole('region', { name: '文章列表' }).getByText('草稿', { exact: true }).first().waitFor()
  await owner.screenshot({ path: join(evidence, 'author-inventory-desktop.png'), animations: 'disabled' })
  await owner.getByRole('button', { name: '下一页' }).click()
  await owner.getByText('第 2 页', { exact: true }).waitFor()
  await owner.getByRole('heading', { name: articles[0].title, exact: true }).waitFor()
  const keyword = owner.getByLabel('标题或摘要', { exact: true })
  const search = owner.getByRole('form', { name: '筛选文章' }).getByRole('button', { name: '搜索', exact: true })
  await keyword.fill(articles[10].title)
  await search.click()
  await owner.getByText('共 1 篇', { exact: true }).waitFor()
  await owner.getByRole('heading', { name: articles[10].title, exact: true }).waitFor()
  await keyword.fill(summaryNeedle)
  const summaryResult = owner.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === WireRoutes.AuthorArticles && url.searchParams.get('match') === 'title-summary' &&
      url.searchParams.get('keyword') === summaryNeedle
  })
  await search.click()
  const summaryResponse = await summaryResult
  assert.equal(summaryResponse.status(), 200)
  assert.equal((await summaryResponse.body()).includes(Buffer.from(summaryNeedle)), false)
  await owner.getByText('共 1 篇', { exact: true }).waitFor()
  assert.equal(await owner.getByRole('heading', { name: secondTitle, exact: true }).count(), 0)
  const summaryArticle = articles[12]
  const edit = owner.getByRole('link', { name: `编辑 ${summaryArticle.title}`, exact: true })
  assert.equal(await edit.getAttribute('href'), `/user/manage/article/edit/${summaryArticle.id}`)
  assert.equal(await owner.getByRole('heading', { name: articles[10].title, exact: true }).count(), 0)
  await edit.click()
  await owner.waitForURL(url => url.pathname === `/user/manage/article/edit/${summaryArticle.id}`)
  await owner.waitForFunction(title => document.querySelector('#article-title')?.value === title, summaryArticle.title)
  await owner.getByRole('link', { name: 'Manage articles', exact: true }).first().click()
  await owner.waitForURL(url => url.pathname === inventoryPath)
  const deleteButton = owner.getByRole('button', { name: `移至回收站 ${published.title}`, exact: true })
  const deleteDialog = owner.getByRole('dialog', { name: '移至回收站', exact: true })
  await deleteButton.click()
  await deleteDialog.getByText(`「${published.title}」`, { exact: true }).waitFor()
  await deleteDialog.getByRole('button', { name: '取消', exact: true }).click()
  await deleteDialog.waitFor({ state: 'hidden' })
  assert.equal((await anonymous.request.get(publicUrl)).status(), 200)

  const updated = await command(desktop, WireRoutes.Save, { id: published.id, expectedRevision: published.revision,
    title: published.title, body: 'An updated private revision is preserved on restore.' })
  await deleteButton.click()
  const staleDelete = mutationResponse(owner, WireRoutes.Delete)
  await deleteDialog.getByRole('button', { name: '移至回收站', exact: true }).click()
  assert.equal((await staleDelete).status(), 409)
  await owner.getByText('文章状态已变更。请在更新后的列表中确认后再操作。', { exact: true }).waitFor()
  assert.equal((await anonymous.request.get(publicApi)).status(), 200)

  await deleteButton.click()
  const acceptedDelete = mutationResponse(owner, WireRoutes.Delete)
  await deleteDialog.getByRole('button', { name: '移至回收站', exact: true }).click()
  assert.equal((await acceptedDelete).status(), 200)
  await owner.getByText('文章已移至回收站。', { exact: true }).waitFor()
  await owner.getByText('共 21 篇', { exact: true }).waitFor()
  assert.equal(await owner.getByRole('heading', { name: published.title, exact: true }).count(), 0)
  assert.equal((await anonymous.request.get(publicUrl)).status(), 404)
  assert.equal((await anonymous.request.get(publicApi)).status(), 404)

  await owner.getByRole('link', { name: '回收站', exact: true }).click()
  await owner.waitForURL(url => url.pathname === trashPath)
  await owner.getByRole('heading', { name: published.title, exact: true }).waitFor()
  assert.equal(await owner.getByRole('link', { name: /^编辑 /u }).count(), 0)
  assert.equal(await owner.getByRole('button', { name: /永久删除/u }).count(), 0)

  await readyInventory(second, inventoryPath, '文章管理')
  await second.getByRole('heading', { name: secondTitle, exact: true }).waitFor()
  await second.getByText('共 1 篇', { exact: true }).waitFor()
  assert.equal(await second.getByText(articles.at(-1).title, { exact: true }).count(), 0)
  const fit = await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
  assert.equal(fit, true, 'Narrow inventory must fit without page overflow.')
  await second.getByRole('region', { name: '文章列表' }).getByText('草稿', { exact: true }).waitFor()
  await second.screenshot({ path: join(evidence, 'author-inventory-mobile.png'), animations: 'disabled' })
  await second.getByRole('link', { name: '回收站', exact: true }).click()
  await second.getByText('回收站没有匹配的文章', { exact: true }).waitFor()
  assert.equal(await second.getByText(published.title, { exact: true }).count(), 0)
  const foreignRestore = await submitCommand(mobile, WireRoutes.Restore, { id: published.id,
    expectedRevision: updated.revision + 1n, title: '', body: '' })
  assert.equal(foreignRestore.status(), 404)

  await owner.getByRole('button', { name: `恢复文章 ${published.title}`, exact: true }).click()
  const restoreDialog = owner.getByRole('dialog', { name: '恢复文章', exact: true })
  await restoreDialog.getByText('恢复后可继续编辑，文章保持非公开状态。', { exact: true }).waitFor()
  await owner.screenshot({ path: join(evidence, 'author-inventory-restore.png'), animations: 'disabled' })
  const acceptedRestore = mutationResponse(owner, WireRoutes.Restore)
  await restoreDialog.getByRole('button', { name: '恢复文章', exact: true }).click()
  const restored = await acceptedRestore
  assert.equal(restored.status(), 200)
  const restoredFrame = decodeFrame(await restored.body())
  assert.equal(restoredFrame.type, FrameType.Draft)
  const recovered = decodeDraft(restoredFrame.payload)
  assert.equal(recovered.revision, updated.revision + 2n)
  assert.equal(recovered.body, updated.body)
  assert.equal(recovered.published, false)
  await owner.getByText('回收站没有匹配的文章', { exact: true }).waitFor()
  await owner.getByRole('link', { name: '文章列表', exact: true }).click()
  await owner.getByRole('link', { name: `编辑 ${published.title}`, exact: true }).waitFor()
  const restoredRow = owner.locator('li').filter({ has: owner.getByRole('heading', { name: published.title, exact: true }) })
  await restoredRow.getByText('已撤回', { exact: true }).waitFor()
  assert.equal((await anonymous.request.get(publicUrl)).status(), 404)
  assert.equal((await anonymous.request.get(publicApi)).status(), 404)

  assert.deepEqual(errors.flat(), [])
  await writeFile(join(evidence, 'author-inventory-result.json'), JSON.stringify({
    started, finished: new Date().toISOString(), browser: browser.version(), desktop: '1280×900', mobile: '375×812',
    completed: ['anonymous route and API denial', 'owner list and trash', 'second author isolation', 'title and summary-only filtering', 'keyset next page',
      'edit handoff', 'narrow layout', 'cancelled delete', 'stale delete and reload', 'published article withdrawal',
      'restore preserves saved content and remains private'],
  }, null, 2) + '\n')
} finally {
  await browser.close()
}

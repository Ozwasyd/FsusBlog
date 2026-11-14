import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeDraft, encodeArticleCommand, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const tools = createRequire(new URL('../../src/Web/package.json', import.meta.url))
const { chromium } = tools('@playwright/test')
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

async function command(context, path, article, expected = FrameType.Draft) {
  const frame = encodeFrame(FrameType.ArticleCommand, encodeArticleCommand({ idempotencyKey: randomUUID(), ...article }))
  const response = await context.request.post(new URL(path, origin).href, {
    data: Buffer.from(frame), headers: { 'content-type': 'application/octet-stream' },
  })
  assert.equal(response.status(), 200, `Article command ${path}`)
  const wire = decodeFrame(await response.body())
  assert.equal(wire.type, expected)
  return expected === FrameType.Draft ? decodeDraft(wire.payload) : null
}

async function draft(context, title) {
  return command(context, WireRoutes.Save, { id: 0, expectedRevision: 0n, title, body: 'Private browser fixture body.' })
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
  for (let i = 1; i <= 21; i++) articles.push(await draft(desktop, `${ownerNeedle} ${String(i).padStart(2, '0')}`))
  const deleted = await draft(desktop, `${ownerNeedle} removed`)
  await command(desktop, WireRoutes.Delete, { id: deleted.id, expectedRevision: deleted.revision, title: '', body: '' }, FrameType.EmptySuccess)
  await draft(mobile, secondTitle)

  await readyInventory(owner, inventoryPath, '文章管理')
  await owner.getByText('共 21 篇', { exact: true }).waitFor()
  await owner.getByRole('heading', { name: articles.at(-1).title, exact: true }).waitFor()
  assert.equal(await owner.getByRole('heading', { name: articles[0].title, exact: true }).count(), 0)
  assert.equal(await owner.getByText(secondTitle, { exact: true }).count(), 0)
  assert.equal(await owner.getByText(deleted.title, { exact: true }).count(), 0)
  await owner.getByRole('region', { name: '文章列表' }).getByText('草稿', { exact: true }).first().waitFor()
  await owner.screenshot({ path: join(evidence, 'author-inventory-desktop.png'), animations: 'disabled' })
  await owner.getByRole('button', { name: '下一页' }).click()
  await owner.getByText('第 2 页', { exact: true }).waitFor()
  await owner.getByRole('heading', { name: articles[0].title, exact: true }).waitFor()
  await owner.getByLabel('文章标题', { exact: true }).fill(articles[10].title)
  await owner.getByRole('form', { name: '筛选文章' }).getByRole('button', { name: '搜索', exact: true }).click()
  await owner.getByText('共 1 篇', { exact: true }).waitFor()
  const edit = owner.getByRole('link', { name: `编辑 ${articles[10].title}`, exact: true })
  assert.equal(await edit.getAttribute('href'), `/user/manage/article/edit/${articles[10].id}`)
  await edit.click()
  await owner.waitForURL(url => url.pathname === `/user/manage/article/edit/${articles[10].id}`)
  await owner.waitForFunction(title => document.querySelector('#article-title')?.value === title, articles[10].title)
  await owner.getByRole('link', { name: '文章管理', exact: true }).first().click()
  await owner.waitForURL(url => url.pathname === inventoryPath)
  await owner.getByRole('link', { name: '回收站', exact: true }).click()
  await owner.waitForURL(url => url.pathname === trashPath)
  await owner.getByRole('heading', { name: deleted.title, exact: true }).waitFor()
  assert.equal(await owner.getByRole('link', { name: /^编辑 /u }).count(), 0)
  assert.equal(await owner.getByRole('button', { name: /恢复|永久删除/u }).count(), 0)

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
  assert.equal(await second.getByText(deleted.title, { exact: true }).count(), 0)

  assert.deepEqual(errors.flat(), [])
  await writeFile(join(evidence, 'author-inventory-result.json'), JSON.stringify({
    started, finished: new Date().toISOString(), browser: browser.version(), desktop: '1280×900', mobile: '375×812',
    completed: ['anonymous route and API denial', 'owner list and read-only trash', 'second author isolation', 'title filtering', 'keyset next page', 'edit handoff', 'narrow layout'],
  }, null, 2) + '\n')
} finally {
  await browser.close()
}

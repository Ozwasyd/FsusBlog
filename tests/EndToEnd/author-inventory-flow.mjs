import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeDraft, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { chromium, submitArticle } from './browser-authoring-fixture.mjs'
import { exactButton, roleWithExactName, exactLabel, exactText } from './role-locators.mjs'

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
  await exactButton(page, 'Log in').click()
  assert.equal((await accepted).status(), 200)
  await page.waitForURL(url => url.pathname !== '/login')
}

async function readyInventory(page, path, title) {
  const response = await page.goto(new URL(path, origin).href)
  assert.equal(response.status(), 200)
  await roleWithExactName(page, 'heading', title).waitFor()
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
  await exactText(anonymous, '请先登录作者账号').waitFor()
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
  await exactText(owner, '共 22 篇').waitFor()
  await roleWithExactName(owner, 'heading', articles.at(-1).title).waitFor()
  assert.equal(await roleWithExactName(owner, 'heading', articles[0].title).count(), 0)
  assert.equal(await exactText(owner, secondTitle).count(), 0)
  await exactText(owner.getByRole('region', { name: '文章列表' }), '草稿').first().waitFor()
  await owner.screenshot({ path: join(evidence, 'author-inventory-desktop.png'), animations: 'disabled' })
  await owner.getByRole('button', { name: '下一页' }).click()
  await exactText(owner, '第 2 页').waitFor()
  await roleWithExactName(owner, 'heading', articles[0].title).waitFor()
  const keyword = exactLabel(owner, '标题或摘要')
  const search = exactButton(owner.getByRole('form', { name: '筛选文章' }), '搜索')
  await keyword.fill(articles[10].title)
  await search.click()
  await exactText(owner, '共 1 篇').waitFor()
  await roleWithExactName(owner, 'heading', articles[10].title).waitFor()
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
  await exactText(owner, '共 1 篇').waitFor()
  assert.equal(await roleWithExactName(owner, 'heading', secondTitle).count(), 0)
  const summaryArticle = articles[12]
  const edit = roleWithExactName(owner, 'link', `编辑 ${summaryArticle.title}`)
  assert.equal(await edit.getAttribute('href'), `/user/manage/article/edit/${summaryArticle.id}`)
  assert.equal(await roleWithExactName(owner, 'heading', articles[10].title).count(), 0)
  await edit.click()
  await owner.waitForURL(url => url.pathname === `/user/manage/article/edit/${summaryArticle.id}`)
  await owner.waitForFunction(title => document.querySelector('#article-title')?.value === title, summaryArticle.title)
  await roleWithExactName(owner, 'link', 'Manage articles').first().click()
  await owner.waitForURL(url => url.pathname === inventoryPath)
  const deleteButton = exactButton(owner, `移至回收站 ${published.title}`)
  const deleteDialog = roleWithExactName(owner, 'dialog', '移至回收站')
  await deleteButton.click()
  await exactText(deleteDialog, `「${published.title}」`).waitFor()
  await exactButton(deleteDialog, '取消').click()
  await deleteDialog.waitFor({ state: 'hidden' })
  assert.equal((await anonymous.request.get(publicUrl)).status(), 200)

  const updated = await command(desktop, WireRoutes.Save, { id: published.id, expectedRevision: published.revision,
    title: published.title, body: 'An updated private revision is preserved on restore.' })
  await deleteButton.click()
  const staleDelete = mutationResponse(owner, WireRoutes.Delete)
  await exactButton(deleteDialog, '移至回收站').click()
  assert.equal((await staleDelete).status(), 409)
  await exactText(owner, '文章状态已变更。请在更新后的列表中确认后再操作。').waitFor()
  assert.equal((await anonymous.request.get(publicApi)).status(), 200)

  await deleteButton.click()
  const acceptedDelete = mutationResponse(owner, WireRoutes.Delete)
  await exactButton(deleteDialog, '移至回收站').click()
  assert.equal((await acceptedDelete).status(), 200)
  await exactText(owner, '文章已移至回收站。').waitFor()
  await exactText(owner, '共 21 篇').waitFor()
  assert.equal(await roleWithExactName(owner, 'heading', published.title).count(), 0)
  assert.equal((await anonymous.request.get(publicUrl)).status(), 404)
  assert.equal((await anonymous.request.get(publicApi)).status(), 404)

  await roleWithExactName(owner, 'link', '回收站').click()
  await owner.waitForURL(url => url.pathname === trashPath)
  await roleWithExactName(owner, 'heading', published.title).waitFor()
  assert.equal(await owner.getByRole('link', { name: /^编辑 /u }).count(), 0)
  assert.equal(await owner.getByRole('button', { name: /永久删除/u }).count(), 0)

  await readyInventory(second, inventoryPath, '文章管理')
  await roleWithExactName(second, 'heading', secondTitle).waitFor()
  await exactText(second, '共 1 篇').waitFor()
  assert.equal(await exactText(second, articles.at(-1).title).count(), 0)
  const fit = await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
  assert.equal(fit, true, 'Narrow inventory must fit without page overflow.')
  await exactText(second.getByRole('region', { name: '文章列表' }), '草稿').waitFor()
  await second.screenshot({ path: join(evidence, 'author-inventory-mobile.png'), animations: 'disabled' })
  await roleWithExactName(second, 'link', '回收站').click()
  await exactText(second, '回收站没有匹配的文章').waitFor()
  assert.equal(await exactText(second, published.title).count(), 0)
  const foreignRestore = await submitCommand(mobile, WireRoutes.Restore, { id: published.id,
    expectedRevision: updated.revision + 1n, title: '', body: '' })
  assert.equal(foreignRestore.status(), 404)

  await exactButton(owner, `恢复文章 ${published.title}`).click()
  const restoreDialog = roleWithExactName(owner, 'dialog', '恢复文章')
  await exactText(restoreDialog, '恢复后可继续编辑，文章保持非公开状态。').waitFor()
  await owner.screenshot({ path: join(evidence, 'author-inventory-restore.png'), animations: 'disabled' })
  const acceptedRestore = mutationResponse(owner, WireRoutes.Restore)
  await exactButton(restoreDialog, '恢复文章').click()
  const restored = await acceptedRestore
  assert.equal(restored.status(), 200)
  const restoredFrame = decodeFrame(await restored.body())
  assert.equal(restoredFrame.type, FrameType.Draft)
  const recovered = decodeDraft(restoredFrame.payload)
  assert.equal(recovered.revision, updated.revision + 2n)
  assert.equal(recovered.body, updated.body)
  assert.equal(recovered.published, false)
  await exactText(owner, '回收站没有匹配的文章').waitFor()
  await roleWithExactName(owner, 'link', '文章列表').click()
  await roleWithExactName(owner, 'link', `编辑 ${published.title}`).waitFor()
  const restoredRow = owner.locator('li').filter({ has: roleWithExactName(owner, 'heading', published.title) })
  await exactText(restoredRow, '已撤回').waitFor()
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

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function exercisePropertyFilter(publisher, origin, article, exactScore, observations) {
  const page = await publisher.context().newPage()
  try {
    await page.goto(`${origin}/user/manage/article/list`)
    await page.getByText('按文章属性筛选', { exact: true }).click()
    const field = async name => {
      await page.getByRole('combobox', { name: '属性字段', exact: true }).click()
      await page.getByRole('option', { name, exact: true }).click()
    }
    const pickScore = () => field('Editorial score · editorial-score')
    await pickScore()
    await page.getByRole('button', { name: '启用此字段的筛选' }).click()
    await page.getByRole('button', { name: '停用此字段的筛选' }).waitFor()
    await page.getByLabel('属性值', { exact: true }).fill(exactScore)
    const result = page.getByRole('region', { name: '属性筛选结果' })
    const response = page.waitForResponse(item => new URL(item.url()).pathname === WireRoutes.PropertyArticleQuery)
    await page.getByRole('button', { name: '筛选属性', exact: true }).click()
    assert.equal((await response).status(), 200)
    await result.getByRole('link', { name: article.title, exact: true }).waitFor()
    assert.equal(await result.getByRole('link').count(), 1)
    assert.equal(await result.getByRole('link').getAttribute('href'), `/user/manage/article/edit/${article.id}`)
    await page.getByLabel('属性值', { exact: true }).fill('0')
    await result.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '筛选属性', exact: true }).click()
    await result.getByText('没有匹配的文章。').waitFor()
    const replacement = process.env.FSUSBLOG_TEST_PROPERTY_PEER_TICKET
    if (replacement) await verifyLateReply(publisher, origin, exactScore, replacement, observations)

    await page.setViewportSize({ width: 375, height: 850 })
    await field('Editorial date · editorial-date')
    await page.getByRole('button', { name: '启用此字段的筛选' }).click()
    await page.getByRole('button', { name: '停用此字段的筛选' }).waitFor()
    const comparison = async name => {
      await page.getByRole('combobox', { name: '匹配方式', exact: true }).click()
      await page.getByRole('option', { name, exact: true }).click()
    }
    await comparison('早于或等于')
    await page.getByLabel('属性值', { exact: true }).fill('2024-02-29T17:06:01.150Z')
    await page.getByRole('button', { name: '添加条件', exact: true }).click()
    await pickScore()
    await comparison('大于或等于')
    await page.getByLabel('属性值', { exact: true }).fill(exactScore)
    await page.getByRole('button', { name: '匹配全部条件', exact: true }).click()
    await result.getByRole('link', { name: article.title, exact: true }).waitFor()
    assert.equal(await result.getByRole('link').count(), 1)
    if (process.env.FSUSBLOG_TEST_EVIDENCE)
      await page.screenshot({ path: join(process.env.FSUSBLOG_TEST_EVIDENCE, 'property-range-mobile.png') })
    await verifySavedView(page, article, observations)
    await comparison('大于')
    await result.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '匹配全部条件', exact: true }).click()
    await result.getByText('没有匹配的文章。').waitFor()
    await page.getByRole('button', { name: '移除第 1 个筛选条件', exact: true }).click()
    await result.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '停用此字段的筛选' }).click()
    await page.getByRole('button', { name: '启用此字段的筛选' }).waitFor()
    assert.equal(await result.count(), 0)
    observations.push('The private author collection opts a saved typed field into exact filtering, distinguishes the full decimal value from zero, and clears disabled results.')
    observations.push('The author collection combines a UTC date bound and an exact decimal bound, distinguishes inclusive from strict comparison, and clears results when a condition changes at 375px.')
  } finally {
    await page.close()
  }
}

async function verifySavedView(page, article, observations) {
  const label = 'Editorial checklist'
  const renamed = 'Editorial review'
  const section = page.getByRole('region', { name: '保存视图结果' })
  const toggle = page.getByText('保存视图', { exact: true })
  const name = page.getByLabel('保存视图名称', { exact: true })
  const view = page.getByRole('combobox', { name: '选择保存视图', exact: true })
  await toggle.click()
  await name.fill(label)
  await page.getByRole('button', { name: '保存当前筛选', exact: true }).click()
  await page.getByRole('button', { name: '打开保存视图', exact: true }).waitFor()
  await toggle.click()
  await view.waitFor({ state: 'hidden' })
  await toggle.click()
  await view.click()
  await page.getByRole('option', { name: label, exact: true }).click()
  await page.getByRole('button', { name: '打开保存视图', exact: true }).click()
  await section.getByRole('link', { name: article.title, exact: true }).waitFor()
  assert.equal(await section.getByRole('link').count(), 1)
  assert.equal(await section.getByRole('link').getAttribute('href'), `/user/manage/article/edit/${article.id}`)
  const stableLink = await page.getByRole('link', { name: '保存视图链接', exact: true }).getAttribute('href')
  if (process.env.FSUSBLOG_TEST_EVIDENCE)
    await page.screenshot({ path: join(process.env.FSUSBLOG_TEST_EVIDENCE, 'saved-views-mobile.png') })
  await name.fill(renamed)
  await page.getByRole('button', { name: '重命名保存视图', exact: true }).click()
  await name.waitFor()
  await page.getByRole('button', { name: '打开保存视图', exact: true }).click()
  await section.getByRole('link', { name: article.title, exact: true }).waitFor()
  const firstLink = await page.getByRole('link', { name: '保存视图链接', exact: true }).getAttribute('href')
  assert.equal(firstLink, stableLink)
  await page.getByRole('button', { name: '固定视图', exact: true }).click()
  await page.getByRole('button', { name: '取消固定视图', exact: true }).waitFor()
  await page.getByRole('button', { name: '设为默认视图', exact: true }).click()
  await page.getByRole('button', { name: '清除默认视图', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '移除保存视图', exact: true }).isEnabled(), false)

  await view.click()
  await page.getByRole('option', { name: '新建保存视图', exact: true }).click()
  await name.fill('Peer editorial checklist')
  await page.getByRole('button', { name: '保存当前筛选', exact: true }).click()
  await page.getByRole('button', { name: '固定视图', exact: true }).click()
  await page.getByRole('button', { name: '上移固定视图', exact: true }).focus()
  await page.keyboard.press('Enter')
  const rail = page.getByRole('navigation', { name: '固定视图' })
  await rail.getByRole('link').first().filter({ hasText: 'Peer editorial checklist' }).waitFor()
  await page.getByRole('button', { name: '下移固定视图', exact: true }).and(page.locator(':focus')).waitFor()
  const peerLink = await rail.getByRole('link').first().getAttribute('href')
  assert(firstLink && peerLink && firstLink !== peerLink)
  assert.match(peerLink, /\?view=[0-9a-f-]{36}&viewSchema=1$/)

  const linked = await page.context().newPage()
  try {
    const origin = new URL(page.url()).origin
    const output = linked.getByRole('region', { name: '保存视图结果' })
    const pinned = linked.getByRole('navigation', { name: '固定视图' })
    const control = text => linked.getByRole('button', { name: text, exact: true })
    await linked.setViewportSize({ width: 375, height: 850 })
    await linked.goto(new URL(peerLink, origin).href)
    await output.getByRole('heading', { name: 'Peer editorial checklist', exact: true }).and(linked.locator(':focus')).waitFor()
    await control('移除保存视图').click()
    const retire = linked.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.SavedViews &&
      response.request().method() === 'POST')
    await control('确认移除视图').click()
    assert.equal((await retire).status(), 200)
    await output.waitFor({ state: 'detached' })
    await control('打开保存视图').waitFor({ state: 'hidden' })
    await pinned.getByRole('link', { name: `${renamed}（默认）`, exact: true }).waitFor()
    await linked.goto(new URL(peerLink, origin).href)
    await linked.getByText('Saved view is unavailable.', { exact: true }).waitFor()
    assert.equal(await output.count(), 0)
    await linked.goto(new URL(peerLink.replace('viewSchema=1', 'viewSchema=2'), origin).href)
    await linked.getByText('保存视图链接无效。', { exact: true }).waitFor()
    assert.equal(await output.count(), 0)
    await linked.getByRole('link', { name: '返回全部视图', exact: true }).click()
    await linked.getByText('保存视图', { exact: true }).click()
    await output.getByRole('heading', { name: renamed, exact: true }).waitFor()
    await control('清除默认视图').click()
    await control('设为默认视图').waitFor()
    await control('移除保存视图').click()
    const retireDefault = linked.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.SavedViews &&
      response.request().method() === 'POST')
    await control('确认移除视图').click()
    assert.equal((await retireDefault).status(), 200)
    await control('打开保存视图').waitFor({ state: 'hidden' })
    await linked.getByRole('link', { name: `${renamed}（默认）`, exact: true }).waitFor({ state: 'hidden' })
    await linked.getByRole('combobox', { name: '选择保存视图', exact: true }).click()
    assert.equal(await linked.getByRole('option', { name: renamed, exact: true }).count(), 0)
  } finally {
    await linked.close()
  }
  observations.push('At 375px, private saved views preserve the date/decimal query, pin and reorder with the keyboard, resolve explicit deep links, and never fall back to the still-active default for invalid or retired links.')
}

async function verifyLateReply(publisher, origin, exactScore, replacement, observations) {
  const owner = publisher.context()
  const context = await owner.browser().newContext({ storageState: await owner.storageState() })
  try {
    const page = await context.newPage()
    await page.goto(`${origin}/user/manage/article/list`)
    await page.getByText('按文章属性筛选', { exact: true }).click()
    await page.getByRole('combobox', { name: '属性字段', exact: true }).click()
    await page.getByRole('option', { name: 'Editorial score · editorial-score' }).click()
    await page.getByLabel('属性值', { exact: true }).fill(exactScore)
    await page.evaluate(path => {
      const fetch = window.fetch
      window.fetch = (url, options) => url === path ? new Promise(resolve => {
        window.pendingPropertyReply = {
          signal: options.signal,
          deliver: () => resolve(new Response(null, { status: 401 })),
        }
      }) : fetch(url, options)
    }, WireRoutes.PropertyArticleQuery)
    await page.getByRole('button', { name: '筛选属性', exact: true }).click()
    await page.waitForFunction(() => !!window.pendingPropertyReply)

    await page.getByRole('link', { name: '回收站', exact: true }).click()
    await page.getByRole('heading', { name: '回收站', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.pendingPropertyReply.signal.aborted), true)

    await context.clearCookies()
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')))
    await page.getByRole('main').getByRole('link', { name: '登录', exact: true }).click()
    await page.getByLabel('Owner access key').fill(replacement)
    await page.getByRole('button', { name: 'Log in', exact: true }).click()
    await page.getByRole('heading', { name: 'New article', exact: true }).waitFor()
    await page.evaluate(async () => {
      window.pendingPropertyReply.deliver()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await page.getByRole('link', { name: '文章管理', exact: true }).click()
    await page.getByText('按文章属性筛选', { exact: true }).click()
    await page.getByText('请先在文章编辑器中创建属性定义。', { exact: true }).waitFor()
    observations.push('Leaving the filter cancels its pending request, and its late 401 cannot clear a different signed-in author.')
  } finally {
    await context.close()
  }
}

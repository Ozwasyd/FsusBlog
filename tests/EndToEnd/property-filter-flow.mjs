import assert from 'node:assert/strict'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function exercisePropertyFilter(publisher, origin, article, exactScore, observations) {
  const page = await publisher.context().newPage()
  try {
    await page.goto(`${origin}/user/manage/article/list`)
    await page.getByText('按文章属性筛选', { exact: true }).click()
    const pickScore = async () => {
      await page.getByRole('combobox', { name: '属性字段', exact: true }).click()
      await page.getByRole('option', { name: 'Editorial score · editorial-score' }).click()
    }
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
    await page.getByRole('button', { name: '停用此字段的筛选' }).click()
    await page.getByRole('button', { name: '启用此字段的筛选' }).waitFor()
    assert.equal(await result.count(), 0)
    observations.push('The private author collection opts a saved typed field into exact filtering, distinguishes the full decimal value from zero, and clears disabled results.')
  } finally {
    await page.close()
  }
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

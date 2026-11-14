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
    await page.getByRole('button', { name: '停用此字段的筛选' }).click()
    await page.getByRole('button', { name: '启用此字段的筛选' }).waitFor()
    assert.equal(await result.count(), 0)
    observations.push('The private author collection opts a saved typed field into exact filtering, distinguishes the full decimal value from zero, and clears disabled results.')
  } finally {
    await page.close()
  }
}

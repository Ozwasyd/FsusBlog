import assert from 'node:assert/strict'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAuthorTextSearchPage } from '../../src/Contracts/author-text-search.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function exerciseAuthorTextSearch({ publisher, origin, article, bodyTerm, monitor, observations }) {
  const page = await publisher.context().newPage()
  try {
    monitor(page, 'author-full-text')
    await page.setViewportSize({ width: 375, height: 850 })
    await page.goto(`${origin}/user/manage/article/list`)
    const inventory = page.getByRole('form', { name: '筛选文章', exact: true })
    await inventory.getByLabel('标题或摘要', { exact: true }).fill(bodyTerm)
    await inventory.getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByRole('region', { name: '文章列表', exact: true }).getByText('共 0 篇', { exact: true }).waitFor()

    await page.getByText('作者全文搜索', { exact: true }).click()
    const form = page.getByRole('form', { name: '作者全文搜索', exact: true })
    const query = form.getByLabel('全文搜索词', { exact: true })
    const start = form.getByRole('button', { name: '搜索全文', exact: true })
    const next = form.getByRole('button', { name: '继续搜索', exact: true })
    const results = page.getByRole('region', { name: '全文搜索结果', exact: true })
    async function search(text) {
      await query.fill(text)
      await results.waitFor({ state: 'detached' })
      for (let attempt = 0; attempt < 16; attempt++) {
        const reply = page.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.AuthorTextSearch &&
          response.request().method() === 'POST')
        await (attempt === 0 ? start : next).click()
        const response = await reply
        assert.equal(response.status(), 200)
        const frame = decodeFrame(await response.body())
        assert.equal(frame.type, FrameType.AuthorTextSearchPage)
        const batch = decodeAuthorTextSearchPage(frame.payload)
        if (batch.ready) { await results.waitFor(); return }
        await next.waitFor()
        assert.equal(await results.count(), 0, 'Incomplete index batches must not render partial results')
      }
      assert.fail('The isolated author fixture index was not ready after 16 batches')
    }

    async function verifyBodyMatch() {
      const link = results.getByRole('link', { name: article.title, exact: true })
      assert.equal(await link.getAttribute('href'), `/user/manage/article/edit/${article.id}`)
      assert.equal(await results.getByRole('listitem').count(), 1)
      await results.getByText('正文', { exact: true }).waitFor()
      assert.equal(await results.locator('mark').textContent(), bodyTerm)
    }

    await search(bodyTerm.toUpperCase())
    await verifyBodyMatch()
    await search(`"${bodyTerm} 博客搜索"`)
    await verifyBodyMatch()
    await search(`"博客搜索 ${bodyTerm}"`)
    await results.getByText('没有匹配的文章。', { exact: true }).waitFor()
    assert.equal(new URL(page.url()).search, '')
    observations.push('At 375px before publication, author full-text finds and highlights a saved body word beyond the inventory summary, folds its case, and matches the quoted mixed-script phrase only in source order.')
  } finally {
    await page.close()
  }
}

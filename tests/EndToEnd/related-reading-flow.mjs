import assert from 'node:assert/strict'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeRelatedReading } from '../../src/Contracts/related-reading.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function exerciseRelatedReading(page, articleId, articleTitle, origin) {
  const path = WireRoutes.PublicRelatedReading.replace('{articleId:int}', String(articleId))
  const response = await page.request.get(origin + path)
  assert.equal(response.status(), 200)
  assert.equal(response.headers()['cache-control'], 'no-store')
  const reading = decodeRelatedReading(decodeFrame(await response.body(), FrameType.ArticleRelatedReading).payload)
  assert(reading.related.some(item => item.title === 'Browser fixture 12'))
  assert(!reading.related.some(item => item.title === 'Browser fixture 11'))
  assert.equal(reading.previous?.title, 'Browser fixture 12')
  assert.equal(reading.next, null)
  const nav = page.getByRole('navigation', { name: 'Related articles' })
  const previous = nav.locator('[data-related-role="previous"]')
  await previous.waitFor()
  assert.equal(await nav.getByRole('link').count(), 1)
  assert.equal(await previous.getAttribute('aria-label'), 'Previous article · Browser fixture 12')
  await previous.focus()
  await previous.press('Enter')
  await page.waitForURL(new URL(`/article/${reading.previous.id}`, origin).href)
  await page.getByRole('heading', { name: 'Browser fixture 12', exact: true }).waitFor()
  const next = nav.locator('[data-related-role="next"]')
  await next.waitFor()
  assert.equal(await next.getAttribute('aria-label'), `Next article · ${articleTitle}`)
  await next.click()
  await page.waitForURL(new URL(`/article/${articleId}`, origin).href)
  await page.getByRole('heading', { name: articleTitle, exact: true }).waitFor()
  return reading.previous.id
}

export async function verifyRelatedWithdrawal(page, articleId, previousId, origin) {
  const withdrawn = await page.request.get(origin + WireRoutes.PublicRelatedReading.replace('{articleId:int}', String(articleId)))
  assert.equal(withdrawn.status(), 404)
  assert.equal(decodeFrame(await withdrawn.body()).type, FrameType.ApiError)
  if (previousId === undefined) return
  const source = await page.request.get(origin + WireRoutes.PublicRelatedReading.replace('{articleId:int}', String(previousId)))
  assert.equal(source.status(), 200)
  const reading = decodeRelatedReading(decodeFrame(await source.body(), FrameType.ArticleRelatedReading).payload)
  assert(![...reading.related, reading.previous, reading.next].some(item => item?.id === articleId))
}

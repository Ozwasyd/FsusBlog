import assert from 'node:assert/strict'
import { decodeRelatedReading } from '../../src/Contracts/related-reading.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { assertApiError, assertNoStore, readFrame } from './response-status-fixture.mjs'
import { roleWithExactName } from './role-locators.mjs'

const relatedUrl = (origin, id) => origin + WireRoutes.PublicRelatedReading.replace('{articleId:int}', String(id))

export async function exerciseRelatedReading(page, articleId, articleTitle, origin) {
  const response = await page.request.get(relatedUrl(origin, articleId))
  await assertNoStore(response)
  const reading = await readFrame(response, FrameType.ArticleRelatedReading, decodeRelatedReading)
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
  await roleWithExactName(page, 'heading', 'Browser fixture 12').waitFor()
  const next = nav.locator('[data-related-role="next"]')
  await next.waitFor()
  assert.equal(await next.getAttribute('aria-label'), `Next article · ${articleTitle}`)
  await next.click()
  await page.waitForURL(new URL(`/article/${articleId}`, origin).href)
  await roleWithExactName(page, 'heading', articleTitle).waitFor()
  return reading.previous.id
}

export async function verifyRelatedWithdrawal(page, articleId, previousId, origin) {
  await assertApiError(await page.request.get(relatedUrl(origin, articleId)), 404)
  if (previousId === undefined) return
  const reading = await readFrame(await page.request.get(relatedUrl(origin, previousId)),
    FrameType.ArticleRelatedReading, decodeRelatedReading)
  assert(![...reading.related, reading.previous, reading.next].some(item => item?.id === articleId))
}

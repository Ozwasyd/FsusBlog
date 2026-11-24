import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { decodeFrame, decodeSuccess } from '../../src/Contracts/aeds.ts'
import { decodeArticleHot } from '../../src/Contracts/article-hot.ts'
import { decodeArticle } from '../../src/Contracts/public-articles.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export function assertStatus(response, expected, ...message) {
  assert.equal(response.status(), expected, ...message)
}

export async function assertGetStatus(request, url, expected, ...message) {
  assertStatus(await request.get(url), expected, ...message)
}

export async function assertGetAll(request, expected, urls) {
  for (const url of urls) assertStatus(await request.get(url), expected)
}

export function assertNoneIn(bytes, ...texts) {
  for (const text of texts) assert.equal(bytes.includes(Buffer.from(text)), false)
}

export function assertFields(actual, expected) {
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, key)
}

export function assertHeaders(response, expected) {
  const headers = response.headers()
  for (const [key, value] of Object.entries(expected)) assert.equal(headers[key], value, key)
}

export async function readFrame(response, type, decode, expected = 200) {
  assertStatus(response, expected)
  const payload = decodeFrame(await response.body(), type).payload
  return decode ? decode(payload) : payload
}

export async function readNoStoreFrame(response, type, decode, expected = 200) {
  await assertNoStore(response)
  return readFrame(response, type, decode, expected)
}

export async function getFrame(request, url, type, decode, options, expected = 200) {
  const response = await request.get(url, options)
  try { return await readFrame(response, type, decode, expected) }
  finally { await response.dispose() }
}

export async function assertEmpty(response) {
  await readFrame(response, FrameType.EmptySuccess, decodeSuccess)
}

export async function assertApiError(response, expected, ...forbidden) {
  assertStatus(response, expected)
  const bytes = await response.body()
  const payload = decodeFrame(bytes, FrameType.ApiError).payload
  assertNoneIn(bytes, ...forbidden)
  return { bytes, payload }
}

export const decodeJsonFrame = (bytes, type) => JSON.parse(Buffer.from(decodeFrame(bytes, type).payload).toString('utf8'))

export async function readJsonFrame(response, type, expected = 200) {
  return JSON.parse(Buffer.from(await readFrame(response, type, undefined, expected)).toString('utf8'))
}

export function fetchPublicArticle(request, origin, id) {
  return getFrame(request, origin + WireRoutes.PublicArticle.replace('{id}', String(id)), FrameType.ArticleDetail, decodeArticle)
}

export async function pollHotRanking(origin, fetcher = fetch) {
  const hotPath = WireRoutes.PublicArticleHot.replace('{size}', '10')
  const signal = AbortSignal.timeout(2500)
  for (;;) {
    const response = await fetcher(new URL(hotPath, origin), { signal })
    if (response.status === 503) {
      await response.body?.cancel()
      await delay(20, undefined, { signal })
      continue
    }
    assert.equal(response.status, 200)
    const items = decodeArticleHot(decodeFrame(new Uint8Array(await response.arrayBuffer()), FrameType.ArticleHot).payload)
    const generation = response.headers.get(WireHeaders.SearchIndexGeneration)
    assert(generation, 'The ranking must bind to a public generation')
    return { items, generation }
  }
}

export async function assertNoStore(response, message) {
  const headers = 'allHeaders' in response ? await response.allHeaders() : response.headers()
  assert(headers['cache-control']?.includes('no-store'), message)
}

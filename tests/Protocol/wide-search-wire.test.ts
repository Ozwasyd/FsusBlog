import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { ApiError, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts'
import { FrameType, WireHeaders, WireLayouts as L, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import {
  fetchWideSearchManifest, fetchWideSearchPage, verifyWideSearchGeneration, verifyWideSearchPageBytes,
} from '../../src/Web/src/wideSearchWire.ts'
import { apiErrorResponse, hexBytes, sha256Hex } from './fixture-source.ts'

type FixturePage = { first: number; last: number; count: number; bytes: Uint8Array<ArrayBuffer> }
const generation = '9223372036854775807'
const pages: FixturePage[] = [
  { first: 42, last: 42, count: 1, bytes: new Uint8Array(180).fill(7) },
  { first: 48, last: 51, count: 2, bytes: new Uint8Array(256).fill(9) },
]

test('wide transport verifies the independent manifest and pinned streamed page and HEAD', async t => {
  const fixture = manifestFrame(pages)
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', (path: string, init: RequestInit) => {
    assert.equal(init.cache, 'no-store')
    assert.equal(init.credentials, 'omit')
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(new Headers(init.headers).get('Accept'), 'application/octet-stream')
    requests.push(`${init.method} ${path}`)
    if (init.method === 'HEAD') return new Response(null, { status: 204, headers: fixture.headers })
    if (path === WireRoutes.PublicSearchWideManifest) return packet(fixture.frame, fixture.headers)
    return packet(pages[1].bytes, { ...fixture.headers, ETag: `"${sha256Hex(pages[1].bytes)}"` })
  })
  const manifest = await fetchWideSearchManifest()
  assert.equal(manifest.generation, generation)
  assert.equal(manifest.digest, fixture.digest)
  assert.equal(manifest.pageCount, 2)
  assert.equal(manifest.documentCount, 3)
  assert.equal(manifest.byteCount, 436)
  assert(Object.isFrozen(manifest) && Object.isFrozen(manifest.pages))
  const second = manifest.pages[1]
  assert(Object.isFrozen(second))
  assert.deepEqual(second, {
    number: 2, documentCount: 2, firstArticleId: 48, lastArticleId: 51, offset: 180, length: 256, sha256: sha256Hex(pages[1].bytes),
  })
  const bytes = await fetchWideSearchPage(manifest, second)
  assert.deepEqual(bytes, pages[1].bytes)
  await verifyWideSearchPageBytes(second, bytes)
  await verifyWideSearchGeneration(manifest)
  const pins = `generation=${generation}&digest=${fixture.digest}`
  assert.deepEqual(requests, [
    `GET ${WireRoutes.PublicSearchWideManifest}`,
    `GET ${WireRoutes.PublicSearchWidePage.replace('{page}', '2')}?${pins}`,
    `HEAD ${WireRoutes.PublicSearchWideManifest}?${pins}`,
  ])
})

test('manifest parsing rejects wrong coordinates, totals, independent digest and stale headers', async t => {
  const good = manifestFrame(pages)
  let respond = () => packet(good.frame, good.headers)
  t.mock.method(globalThis, 'fetch', () => respond())
  await fetchWideSearchManifest()
  const entry2 = L.SearchWideManifestHeaderSize + L.SearchWideManifestPageRecordSize
  for (const change of [
    (v: DataView) => v.setInt32(entry2 + 8, 42, true), (v: DataView) => v.setBigInt64(entry2 + 16, 181n, true),
    (v: DataView) => v.setInt32(entry2 + 4, 3, true), (v: DataView) => v.setInt32(entry2 + 24, 255, true),
    (v: DataView) => v.setInt32(12, 4, true), (v: DataView) => v.setBigInt64(20, 437n, true),
  ]) {
    const malformed = manifestFrame(pages, change)
    respond = () => packet(malformed.frame, malformed.headers)
    await assert.rejects(fetchWideSearchManifest(), ProtocolError)
  }
  const badDigest = manifestFrame(pages, undefined, true)
  respond = () => packet(badDigest.frame, badDigest.headers)
  await assert.rejects(fetchWideSearchManifest(), /manifest digest/)
  for (const patch of [
    { 'Cache-Control': 'max-age=300' }, { Age: '2' },
    { [WireHeaders.SearchIndexGeneration]: '9223372036854775808' }, { [WireHeaders.SearchIndexGeneration]: '7' },
    { [WireHeaders.SearchCorpusDigest]: 'a'.repeat(64) },
    { [WireHeaders.SearchIndexPages]: '02' }, { [WireHeaders.SearchIndexPages]: '513' },
  ]) {
    respond = () => packet(good.frame, { ...good.headers, ...patch })
    await assert.rejects(fetchWideSearchManifest(), ProtocolError)
  }
  const empty = manifestFrame([{ first: 0, last: 0, count: 0, bytes: new Uint8Array(104) }])
  respond = () => packet(empty.frame, empty.headers)
  assert.equal((await fetchWideSearchManifest()).documentCount, 0)
})

test('page and HEAD fail closed on stale pins, noncanonical replies, and wrong body lengths', async t => {
  const fixture = manifestFrame(pages)
  const headers = { ...fixture.headers, ETag: `"${sha256Hex(pages[0].bytes)}"` }
  let respond = () => packet(fixture.frame, fixture.headers)
  t.mock.method(globalThis, 'fetch', () => respond())
  const manifest = await fetchWideSearchManifest()
  const page = manifest.pages[0]
  for (const patch of [
    { [WireHeaders.SearchIndexGeneration]: '51' }, { [WireHeaders.SearchIndexPages]: '1' },
    { [WireHeaders.SearchCorpusDigest]: '0'.repeat(64) }, { ETag: `W/${headers.ETag}` }, { 'Content-Type': 'text/plain' },
  ]) {
    respond = () => packet(pages[0].bytes, { ...headers, ...patch })
    await assert.rejects(fetchWideSearchPage(manifest, page), ProtocolError)
  }
  for (const [body, status] of [
    [pages[0].bytes.subarray(1), 200], [new Uint8Array(181), 200], [new Uint8Array(180), 200], [pages[0].bytes, 206],
  ] as const) {
    respond = () => packet(body, headers, status)
    await assert.rejects(fetchWideSearchPage(manifest, page), ProtocolError)
  }
  await assert.rejects(fetchWideSearchPage(manifest, { ...page }, undefined), ProtocolError)
  await assert.rejects(verifyWideSearchPageBytes(page, new Uint8Array(page.length)), /page digest/)
  respond = () => new Response(null, { status: 204, headers: { ...fixture.headers, 'Content-Length': '1' } })
  await assert.rejects(verifyWideSearchGeneration(manifest), ProtocolError)
  respond = () => {
    const head = new Response(null, { status: 204, headers: fixture.headers })
    Object.defineProperty(head, 'body', { value: stream(Uint8Array.of(1)) })
    return head
  }
  await assert.rejects(verifyWideSearchGeneration(manifest), ProtocolError)
  respond = () => new Response(null, { status: 409 })
  await assert.rejects(verifyWideSearchGeneration(manifest), { name: 'ApiError', status: 409 })
})

test('bounded AEDS errors preserve genuine HTTP status for callers', async t => {
  let respond = () => apiErrorResponse(503, '', 'Wide unavailable')
  t.mock.method(globalThis, 'fetch', () => respond())
  await assert.rejects(fetchWideSearchManifest(), (error: unknown) =>
    error instanceof ApiError && error.status === 503 && error.message === 'Wide unavailable')
  respond = () => packet(new Uint8Array(4096), { 'Content-Type': 'application/octet-stream' }, 503)
  await assert.rejects(fetchWideSearchManifest(), ProtocolError)
  respond = () => new Response(null, { status: 404 })
  await assert.rejects(fetchWideSearchManifest(), { name: 'ApiError', status: 404 })
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(fetchWideSearchManifest(abort.signal), { name: 'AbortError' })
})

function stream(bytes: Uint8Array<ArrayBuffer>) {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 3))
      controller.enqueue(bytes.subarray(3))
      controller.close()
    },
  })
}

const packet = (bytes: Uint8Array<ArrayBuffer>, headers: HeadersInit, status = 200) =>
  new Response(stream(bytes), { headers, status })

function manifestFrame(rows: FixturePage[], change?: (view: DataView) => void, wrongDigest = false) {
  const payload = new Uint8Array(60 + 60 * rows.length)
  const view = new DataView(payload.buffer)
  view.setInt32(0, 1, true)
  view.setBigInt64(4, BigInt(generation), true)
  view.setInt32(12, rows.reduce((sum, row) => sum + row.count, 0), true)
  view.setInt32(16, rows.length, true)
  view.setBigInt64(20, BigInt(rows.reduce((sum, row) => sum + row.bytes.length, 0)), true)
  let offset = 0
  for (const [i, row] of rows.entries()) {
    const at = 60 + 60 * i
    view.setInt32(at, i + 1, true)
    view.setInt32(at + 4, row.count, true)
    view.setInt32(at + 8, row.first, true)
    view.setInt32(at + 12, row.last, true)
    view.setBigInt64(at + 16, BigInt(offset), true)
    view.setInt32(at + 24, row.bytes.length, true)
    payload.set(hexBytes(sha256Hex(row.bytes)), at + 28)
    offset += row.bytes.length
  }
  change?.(view)
  const digest = wrongDigest ? '0'.repeat(64) : createHash('sha256').update('public-search-fspk-manifest-v1\0')
    .update(payload.subarray(12, 28)).update(payload.subarray(60)).digest('hex')
  payload.set(hexBytes(digest), 28)
  const frame = encodeFrame(FrameType.PublicSearchWideManifest, payload)
  return { frame, digest, headers: {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    [WireHeaders.SearchIndexGeneration]: generation,
    [WireHeaders.SearchCorpusDigest]: digest,
    [WireHeaders.SearchIndexPages]: String(rows.length),
  } }
}

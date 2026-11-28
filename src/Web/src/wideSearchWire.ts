import { ApiError, decodeApiError, decodeFrame, ProtocolError } from '../../Contracts/aeds.ts'
import { toHex } from '../../Contracts/binary.ts'
import { FrameType, WireHeader, WireHeaders, WireLayouts as L, WireLimits as Limit, WireRoutes } from '../../Contracts/wire.generated.ts'

export type WideSearchIdentity = Readonly<{ generation: string; digest: string; pageCount: number }>
export const wideSearchAttemptMs = 300_000

export type WideSearchPage = Readonly<{
  number: number
  documentCount: number
  firstArticleId: number
  lastArticleId: number
  offset: number
  length: number
  sha256: string
}>

export type WideSearchManifest = WideSearchIdentity & Readonly<{
  documentCount: number
  byteCount: number
  pages: readonly WideSearchPage[]
}>

const binary = 'application/octet-stream'
const generationPattern = /^(0|[1-9][0-9]{0,18})$/
const digestPattern = /^[0-9a-f]{64}$/
const manifestDomain = new TextEncoder().encode('public-search-fspk-manifest-v1\0')
const fspkHeaderSize = L.SearchPackagePayloadOffset + L.SearchShardHeaderSize
const digestOffset = 28

function discard(response?: Response) {
  if (response?.body) void response.body.cancel().catch(() => undefined)
}

function requireWire(condition: boolean, field: string, unread?: Response): asserts condition {
  if (condition) return
  discard(unread)
  throw new ProtocolError(`Invalid wide search ${field}`)
}

function isBinary(response: Response) {
  return response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === binary
}

function isGeneration(value: string) {
  return typeof value === 'string' && generationPattern.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n
}

function isPageLength(length: number) {
  return Number.isInteger(length) && length >= fspkHeaderSize && length <= Limit.SearchCorpusPageBytes
}

function checkIdentity({ generation, digest, pageCount }: WideSearchIdentity) {
  requireWire(isGeneration(generation) && digestPattern.test(digest) && Number.isInteger(pageCount) &&
    pageCount > 0 && pageCount <= Limit.SearchWideCorpusMaxPages, 'request pins')
}

function responseIdentity(response: Response): WideSearchIdentity {
  const headers = response.headers
  const caching = headers.get('Cache-Control')?.toLowerCase().split(',').map(part => part.trim())
  const age = headers.get('Age')
  requireWire(caching?.includes('no-store') === true && (age === null || age === '0'), 'response cache policy', response)
  const generation = headers.get(WireHeaders.SearchIndexGeneration)
  const digest = headers.get(WireHeaders.SearchCorpusDigest)
  const count = headers.get(WireHeaders.SearchIndexPages)
  requireWire(generation !== null && isGeneration(generation) && digest !== null && digestPattern.test(digest) &&
    count !== null && /^[1-9][0-9]{0,2}$/.test(count), 'response pins', response)
  const pageCount = Number(count)
  requireWire(pageCount <= Limit.SearchWideCorpusMaxPages, 'response page count', response)
  return { generation, digest, pageCount }
}

function requirePins(response: Response, expected: WideSearchIdentity) {
  const current = responseIdentity(response)
  requireWire(current.generation === expected.generation && current.digest === expected.digest &&
    current.pageCount === expected.pageCount, 'response pins', response)
}

function pinsQuery(identity: WideSearchIdentity) {
  checkIdentity(identity)
  return new URLSearchParams({ generation: identity.generation, digest: identity.digest })
}

async function request(path: string, method: 'GET' | 'HEAD', signal?: AbortSignal) {
  signal?.throwIfAborted()
  const response = await fetch(path, {
    method, credentials: 'omit', cache: 'no-store', mode: 'same-origin', redirect: 'error',
    headers: { Accept: binary }, signal,
  })
  if (signal?.aborted) {
    discard(response)
    signal.throwIfAborted()
  }
  if (response.status === (method === 'GET' ? 200 : 204)) return response
  if (response.status >= 400 && response.status <= 599) {
    if (method === 'GET' && isBinary(response)) {
      const bytes = await readExact(response, WireHeader.HeaderSize + L.ErrorBytes, signal)
      throw decodeApiError(decodeFrame(bytes, FrameType.ApiError).payload, response.status)
    }
    // HEAD has no response body, including when the server advertises an error representation.
    discard(response)
    throw new ApiError('Wide search corpus is unavailable', response.status)
  }
  discard(response)
  throw new ProtocolError('Invalid wide search response status')
}

async function readExact(response: Response, size: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get('Content-Length')
  const encoding = response.headers.get('Content-Encoding')
  requireWire(length === null || (encoding !== null && encoding.toLowerCase() !== 'identity') ||
    length === String(size), 'response length', response)
  if (size === 0 && response.body === null) return new Uint8Array()
  requireWire(response.body !== null, 'response body')
  const bytes = new Uint8Array(size)
  const reader = response.body.getReader()
  try {
    let at = 0
    for (;;) {
      signal?.throwIfAborted()
      const next = await reader.read()
      signal?.throwIfAborted()
      if (next.done) break
      requireWire(next.value.length <= bytes.length - at, 'response length')
      bytes.set(next.value, at)
      at += next.value.length
    }
    requireWire(at === bytes.length, 'response length')
    return bytes
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

async function sha256(bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal) {
  signal?.throwIfAborted()
  requireWire(globalThis.crypto?.subtle !== undefined, 'SHA-256 availability')
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  signal?.throwIfAborted()
  return toHex(new Uint8Array(hash))
}

async function decodeManifest(frame: Uint8Array<ArrayBuffer>, pins: WideSearchIdentity, signal?: AbortSignal): Promise<WideSearchManifest> {
  const { payload } = decodeFrame(frame, FrameType.PublicSearchWideManifest)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const generation = view.getBigInt64(4, true).toString()
  const documentCount = view.getInt32(12, true)
  const pageCount = view.getInt32(16, true)
  const declaredBytes = view.getBigInt64(20, true)
  const digest = toHex(payload.subarray(digestOffset, L.SearchWideManifestHeaderSize))
  requireWire(view.getInt32(0, true) === L.SearchWideManifestVersion && generation === pins.generation &&
    digest === pins.digest && pageCount === pins.pageCount &&
    documentCount >= 0 && documentCount <= pageCount * Limit.SearchIndexPageSize &&
    declaredBytes >= BigInt(fspkHeaderSize) && declaredBytes <= BigInt(Limit.SearchWideCorpusTotalBytes), 'manifest header')
  const byteCount = Number(declaredBytes)
  const pages: WideSearchPage[] = []
  let offset = 0
  let documents = 0
  let lastId = 0
  for (let i = 0; i < pageCount; i++) {
    const at = L.SearchWideManifestHeaderSize + i * L.SearchWideManifestPageRecordSize
    const number = view.getInt32(at, true)
    const count = view.getInt32(at + 4, true)
    const firstArticleId = view.getInt32(at + 8, true)
    const lastArticleId = view.getInt32(at + 12, true)
    const length = view.getInt32(at + 24, true)
    const range = count === 0
      ? documentCount === 0 && number === 1 && length === fspkHeaderSize && firstArticleId === 0 && lastArticleId === 0
      : firstArticleId > lastId && (count === 1 ? lastArticleId === firstArticleId : lastArticleId - firstArticleId + 1 >= count)
    requireWire(number === i + 1 && view.getBigInt64(at + 16, true) === BigInt(offset) &&
      count >= 0 && count <= Limit.SearchIndexPageSize && count <= documentCount - documents &&
      length >= fspkHeaderSize + count * L.SearchDocumentRecordSize && length <= Limit.SearchCorpusPageBytes &&
      length <= byteCount - offset && range, 'manifest page descriptor')
    pages.push(Object.freeze({
      number, documentCount: count, firstArticleId, lastArticleId, offset, length,
      sha256: toHex(payload.subarray(at + digestOffset, at + L.SearchWideManifestPageRecordSize)),
    }))
    offset += length
    documents += count
    lastId = lastArticleId
  }
  requireWire(offset === byteCount && documents === documentCount, 'manifest totals')
  const entries = payload.subarray(L.SearchWideManifestHeaderSize)
  const canonical = new Uint8Array(manifestDomain.length + 16 + entries.length)
  canonical.set(manifestDomain)
  canonical.set(payload.subarray(12, digestOffset), manifestDomain.length)
  canonical.set(entries, manifestDomain.length + 16)
  requireWire(await sha256(canonical, signal) === digest, 'manifest digest')
  return Object.freeze({ generation, digest, pageCount, documentCount, byteCount, pages: Object.freeze(pages) })
}

export async function fetchWideSearchManifest(signal?: AbortSignal): Promise<WideSearchManifest> {
  const response = await request(WireRoutes.PublicSearchWideManifest, 'GET', signal)
  requireWire(isBinary(response), 'manifest media type', response)
  const identity = responseIdentity(response)
  const size = WireHeader.HeaderSize + L.SearchWideManifestHeaderSize + identity.pageCount * L.SearchWideManifestPageRecordSize
  return decodeManifest(await readExact(response, size, signal), identity, signal)
}

export async function fetchWideSearchPage(manifest: WideSearchManifest, page: WideSearchPage,
  signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  requireWire(Number.isInteger(page.number) && page.number > 0 && page.number <= manifest.pageCount &&
    isPageLength(page.length) && digestPattern.test(page.sha256) && manifest.pages[page.number - 1] === page, 'requested page descriptor')
  const path = WireRoutes.PublicSearchWidePage.replace('{page}', String(page.number))
  const response = await request(`${path}?${pinsQuery(manifest)}`, 'GET', signal)
  requirePins(response, manifest)
  requireWire(isBinary(response) && response.headers.get('ETag') === `"${page.sha256}"`, 'page media type or validator', response)
  const bytes = await readExact(response, page.length, signal)
  await verifyWideSearchPageBytes(page, bytes, signal)
  return bytes
}

export async function verifyWideSearchGeneration(identity: WideSearchIdentity, signal?: AbortSignal): Promise<void> {
  const response = await request(`${WireRoutes.PublicSearchWideManifest}?${pinsQuery(identity)}`, 'HEAD', signal)
  requirePins(response, identity)
  await readExact(response, 0, signal)
  signal?.throwIfAborted()
}

export async function verifyWideSearchPageBytes(page: WideSearchPage, bytes: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal): Promise<void> {
  requireWire(isPageLength(page.length) && bytes.length === page.length, 'page byte count')
  requireWire(await sha256(bytes, signal) === page.sha256, 'page digest')
}

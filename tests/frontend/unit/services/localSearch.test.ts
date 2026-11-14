import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppErrorCode, createAppError } from '@/utils/appError'
import { invalidateSearchIndexMemory, searchIndex } from '@/services/localSearch'

const wasm = vi.hoisted(() => ({
  initSearchRuntime: vi.fn(),
  loadSearchIndex: vi.fn(),
  loadSearchEntry: vi.fn(),
  searchIndexBinary: vi.fn()
}))

vi.mock('@wasm/search', () => ({
  initSearchRuntime: wasm.initSearchRuntime,
  loadSearchIndex: wasm.loadSearchIndex,
  loadSearchEntry: wasm.loadSearchEntry,
  searchIndexBinary: wasm.searchIndexBinary
}))

vi.mock('@/adapters/binary/articleAdapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/adapters/binary/articleAdapter')>()
  return {
    ...actual,
    mapArticleSearchFromPodPayload: vi.fn(() => ({
      items: [],
      total: 0,
      hasMore: false,
      nextCursor: null
    }))
  }
})

vi.mock('@/services/serviceWorkerRuntime', () => ({
  subscribeServiceWorkerMessages: vi.fn()
}))

function encodeSearchManifest(currentVersion: string, shardUrl: string): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = []
  const u32 = (value: number) => {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value, true)
    chunks.push(bytes)
  }
  const i32 = (value: number) => {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setInt32(0, value, true)
    chunks.push(bytes)
  }
  const i64 = (value: bigint) => {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigInt64(0, value, true)
    chunks.push(bytes)
  }
  const str = (value: string) => {
    const encoded = new TextEncoder().encode(value)
    i32(encoded.byteLength)
    chunks.push(encoded)
  }
  const nullableStr = (value: string | null) => {
    chunks.push(Uint8Array.of(value === null ? 0 : 1))
    if (value !== null) {
      str(value)
    }
  }
  const strList = (values: string[]) => {
    i32(values.length)
    for (const value of values) {
      str(value)
    }
  }

  u32(0x4d495346)
  u32(1)
  i32(4)
  i64(BigInt(Date.now() + 62135596800000) * 10000n)
  str(currentVersion)
  i32(1)
  u32(0)
  str(shardUrl)
  str('ab'.repeat(32))
  nullableStr(null)
  nullableStr(null)
  i32(0)
  strList(['core'])
  strList([])
  strList([])

  let total = 0
  for (const chunk of chunks) {
    total += chunk.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

describe('localSearch generation retry', () => {
  beforeEach(() => {
    invalidateSearchIndexMemory()
    wasm.initSearchRuntime.mockResolvedValue('SCALAR-BASIC')
    wasm.loadSearchIndex.mockResolvedValue('SCALAR-BASIC')
    wasm.loadSearchEntry.mockResolvedValue('SCALAR-BASIC')
    wasm.searchIndexBinary.mockResolvedValue(new Uint8Array([1, 2, 3]))
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    invalidateSearchIndexMemory()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('retries search index load once after a lagging generation failure', async () => {
    const staleManifest = encodeSearchManifest('stale-version', '/search/index.core.stale.bin')
    const currentManifest = encodeSearchManifest('current-version', '/search/index.core.current.bin')
    const fetchMock = vi.mocked(fetch)
    let manifestFetches = 0
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('index.manifest.aeds')) {
        manifestFetches += 1
        const body = manifestFetches === 1 ? staleManifest : currentManifest
        return new Response(body, { status: 200 })
      }
      return new Response(new Uint8Array([9, 9, 9]), { status: 200 })
    })

    wasm.loadSearchIndex
      .mockRejectedValueOnce(createAppError(AppErrorCode.ProtocolFailure, 'search_index_load_failed'))
      .mockResolvedValue('SCALAR-BASIC')

    const result = await searchIndex('AOT', 'relevance', 1, 10)

    expect(result.items).toEqual([])
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('index.manifest.aeds'))).toHaveLength(2)
    expect(wasm.loadSearchIndex).toHaveBeenCalledTimes(2)
    expect(wasm.searchIndexBinary).toHaveBeenCalledTimes(1)
  })

  it('does not retry a successful first search index load', async () => {
    const manifest = encodeSearchManifest('current-version', '/search/index.core.current.bin')
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      const body = url.includes('index.manifest.aeds') ? manifest : new Uint8Array([9, 9, 9])
      return new Response(body, { status: 200 })
    })

    await searchIndex('AOT', 'relevance', 1, 10)

    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('index.manifest.aeds'))).toHaveLength(1)
    expect(wasm.loadSearchIndex).toHaveBeenCalledTimes(1)
  })
})

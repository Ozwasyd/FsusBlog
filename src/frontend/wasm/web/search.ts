import { loadEmscriptenModule } from './runtime/emscripten'
import { resolveSearchAsset, type SearchAssetKind } from './runtime/assets'
import { createSerializedExecutor } from './runtime/serialized'
import { decodeUtf8, encodeUtf8 } from './runtime/utf8'
import { AppErrorCode, createAppError } from '@/utils/appError'

export type SearchSortMode = 'relevance' | 'latest' | 'hot'
export type SearchRuntimeKind = 'SIMD-128' | 'SCALAR-BASIC' | 'UNKNOWN'
export type SearchEntryKind = 'shard' | 'patch'
export type SearchEntryRole = 'core' | 'recent' | 'archive'

type SearchModule = {
  HEAPU8: Uint8Array
  memory?: WebAssembly.Memory
  _alloc_buffer?: (size: number) => number
  _free_buffer?: (ptr: number) => void
  _load_search_index?: (ptr: number, len: number) => number
  _load_search_entry?: (kind: number, role: number, ptr: number, len: number) => number
  _search_articles?: (ptr: number, len: number, sortMode: number, page: number, pageSize: number) => number
  _get_last_result_ptr?: () => number
  _get_last_result_len?: () => number
  _get_last_error_ptr?: () => number
  _get_last_error_len?: () => number
  _get_last_error_code?: () => number
}

type SearchModuleFactoryResult = SearchModule & Record<string, unknown>

let runtimeModule: SearchModuleFactoryResult | null = null
let runtimePromise: Promise<{ module: SearchModuleFactoryResult | null; engine: SearchRuntimeKind }> | null = null
let runtimeEngine: SearchRuntimeKind = 'UNKNOWN'
let searchIndexLoaded = false
const withSearchRuntimeLock = createSerializedExecutor()

function supportsSimdSearch(): boolean {
  try {
    const simdProbe = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0,
      1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
      1, 8, 0, 65, 0, 253, 15, 253, 98, 11
    ])
    return WebAssembly.validate(simdProbe)
  } catch {
    return false
  }
}

function resolveSearchAssetKind(): SearchAssetKind {
  return supportsSimdSearch() ? 'simd' : 'basic'
}

function pickExport<T>(raw: Record<string, unknown>, ...names: string[]): T {
  for (const name of names) {
    const direct = raw[name]
    if (direct) {
      return direct as T
    }

    const underscored = raw[`_${name}`]
    if (underscored) {
      return underscored as T
    }
  }

  throw createAppError(AppErrorCode.InvariantViolation, `wasm_export_missing:${names[0] ?? 'unknown'}`)
}

function resolveModuleMemory(module: SearchModuleFactoryResult): WebAssembly.Memory | null {
  if (module.memory) {
    return module.memory
  }

  const heapBuffer = module.HEAPU8?.buffer
  if (!heapBuffer) {
    return null
  }

  return { buffer: heapBuffer } as WebAssembly.Memory
}

function readBuffer(memory: WebAssembly.Memory, ptr: number, len: number): Uint8Array {
  if (ptr <= 0 || len <= 0) {
    return new Uint8Array(0)
  }

  return new Uint8Array(memory.buffer, ptr, len).slice()
}

function readCString(memory: WebAssembly.Memory, ptr: number, len: number): string {
  if (ptr <= 0 || len <= 0) {
    return ''
  }

  return decodeUtf8(new Uint8Array(memory.buffer, ptr, len))
}

function normalizeSortMode(mode: SearchSortMode): number {
  switch (mode) {
    case 'latest':
      return 1
    case 'hot':
      return 2
    default:
      return 0
  }
}

function normalizeEntryKind(kind: SearchEntryKind): number {
  return kind === 'patch' ? 1 : 0
}

function normalizeEntryRole(role: SearchEntryRole): number {
  switch (role) {
    case 'recent':
      return 1
    case 'archive':
      return 2
    default:
      return 0
  }
}

function mapSearchErrorCode(code: number, fallback: string): AppErrorCode {
  switch (code) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
    case 10:
    case 11:
    case 12:
    case 13:
      return AppErrorCode.ProtocolFailure
    case 14:
      return AppErrorCode.InvariantViolation
    default:
      if (fallback.includes('payload') || fallback.includes('header') || fallback.includes('patch')) {
        return AppErrorCode.ProtocolFailure
      }
      return AppErrorCode.InfraFailure
  }
}

async function initSearchRuntimeModule(): Promise<{ module: SearchModuleFactoryResult | null; engine: SearchRuntimeKind }> {
  if (runtimeModule) {
    return { module: runtimeModule, engine: runtimeEngine }
  }

  if (!runtimePromise) {
    runtimePromise = (async () => {
      const assetKind = resolveSearchAssetKind()
      const engine: SearchRuntimeKind = assetKind === 'simd' ? 'SIMD-128' : 'SCALAR-BASIC'
      const asset = resolveSearchAsset(assetKind)
      const module = await loadEmscriptenModule<SearchModuleFactoryResult>(
        asset.moduleUrl,
        'createSearchModule',
        asset.wasmUrl
      )

      if (!module) {
        return { module: null, engine }
      }

      const raw = module as unknown as Record<string, unknown>
      runtimeModule = {
        ...module,
        _alloc_buffer: pickExport<(size: number) => number>(raw, 'alloc_buffer'),
        _free_buffer: pickExport<(ptr: number) => void>(raw, 'free_buffer'),
        _load_search_index: pickExport<(ptr: number, len: number) => number>(raw, 'load_search_index'),
        _load_search_entry: pickExport<(kind: number, role: number, ptr: number, len: number) => number>(raw, 'load_search_entry'),
        _search_articles: pickExport<(ptr: number, len: number, sortMode: number, page: number, pageSize: number) => number>(raw, 'search_articles'),
        _get_last_result_ptr: pickExport<() => number>(raw, 'get_last_result_ptr'),
        _get_last_result_len: pickExport<() => number>(raw, 'get_last_result_len'),
        _get_last_error_ptr: pickExport<() => number>(raw, 'get_last_error_ptr'),
        _get_last_error_len: pickExport<() => number>(raw, 'get_last_error_len'),
        _get_last_error_code: pickExport<() => number>(raw, 'get_last_error_code')
      }
      runtimeEngine = engine
      return { module: runtimeModule, engine }
    })().catch(() => ({ module: null, engine: 'UNKNOWN' as SearchRuntimeKind }))
  }

  return await runtimePromise
}

function assertSearchModule(module: SearchModuleFactoryResult | null): SearchModuleFactoryResult {
  if (!module) {
    throw createAppError(AppErrorCode.InfraFailure, 'search_runtime_unavailable')
  }

  return module
}

export async function initSearchRuntime(): Promise<SearchRuntimeKind> {
  const result = await initSearchRuntimeModule()
  return result.engine
}

export async function loadSearchIndex(indexBytes: Uint8Array): Promise<SearchRuntimeKind> {
  return await withSearchRuntimeLock(async () => {
    const { module, engine } = await initSearchRuntimeModule()
    const runtime = assertSearchModule(module)
    const alloc = runtime._alloc_buffer
    const free = runtime._free_buffer
    const load = runtime._load_search_index

    if (!alloc || !free || !load) {
      throw createAppError(AppErrorCode.InvariantViolation, 'search_runtime_exports_missing')
    }

    const ptr = alloc(indexBytes.byteLength)
    if (ptr <= 0) {
      throw createAppError(AppErrorCode.InfraFailure, 'search_runtime_oom')
    }

    try {
      runtime.HEAPU8.set(indexBytes, ptr)
      const ok = load(ptr, indexBytes.byteLength)
      if (ok !== 1) {
        const memory = resolveModuleMemory(runtime)
        const message = memory && runtime._get_last_error_ptr && runtime._get_last_error_len
          ? readCString(memory, runtime._get_last_error_ptr(), runtime._get_last_error_len())
          : ''
        throw createAppError(AppErrorCode.InfraFailure, message || 'search_index_load_failed')
      }

      searchIndexLoaded = true
      return engine
    } finally {
      free(ptr)
    }
  })
}

export async function loadSearchEntry(kind: SearchEntryKind, role: SearchEntryRole, bytes: Uint8Array): Promise<SearchRuntimeKind> {
  return await withSearchRuntimeLock(async () => {
    const { module, engine } = await initSearchRuntimeModule()
    const runtime = assertSearchModule(module)

    if (!searchIndexLoaded) {
      throw createAppError(AppErrorCode.InvariantViolation, 'search_index_not_loaded')
    }

    const alloc = runtime._alloc_buffer
    const free = runtime._free_buffer
    const loadEntry = runtime._load_search_entry

    if (!alloc || !free || !loadEntry) {
      throw createAppError(AppErrorCode.InvariantViolation, 'search_runtime_exports_missing')
    }

    const ptr = alloc(bytes.byteLength)
    if (ptr <= 0) {
      throw createAppError(AppErrorCode.InfraFailure, 'search_runtime_oom')
    }

    try {
      runtime.HEAPU8.set(bytes, ptr)
      const ok = loadEntry(normalizeEntryKind(kind), normalizeEntryRole(role), ptr, bytes.byteLength)
      if (ok !== 1) {
        const memory = resolveModuleMemory(runtime)
        const message = memory && runtime._get_last_error_ptr && runtime._get_last_error_len
          ? readCString(memory, runtime._get_last_error_ptr(), runtime._get_last_error_len())
          : ''
        throw createAppError(mapSearchErrorCode(runtime._get_last_error_code?.() ?? 0, message), message || 'search_entry_load_failed')
      }

      return engine
    } finally {
      free(ptr)
    }
  })
}

export async function searchIndexBinary(
  query: string,
  sortMode: SearchSortMode,
  page: number,
  pageSize: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  return await withSearchRuntimeLock(async () => {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    const { module } = await initSearchRuntimeModule()
    const runtime = assertSearchModule(module)

    if (!searchIndexLoaded) {
      throw createAppError(AppErrorCode.InvariantViolation, 'search_index_not_loaded')
    }

    const alloc = runtime._alloc_buffer
    const free = runtime._free_buffer
    const search = runtime._search_articles
    const getResultPtr = runtime._get_last_result_ptr
    const getResultLen = runtime._get_last_result_len
    const getErrorPtr = runtime._get_last_error_ptr
    const getErrorLen = runtime._get_last_error_len
    const getErrorCode = runtime._get_last_error_code
    const memory = resolveModuleMemory(runtime)

    if (!alloc || !free || !search || !getResultPtr || !getResultLen || !getErrorPtr || !getErrorLen || !getErrorCode || !memory) {
      throw createAppError(AppErrorCode.InvariantViolation, 'search_runtime_exports_missing')
    }

    const queryBytes = encodeUtf8(query)
    const ptr = queryBytes.byteLength > 0 ? alloc(queryBytes.byteLength) : 0
    if (queryBytes.byteLength > 0 && ptr <= 0) {
      throw createAppError(AppErrorCode.InfraFailure, 'search_runtime_oom')
    }

    try {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }

      if (queryBytes.byteLength > 0) {
        runtime.HEAPU8.set(queryBytes, ptr)
      }

      const ok = search(ptr, queryBytes.byteLength, normalizeSortMode(sortMode), page, pageSize)
      if (ok !== 1) {
        const message = readCString(memory, getErrorPtr(), getErrorLen())
        throw createAppError(mapSearchErrorCode(getErrorCode(), message), message || 'search_runtime_failed')
      }

      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }

      return readBuffer(memory, getResultPtr(), getResultLen())
    } finally {
      if (ptr > 0) {
        free(ptr)
      }
    }
  })
}

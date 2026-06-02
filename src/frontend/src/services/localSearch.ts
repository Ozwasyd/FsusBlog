import type { ArticleListItemResponse, PageResponse } from '@/api/article'
import { withBinaryAccept } from '@/api/contracts'
import { mapArticleSearchFromPodPayload } from '@/adapters/binary/articleAdapter'
import { subscribeServiceWorkerMessages } from '@/services/serviceWorkerRuntime'
import { AppErrorCode, appErrorFromStatus, createAppError } from '@/utils/appError'
import { isAbortError } from '@/utils/errors'
import { initSearchRuntime, loadSearchEntry, loadSearchIndex as loadSearchIndexIntoRuntime, searchIndexBinary, type SearchSortMode } from '@wasm/search'

type SearchShardRole = 'core' | 'recent' | 'archive'
type SearchShardRoleValue = SearchShardRole | 0 | 1 | 2

type SearchShardManifest = {
  role: SearchShardRoleValue
  fullUrl: string
  fullSha256: string
  patchUrl?: string | null
  patchSha256?: string | null
  loadPhase: number
}

type SearchManifest = {
  schemaVersion: number
  currentVersion: string
  generatedAt: string
  shards: SearchShardManifest[]
  initialRoles: string[]
  backgroundRoles: string[]
  deepRoles: string[]
}

function resolveSearchManifestUrl(): string {
  return `${(import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')}search/index.manifest.aeds`
}

const SEARCH_MANIFEST_URL = resolveSearchManifestUrl()
const SEARCH_MANIFEST_MAGIC = 0x4d495346
const SEARCH_MANIFEST_BINARY_VERSION = 1
const SEARCH_PACKAGE_MAGIC = 0x4b505346
const SEARCH_PACKAGE_VERSION = 3
const DOTNET_EPOCH_OFFSET_MS = 62135596800000
const textDecoder = new TextDecoder()

let loadPromise: Promise<void> | null = null
let loaded = false
let loadedVersion: string | null = null
let loadedEntryKeys = new Set<string>()
let activeGeneration = 0
let activeSearchController: AbortController | null = null
let activeLoadController: AbortController | null = null
let backgroundPreloadController: AbortController | null = null
let runtimeReloadPromise: Promise<void> = Promise.resolve()

async function fetchManifestBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, {
    method: 'GET',
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: withBinaryAccept()
  })

  if (!response.ok) {
    throw appErrorFromStatus(response.status, `search_manifest_fetch_failed:${response.status}`)
  }

  return new Uint8Array(await response.arrayBuffer())
}

async function fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, {
    method: 'GET',
    signal,
    credentials: 'same-origin',
    cache: import.meta.env.PROD ? 'no-store' : 'force-cache'
  })

  if (!response.ok) {
    throw appErrorFromStatus(response.status, `search_asset_fetch_failed:${response.status}`)
  }

  return new Uint8Array(await response.arrayBuffer())
}

function resolveRole(role: SearchShardRole): number {
  switch (role) {
    case 'recent':
      return 1
    case 'archive':
      return 2
    default:
      return 0
  }
}

function normalizeShardRole(role: SearchShardRoleValue): SearchShardRole | null {
  switch (role) {
    case 0:
    case 'core':
      return 'core'
    case 1:
    case 'recent':
      return 'recent'
    case 2:
    case 'archive':
      return 'archive'
    default:
      return null
  }
}

function roleCacheKey(kind: 'shard' | 'patch', role: SearchShardRole): string {
  return `${kind}:${role}`
}

function align(value: number, alignment: number): number {
  return (value + alignment - 1) & ~(alignment - 1)
}

function buildSearchPackage(entries: Array<{ kind: 'shard' | 'patch'; role: SearchShardRole; bytes: Uint8Array }>): Uint8Array {
  const headerSize = 12
  const entryHeaderSize = 16
  let payloadOffset = align(headerSize + entries.length * entryHeaderSize, 8)
  const payloads: number[] = []
  for (const entry of entries) {
    payloads.push(payloadOffset)
    payloadOffset = align(payloadOffset + entry.bytes.byteLength, 8)
  }

  const out = new Uint8Array(payloadOffset)
  const view = new DataView(out.buffer)
  view.setUint32(0, SEARCH_PACKAGE_MAGIC, true)
  view.setUint32(4, SEARCH_PACKAGE_VERSION, true)
  view.setUint32(8, entries.length, true)

  let metaOffset = headerSize
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    view.setUint32(metaOffset, entry.kind === 'patch' ? 1 : 0, true)
    view.setUint32(metaOffset + 4, resolveRole(entry.role), true)
    view.setUint32(metaOffset + 8, payloads[index], true)
    view.setUint32(metaOffset + 12, entry.bytes.byteLength, true)
    metaOffset += entryHeaderSize
  }

  for (let index = 0; index < entries.length; index += 1) {
    out.set(entries[index].bytes, payloads[index])
  }

  return out
}

const EMPTY_SEARCH_PACKAGE = buildSearchPackage([])

async function loadManifest(signal?: AbortSignal): Promise<SearchManifest> {
  return decodeSearchManifest(await fetchManifestBytes(SEARCH_MANIFEST_URL, signal))
}

function decodeSearchManifest(bytes: Uint8Array): SearchManifest {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  const readUint32 = (): number => {
    if (offset + 4 > bytes.byteLength) throw createAppError(AppErrorCode.ProtocolFailure, 'search_manifest_truncated')
    const value = view.getUint32(offset, true)
    offset += 4
    return value
  }
  const readInt32 = (): number => {
    if (offset + 4 > bytes.byteLength) throw createAppError(AppErrorCode.ProtocolFailure, 'search_manifest_truncated')
    const value = view.getInt32(offset, true)
    offset += 4
    return value
  }
  const readInt64 = (): bigint => {
    if (offset + 8 > bytes.byteLength) throw createAppError(AppErrorCode.ProtocolFailure, 'search_manifest_truncated')
    const value = view.getBigInt64(offset, true)
    offset += 8
    return value
  }
  const readBool = (): boolean => {
    if (offset + 1 > bytes.byteLength) throw createAppError(AppErrorCode.ProtocolFailure, 'search_manifest_truncated')
    return bytes[offset++] !== 0
  }
  const readString = (): string => {
    const length = readInt32()
    if (length < 0 || length > 4096 || offset + length > bytes.byteLength) {
      throw createAppError(AppErrorCode.ProtocolFailure, 'search_manifest_string_invalid')
    }

    const value = textDecoder.decode(bytes.subarray(offset, offset + length))
    offset += length
    return value
  }
  const readNullableString = (): string | null => readBool() ? readString() : null
  const readStringList = (): string[] => {
    const count = readInt32()
    if (count < 0 || count > 32) {
      throw createAppError(AppErrorCode.ProtocolFailure, 'search_manifest_list_invalid')
    }

    const values = new Array<string>(count)
    for (let index = 0; index < count; index += 1) {
      values[index] = readString()
    }

    return values
  }

  if (readUint32() !== SEARCH_MANIFEST_MAGIC || readUint32() !== SEARCH_MANIFEST_BINARY_VERSION) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'search_manifest_magic_invalid')
  }

  const schemaVersion = readInt32()
  const ticks = readInt64()
  const generatedAtMs = Number(ticks / 10000n) - DOTNET_EPOCH_OFFSET_MS
  const currentVersion = readString()
  const shardCount = readInt32()
  if (shardCount < 0 || shardCount > 32) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'search_manifest_shards_invalid')
  }

  const shards: SearchShardManifest[] = []
  for (let index = 0; index < shardCount; index += 1) {
    shards.push({
      role: readUint32() as SearchShardRoleValue,
      fullUrl: readString(),
      fullSha256: readString(),
      patchUrl: readNullableString(),
      patchSha256: readNullableString(),
      loadPhase: readInt32()
    })
  }

  const manifest = {
    schemaVersion,
    currentVersion,
    generatedAt: new Date(generatedAtMs).toISOString(),
    shards,
    initialRoles: readStringList(),
    backgroundRoles: readStringList(),
    deepRoles: readStringList()
  }

  if (offset !== bytes.byteLength) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'search_manifest_trailing_bytes')
  }

  return manifest
}

async function loadAssetsForRoles(manifest: SearchManifest, roles: readonly string[], signal?: AbortSignal): Promise<Map<string, Uint8Array>> {
  const results = new Map<string, Uint8Array>()
  const shardsByRole = new Map<SearchShardRole, SearchShardManifest>()
  for (const shard of manifest.shards) {
    const normalizedRole = normalizeShardRole(shard.role)
    if (normalizedRole) {
      shardsByRole.set(normalizedRole, shard)
    }
  }

  const entries = await Promise.all(roles.map(async (role) => {
    const normalizedRole = role === 'core' || role === 'recent' || role === 'archive' ? role : null
    if (!normalizedRole) {
      return null
    }

    const shard = shardsByRole.get(normalizedRole)
    if (!shard) {
      return null
    }

    const shardBytes = await fetchBytes(shard.fullUrl, signal)
    return [roleCacheKey('shard', normalizedRole), shardBytes] as const
  }))

  for (const entry of entries) {
    if (entry) {
      results.set(entry[0], entry[1])
    }
  }

  return results
}

function isGenerationActive(generation: number, controller?: AbortController | null): boolean {
  return generation === activeGeneration && !(controller?.signal.aborted ?? false)
}

function createAbortError(message: string): Error {
  return new DOMException(message, 'AbortError')
}

type CombinedAbortSignal = Readonly<{
  signal: AbortSignal
  cleanup: () => void
}>

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): CombinedAbortSignal {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (activeSignals.length === 1) {
    return {
      signal: activeSignals[0],
      cleanup: () => {}
    }
  }

  const controller = new AbortController()
  const listeners: Array<readonly [AbortSignal, () => void]> = []
  const abort = () => controller.abort()
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort()
      break
    }

    signal.addEventListener('abort', abort, { once: true })
    listeners.push([signal, abort])
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener('abort', listener)
      }
      listeners.length = 0
    }
  }
}

function abortInFlightLoads(): void {
  activeLoadController?.abort()
  backgroundPreloadController?.abort()
  activeSearchController?.abort()
  activeLoadController = null
  backgroundPreloadController = null
  activeSearchController = null
}

function withCallerAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise
  }

  if (signal.aborted) {
    return Promise.reject(createAbortError('The operation was aborted.'))
  }

  return new Promise<T>((resolve, reject) => {
    const abortHandler = () => {
      signal.removeEventListener('abort', abortHandler)
      reject(createAbortError('The operation was aborted.'))
    }

    signal.addEventListener('abort', abortHandler, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abortHandler)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abortHandler)
        reject(error)
      }
    )
  })
}

async function reloadRuntimeFromEntries(entries: Map<string, Uint8Array>, generation: number, controller?: AbortController | null): Promise<void> {
  const snapshot = new Map(entries)
  runtimeReloadPromise = runtimeReloadPromise
    .catch(() => {})
    .then(async () => {
      if (!isGenerationActive(generation, controller)) {
        return
      }

      const packageEntries: Array<{ kind: 'shard' | 'patch'; role: SearchShardRole; bytes: Uint8Array }> = []
      for (const role of ['core', 'recent', 'archive'] as const) {
        const shardBytes = snapshot.get(roleCacheKey('shard', role))
        if (shardBytes) {
          packageEntries.push({ kind: 'shard', role, bytes: shardBytes })
        }

        const patchBytes = snapshot.get(roleCacheKey('patch', role))
        if (patchBytes) {
          packageEntries.push({ kind: 'patch', role, bytes: patchBytes })
        }
      }

      await initSearchRuntime()
      if (!isGenerationActive(generation, controller)) {
        return
      }

      await loadSearchIndexIntoRuntime(EMPTY_SEARCH_PACKAGE)
      for (const entry of packageEntries) {
        if (!isGenerationActive(generation, controller)) {
          return
        }

        await loadSearchEntry(entry.kind, entry.role, entry.bytes)
      }
    })

  await runtimeReloadPromise
}

async function loadIncrementalEntries(extra: Map<string, Uint8Array>, generation: number, controller?: AbortController | null): Promise<Set<string>> {
  const nextEntryKeys = new Set(loadedEntryKeys)
  for (const [key, value] of extra) {
    if (nextEntryKeys.has(key)) {
      continue
    }

    const [kind, role] = key.split(':') as ['shard' | 'patch', SearchShardRole]
    if (!isGenerationActive(generation, controller)) {
      return nextEntryKeys
    }

    await loadSearchEntry(kind, role, value)
    if (!isGenerationActive(generation, controller)) {
      return nextEntryKeys
    }

    nextEntryKeys.add(key)
  }

  return nextEntryKeys
}

type SearchNavigator = Navigator & {
  deviceMemory?: number
  connection?: {
    saveData?: boolean
  }
}

type SearchIdleWindow = Window & typeof globalThis & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
  cancelIdleCallback?: (handle: number) => void
}

function shouldPreloadBackgroundShard(): boolean {
  if (typeof navigator === 'undefined') {
    return true
  }

  const searchNavigator = navigator as SearchNavigator
  if (searchNavigator.connection?.saveData === true) {
    return false
  }

  return typeof searchNavigator.deviceMemory !== 'number' || searchNavigator.deviceMemory > 4
}

function waitForSearchIdle(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(createAbortError('The operation was aborted.'))
  }

  if (typeof window === 'undefined') {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const idleWindow = window as SearchIdleWindow
    let idleHandle: number | null = null
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      signal.removeEventListener('abort', abortHandler)
      if (idleHandle !== null && typeof idleWindow.cancelIdleCallback === 'function') {
        idleWindow.cancelIdleCallback(idleHandle)
      }
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle)
      }
    }
    const complete = () => {
      cleanup()
      resolve()
    }
    const abortHandler = () => {
      cleanup()
      reject(createAbortError('The operation was aborted.'))
    }

    signal.addEventListener('abort', abortHandler, { once: true })
    if (typeof idleWindow.requestIdleCallback === 'function') {
      idleHandle = idleWindow.requestIdleCallback(() => complete(), { timeout: 2000 })
      return
    }

    timeoutHandle = setTimeout(complete, 250)
  })
}

async function preloadBackgroundShard(manifest: SearchManifest, generation: number): Promise<void> {
  if (!isGenerationActive(generation)) {
    return
  }

  backgroundPreloadController?.abort()
  const controller = new AbortController()
  backgroundPreloadController = controller

  if (!shouldPreloadBackgroundShard()) {
    if (backgroundPreloadController === controller) {
      backgroundPreloadController = null
    }
    return
  }

  const roles = manifest.backgroundRoles.filter((role): role is SearchShardRole => role === 'archive')
  if (roles.length === 0) {
    if (backgroundPreloadController === controller) {
      backgroundPreloadController = null
    }
    return
  }

  try {
    await waitForSearchIdle(controller.signal)
    if (!isGenerationActive(generation, controller)) {
      return
    }

    const extra = await loadAssetsForRoles(manifest, roles, controller.signal)
    if (!isGenerationActive(generation, controller)) {
      return
    }

    loadedEntryKeys = await loadIncrementalEntries(extra, generation, controller)
  } catch (error) {
    if (!isAbortError(error)) {
      throw error
    }
  } finally {
    if (backgroundPreloadController === controller) {
      backgroundPreloadController = null
    }
  }
}

function ensureLoadPromise(): Promise<void> {
  if (loadPromise) {
    return loadPromise
  }

  const generation = activeGeneration
  const controller = new AbortController()
  activeLoadController = controller

  const currentLoad = { promise: null as Promise<void> | null }
  const promise = (async () => {
    try {
      const manifest = await loadManifest(controller.signal)
      if (!isGenerationActive(generation, controller)) {
        return
      }

      const initialRoles = manifest.initialRoles.filter((role): role is SearchShardRole => role === 'core' || role === 'recent' || role === 'archive')
      const entries = await loadAssetsForRoles(manifest, initialRoles, controller.signal)
      if (!isGenerationActive(generation, controller)) {
        return
      }

      await reloadRuntimeFromEntries(entries, generation, controller)
      if (!isGenerationActive(generation, controller)) {
        return
      }

      loadedEntryKeys = new Set(entries.keys())
      loaded = true
      loadedVersion = manifest.currentVersion
      void preloadBackgroundShard(manifest, generation).catch(() => {})
    } catch (error) {
      if (!controller.signal.aborted) {
        throw error
      }
    } finally {
      if (activeLoadController === controller) {
        activeLoadController = null
      }

      if (loadPromise === currentLoad.promise) {
        loadPromise = null
      }
    }
  })()

  currentLoad.promise = promise
  loadPromise = promise
  return promise
}

async function waitForCurrentLoad(signal?: AbortSignal): Promise<void> {
  while (!loaded) {
    const generation = activeGeneration
    const promise = ensureLoadPromise()
    await withCallerAbort(promise, signal)

    if (loaded && generation === activeGeneration) {
      return
    }
  }
}

export function invalidateSearchIndexMemory(): void {
  activeGeneration += 1
  abortInFlightLoads()
  loadPromise = null
  loaded = false
  loadedVersion = null
  loadedEntryKeys = new Set<string>()
}

async function loadSearchIndex(signal?: AbortSignal): Promise<void> {
  if (loaded) {
    return
  }

  await waitForCurrentLoad(signal)
}

export async function loadDeepSearchIndex(signal?: AbortSignal): Promise<void> {
  await loadSearchIndex(signal)
}

export async function searchIndex(
  query: string,
  sort: SearchSortMode,
  page: number,
  pageSize: number,
  signal?: AbortSignal
): Promise<PageResponse<ArticleListItemResponse>> {
  activeSearchController?.abort()
  const controller = new AbortController()
  activeSearchController = controller
  const combinedSignal = combineAbortSignals(signal, controller.signal)
  const effectiveSignal = combinedSignal.signal

  try {
    await loadSearchIndex(effectiveSignal)
    if (effectiveSignal.aborted || activeSearchController !== controller) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    const payload = await searchIndexBinary(query.trim(), sort, Math.max(1, page), Math.max(1, pageSize), effectiveSignal)
    if (effectiveSignal.aborted || activeSearchController !== controller) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    return mapArticleSearchFromPodPayload(payload)
  } finally {
    combinedSignal.cleanup()
    if (activeSearchController === controller) {
      activeSearchController = null
    }
  }
}

export type { SearchSortMode }

if (typeof window !== 'undefined') {
  subscribeServiceWorkerMessages((message) => {
    if (message.type === 'search-index-ready' && (!loadedVersion || message.version !== loadedVersion)) {
      invalidateSearchIndexMemory()
    }
  })
}

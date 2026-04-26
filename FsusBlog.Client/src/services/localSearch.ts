import type { ArticleListItemResponse, PageResponse } from '@/api/article'
import { mapArticlePageFromPodPayload } from '@/adapters/binary/articleAdapter'
import { subscribeServiceWorkerMessages } from '@/services/serviceWorkerRuntime'
import { appErrorFromStatus } from '@/utils/appError'
import { isAbortError } from '@/utils/errors'
import { initSearchRuntime, loadSearchIndex as loadSearchIndexIntoRuntime, searchIndexBinary, type SearchSortMode } from '@wasm/search'

type SearchShardRole = 'core' | 'recent' | 'archive' | 'body'
type SearchShardRoleValue = SearchShardRole | 0 | 1 | 2 | 3

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
  return `${(import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')}search/index.manifest.json`
}

const SEARCH_MANIFEST_URL = resolveSearchManifestUrl()
const SEARCH_PACKAGE_MAGIC = 0x4b505346
const SEARCH_PACKAGE_VERSION = 2

let loadPromise: Promise<void> | null = null
let loaded = false
let loadedVersion: string | null = null
let loadedEntries = new Map<string, Uint8Array>()
let loadedManifest: SearchManifest | null = null
let activeGeneration = 0
let activeLoadController: AbortController | null = null
let backgroundPreloadController: AbortController | null = null
let runtimeReloadPromise: Promise<void> = Promise.resolve()

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: 'GET',
    signal,
    credentials: 'same-origin',
    cache: 'no-store'
  })

  if (!response.ok) {
    throw appErrorFromStatus(response.status, `search_manifest_fetch_failed:${response.status}`)
  }

  return await response.json() as T
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
    case 'body':
      return 3
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
    case 3:
    case 'body':
      return 'body'
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

async function loadManifest(signal?: AbortSignal): Promise<SearchManifest> {
  return await fetchJson<SearchManifest>(SEARCH_MANIFEST_URL, signal)
}

async function loadAssetsForRoles(manifest: SearchManifest, roles: readonly string[], signal?: AbortSignal): Promise<Map<string, Uint8Array>> {
  const results = new Map<string, Uint8Array>()
  for (const role of roles) {
    const shard = manifest.shards.find((it) => normalizeShardRole(it.role) === role)
    if (!shard) {
      continue
    }

    const normalizedRole = normalizeShardRole(shard.role)
    if (!normalizedRole) {
      continue
    }

    const shardBytes = await fetchBytes(shard.fullUrl, signal)
    results.set(roleCacheKey('shard', normalizedRole), shardBytes)
  }

  return results
}

function isGenerationActive(generation: number, controller?: AbortController | null): boolean {
  return generation === activeGeneration && !(controller?.signal.aborted ?? false)
}

function createAbortError(message: string): Error {
  return new DOMException(message, 'AbortError')
}

function abortInFlightLoads(): void {
  activeLoadController?.abort()
  backgroundPreloadController?.abort()
  activeLoadController = null
  backgroundPreloadController = null
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
      for (const role of ['core', 'recent', 'archive', 'body'] as const) {
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

      await loadSearchIndexIntoRuntime(buildSearchPackage(packageEntries))
    })

  await runtimeReloadPromise
}

async function preloadBackgroundShard(manifest: SearchManifest, generation: number): Promise<void> {
  if (!isGenerationActive(generation)) {
    return
  }

  backgroundPreloadController?.abort()
  const controller = new AbortController()
  backgroundPreloadController = controller

  const roles = manifest.backgroundRoles.filter((role): role is SearchShardRole => role === 'archive')
  if (roles.length === 0) {
    if (backgroundPreloadController === controller) {
      backgroundPreloadController = null
    }
    return
  }

  try {
    const extra = await loadAssetsForRoles(manifest, roles, controller.signal)
    if (!isGenerationActive(generation, controller)) {
      return
    }

    const nextEntries = new Map(loadedEntries)
    let changed = false
    for (const [key, value] of extra) {
      if (!nextEntries.has(key)) {
        nextEntries.set(key, value)
        changed = true
      }
    }

    if (!changed) {
      return
    }

    await reloadRuntimeFromEntries(nextEntries, generation, controller)
    if (!isGenerationActive(generation, controller)) {
      return
    }

    loadedEntries = nextEntries
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

  const promise = (async () => {
    try {
      const manifest = await loadManifest(controller.signal)
      if (!isGenerationActive(generation, controller)) {
        return
      }

      const initialRoles = manifest.initialRoles.filter((role): role is SearchShardRole => role === 'core' || role === 'recent' || role === 'archive' || role === 'body')
      const entries = await loadAssetsForRoles(manifest, initialRoles, controller.signal)
      if (!isGenerationActive(generation, controller)) {
        return
      }

      await reloadRuntimeFromEntries(entries, generation, controller)
      if (!isGenerationActive(generation, controller)) {
        return
      }

      loadedEntries = entries
      loadedManifest = manifest
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

      if (loadPromise === promise) {
        loadPromise = null
      }
    }
  })()

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

async function mergeEntriesAndReload(extra: Map<string, Uint8Array>, generation: number, controller?: AbortController | null): Promise<void> {
  if (!isGenerationActive(generation, controller)) {
    return
  }

  const nextEntries = new Map(loadedEntries)
  let changed = false
  for (const [key, value] of extra) {
    if (!nextEntries.has(key)) {
      nextEntries.set(key, value)
      changed = true
    }
  }

  if (!changed) {
    return
  }

  await reloadRuntimeFromEntries(nextEntries, generation, controller)
  if (!isGenerationActive(generation, controller)) {
    return
  }

  loadedEntries = nextEntries
}

export function invalidateSearchIndexMemory(): void {
  activeGeneration += 1
  abortInFlightLoads()
  loadPromise = null
  loaded = false
  loadedVersion = null
  loadedEntries = new Map<string, Uint8Array>()
  loadedManifest = null
}

export async function loadSearchIndex(signal?: AbortSignal): Promise<void> {
  if (loaded) {
    return
  }

  await waitForCurrentLoad(signal)
}

export async function loadDeepSearchIndex(signal?: AbortSignal): Promise<void> {
  await loadSearchIndex(signal)
  const generation = activeGeneration
  const manifest = loadedManifest ?? await loadManifest(signal)
  if (generation !== activeGeneration) {
    return
  }
  loadedManifest = manifest
  const roles = manifest.deepRoles.filter((role): role is SearchShardRole => role === 'body')
  if (roles.length === 0) {
    return
  }

  const extra = await loadAssetsForRoles(manifest, roles, signal)
  await mergeEntriesAndReload(extra, generation)
}

export async function searchIndex(
  query: string,
  sort: SearchSortMode,
  page: number,
  pageSize: number,
  signal?: AbortSignal
): Promise<PageResponse<ArticleListItemResponse>> {
  await loadSearchIndex(signal)
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }

  const payload = await searchIndexBinary(query.trim(), sort, Math.max(1, page), Math.max(1, pageSize))
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }

  return mapArticlePageFromPodPayload(payload)
}

export type { SearchSortMode }

if (typeof window !== 'undefined') {
  subscribeServiceWorkerMessages((message) => {
    if (message.type === 'search-index-ready' && (!loadedVersion || message.version !== loadedVersion)) {
      invalidateSearchIndexMemory()
    }
  })
}

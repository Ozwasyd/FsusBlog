import type { ArticleListItemResponse, PageResponse } from '@/api/article'
import { mapArticlePageFromPodPayload } from '@/adapters/binary/articleAdapter'
import { subscribeServiceWorkerMessages } from '@/services/serviceWorkerRuntime'
import { appErrorFromStatus } from '@/utils/appError'
import { initSearchRuntime, loadSearchIndex as loadSearchIndexIntoRuntime, searchIndexBinary, type SearchSortMode } from '@wasm/search'

function resolveSearchIndexUrl(): string {
  return `${(import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')}search/index.bin`
}

const SEARCH_INDEX_URL = resolveSearchIndexUrl()

let loadPromise: Promise<void> | null = null
let loaded = false

async function fetchSearchIndex(signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(SEARCH_INDEX_URL, {
    method: 'GET',
    signal,
    credentials: 'same-origin',
    cache: import.meta.env.PROD ? 'no-store' : 'force-cache'
  })

  if (!response.ok) {
    throw appErrorFromStatus(response.status, `search_index_fetch_failed:${response.status}`)
  }

  const buffer = await response.arrayBuffer()
  return new Uint8Array(buffer)
}

export function invalidateSearchIndexMemory(): void {
  loadPromise = null
  loaded = false
}

export async function loadSearchIndex(signal?: AbortSignal): Promise<void> {
  if (loaded) {
    return
  }

  if (!loadPromise) {
    loadPromise = (async () => {
      await initSearchRuntime()
      const bytes = await fetchSearchIndex(signal)
      await loadSearchIndexIntoRuntime(bytes)
      loaded = true
    })().catch((error) => {
      loadPromise = null
      throw error
    })
  }

  await loadPromise
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
    if (message.type === 'search-index-ready') {
      invalidateSearchIndexMemory()
    }
  })
}

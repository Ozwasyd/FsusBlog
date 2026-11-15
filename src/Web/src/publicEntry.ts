import { api } from '../../Contracts/client'
import { fetchPublicArticleMedia, type PublicArticleImage } from '../../Contracts/published-media'

type InitialListing = { page: number; value: Awaited<ReturnType<typeof api.publicList>> }
type InitialArticle = {
  value: Awaited<ReturnType<typeof api.publicArticle>>
  images?: readonly PublicArticleImage[]
}

let listing: InitialListing | undefined
let article: InitialArticle | undefined

export function pageNumber(input: unknown): number {
  const value = typeof input === 'string' ? Number(input) : 1
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : 1
}

export async function preloadPublicEntry(route: { name: unknown; params: Record<string, unknown>; query: Record<string, unknown> }) {
  const entry = document.querySelector('#app')
  if (!entry?.firstElementChild) return
  const signal = AbortSignal.timeout(2_500)
  try {
    if (route.name === 'home' && pageNumber(route.query.page) === 1 && !route.query.cursor) {
      listing = { page: 1, value: await api.publicList(1, 10, signal) }
    } else if (route.name === 'article') {
      const id = Number(route.params.id)
      const value = await api.publicArticle(id, signal)
      if (value.id !== id) return
      article = { value }
      if (value.hasPublishedMedia) article.images = await fetchPublicArticleMedia(id, value.publication, signal)
    }
  } catch {
    // The route owns retry, not-found, and error states after takeover.
  }
}

export function readInitialArticle(id: number) {
  const value = article
  article = undefined
  return value?.value.id === id ? value : undefined
}

export function readInitialListing(page: number) {
  const value = listing
  listing = undefined
  return value?.page === page ? value.value : undefined
}

import { api } from '../../Contracts/client'
import { fetchPublicArticleMedia, type PublicArticleImage } from '../../Contracts/published-media'

type ListingScope = 'home' | 'archive'
type InitialListing = { scope: ListingScope; page: number; value: Awaited<ReturnType<typeof api.publicList>> }
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
    if ((route.name === 'home' || route.name === 'archive') && pageNumber(route.query.page) === 1 && !route.query.cursor) {
      listing = { scope: route.name, page: 1, value: await api.publicList(1, 10, signal, { archive: route.name === 'archive' }) }
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

export function readInitialListing(page: number, scope: ListingScope) {
  const value = listing
  listing = undefined
  return value?.page === page && value.scope === scope ? value.value : undefined
}

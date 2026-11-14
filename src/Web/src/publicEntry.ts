import { api } from '../../Contracts/client'

type InitialListing = { page: number; value: Awaited<ReturnType<typeof api.publicList>> }
type InitialArticle = { id: number; value: Awaited<ReturnType<typeof api.publicArticle>> }

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
      article = { id, value: await api.publicArticle(id, signal) }
    }
  } catch {
    // The route owns retry, not-found, and error states after takeover.
  }
}

export function readInitialArticle(id: number) {
  const value = article
  article = undefined
  return value?.id === id ? value.value : undefined
}

export function readInitialListing(page: number) {
  const value = listing
  listing = undefined
  return value?.page === page ? value.value : undefined
}

import { api } from '../../Contracts/client'
import { fetchPublicArticleMedia, type PublicArticleImage } from '../../Contracts/published-media'
import { taxonomyArticles, taxonomyMetadata, type TaxonomyKind, type TaxonomyMetadata } from '../../Contracts/taxonomy-client'
import { isSitePageSlug, preloadSitePage } from './sitePageEntry'

type ListingScope = 'home' | 'archive'
type InitialListing = { scope: ListingScope; page: number; value: Awaited<ReturnType<typeof api.publicList>> }
type InitialArticle = {
  value: Awaited<ReturnType<typeof api.publicArticle>>
  images?: readonly PublicArticleImage[]
}
type InitialTaxonomy = {
  kind: TaxonomyKind
  id: number
  page: number
  metadata: TaxonomyMetadata
  result: Awaited<ReturnType<typeof api.publicList>>
}

let listing: InitialListing | undefined
let article: InitialArticle | undefined
let taxonomy: InitialTaxonomy | undefined

export function pageNumber(input: unknown): number {
  const value = typeof input === 'string' ? Number(input) : 1
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : 1
}

async function fetchPublicRoute(route: { name: unknown; params: Record<string, unknown>; query: Record<string, unknown> }, signal: AbortSignal) {
  listing = undefined
  article = undefined
  taxonomy = undefined
  try {
    if ((route.name === 'home' || route.name === 'archive') && pageNumber(route.query.page) === 1 && !route.query.cursor) {
      const value = await api.publicList(1, 10, signal, { archive: route.name === 'archive' })
      if (!signal.aborted) listing = { scope: route.name, page: 1, value }
    } else if (route.name === 'article') {
      const id = Number(route.params.id)
      const value = await api.publicArticle(id, signal)
      if (signal.aborted || value.id !== id) return
      const next: InitialArticle = { value }
      if (value.hasPublishedMedia) {
        const images = await fetchPublicArticleMedia(id, value.publication, signal)
        if (!signal.aborted) next.images = images
      }
      if (!signal.aborted) article = next
    } else if ((route.name === 'category' || route.name === 'tag') && pageNumber(route.query.page) === 1 && !route.query.cursor) {
      const id = Number(route.params.id)
      const kind = route.name
      const [metadata, result] = await Promise.all([
        taxonomyMetadata(kind, id, signal),
        taxonomyArticles(kind, id, 1, 10, signal),
      ])
      if (!signal.aborted) taxonomy = { kind, id, page: 1, metadata, result }
    } else if (isSitePageSlug(route.name)) {
      await preloadSitePage(route.name, signal)
    }
  } catch {
    // The route owns retry, not-found, and error states after takeover.
  }
}

export async function preloadPublicEntry(route: { name: unknown; params: Record<string, unknown>; query: Record<string, unknown> }) {
  const entry = document.querySelector('#app')
  if (!entry?.firstElementChild) return
  if (isSitePageSlug(route.name)) return
  await fetchPublicRoute(route, AbortSignal.timeout(2_500))
}

export async function preloadPublicRoute(
  route: { name: unknown; params: Record<string, unknown>; query: Record<string, unknown> },
  signal: AbortSignal,
) {
  await fetchPublicRoute(route, signal)
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

export function readInitialTaxonomy(kind: TaxonomyKind, id: number, page: number) {
  const value = taxonomy
  taxonomy = undefined
  return value?.kind === kind && value.id === id && value.page === page ? value : undefined
}

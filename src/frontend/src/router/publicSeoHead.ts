export const PUBLIC_SEO_HEAD_SCHEMA = 'fsusblog.public-seo-head'
export const PUBLIC_SEO_HEAD_VERSION = 1

export type PublicSeoHeadModel = Readonly<{
  schema: typeof PUBLIC_SEO_HEAD_SCHEMA
  version: typeof PUBLIC_SEO_HEAD_VERSION
  digest: string
  documentTitle: string
  description: string
  canonicalUrl: string
  publicOrigin: string
  robots: string
  locale: string
  pageType: string
  pageEntityId: string
  openGraph: Readonly<{
    title: string
    description: string
    type: string
    url: string
    locale: string
    imageUrl?: string | null
  }>
  twitter: Readonly<{
    card: string
    title: string
    description: string
    imageUrl?: string | null
  }>
  jsonLdGraph: string
  articlePublishedAtUtc?: string | null
  articleModifiedAtUtc?: string | null
  articleAuthor?: string | null
  articleImageUrl?: string | null
}>

type StoredHead = Readonly<{
  model: PublicSeoHeadModel
  expiresAtMs: number
}>

const HEAD_TTL_MS = 5 * 60 * 1000
const preparedHeads = new Map<string, StoredHead>()
const encoder = new TextEncoder()

function resolveBrowserOrigin(): string {
  if (typeof window === 'undefined') return 'https://fsus.blog'
  const origin = window.location.origin
  return origin && origin !== 'null' ? origin : 'http://127.0.0.1'
}

function normalizeFullPath(value: string): string {
  const url = new URL(value, resolveBrowserOrigin())
  const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/u, '') || '/'
  return `${path}${url.search}${url.hash}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  return optionalString(record[key])
}

function parseModel(value: unknown): PublicSeoHeadModel | null {
  if (!isRecord(value) || !isRecord(value.openGraph) || !isRecord(value.twitter)) {
    return null
  }

  const model = value as Record<string, unknown>
  const openGraph = value.openGraph
  const twitter = value.twitter
  const required = [
    'digest', 'documentTitle', 'description', 'canonicalUrl', 'publicOrigin', 'robots', 'locale',
    'pageType', 'pageEntityId', 'jsonLdGraph'
  ] as const
  if (model.schema !== PUBLIC_SEO_HEAD_SCHEMA || model.version !== PUBLIC_SEO_HEAD_VERSION ||
      required.some((key) => requiredString(model, key) === null) ||
      ['title', 'description', 'type', 'url', 'locale'].some((key) => requiredString(openGraph, key) === null) ||
      ['card', 'title', 'description'].some((key) => requiredString(twitter, key) === null)) {
    return null
  }

  return value as PublicSeoHeadModel
}

function digestFields(model: PublicSeoHeadModel): readonly (string | null | undefined)[] {
  return [
    model.schema,
    String(model.version),
    model.documentTitle,
    model.description,
    model.canonicalUrl,
    model.publicOrigin,
    model.robots,
    model.locale,
    model.pageType,
    model.pageEntityId,
    model.openGraph.title,
    model.openGraph.description,
    model.openGraph.type,
    model.openGraph.url,
    model.openGraph.locale,
    model.openGraph.imageUrl,
    model.twitter.card,
    model.twitter.title,
    model.twitter.description,
    model.twitter.imageUrl,
    model.jsonLdGraph,
    model.articlePublishedAtUtc,
    model.articleModifiedAtUtc,
    model.articleAuthor,
    model.articleImageUrl
  ]
}

export async function computePublicSeoHeadDigest(model: PublicSeoHeadModel): Promise<string> {
  const chunks = digestFields(model).flatMap((value) => {
    const bytes = encoder.encode(value ?? '')
    return [encoder.encode(`${bytes.byteLength}:`), bytes]
  })
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const payload = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    payload.set(chunk, offset)
    offset += chunk.byteLength
  }

  const digest = await globalThis.crypto.subtle.digest('SHA-256', payload)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

function hasConsistentOriginAndIdentity(model: PublicSeoHeadModel, canonicalPath: string): boolean {
  if (typeof window === 'undefined') {
    return true
  }

  try {
    const canonical = new URL(model.canonicalUrl)
    const entity = new URL(model.pageEntityId, canonical)
    const expectedPath = normalizeFullPath(canonicalPath).split('#', 1)[0]
    const canonicalFullPath = normalizeFullPath(`${canonical.pathname}${canonical.search}`).split('#', 1)[0]
    return canonical.origin === model.publicOrigin &&
      entity.origin === canonical.origin &&
      entity.toString() === canonical.toString() &&
      canonicalFullPath === expectedPath &&
      model.openGraph.url === model.canonicalUrl
  } catch {
    return false
  }
}

function jsonLdReferencesPageEntity(value: unknown, entityId: string): boolean {
  if (!isRecord(value) || !Array.isArray(value['@graph'])) return false
  return value['@graph'].some((node) => {
    if (!isRecord(node)) return false
    if (node.url === entityId || node['@id'] === entityId) return true
    const mainEntity = node.mainEntityOfPage
    return isRecord(mainEntity) && mainEntity['@id'] === entityId
  })
}

function store(model: PublicSeoHeadModel, fullPath: string, nowMs = Date.now()): void {
  preparedHeads.set(normalizeFullPath(fullPath), { model, expiresAtMs: nowMs + HEAD_TTL_MS })
}

export async function validateAndPreparePublicSeoHead(
  value: unknown,
  fullPath: string,
  canonicalPath: string,
  nowMs?: number
): Promise<boolean> {
  const model = parseModel(value)
  if (!model || !hasConsistentOriginAndIdentity(model, canonicalPath)) {
    return false
  }

  const expectedDigest = await computePublicSeoHeadDigest(model)
  if (expectedDigest !== model.digest.toLowerCase()) {
    return false
  }

  try {
    const graph = JSON.parse(model.jsonLdGraph) as unknown
    if (!jsonLdReferencesPageEntity(graph, model.pageEntityId)) {
      return false
    }
  } catch {
    return false
  }

  store(model, fullPath, nowMs)
  return true
}

export function hasPreparedPublicSeoHead(fullPath: string, nowMs = Date.now()): boolean {
  const key = normalizeFullPath(fullPath)
  const entry = preparedHeads.get(key)
  if (!entry || entry.expiresAtMs <= nowMs) {
    preparedHeads.delete(key)
    return false
  }

  return true
}

function captureCurrentHead(fullPath: string): void {
  if (typeof document === 'undefined') {
    return
  }

  const script = document.querySelector<HTMLScriptElement>('script[data-fsus-seo-head-model]')
  if (!script?.textContent) {
    return
  }

  try {
    const model = parseModel(JSON.parse(script.textContent))
    if (model && hasConsistentOriginAndIdentity(model, new URL(model.canonicalUrl).pathname)) {
      store(model, fullPath)
    }
  } catch {
    // A malformed server marker is never reused; the next navigation will fetch a fresh snapshot.
  }
}

function appendMeta(fragment: DocumentFragment, selector: 'name' | 'property', key: string, content: string | null | undefined): void {
  if (!content) return
  const meta = document.createElement('meta')
  meta.setAttribute(selector, key)
  meta.setAttribute('content', content)
  meta.dataset.fsusAotHead = ''
  fragment.appendChild(meta)
}

function appendFeed(fragment: DocumentFragment, type: string, title: string, href: string): void {
  const link = document.createElement('link')
  link.rel = 'alternate'
  link.type = type
  link.title = title
  link.href = href
  link.dataset.fsusAotHead = ''
  fragment.appendChild(link)
}

function readCspNonce(): string {
  const source = document.querySelector<HTMLElement>('meta[property="csp-nonce"], script[nonce], style[nonce]')
  return source?.nonce ?? ''
}

function buildHeadFragment(model: PublicSeoHeadModel): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const title = document.createElement('title')
  title.dataset.fsusAotHead = ''
  title.textContent = model.documentTitle
  fragment.appendChild(title)
  appendMeta(fragment, 'name', 'description', model.description)
  appendMeta(fragment, 'name', 'robots', model.robots)
  appendMeta(fragment, 'property', 'og:title', model.openGraph.title)
  appendMeta(fragment, 'property', 'og:description', model.openGraph.description)
  appendMeta(fragment, 'property', 'og:type', model.openGraph.type)
  appendMeta(fragment, 'property', 'og:url', model.openGraph.url)
  appendMeta(fragment, 'property', 'og:locale', model.openGraph.locale)
  appendMeta(fragment, 'property', 'og:image', model.openGraph.imageUrl)
  appendMeta(fragment, 'name', 'twitter:card', model.twitter.card)
  appendMeta(fragment, 'name', 'twitter:title', model.twitter.title)
  appendMeta(fragment, 'name', 'twitter:description', model.twitter.description)
  appendMeta(fragment, 'name', 'twitter:image', model.twitter.imageUrl)

  const canonical = document.createElement('link')
  canonical.rel = 'canonical'
  canonical.href = model.canonicalUrl
  canonical.dataset.fsusAotHead = ''
  fragment.appendChild(canonical)
  appendFeed(fragment, 'application/rss+xml', 'RSS', '/feed/rss.xml')
  appendFeed(fragment, 'application/atom+xml', 'Atom', '/feed/atom.xml')
  appendFeed(fragment, 'application/feed+json', 'JSON Feed', '/feed/feed.json')

  const jsonLd = document.createElement('script')
  jsonLd.type = 'application/ld+json'
  const nonce = readCspNonce()
  if (nonce) jsonLd.nonce = nonce
  jsonLd.dataset.fsusAotHead = ''
  jsonLd.textContent = model.jsonLdGraph
  fragment.appendChild(jsonLd)
  const marker = document.createElement('script')
  marker.type = 'application/json'
  if (nonce) marker.nonce = nonce
  marker.dataset.fsusSeoHeadModel = ''
  marker.dataset.fsusAotHead = ''
  marker.textContent = JSON.stringify(model)
  fragment.appendChild(marker)
  return fragment
}

function removeExistingPublicPageHead(): void {
  const selectors = [
    '[data-fsus-aot-head]',
    'title',
    'meta[name="description"]',
    'meta[name="robots"]',
    'meta[property^="og:"]',
    'meta[name^="twitter:"]',
    'link[rel="canonical"]',
    'link[rel="alternate"][type="application/rss+xml"]',
    'link[rel="alternate"][type="application/atom+xml"]',
    'link[rel="alternate"][type="application/feed+json"]',
    'script[type="application/ld+json"]',
    'script[data-fsus-seo-head-model]'
  ]
  const nodes = new Set(selectors.flatMap((selector) => Array.from(document.head.querySelectorAll(selector))))
  for (const node of nodes) node.remove()
}

export function commitPreparedPublicSeoHead(
  fullPath: string,
  previousFullPath?: string
): boolean {
  if (typeof document === 'undefined') {
    return false
  }

  if (previousFullPath) {
    captureCurrentHead(previousFullPath)
  }
  const key = normalizeFullPath(fullPath)
  const entry = preparedHeads.get(key)
  if (!entry || entry.expiresAtMs <= Date.now()) {
    preparedHeads.delete(key)
    return false
  }

  const fragment = buildHeadFragment(entry.model)
  removeExistingPublicPageHead()
  document.documentElement.lang = entry.model.locale
  document.head.appendChild(fragment)
  return true
}

export function clearPublicSeoHead(previousFullPath?: string): void {
  if (typeof document === 'undefined') return
  if (previousFullPath) captureCurrentHead(previousFullPath)
  for (const node of document.head.querySelectorAll('[data-fsus-aot-head]')) {
    node.remove()
  }
}

export function commitPublicSearchNoIndexHead(previousFullPath?: string): void {
  if (typeof document === 'undefined') return
  if (previousFullPath) captureCurrentHead(previousFullPath)
  removeExistingPublicPageHead()
  const robots = document.createElement('meta')
  robots.name = 'robots'
  robots.content = 'noindex,follow'
  robots.dataset.fsusSearchHead = ''
  document.head.appendChild(robots)
}

export function clearPublicSearchNoIndexHead(): void {
  if (typeof document === 'undefined') return
  for (const node of document.head.querySelectorAll('[data-fsus-search-head]')) {
    node.remove()
  }
}

export function resetPublicSeoHeadForTests(): void {
  preparedHeads.clear()
}

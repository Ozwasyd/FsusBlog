import type { ArticleDetailResponse, ArticleListItemResponse, Tag } from '@/api/article'

export type PublicAotBootstrapKind = 'Home' | 'About' | 'Archive' | 'ArticleDetail' | 'Filter'

type BootstrapArticleSummary = Readonly<{
  id: number
  title: string
  summary?: string | null
  snippet?: string | null
  content?: string | null
  views?: number | null
  createTime: string
  category?: string | null
  tags?: readonly string[] | null
}>

type BaseBootstrapPayload = Readonly<{
  kind: PublicAotBootstrapKind
  path?: string
  query?: string
  siteTitle?: string
  siteDescription?: string
  generatedAt?: string
}>

export type HomeBootstrapPayload = BaseBootstrapPayload & Readonly<{
  kind: 'Home'
  total: number
  articles: readonly BootstrapArticleSummary[]
}>

export type AboutBootstrapPayload = BaseBootstrapPayload & Readonly<{
  kind: 'About'
  about?: Readonly<{
    slug?: string
    content?: string
  }>
}>

export type ArchiveBootstrapPayload = BaseBootstrapPayload & Readonly<{
  kind: 'Archive'
  total: number
  articles: readonly Readonly<{
    id: number
    title: string
    createTime: string
  }>[]
}>

export type ArticleDetailBootstrapPayload = BaseBootstrapPayload & Readonly<{
  kind: 'ArticleDetail'
  article?: BootstrapArticleSummary
  commentsPlaceholder?: string
}>

export type FilterBootstrapPayload = BaseBootstrapPayload & Readonly<{
  kind: 'Filter'
  filter?: Readonly<{
    pageIndex?: number
    pageSize?: number
    total?: number
    articles?: readonly BootstrapArticleSummary[]
  }>
}>

export type PublicAotBootstrapPayload =
  | HomeBootstrapPayload
  | AboutBootstrapPayload
  | ArchiveBootstrapPayload
  | ArticleDetailBootstrapPayload
  | FilterBootstrapPayload

const BOOTSTRAP_SCRIPT_ID = 'fsus-aot-bootstrap'

let cachedBootstrap: PublicAotBootstrapPayload | null | undefined
let bootstrapConsumed = false

function decodeHtmlEntities(raw: string): string {
  return raw
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&#39;', '\'')
    .replaceAll('&#x2F;', '/')
}

function normalizePathname(pathname: string | null | undefined): string {
  if (!pathname || pathname === '/') {
    return '/'
  }

  const trimmed = pathname.trim().replace(/\/+$/, '')
  return trimmed.length > 0 ? trimmed : '/'
}

function readBootstrapScriptText(): string | null {
  if (typeof document === 'undefined') {
    return null
  }

  const script = document.getElementById(BOOTSTRAP_SCRIPT_ID)
  const text = script?.textContent?.trim()
  return text ? text : null
}

function readBootstrap(): PublicAotBootstrapPayload | null {
  if (cachedBootstrap !== undefined) {
    return cachedBootstrap
  }

  const raw = readBootstrapScriptText()
  if (!raw) {
    cachedBootstrap = null
    return cachedBootstrap
  }

  try {
    const parsed = JSON.parse(decodeHtmlEntities(raw)) as PublicAotBootstrapPayload
    cachedBootstrap = parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    cachedBootstrap = null
  }

  return cachedBootstrap
}

function matchesCurrentLocation(payload: BaseBootstrapPayload): boolean {
  if (typeof window === 'undefined') {
    return true
  }

  const currentPath = normalizePathname(window.location.pathname)
  const bootstrapPath = normalizePathname(payload.path)
  const currentQuery = window.location.search || ''
  const bootstrapQuery = payload.query || ''

  return currentPath === bootstrapPath && currentQuery === bootstrapQuery
}

function markConsumed(): void {
  bootstrapConsumed = true
  if (typeof document === 'undefined') {
    return
  }

  document.getElementById(BOOTSTRAP_SCRIPT_ID)?.remove()
}

export function consumePublicAotBootstrap<TKind extends PublicAotBootstrapKind>(
  kind: TKind
): Extract<PublicAotBootstrapPayload, { kind: TKind }> | null {
  if (bootstrapConsumed) {
    return null
  }

  const payload = readBootstrap()
  if (!payload || payload.kind !== kind || !matchesCurrentLocation(payload)) {
    return null
  }

  markConsumed()
  return payload as Extract<PublicAotBootstrapPayload, { kind: TKind }>
}

function normalizeTagList(tags: readonly string[] | null | undefined): Tag[] {
  return Array.isArray(tags)
    ? tags.map((name, index) => ({
        id: index + 1,
        name
      }))
    : []
}

export function toBootstrapArticleListItem(article: BootstrapArticleSummary): ArticleListItemResponse {
  return {
    id: article.id,
    title: article.title,
    summary: article.summary ?? '',
    views: Number(article.views) || 0,
    createTime: article.createTime,
    category: {
      id: 0,
      name: article.category?.trim() || '未分类'
    },
    tags: normalizeTagList(article.tags)
  }
}

export function toBootstrapArchiveArticleListItem(article: {
  id: number
  title: string
  createTime: string
}): ArticleListItemResponse {
  return {
    id: article.id,
    title: article.title,
    summary: '',
    views: 0,
    createTime: article.createTime,
    category: {
      id: 0,
      name: '未分类'
    },
    tags: []
  }
}

export function toBootstrapArticleDetail(article: BootstrapArticleSummary): ArticleDetailResponse {
  return {
    id: article.id,
    title: article.title,
    content: article.content ?? '',
    summary: article.summary ?? '',
    views: Number(article.views) || 0,
    createTime: article.createTime,
    category: article.category?.trim()
      ? {
          id: 0,
          name: article.category.trim()
        }
      : undefined,
    tags: normalizeTagList(article.tags)
  }
}

import type { ArticleDetailResponse, ArticleListItemResponse, Tag } from '@/api/article'
import { decodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import type {
  BootstrapArticleSummary,
  PublicAotBootstrapKind,
  PublicAotBootstrapPayload,
  PublicAotBootstrapPayloadFor
} from '@/public-renderers/publicPayloadTypes'

export type {
  PublicAotBootstrapKind,
  PublicAotBootstrapPayload,
  PublicAotBootstrapPayloadFor
} from '@/public-renderers/publicPayloadTypes'

const BOOTSTRAP_SCRIPT_ID = 'fsus-aot-bootstrap'

let cachedBootstrap: PublicAotBootstrapPayload | null | undefined
let bootstrapConsumed = false
let serverBootstrapOverride: PublicAotBootstrapPayload | null = null

type PublicBootstrapSnapshotWindow = Window & typeof globalThis & {
  __FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__?: string | null
}

function readWindowBootstrapRaw(): string | null {
  if (typeof window === 'undefined') {
    return null
  }

  const raw = (window as PublicBootstrapSnapshotWindow).__FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

function writeWindowBootstrapRaw(rawPayload: string | null): void {
  if (typeof window === 'undefined') {
    return
  }

  (window as PublicBootstrapSnapshotWindow).__FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__ = rawPayload
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
  if (text) {
    return text
  }

  return readWindowBootstrapRaw()
}

function readBootstrap(): PublicAotBootstrapPayload | null {
  if (serverBootstrapOverride) {
    return serverBootstrapOverride
  }

  const raw = readBootstrapScriptText()

  if (cachedBootstrap !== undefined && (cachedBootstrap !== null || !raw)) {
    return cachedBootstrap
  }

  if (!raw) {
    return null
  }

  try {
    const parsed = decodePublicAotPayload<PublicAotBootstrapPayload>(raw)
    cachedBootstrap = parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    cachedBootstrap = null
  }

  return cachedBootstrap
}

function matchesCurrentLocation(payload: Pick<PublicAotBootstrapPayload, 'path' | 'query'>): boolean {
  if (typeof window === 'undefined') {
    return true
  }

  const rawPath = typeof payload.path === 'string' ? payload.path.trim() : ''
  const rawQuery = typeof payload.query === 'string' ? payload.query : null
  if (!rawPath && rawQuery === null) {
    return true
  }

  const currentPath = normalizePathname(window.location.pathname)
  const currentQuery = window.location.search || ''

  if (rawPath && currentPath !== normalizePathname(rawPath)) {
    return false
  }

  return rawQuery === null || currentQuery === rawQuery
}

function markConsumed(): void {
  bootstrapConsumed = true
  writeWindowBootstrapRaw(null)
  if (typeof document === 'undefined') {
    return
  }

  document.getElementById(BOOTSTRAP_SCRIPT_ID)?.remove()
}

export function consumePublicAotBootstrap<TKind extends PublicAotBootstrapKind>(
  kind: TKind
): PublicAotBootstrapPayloadFor<TKind> | null {
  if (bootstrapConsumed) {
    return null
  }

  const payload = readBootstrap()
  if (!payload || payload.kind !== kind || !matchesCurrentLocation(payload)) {
    return null
  }

  markConsumed()
  return payload as PublicAotBootstrapPayloadFor<TKind>
}

export function setServerPublicAotBootstrapOverride(payload: PublicAotBootstrapPayload | null): void {
  serverBootstrapOverride = payload
  cachedBootstrap = payload
  bootstrapConsumed = false
}

function normalizeTagList(tags: readonly string[] | null | undefined): Tag[] {
  return Array.isArray(tags)
    ? tags.map((name, index) => ({
        id: index + 1,
        name
      }))
    : []
}

function normalizeCategory(
  category: BootstrapArticleSummary['category']
): { id: number; name: string } {
  if (category && typeof category === 'object') {
    const normalizedId = Number(category.id) || 0
    const normalizedName = category.name?.trim() || '未分类'
    return {
      id: normalizedId,
      name: normalizedName
    }
  }

  return {
    id: 0,
    name: typeof category === 'string' && category.trim().length > 0 ? category.trim() : '未分类'
  }
}

export function toBootstrapArticleListItem(article: BootstrapArticleSummary): ArticleListItemResponse {
  const category = normalizeCategory(article.category)
  return {
    id: article.id,
    title: article.title,
    summary: article.summary ?? '',
    views: Number(article.views) || 0,
    createTime: article.createTime,
    category,
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
  const category = normalizeCategory(article.category)
  return {
    id: article.id,
    title: article.title,
    content: article.content ?? '',
    summary: article.summary ?? '',
    views: Number(article.views) || 0,
    createTime: article.createTime,
    category,
    tags: normalizeTagList(article.tags)
  }
}

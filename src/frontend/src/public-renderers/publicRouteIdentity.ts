import { PUBLIC_ROUTE_IDENTITY_TOKENS } from '@/public-renderers/generated/publicPageManifest'
import {
  PUBLIC_FIXED_PATHS,
  PUBLIC_FIXED_ROUTE_KEYS
} from '@/public-renderers/publicFixedPageSemantics'
import {
  normalizePublicFilterType,
  PUBLIC_FILTER_TYPE,
  type PublicFilterType
} from '@/public-renderers/publicFilterSemantics'
import { resolvePublicFilterRouteMode } from '@/public-renderers/publicRouteRegistry'

export type PublicFilterIdentity = Readonly<{
  filterType: PublicFilterType
  filterKey: string
  routeKey: string
  filterId: number
  filterName: string | null
  canonicalPath: string
}>

const UNKNOWN_FILTER_ROUTE_KEY = PUBLIC_ROUTE_IDENTITY_TOKENS.unknownFilterRouteKey
const SEARCH_ROUTE_KEY = PUBLIC_ROUTE_IDENTITY_TOKENS.searchRouteKey
const ARTICLE_ROUTE_PREFIX = `${PUBLIC_ROUTE_IDENTITY_TOKENS.articleBucket}:`
const CATEGORY_ROUTE_PREFIX = `${PUBLIC_ROUTE_IDENTITY_TOKENS.categoryBucket}:`
const TAG_ROUTE_PREFIX = `${PUBLIC_ROUTE_IDENTITY_TOKENS.tagBucket}:`
const TAG_NAME_ROUTE_PREFIX = `${PUBLIC_ROUTE_IDENTITY_TOKENS.tagNameBucket}:`
const ARTICLE_PATH_PREFIX = PUBLIC_ROUTE_IDENTITY_TOKENS.articlePathPrefix
const CATEGORY_PATH_PREFIX = PUBLIC_ROUTE_IDENTITY_TOKENS.categoryPathPrefix
const TAG_PATH_PREFIX = PUBLIC_ROUTE_IDENTITY_TOKENS.tagPathPrefix
const SEARCH_PATH = PUBLIC_ROUTE_IDENTITY_TOKENS.searchPath
const PAGE_ROUTE_MARKER = ':page:'

function normalizeText(value: unknown): string {
  if (Array.isArray(value)) {
    return normalizeText(value[0])
  }
  if (typeof value === 'string') {
    return value.trim()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value))
  }
  return ''
}

export function parsePublicPaginationCursor(value: unknown): string | null {
  const normalized = normalizeText(value)
  return normalized.length > 0
    && normalized.length <= 512
    && /^[A-Za-z0-9_-]+$/.test(normalized)
    ? normalized
    : null
}

export function parsePositiveInt(value: unknown): number {
  const normalized = normalizeText(value)
  if (!normalized) {
    return 0
  }

  const parsed = Number.parseInt(normalized, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function buildPublicHomeRouteKey(): string {
  return PUBLIC_FIXED_ROUTE_KEYS.home
}

function assertNoLegacyPaginationRouteKey(routeKey: string): string {
  const normalized = normalizeText(routeKey)
  const markerIndex = normalized.lastIndexOf(PAGE_ROUTE_MARKER)
  if (markerIndex > 0) {
    const page = Number(normalized.slice(markerIndex + PAGE_ROUTE_MARKER.length))
    if (Number.isSafeInteger(page) && page > 1) {
      throw new Error('public_legacy_pagination_route_key_forbidden')
    }
  }

  return normalized
}

export function buildPublicPaginationHref(path: string, page: number, cursor?: string | null): string {
  const requestedPage = Math.trunc(page)
  const normalizedPage = Number.isSafeInteger(requestedPage) && requestedPage > 1 ? requestedPage : 1
  if (normalizedPage <= 1) {
    return path
  }

  const normalizedCursor = parsePublicPaginationCursor(cursor)
  if (!normalizedCursor) {
    return path
  }

  const query = new URLSearchParams({ page: String(normalizedPage), cursor: normalizedCursor })
  return `${path}?${query.toString()}`
}

export function buildPublicHomePaginationHref(page: number, cursor?: string | null): string {
  return buildPublicPaginationHref(PUBLIC_FIXED_PATHS.home, page, cursor)
}

export function buildPublicAboutRouteKey(): string {
  return PUBLIC_FIXED_ROUTE_KEYS.about
}

export function buildPublicPrivacyRouteKey(): string {
  return PUBLIC_FIXED_ROUTE_KEYS.privacy
}

export function buildPublicGuidelinesRouteKey(): string {
  return PUBLIC_FIXED_ROUTE_KEYS.guidelines
}

export function buildPublicCopyrightRouteKey(): string {
  return PUBLIC_FIXED_ROUTE_KEYS.copyright
}

export function buildPublicArchiveRouteKey(): string {
  return PUBLIC_FIXED_ROUTE_KEYS.archive
}

export function buildPublicArticleRouteKey(articleId: number | string): string {
  const id = parsePositiveInt(articleId)
  return `${ARTICLE_ROUTE_PREFIX}${id > 0 ? id : 0}`
}

export function buildPublicArticleHref(articleId: number | string): string {
  return `${ARTICLE_PATH_PREFIX}${Math.max(0, parsePositiveInt(articleId))}`
}

function buildPublicCategoryRouteKey(categoryId: number | string): string {
  const id = parsePositiveInt(categoryId)
  return `${CATEGORY_ROUTE_PREFIX}${id > 0 ? id : 0}`
}

function buildPublicTagIdRouteKey(tagId: number | string): string {
  const id = parsePositiveInt(tagId)
  return `${TAG_ROUTE_PREFIX}${id > 0 ? id : 0}`
}

function buildPublicTagNameRouteKey(tagName: string): string {
  const normalizedName = normalizeText(tagName)
  return normalizedName ? `${TAG_NAME_ROUTE_PREFIX}${normalizedName}` : UNKNOWN_FILTER_ROUTE_KEY
}

export function buildPublicFilterRouteKey(input: {
  routeKey?: unknown
  filterType?: unknown
  filterKey?: unknown
  filterId?: unknown
  filterName?: unknown
  searchKeyword?: unknown
} = {}): string {
  const routeKey = normalizeText(input.routeKey)
  if (routeKey) {
    return assertNoLegacyPaginationRouteKey(routeKey)
  }

  const filterKey = normalizeText(input.filterKey)
  if (
    filterKey === SEARCH_ROUTE_KEY
    || filterKey.startsWith(CATEGORY_ROUTE_PREFIX)
    || filterKey.startsWith(TAG_ROUTE_PREFIX)
    || filterKey.startsWith(TAG_NAME_ROUTE_PREFIX)
  ) {
    return filterKey
  }

  const filterType = normalizePublicFilterType(normalizeText(input.filterType))
  if (filterType === PUBLIC_FILTER_TYPE.category) {
    return buildPublicCategoryRouteKey(normalizeText(input.filterId ?? filterKey))
  }

  if (filterType === PUBLIC_FILTER_TYPE.tag) {
    const filterId = parsePositiveInt(input.filterId ?? filterKey)
    if (filterId > 0) {
      return buildPublicTagIdRouteKey(filterId)
    }

    return buildPublicTagNameRouteKey(normalizeText(input.filterName ?? filterKey))
  }

  const searchKeyword = normalizeText(input.searchKeyword)
  if (searchKeyword) {
    return SEARCH_ROUTE_KEY
  }

  return filterKey || SEARCH_ROUTE_KEY
}

export function buildPublicCategoryHref(categoryId: number | string): string {
  return `${CATEGORY_PATH_PREFIX}${Math.max(0, parsePositiveInt(categoryId))}`
}

export function buildPublicTagHref(tagId: number | string): string {
  return `${TAG_PATH_PREFIX}${Math.max(0, parsePositiveInt(tagId))}`
}

function toCanonicalPublicPath(routeKey: string): string {
  const normalizedRouteKey = assertNoLegacyPaginationRouteKey(routeKey)
  if (!normalizedRouteKey) {
    return '/'
  }

  if (normalizedRouteKey === PUBLIC_FIXED_ROUTE_KEYS.home) {
    return PUBLIC_FIXED_PATHS.home
  }
  if (normalizedRouteKey === PUBLIC_FIXED_ROUTE_KEYS.about) {
    return PUBLIC_FIXED_PATHS.about
  }
  if (normalizedRouteKey === PUBLIC_FIXED_ROUTE_KEYS.archive) {
    return PUBLIC_FIXED_PATHS.archive
  }
  if (normalizedRouteKey === PUBLIC_FIXED_ROUTE_KEYS.privacy) {
    return PUBLIC_FIXED_PATHS.privacy
  }
  if (normalizedRouteKey === PUBLIC_FIXED_ROUTE_KEYS.guidelines) {
    return PUBLIC_FIXED_PATHS.guidelines
  }
  if (normalizedRouteKey === PUBLIC_FIXED_ROUTE_KEYS.copyright) {
    return PUBLIC_FIXED_PATHS.copyright
  }
  if (normalizedRouteKey.startsWith(ARTICLE_ROUTE_PREFIX)) {
    return `${ARTICLE_PATH_PREFIX}${normalizedRouteKey.slice(ARTICLE_ROUTE_PREFIX.length)}`
  }
  if (normalizedRouteKey.startsWith(CATEGORY_ROUTE_PREFIX)) {
    return `${CATEGORY_PATH_PREFIX}${normalizedRouteKey.slice(CATEGORY_ROUTE_PREFIX.length)}`
  }
  if (normalizedRouteKey.startsWith(TAG_ROUTE_PREFIX)) {
    return `${TAG_PATH_PREFIX}${normalizedRouteKey.slice(TAG_ROUTE_PREFIX.length)}`
  }
  if (normalizedRouteKey.startsWith(TAG_NAME_ROUTE_PREFIX)) {
    return ''
  }

  return '/'
}

export function buildPublicRoutePaginationHref(routeKey: string, page: number, cursor?: string | null): string {
  return buildPublicPaginationHref(toCanonicalPublicPath(routeKey), page, cursor)
}

export function parsePublicFilterRouteKey(routeKey: string): PublicFilterIdentity {
  const fullRouteKey = normalizeText(routeKey) || UNKNOWN_FILTER_ROUTE_KEY
  const normalizedRouteKey = assertNoLegacyPaginationRouteKey(fullRouteKey)
  if (normalizedRouteKey.startsWith(CATEGORY_ROUTE_PREFIX)) {
    const filterId = parsePositiveInt(normalizedRouteKey.slice(CATEGORY_ROUTE_PREFIX.length))
    return {
      filterType: PUBLIC_FILTER_TYPE.category,
      filterKey: filterId > 0 ? buildPublicCategoryRouteKey(filterId) : normalizedRouteKey,
      routeKey: fullRouteKey,
      filterId,
      filterName: null,
      canonicalPath: toCanonicalPublicPath(normalizedRouteKey)
    }
  }

  if (normalizedRouteKey.startsWith(TAG_NAME_ROUTE_PREFIX)) {
    const filterName = normalizeText(normalizedRouteKey.slice(TAG_NAME_ROUTE_PREFIX.length))
    return {
      filterType: PUBLIC_FILTER_TYPE.tag,
      filterKey: filterName ? buildPublicTagNameRouteKey(filterName) : normalizedRouteKey,
      routeKey: fullRouteKey,
      filterId: 0,
      filterName: filterName || null,
      canonicalPath: toCanonicalPublicPath(normalizedRouteKey)
    }
  }

  if (normalizedRouteKey.startsWith(TAG_ROUTE_PREFIX)) {
    const filterId = parsePositiveInt(normalizedRouteKey.slice(TAG_ROUTE_PREFIX.length))
    return {
      filterType: PUBLIC_FILTER_TYPE.tag,
      filterKey: filterId > 0 ? buildPublicTagIdRouteKey(filterId) : normalizedRouteKey,
      routeKey: fullRouteKey,
      filterId,
      filterName: null,
      canonicalPath: toCanonicalPublicPath(normalizedRouteKey)
    }
  }

  return {
    filterType: PUBLIC_FILTER_TYPE.search,
    filterKey: normalizedRouteKey,
    routeKey: fullRouteKey,
    filterId: 0,
    filterName: null,
    canonicalPath: '/'
  }
}

export function resolvePublicFilterIdentity(input: {
  routeName?: string | null
  routeParam?: unknown
  searchKeyword?: unknown
}): PublicFilterIdentity {
  const routeMode = resolvePublicFilterRouteMode(input.routeName)
  const searchKeyword = normalizeText(input.searchKeyword)
  if (routeMode === 'search' || searchKeyword.length > 0) {
    return {
      filterType: PUBLIC_FILTER_TYPE.search,
      filterKey: SEARCH_ROUTE_KEY,
      routeKey: SEARCH_ROUTE_KEY,
      filterId: 0,
      filterName: searchKeyword,
      canonicalPath: SEARCH_PATH
    }
  }

  const routeParam = normalizeText(input.routeParam)
  if (routeMode === 'category') {
    return parsePublicFilterRouteKey(buildPublicCategoryRouteKey(routeParam))
  }
  if (routeMode === 'tag-id') {
    return parsePublicFilterRouteKey(buildPublicTagIdRouteKey(routeParam))
  }
  if (routeMode === 'tag') {
    const numericTagId = parsePositiveInt(routeParam)
    return numericTagId > 0
      ? parsePublicFilterRouteKey(buildPublicTagIdRouteKey(numericTagId))
      : parsePublicFilterRouteKey(buildPublicTagNameRouteKey(routeParam))
  }

  return parsePublicFilterRouteKey(UNKNOWN_FILTER_ROUTE_KEY)
}

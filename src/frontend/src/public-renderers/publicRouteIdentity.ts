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

function normalizeText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value))
  }
  return ''
}

function parsePositiveInt(value: unknown): number {
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
    return routeKey
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

export function buildPublicTagHref(tagName: string): string {
  const normalizedName = normalizeText(tagName)
  return normalizedName ? `${TAG_PATH_PREFIX}${encodeURIComponent(normalizedName)}` : TAG_PATH_PREFIX.slice(0, -1)
}

function toCanonicalPublicPath(routeKey: string): string {
  const normalizedRouteKey = normalizeText(routeKey)
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
    return `${TAG_PATH_PREFIX}${encodeURIComponent(normalizedRouteKey.slice(TAG_NAME_ROUTE_PREFIX.length))}`
  }

  return '/'
}

export function parsePublicFilterRouteKey(routeKey: string): PublicFilterIdentity {
  const normalizedRouteKey = normalizeText(routeKey) || UNKNOWN_FILTER_ROUTE_KEY
  if (normalizedRouteKey.startsWith(CATEGORY_ROUTE_PREFIX)) {
    const filterId = parsePositiveInt(normalizedRouteKey.slice(CATEGORY_ROUTE_PREFIX.length))
    return {
      filterType: PUBLIC_FILTER_TYPE.category,
      filterKey: filterId > 0 ? buildPublicCategoryRouteKey(filterId) : normalizedRouteKey,
      routeKey: normalizedRouteKey,
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
      routeKey: normalizedRouteKey,
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
      routeKey: normalizedRouteKey,
      filterId,
      filterName: null,
      canonicalPath: toCanonicalPublicPath(normalizedRouteKey)
    }
  }

  return {
    filterType: PUBLIC_FILTER_TYPE.search,
    filterKey: normalizedRouteKey,
    routeKey: normalizedRouteKey,
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

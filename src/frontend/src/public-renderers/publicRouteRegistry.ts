import type { RouteRecordRaw } from 'vue-router'
import {
  PUBLIC_PAGE_MANIFEST,
  type SharedSeoEligiblePublicPageKind
} from '@/public-renderers/generated/publicPageManifest'
import { PUBLIC_ROUTE_PATH_PATTERNS } from '@/public-renderers/publicRoutePaths'

export const PUBLIC_SEARCH_ROUTE_NAME = 'Search' as const
export const PUBLIC_FILTER_ROUTE_NAMES = Object.freeze({
  category: 'Category',
  tagById: 'TagById',
  tag: 'Tag',
  search: PUBLIC_SEARCH_ROUTE_NAME
} as const)
export const PUBLIC_SEO_ROUTE_NAMES = Object.freeze({
  home: 'Home',
  articleDetail: 'ArticleDetail',
  archive: 'Archive',
  about: 'About',
  ...PUBLIC_FILTER_ROUTE_NAMES
} as const)

export type PublicSeoRouteName = typeof PUBLIC_SEO_ROUTE_NAMES[keyof typeof PUBLIC_SEO_ROUTE_NAMES]

type PublicShellOnlyRouteName = typeof PUBLIC_SEARCH_ROUTE_NAME
type PublicFilterRouteName = typeof PUBLIC_FILTER_ROUTE_NAMES[keyof typeof PUBLIC_FILTER_ROUTE_NAMES]
export type PublicFilterRouteMode = 'search' | 'category' | 'tag-id' | 'tag'

type PublicSeoRouteDefinition = Readonly<{
  name: PublicSeoRouteName
  kind: SharedSeoEligiblePublicPageKind
  path: string
  component: RouteRecordRaw['component']
  meta?: RouteRecordRaw['meta']
}>

type PublicShellOnlyRouteDefinition = Readonly<{
  name: PublicShellOnlyRouteName
  path: string
  component: RouteRecordRaw['component']
  meta?: RouteRecordRaw['meta']
}>

const PUBLIC_SEO_ROUTE_DEFINITIONS = Object.freeze([
  {
    name: PUBLIC_SEO_ROUTE_NAMES.home,
    kind: 'Home',
    path: PUBLIC_ROUTE_PATH_PATTERNS.home,
    component: () => import('@/views/Home.vue'),
    meta: { title: '首页' }
  },
  {
    name: PUBLIC_SEO_ROUTE_NAMES.articleDetail,
    kind: 'ArticleDetail',
    path: PUBLIC_ROUTE_PATH_PATTERNS.articleDetail,
    component: () => import('@/views/ArticleDetail.vue'),
    meta: { title: '文章详情' }
  },
  {
    name: PUBLIC_SEO_ROUTE_NAMES.archive,
    kind: 'Archive',
    path: PUBLIC_ROUTE_PATH_PATTERNS.archive,
    component: () => import('@/views/Archive.vue'),
    meta: { title: '归档' }
  },
  {
    name: PUBLIC_SEO_ROUTE_NAMES.about,
    kind: 'About',
    path: PUBLIC_ROUTE_PATH_PATTERNS.about,
    component: () => import('@/views/About.vue'),
    meta: { title: '关于我' }
  },
  {
    name: PUBLIC_FILTER_ROUTE_NAMES.category,
    kind: 'Filter',
    path: PUBLIC_ROUTE_PATH_PATTERNS.category,
    component: () => import('@/views/FilterView.vue'),
    meta: { requiresAuth: false }
  },
  {
    name: PUBLIC_FILTER_ROUTE_NAMES.tagById,
    kind: 'Filter',
    path: PUBLIC_ROUTE_PATH_PATTERNS.tagById,
    component: () => import('@/views/FilterView.vue'),
    meta: { requiresAuth: false }
  },
  {
    name: PUBLIC_FILTER_ROUTE_NAMES.tag,
    kind: 'Filter',
    path: PUBLIC_ROUTE_PATH_PATTERNS.tag,
    component: () => import('@/views/FilterView.vue'),
    meta: { requiresAuth: false }
  }
] as const satisfies readonly PublicSeoRouteDefinition[])

const PUBLIC_SHELL_ONLY_ROUTE_DEFINITIONS = Object.freeze([
  {
    name: PUBLIC_SEARCH_ROUTE_NAME,
    path: PUBLIC_ROUTE_PATH_PATTERNS.search,
    component: () => import('@/views/FilterView.vue'),
    meta: { title: '搜索结果', requiresAuth: false }
  }
] as const satisfies readonly PublicShellOnlyRouteDefinition[])

export const PUBLIC_SHELL_ONLY_ROUTE_NAMES = Object.freeze(
  PUBLIC_SHELL_ONLY_ROUTE_DEFINITIONS.map((definition) => definition.name)
) as readonly PublicShellOnlyRouteName[]

const routeDefinitionNames = [...PUBLIC_SEO_ROUTE_DEFINITIONS, ...PUBLIC_SHELL_ONLY_ROUTE_DEFINITIONS]
  .map((definition) => definition.name)

const duplicateRouteNames = routeDefinitionNames.filter((name, index) => routeDefinitionNames.indexOf(name) !== index)
if (duplicateRouteNames.length > 0) {
  throw new Error(`publicRouteRegistry has duplicate route names: ${Array.from(new Set(duplicateRouteNames)).join(', ')}`)
}

const PUBLIC_FILTER_ROUTE_MODES = Object.freeze({
  [PUBLIC_FILTER_ROUTE_NAMES.search]: 'search',
  [PUBLIC_FILTER_ROUTE_NAMES.category]: 'category',
  [PUBLIC_FILTER_ROUTE_NAMES.tagById]: 'tag-id',
  [PUBLIC_FILTER_ROUTE_NAMES.tag]: 'tag'
} as const satisfies Record<PublicFilterRouteName, PublicFilterRouteMode>)

const SHARED_SEO_ROUTE_KINDS = Object.freeze(
  Object.values(PUBLIC_PAGE_MANIFEST)
    .filter((definition) => definition.seoEligible)
    .map((definition) => definition.kind)
) as readonly SharedSeoEligiblePublicPageKind[]

const seoRouteNamesByKind = Object.freeze(
  Object.fromEntries(
    SHARED_SEO_ROUTE_KINDS.map((kind) => [
      kind,
      PUBLIC_SEO_ROUTE_DEFINITIONS
        .filter((definition) => definition.kind === kind)
        .map((definition) => definition.name)
    ])
  ) as unknown as Record<SharedSeoEligiblePublicPageKind, readonly PublicSeoRouteName[]>
)

const missingSeoRouteKinds = SHARED_SEO_ROUTE_KINDS.filter((kind) => seoRouteNamesByKind[kind].length === 0)
if (missingSeoRouteKinds.length > 0) {
  throw new Error(`publicRouteRegistry is missing route definitions for shared SEO pages: ${missingSeoRouteKinds.join(', ')}`)
}

export const PUBLIC_BLOG_CHILD_ROUTES = Object.freeze(
  [...PUBLIC_SEO_ROUTE_DEFINITIONS, ...PUBLIC_SHELL_ONLY_ROUTE_DEFINITIONS].map((definition) => ({
    path: definition.path,
    name: definition.name,
    component: definition.component,
    meta: definition.meta
  }))
) as readonly RouteRecordRaw[]

export function getPublicSeoRouteNamesByKind(kind: SharedSeoEligiblePublicPageKind): readonly PublicSeoRouteName[] {
  return seoRouteNamesByKind[kind]
}

export function resolvePublicFilterRouteMode(routeName: unknown): PublicFilterRouteMode | null {
  if (typeof routeName !== 'string') {
    return null
  }

  return PUBLIC_FILTER_ROUTE_MODES[routeName as PublicFilterRouteName] ?? null
}

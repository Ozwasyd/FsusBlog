import type { LocationQuery, LocationQueryRaw, RouteLocationNormalizedLoaded, Router } from 'vue-router'

const PRIVATE_ROUTE_QUERY_FIELDS = Object.freeze<Record<string, readonly string[]>>({
  UserMessage: ['filter'],
  ManageUsers: ['page', 'pageSize', 'keyword', 'status'],
  ManageArticleList: ['page', 'size', 'keyword', 'categoryId', 'tagId', 'status'],
  ManageWriteArticle: ['preview'],
  ManageEditArticle: ['preview'],
  ManageModerationRegions: ['region'],
  ManageAuditLog: ['action', 'outcome', 'severity', 'source', 'type', 'targetType']
})

export const PRIVATE_NAVIGATION_ALLOWED_FIELDS = PRIVATE_ROUTE_QUERY_FIELDS

function isPrivateRoute(route: Pick<RouteLocationNormalizedLoaded, 'path' | 'meta'>): boolean {
  return route.path.startsWith('/user') || route.meta.requiresAuth === true
}

function normalizeDeclaredValue(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') {
    return value.slice(0, 160)
  }
  if (Array.isArray(value)) {
    const normalized = value
      .filter((item): item is string => typeof item === 'string')
      .slice(0, 8)
      .map((item) => item.slice(0, 160))
    return normalized.length > 0 ? normalized : undefined
  }
  return undefined
}

export function sanitizePrivateRouteQuery(
  routeName: unknown,
  query: LocationQuery | LocationQueryRaw
): LocationQueryRaw {
  const allowed = typeof routeName === 'string'
    ? PRIVATE_ROUTE_QUERY_FIELDS[routeName] ?? []
    : []
  const sanitized: LocationQueryRaw = {}
  for (const key of allowed) {
    const value = normalizeDeclaredValue(query[key])
    if (value !== undefined) {
      sanitized[key] = value
    }
  }
  return sanitized
}

export function privateQueryNeedsSanitizing(
  routeName: unknown,
  query: LocationQuery | LocationQueryRaw
): boolean {
  const sanitized = sanitizePrivateRouteQuery(routeName, query)
  return JSON.stringify(sanitized) !== JSON.stringify(query)
}

export function resolveSafeRedirectTarget(router: Router, target: unknown, fallback = '/'): string {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) {
    return fallback
  }

  const resolved = router.resolve(target)
  if (!isPrivateRoute(resolved)) {
    return resolved.fullPath
  }

  return router.resolve({
    name: resolved.name ?? undefined,
    path: resolved.name ? undefined : resolved.path,
    params: resolved.params,
    query: sanitizePrivateRouteQuery(resolved.name, resolved.query),
    // Private fragments can contain record identifiers or free-form details.
    hash: ''
  }).fullPath
}

export function buildPrivateLoginRedirect(
  route: Pick<RouteLocationNormalizedLoaded, 'name' | 'path' | 'params' | 'query'>,
  router: Router
): string {
  return router.resolve({
    name: route.name ?? undefined,
    path: route.name ? undefined : route.path,
    params: route.params,
    query: sanitizePrivateRouteQuery(route.name, route.query),
    hash: ''
  }).fullPath
}

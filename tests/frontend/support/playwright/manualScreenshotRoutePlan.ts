import type { RouteRecordRaw } from 'vue-router'

import type { PlaywrightAuditFixtures } from './routeAuditFixtures'

export type ManualRouteScope = 'anonymous' | 'user' | 'admin' | 'edge'
export type ManualRouteStorage = 'anonymous' | 'user' | 'admin'

export type ManualRoute = {
  name: string
  path: string
  expectedUrl: string
  scope: ManualRouteScope
  allowExpectedRuntimeNoise?: boolean
}

type FlattenedRouteRecord = {
  name: string
  path: string
  meta: Record<string, unknown>
  redirect: RouteRecordRaw['redirect']
}

export function buildManualRoutesFromRouteRecords(
  records: readonly RouteRecordRaw[],
  routeFixtures: PlaywrightAuditFixtures
): Array<{ scope: ManualRouteScope, storage: ManualRouteStorage, routes: ManualRoute[] }> {
  const flattened = flattenRouteRecords(records)
  const recordsByName = new Map(flattened.map((record) => [record.name, record]))
  const grouped: Record<ManualRouteScope, ManualRoute[]> = {
    anonymous: [],
    user: [],
    admin: [],
    edge: []
  }

  for (const routeRecord of flattened) {
    const pathValue = materializeRoutePath(routeRecord.name, routeRecord.path, routeFixtures)
    const scope = classifyManualRoute(routeRecord)
    grouped[scope].push({
      name: routeRecord.name,
      path: pathValue,
      expectedUrl: resolveExpectedUrl(routeRecord, recordsByName, routeFixtures, pathValue),
      scope,
      // The search view's index load can fail on a stale release-derived
      // manifest generation (tracked separately from layout review); its
      // error-state surface is still a legitimate layout capture. Manage*
      // surfaces depend on admin statistics endpoints that the current-schema
      // test materialization does not provision (daily_read_stats rollups),
      // so those captures tolerate the known backend failure while still
      // rendering the shell layout.
      allowExpectedRuntimeNoise:
        scope === 'edge'
        || routeRecord.name === 'Search'
        || routeRecord.name.startsWith('Manage')
    })
  }

  return [
    { scope: 'anonymous', storage: 'anonymous', routes: grouped.anonymous },
    { scope: 'user', storage: 'user', routes: grouped.user },
    { scope: 'admin', storage: 'admin', routes: grouped.admin },
    { scope: 'edge', storage: 'anonymous', routes: grouped.edge }
  ]
}

function flattenRouteRecords(
  records: readonly RouteRecordRaw[],
  parentPath = '',
  parentMeta: Record<string, unknown> = {}
): FlattenedRouteRecord[] {
  const flattened: FlattenedRouteRecord[] = []

  for (const record of records) {
    const pathValue = joinRoutePath(parentPath, record.path)
    const meta = { ...parentMeta, ...(record.meta ?? {}) }

    if (record.name) {
      flattened.push({
        name: String(record.name),
        path: pathValue,
        meta,
        redirect: record.redirect
      })
    }

    if ('children' in record && Array.isArray(record.children)) {
      flattened.push(...flattenRouteRecords(record.children, pathValue, meta))
    }
  }

  return flattened
}

function joinRoutePath(parentPath: string, routePath: string): string {
  if (routePath.startsWith('/')) {
    return normalizeRoutePath(routePath)
  }

  if (!parentPath || parentPath === '/') {
    return normalizeRoutePath(`/${routePath}`)
  }

  if (!routePath) {
    return normalizeRoutePath(parentPath)
  }

  return normalizeRoutePath(`${parentPath.replace(/\/+$/u, '')}/${routePath}`)
}

function normalizeRoutePath(value: string): string {
  const normalized = value.replace(/\/{2,}/gu, '/')
  return normalized === '' ? '/' : normalized
}

function materializeRoutePath(
  routeName: string,
  pathPattern: string,
  routeFixtures: PlaywrightAuditFixtures
): string {
  if (pathPattern.includes(':pathMatch')) {
    return '/route/that/does/not/exist/with/a/very/long/path/segment'
  }

  let routePath = pathPattern.replace(/:id(?:\([^)]*\))?/gu, () => dynamicRouteId(routeName, pathPattern, routeFixtures))
  if (routeName === 'Search') {
    routePath = `${routePath}?q=${encodeURIComponent(routeFixtures.searchKeyword)}`
  }

  return routePath
}

function dynamicRouteId(routeName: string, pathPattern: string, routeFixtures: PlaywrightAuditFixtures): string {
  if (routeName === 'ArticleDetail' || routeName === 'ManageEditArticle' || pathPattern.includes('/article/')) {
    return routeFixtures.articleId
  }

  if (routeName === 'Category' || pathPattern.includes('/category/')) {
    return routeFixtures.categoryId
  }

  if (routeName === 'Tag' || routeName === 'TagById' || pathPattern.includes('/tag/')) {
    // The slug form (/tag/<name>) of a nonexistent tag is a fail-closed 404
    // status page without the #app root, so the audited capture must target
    // the seeded tag id instead of a hardcoded missing slug.
    return routeFixtures.tagId
  }

  return routeFixtures.articleId
}

function classifyManualRoute(record: FlattenedRouteRecord): ManualRouteScope {
  if (record.name === 'NotFound' || record.path.includes(':pathMatch')) {
    return 'edge'
  }

  const roles = Array.isArray(record.meta.roles)
    ? record.meta.roles.map(String)
    : []

  if (record.path.startsWith('/user/manage')) {
    return 'admin'
  }

  if (record.path.startsWith('/user') || record.meta.requiresAuth === true) {
    return 'user'
  }

  if (roles.includes('admin')) {
    return 'admin'
  }

  return 'anonymous'
}

export function assertManualRouteScopeInvariants(
  manualRouteSets: ReadonlyArray<{ scope: ManualRouteScope, routes: readonly ManualRoute[] }>
): void {
  const adminRoutes = manualRouteSets.find((routeSet) => routeSet.scope === 'admin')?.routes ?? []
  const userRoutes = manualRouteSets.find((routeSet) => routeSet.scope === 'user')?.routes ?? []
  const selfServiceAdminRoutes = adminRoutes.filter(
    (route) => route.path.startsWith('/user/') && !route.path.startsWith('/user/manage')
  )

  if (selfServiceAdminRoutes.length > 0) {
    throw new Error(`Manual screenshot admin scope includes self-service user routes: ${
      selfServiceAdminRoutes.map((route) => route.name).join(', ')
    }`)
  }

  for (const routeName of ['UserProfile', 'UserComments', 'UserMessage']) {
    if (!userRoutes.some((route) => route.name === routeName)) {
      throw new Error(`Manual screenshot user scope is missing ${routeName}`)
    }
  }
}

function resolveExpectedUrl(
  record: FlattenedRouteRecord,
  recordsByName: ReadonlyMap<string, FlattenedRouteRecord>,
  routeFixtures: PlaywrightAuditFixtures,
  fallbackUrl: string
): string {
  const redirect = record.redirect
  if (!redirect || typeof redirect === 'function') {
    return fallbackUrl
  }

  if (typeof redirect === 'string') {
    return materializeRoutePath(record.name, redirect, routeFixtures)
  }

  if ('path' in redirect && typeof redirect.path === 'string') {
    return `${materializeRoutePath(record.name, redirect.path, routeFixtures)}${stringifyQuery(redirect.query)}`
  }

  if ('name' in redirect && redirect.name) {
    const target = recordsByName.get(String(redirect.name))
    if (target) {
      return `${materializeRoutePath(target.name, target.path, routeFixtures)}${stringifyQuery(redirect.query)}`
    }
  }

  return fallbackUrl
}

function stringifyQuery(query: unknown): string {
  if (!query || typeof query !== 'object') {
    return ''
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          params.append(key, String(item))
        }
      }
      continue
    }

    if (value !== undefined && value !== null) {
      params.set(key, String(value))
    }
  }

  const queryString = params.toString()
  return queryString ? `?${queryString}` : ''
}

export function parseManualScreenshotFilter(
  envName: string,
  allowedValues: readonly string[]
): Set<string> | null {
  const raw = process.env[envName]?.trim()
  if (!raw) {
    return null
  }

  const allowed = new Set(allowedValues)
  const values = new Set(raw.split(',')
    .map((value) => value.trim())
    .filter(Boolean))
  const unknown = [...values].filter((value) => !allowed.has(value))
  if (unknown.length > 0) {
    throw new Error(`${envName} contains unsupported values: ${unknown.join(', ')}; allowed=${allowedValues.join(',')}`)
  }

  return values
}

export function filterManualScreenshotItems<T>(
  label: string,
  items: readonly T[],
  readName: (item: T) => string,
  filter: ReadonlySet<string> | null
): T[] {
  if (!filter) {
    return [...items]
  }

  const selected = items.filter((item) => filter.has(readName(item)))
  if (selected.length === 0) {
    throw new Error(`manual screenshot ${label} filter selected no items`)
  }

  return selected
}

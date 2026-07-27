import type { TranslationKey } from '../locales/keys'

import type { RouteRecordRaw } from 'vue-router'

export type RouteTitleKey = Extract<
  TranslationKey,
  | `common.routeTitles.${string}`
  | 'identity.profile.pageTitle'
  | `identity.meta.${string}.title`
  | `admin.nav.${string}`
  | `admin.routeTitles.${string}`
>

export type StaticRouteTitle = Readonly<{
  titleKey: RouteTitleKey
  titleMode?: never
}>

export type SiteOnlyRouteTitle = Readonly<{
  titleMode: 'site-only'
  titleKey?: never
}>

export type RouteTitleContract = StaticRouteTitle | SiteOnlyRouteTitle

export function staticRouteTitle(titleKey: RouteTitleKey): StaticRouteTitle {
  return { titleKey }
}

export function siteOnlyRouteTitle(): SiteOnlyRouteTitle {
  return { titleMode: 'site-only' }
}

export function isRouteTitleKey(value: unknown): value is RouteTitleKey {
  return typeof value === 'string' && (
    value.startsWith('common.routeTitles.')
    || value === 'identity.profile.pageTitle'
    || /^identity\.meta\.[^.]+\.title$/u.test(value)
    || value.startsWith('admin.nav.')
    || value.startsWith('admin.routeTitles.')
  )
}

export function assertRouteTitleContracts(records: readonly RouteRecordRaw[]): void {
  const visit = (record: RouteRecordRaw): void => {
    if (record.name !== undefined) {
      const meta = record.meta ?? {}
      if ('title' in meta) {
        throw new Error(`${String(record.name)} must not declare the retired raw title metadata`)
      }

      if ('titleKey' in meta && !isRouteTitleKey(meta.titleKey)) {
        throw new Error(`${String(record.name)} must use a dedicated RouteTitleKey`)
      }
      const hasTitleKey = isRouteTitleKey(meta.titleKey)
      const isSiteOnly = meta.titleMode === 'site-only'
      if (hasTitleKey === isSiteOnly) {
        throw new Error(`${String(record.name)} must declare exactly one route title contract`)
      }
    }

    record.children?.forEach(visit)
  }

  records.forEach(visit)
}

declare module 'vue-router' {
  interface RouteMeta {
    titleKey?: RouteTitleKey
    titleMode?: 'site-only'
  }
}

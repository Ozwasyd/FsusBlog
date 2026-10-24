import { nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RouteLocationNormalizedLoaded, RouteRecordRaw } from 'vue-router'
import { APP_ROUTE_RECORDS } from '@/router/appRouteRecords'
import { assertRouteTitleContracts, staticRouteTitle } from '@/router/routeTitleContract'
import { syncStaticDocumentTitleOnLocaleChange } from '@/composables/useSessionBootstrap'
import {
  ENABLED_LOCALES,
  activateLocaleRuntime,
  requestLocale,
  resetLocaleRuntimeForTests,
  translate
} from '@/locales'

afterEach(() => resetLocaleRuntimeForTests())

describe('route title contract', () => {
  it('requires every static route leaf to declare one typed title contract', () => {
    expect(() => assertRouteTitleContracts(APP_ROUTE_RECORDS)).not.toThrow()
    expect(() => assertRouteTitleContracts([
      ...APP_ROUTE_RECORDS,
      {
        path: '/future-static-route',
        name: 'FutureStaticRoute',
        component: { template: '<main />' }
      }
    ])).toThrow('exactly one route title contract')
  })

  it('rejects missing, dual, and retired raw title contracts', () => {
    const fixture = (meta: RouteRecordRaw['meta']): RouteRecordRaw[] => [{
      path: '/fixture',
      name: 'Fixture',
      component: { template: '<main />' },
      meta
    }]

    expect(() => assertRouteTitleContracts(fixture({}))).toThrow('exactly one route title contract')
    expect(() => assertRouteTitleContracts(fixture({ ...staticRouteTitle('common.routeTitles.login'), titleMode: 'site-only' }))).toThrow('exactly one route title contract')
    expect(() => assertRouteTitleContracts(fixture({ title: '登录' }))).toThrow('retired raw title metadata')
    expect(() => assertRouteTitleContracts(fixture({
      titleKey: 'admin.moderationReplay.inputRegionAriaLabel'
    } as never))).toThrow('must use a dedicated RouteTitleKey')
  })

  it('keeps moderation and security route titles on semantic page-title keys', () => {
    const semanticTitleKeys = new Map<string, unknown>()
    const visit = (records: readonly RouteRecordRaw[]): void => {
      for (const record of records) {
        if (record.name) semanticTitleKeys.set(String(record.name), record.meta?.titleKey)
        if (record.children) visit(record.children)
      }
    }
    visit(APP_ROUTE_RECORDS)

    expect(semanticTitleKeys.get('ManageSecurityPolicies')).toBe('admin.nav.security')
    for (const name of [
      'ManageModerationPolicies',
      'ManageModerationRegions',
      'ManageModerationRegionGroups',
      'ManageModerationPolicyTemplates',
      'ManageModerationReplay'
    ]) {
      expect(semanticTitleKeys.get(name), name).toBe('admin.nav.moderation')
    }
    expect([...semanticTitleKeys.values()]).not.toContain(
      'admin.moderationReplay.inputRegionAriaLabel'
    )
  })

  it('resolves the critical static route keys in every enabled locale', async () => {
    const keys = [
      'common.routeTitles.login',
      'common.routeTitles.register',
      'common.routeTitles.recover',
      'identity.profile.pageTitle',
      'admin.nav.dashboard',
      'common.routeTitles.forbidden',
      'common.routeTitles.notFound'
    ] as const

    const dispatchEvent = vi.spyOn(window, 'dispatchEvent').mockImplementation(() => true)
    try {
      for (const locale of ENABLED_LOCALES) {
        await activateLocaleRuntime(locale.code, ['common', 'identity', 'admin'])
        for (const key of keys) {
          expect(translate(key), `${locale.code}:${key}`).not.toHaveLength(0)
        }
      }
    } finally {
      dispatchEvent.mockRestore()
    }
  })

  it('updates a static route title once on locale change without navigation', async () => {
    const route = ref<RouteLocationNormalizedLoaded>({
      path: '/login',
      name: 'Login',
      fullPath: '/login',
      meta: staticRouteTitle('common.routeTitles.login'),
      query: {},
      hash: '',
      params: {},
      matched: [],
      redirectedFrom: undefined
    })
    const syncDocumentTitle = vi.fn((currentRoute: { meta: { titleKey?: string } }) => {
      document.title = currentRoute.meta.titleKey === 'common.routeTitles.login'
        ? translate('common.routeTitles.login')
        : ''
      return document.title
    })
    const stop = syncStaticDocumentTitleOnLocaleChange(route, syncDocumentTitle)
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent').mockImplementation(() => true)

    try {
      await requestLocale('en-US')
      await nextTick()

      expect(document.title).toBe('Log in')
      expect(syncDocumentTitle).toHaveBeenCalledOnce()
      expect(syncDocumentTitle).toHaveBeenCalledWith(route.value)
      expect(route.value.fullPath).toBe('/login')
    } finally {
      stop()
      dispatchEvent.mockRestore()
    }
  })
})

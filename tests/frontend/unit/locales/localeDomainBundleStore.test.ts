import { describe, expect, it, vi } from 'vitest'

import {
  LOCALE_DOMAIN_LOADERS,
  LOCALE_DOMAIN_SCHEMA_DIGESTS,
  LocaleDomainBundleStore,
  localeDomainSchemaDigest,
  type LocaleDomainLoaderRegistry
} from '@/locales/localeDomainBundleStore'
import { LOCALE_DOMAINS, type LocaleDomain } from '@/locales/localeDomains'
import { ENABLED_LOCALES, type SupportedLocale } from '@/locales/localeCatalog'
import { requiredLocaleDomainsForPublicPage, requiredLocaleDomainsForRoute } from '@/locales/routeLocaleDomains'
import { APP_ROUTE_RECORDS } from '@/router/appRouteRecords'
import type { RouteRecordRaw } from 'vue-router'

function localeModule(
  locale: SupportedLocale,
  domain: LocaleDomain,
  exportName: string,
  artifact: unknown
): Readonly<Record<string, unknown>> {
  return {
    [exportName]: artifact,
    localeDomainIdentity: { locale, domain }
  }
}

function registryWith(
  locale: SupportedLocale,
  domain: LocaleDomain,
  importModule: () => Promise<Readonly<Record<string, unknown>>>,
  schemaDigest: string
): LocaleDomainLoaderRegistry {
  return {
    ...LOCALE_DOMAIN_LOADERS,
    [locale]: {
      ...LOCALE_DOMAIN_LOADERS[locale],
      [domain]: {
        ...LOCALE_DOMAIN_LOADERS[locale][domain],
        importModule,
        schemaDigest
      }
    }
  }
}

function findRoute(records: readonly RouteRecordRaw[], name: string): RouteRecordRaw {
  for (const record of records) {
    if (record.name === name) return record
    if (record.children) {
      try {
        return findRoute(record.children, name)
      } catch {
        // Search the next branch.
      }
    }
  }
  throw new Error(`test route missing: ${name}`)
}

function namedLeafRoutes(records: readonly RouteRecordRaw[]): RouteRecordRaw[] {
  return records.flatMap((record) => {
    const descendants = record.children ? namedLeafRoutes(record.children) : []
    return descendants.length > 0 ? descendants : record.name ? [record] : []
  })
}

describe('LocaleDomainBundleStore', () => {
  it('loads and validates every locale/domain pair independently', async () => {
    const expectedDigests = new Map<LocaleDomain, string>()
    for (const domain of LOCALE_DOMAINS) {
      const loader = LOCALE_DOMAIN_LOADERS['zh-CN'][domain]
      const module = await loader.importModule()
      expectedDigests.set(domain, localeDomainSchemaDigest(module[loader.exportName]))
    }

    await Promise.all(ENABLED_LOCALES.flatMap(({ code }) =>
      LOCALE_DOMAINS.map(async (domain) => {
        const loader = LOCALE_DOMAIN_LOADERS[code][domain]
        const module = await loader.importModule()
        expect(Object.keys(module).sort()).toEqual([loader.exportName, 'localeDomainIdentity'].sort())
        expect(module.localeDomainIdentity).toEqual({ locale: code, domain })
        expect(localeDomainSchemaDigest(module[loader.exportName]))
          .toBe(expectedDigests.get(domain))
      })))

    // Kept visible so a schema change has one deterministic table to update.
    console.info('locale-domain-schema-digests', Object.fromEntries(expectedDigests))
    expect(Object.fromEntries(expectedDigests)).toEqual(LOCALE_DOMAIN_SCHEMA_DIGESTS)

    const store = new LocaleDomainBundleStore()
    await Promise.all(ENABLED_LOCALES.flatMap(({ code }) =>
      LOCALE_DOMAINS.map(async (domain) => {
        const artifact = await store.loadLocaleDomain(code, domain)
        expect(store.peekLocaleDomain(code, domain)).toBe(artifact)
      })))
  }, 20_000)

  it('deduplicates concurrent imports and caches only successful artifacts', async () => {
    const artifact = { action: 'save' }
    const importer = vi.fn(async () => localeModule('en-US', 'common', 'common', artifact))
    const registry = registryWith('en-US', 'common', importer, localeDomainSchemaDigest(artifact))
    const store = new LocaleDomainBundleStore(registry)

    const [first, second] = await Promise.all([
      store.loadLocaleDomain('en-US', 'common'),
      store.loadLocaleDomain('en-US', 'common')
    ])

    expect(first).toBe(artifact)
    expect(second).toBe(artifact)
    expect(importer).toHaveBeenCalledTimes(1)
    expect(await store.loadLocaleDomain('en-US', 'common')).toBe(artifact)
    expect(importer).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failure and retries the settled key', async () => {
    const artifact = { action: 'retry' }
    const importer = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(localeModule('en-US', 'common', 'common', artifact))
    const store = new LocaleDomainBundleStore(
      registryWith('en-US', 'common', importer, localeDomainSchemaDigest(artifact)))

    await expect(store.loadLocaleDomain('en-US', 'common')).rejects.toThrow('network')
    await expect(store.loadLocaleDomain('en-US', 'common')).resolves.toBe(artifact)
    expect(importer).toHaveBeenCalledTimes(2)
  })

  it('rejects abort, ignores the late import, and permits a fresh retry', async () => {
    const lateArtifact = { action: 'late' }
    const retryArtifact = { action: 'retry' }
    let resolveLate: ((module: Readonly<Record<string, unknown>>) => void) | undefined
    const importer = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveLate = resolve }))
      .mockResolvedValueOnce(localeModule('ja-JP', 'common', 'common', retryArtifact))
    const registry = registryWith(
      'ja-JP',
      'common',
      importer,
      localeDomainSchemaDigest(retryArtifact))
    const store = new LocaleDomainBundleStore(registry)
    const controller = new AbortController()

    const aborted = store.loadLocaleDomain('ja-JP', 'common', controller.signal)
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    resolveLate?.(localeModule('ja-JP', 'common', 'common', lateArtifact))
    await Promise.resolve()
    expect(store.peekLocaleDomain('ja-JP', 'common')).toBeUndefined()

    await expect(store.loadLocaleDomain('ja-JP', 'common')).resolves.toBe(retryArtifact)
    expect(importer).toHaveBeenCalledTimes(2)
  })

  it('fails closed on export and schema identity drift', async () => {
    const artifact = { action: 'save' }
    const digest = localeDomainSchemaDigest(artifact)
    const wrongExportStore = new LocaleDomainBundleStore(
      registryWith('fr-FR', 'common', async () =>
        localeModule('fr-FR', 'common', 'wrong', artifact), digest))
    const extraExportStore = new LocaleDomainBundleStore(
      registryWith('fr-FR', 'common', async () => ({
        ...localeModule('fr-FR', 'common', 'common', artifact),
        legacy: artifact
      }), digest))
    const wrongSchemaStore = new LocaleDomainBundleStore(
      registryWith('fr-FR', 'common', async () =>
        localeModule('fr-FR', 'common', 'common', { action: 42 }), digest))
    const wrongModuleIdentityStore = new LocaleDomainBundleStore(
      registryWith('fr-FR', 'common', async () =>
        localeModule('zh-CN', 'common', 'common', artifact), digest))

    await expect(wrongExportStore.loadLocaleDomain('fr-FR', 'common'))
      .rejects.toThrow('locale_domain_export_identity_drift')
    await expect(extraExportStore.loadLocaleDomain('fr-FR', 'common'))
      .rejects.toThrow('locale_domain_export_identity_drift')
    await expect(wrongSchemaStore.loadLocaleDomain('fr-FR', 'common'))
      .rejects.toThrow('locale_domain_schema_drift')
    await expect(wrongModuleIdentityStore.loadLocaleDomain('fr-FR', 'common'))
      .rejects.toThrow('locale_domain_module_identity_drift:fr-FR:common:zh-CN:common')
  })

  it('fails closed on unknown locale and domain inputs', async () => {
    const store = new LocaleDomainBundleStore()
    await expect(store.loadLocaleDomain('x-test' as never, 'common'))
      .rejects.toThrow('unsupported_locale:x-test')
    await expect(store.loadLocaleDomain('en-US', 'future' as never))
      .rejects.toThrow('unsupported_locale_domain:future')
  })

  it('rejects a registry whose locale/domain identity is incomplete', () => {
    const incomplete = { ...LOCALE_DOMAIN_LOADERS } as Record<string, unknown>
    delete incomplete['ru-RU']
    expect(() => new LocaleDomainBundleStore(incomplete as LocaleDomainLoaderRegistry))
      .toThrow('locale_domain_loader_locale_identity_drift')
  })
})

describe('route locale-domain authority', () => {
  it.each([
    ['Home', ['common', 'layout', 'public']],
    ['ArticleDetail', ['common', 'layout', 'public', 'article']],
    ['Archive', ['common', 'layout', 'public']],
    ['About', ['common', 'layout', 'public']],
    ['Privacy', ['common', 'layout', 'public']],
    ['Guidelines', ['common', 'layout', 'public']],
    ['Copyright', ['common', 'layout', 'public']],
    ['Filter', ['common', 'layout', 'public']]
  ] as const)('declares the exact PublicShell domains for %s', (pageKind, expected) => {
    expect(requiredLocaleDomainsForPublicPage(pageKind)).toEqual(expected)
  })

  it.each(ENABLED_LOCALES.flatMap(({ code }) =>
    (['Home', 'ArticleDetail'] as const).map((pageKind) => [code, pageKind] as const)
  ))('imports only %s/%s PublicShell domains through the actual loaders', async (locale, pageKind) => {
    const requested: string[] = []
    const registry = Object.fromEntries(ENABLED_LOCALES.map(({ code }) => [code,
      Object.fromEntries(LOCALE_DOMAINS.map((domain) => [domain, {
        ...LOCALE_DOMAIN_LOADERS[code][domain],
        importModule: async () => {
          requested.push(`${code}/${domain}`)
          return await LOCALE_DOMAIN_LOADERS[code][domain].importModule()
        }
      }]))
    ])) as LocaleDomainLoaderRegistry
    const store = new LocaleDomainBundleStore(registry)
    const domains = requiredLocaleDomainsForPublicPage(pageKind)
    await store.loadLocaleDomains(locale, domains)
    expect(requested.sort()).toEqual(domains.map((domain) => `${locale}/${domain}`).sort())
    // Repeated preparation must reuse verified artifacts without another import.
    await store.loadLocaleDomains(locale, domains)
    expect(requested).toHaveLength(domains.length)
    for (const domain of ['security', 'admin', 'identity', 'messages'] as const) {
      expect(store.peekLocaleDomain(locale, domain)).toBeUndefined()
    }
  })

  it.each([
    ['Public Home', 'Home', ['common', 'layout', 'public', 'security']],
    ['Public Article', 'ArticleDetail', ['common', 'layout', 'public', 'security', 'article']],
    ['Auth', 'Login', ['common', 'layout', 'public', 'auth', 'errors', 'security']],
    ['Account Messages', 'UserMessage', ['common', 'layout', 'admin', 'auth', 'errors', 'security', 'messages']],
    ['Admin Security', 'ManageSecurityDashboard', ['common', 'layout', 'admin', 'auth', 'errors', 'security']]
  ])('declares only the domains required by the actual %s route', (_label, name, expected) => {
    const route = findRoute(APP_ROUTE_RECORDS, name)
    expect(requiredLocaleDomainsForRoute({
      name: route.name,
      path: route.path,
      meta: route.meta ?? {}
    })).toEqual(expected)
  })

  it('prepares security copy for the application-level challenge host on every route', () => {
    for (const route of namedLeafRoutes(APP_ROUTE_RECORDS)) {
      expect(requiredLocaleDomainsForRoute({
        name: route.name,
        path: route.path,
        meta: route.meta ?? {}
      })).toContain('security')
    }
  })

  it('prepares auth copy for the account-shell policy modal', () => {
    for (const name of ['UserProfile', 'ManageDashboard']) {
      const route = findRoute(APP_ROUTE_RECORDS, name)
      expect(requiredLocaleDomainsForRoute({
        name: route.name,
        path: route.path,
        meta: route.meta ?? {}
      })).toContain('auth')
    }
  })

  it('fails closed when a route has no domain declaration', () => {
    expect(() => requiredLocaleDomainsForRoute({
      name: 'FutureSurface',
      path: '/future',
      meta: {}
    })).toThrow('locale_route_domains_missing:FutureSurface')
  })

  it('covers every named application leaf route', () => {
    const uncovered = namedLeafRoutes(APP_ROUTE_RECORDS).flatMap((route) => {
      try {
        requiredLocaleDomainsForRoute({
          name: route.name,
          path: route.path,
          meta: route.meta ?? {}
        })
        return []
      } catch {
        return [String(route.name)]
      }
    })
    expect(uncovered).toEqual([])
  })

  it('detects a newly added route until the sole authority classifies it', () => {
    const mutatedRoutes = [
      ...APP_ROUTE_RECORDS,
      {
        path: '/future',
        name: 'FutureSurface',
        component: {}
      }
    ] as RouteRecordRaw[]
    const uncovered = namedLeafRoutes(mutatedRoutes).flatMap((route) => {
      try {
        requiredLocaleDomainsForRoute({
          name: route.name,
          path: route.path,
          meta: route.meta ?? {}
        })
        return []
      } catch {
        return [String(route.name)]
      }
    })
    expect(uncovered).toEqual(['FutureSurface'])
  })
})

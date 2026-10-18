import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter, type RouteComponent } from 'vue-router'

import AccountIdentityFrame from '@/layouts/AccountIdentityFrame.vue'
import AdminWorkspaceFrame from '@/layouts/AdminWorkspaceFrame.vue'
import { APP_ROUTE_RECORDS } from '@/router'
import {
  assertAccountLeafRouteMeta,
  isAccountContentMode,
  isAccountPageKind
} from '@/router/accountRouteMeta'
import {
  ADMIN_LAYOUT_ARCHETYPES,
  IDENTITY_LAYOUT_ARCHETYPES,
  resolveLayoutArchetypePath
} from '../../support/playwright/layoutArchetypeMatrix'

const router = createRouter({
  history: createMemoryHistory(),
  routes: APP_ROUTE_RECORDS
})

async function loadRouteComponent(component: RouteComponent): Promise<unknown> {
  if (typeof component !== 'function') return component
  const loaded: unknown = await Reflect.apply(component, undefined, [])
  return typeof loaded === 'object' && loaded !== null && 'default' in loaded
    ? loaded.default
    : loaded
}

describe('account route frames', () => {
  it('gives every account leaf valid page-kind and content-mode metadata', () => {
    expect(() => assertAccountLeafRouteMeta(APP_ROUTE_RECORDS)).not.toThrow()

    for (const archetype of [...IDENTITY_LAYOUT_ARCHETYPES, ...ADMIN_LAYOUT_ARCHETYPES]) {
      const route = router.resolve(resolveLayoutArchetypePath(archetype))
      expect(isAccountPageKind(route.meta.accountPageKind), archetype.label).toBe(true)
      expect(isAccountContentMode(route.meta.accountContentMode), archetype.label).toBe(true)
    }
  })

  it('selects the identity frame for self routes and the admin frame for manage routes', async () => {
    for (const [archetypes, expectedFrame] of [
      [IDENTITY_LAYOUT_ARCHETYPES, AccountIdentityFrame],
      [ADMIN_LAYOUT_ARCHETYPES, AdminWorkspaceFrame]
    ] as const) {
      for (const archetype of archetypes) {
        const route = router.resolve(resolveLayoutArchetypePath(archetype))
        const frameRecord = route.matched[1]
        expect(frameRecord, `${archetype.label} frame record`).toBeDefined()
        const frame = frameRecord.components?.default
        expect(frame, `${archetype.label} default frame`).toBeDefined()
        expect(await loadRouteComponent(frame!), archetype.label).toBe(expectedFrame)
      }
    }
  })

  it('preserves identity and admin deep-link paths', () => {
    expect(router.resolve('/user/identity/passkeys').name).toBe('UserIdentityPasskeys')
    expect(router.resolve('/user/manage/article/edit/42').name).toBe('ManageEditArticle')
    expect(router.resolve('/user/manage/security/risk-control').name).toBe('ManageSecurityRiskControl')
  })
})

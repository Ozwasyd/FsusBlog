import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter, type RouteRecordRaw } from 'vue-router'
import {
  buildPrivateLoginRedirect,
  PRIVATE_NAVIGATION_ALLOWED_FIELDS,
  resolveSafeRedirectTarget,
  sanitizePrivateRouteQuery
} from '@/security/privateNavigationPolicy'

const component = { template: '<div />' }
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'Home', component, meta: { routeState: 'public-shareable' } },
  { path: '/archive', name: 'Archive', component, meta: { routeState: 'public-shareable' } },
  { path: '/user/identity', name: 'UserIdentityOverview', component, meta: { routeState: 'private-recoverable', accountArea: 'self', allowLoginRedirect: true } },
  { path: '/user/messagebox', name: 'UserMessage', component, meta: { routeState: 'private-recoverable', accountArea: 'self', allowLoginRedirect: true } },
  { path: '/user/identity/mfa', name: 'UserIdentityMfa', component, meta: { routeState: 'session-sensitive', accountArea: 'self', allowLoginRedirect: false } },
  { path: '/user/manage', name: 'ManageDashboard', component, meta: { routeState: 'private-recoverable', accountArea: 'manage', allowLoginRedirect: true } },
  { path: '/user/manage/users', name: 'ManageUsers', component, meta: { routeState: 'private-recoverable', accountArea: 'manage', allowLoginRedirect: true } },
  { path: '/user/manage/article/edit/:id', name: 'ManageEditArticle', component, meta: { routeState: 'memory-only', accountArea: 'manage', allowLoginRedirect: false } },
  { path: '/:pathMatch(.*)*', name: 'NotFound', component, meta: { routeState: 'public-shareable' } }
]

function createPolicyRouter() {
  return createRouter({ history: createMemoryHistory(), routes })
}

describe('private navigation policy', () => {
  it('publishes route-specific fields and excludes free text and object selections', () => {
    expect(PRIVATE_NAVIGATION_ALLOWED_FIELDS.UserMessage).toEqual(['filter'])
    expect(PRIVATE_NAVIGATION_ALLOWED_FIELDS.ManageUsers).toEqual(['page', 'pageSize', 'status'])
    expect(PRIVATE_NAVIGATION_ALLOWED_FIELDS.ManageModerationComments).toEqual([
      'status', 'q', 'article', 'user', 'reason', 'region', 'model', 'runtime', 'from', 'to'
    ])
    expect(PRIVATE_NAVIGATION_ALLOWED_FIELDS.ManageArticleList).not.toContain('keyword')
    expect(PRIVATE_NAVIGATION_ALLOWED_FIELDS.UserMessage).not.toContain('conversation')
  })

  it('validates allowlisted values instead of copying arbitrary strings', () => {
    expect(sanitizePrivateRouteQuery('ManageUsers', {
      page: '2',
      pageSize: '20',
      status: '1',
      keyword: 'account@example.test',
      token: 'secret'
    })).toEqual({ page: '2', pageSize: '20', status: '1' })

    expect(sanitizePrivateRouteQuery('ManageUsers', {
      page: '-1',
      pageSize: '999',
      status: 'admin',
      page2: '1'
    })).toEqual({})
    expect(sanitizePrivateRouteQuery('UserMessage', { filter: ['unread', 'closed'] })).toEqual({ filter: 'unread' })
    expect(sanitizePrivateRouteQuery('ManageModerationComments', {
      status: '2',
      q: '重复内容',
      article: '42',
      user: 'anonymous-7',
      reason: 'spam-repeat',
      region: 'CN-MAINLAND',
      from: '2026-07-01',
      to: '2026-07-23',
      proof: 'secret'
    })).toEqual({
      status: '2',
      q: '重复内容',
      article: '42',
      user: 'anonymous-7',
      reason: 'spam-repeat',
      region: 'CN-MAINLAND',
      from: '2026-07-01',
      to: '2026-07-23'
    })
  })

  it('preserves public targets while rejecting external or ambiguous redirects', () => {
    const router = createPolicyRouter()

    expect(resolveSafeRedirectTarget(router, '/archive?page=2#year-2026')).toBe('/archive?page=2#year-2026')
    expect(resolveSafeRedirectTarget(router, 'https://attacker.test')).toBe('/')
    expect(resolveSafeRedirectTarget(router, '//attacker.test/path')).toBe('/')
    expect(resolveSafeRedirectTarget(router, '/\\attacker.test/path')).toBe('/')
    expect(resolveSafeRedirectTarget(router, '/archive\nSet-Cookie:test')).toBe('/')
  })

  it('recovers only named private routes with validated query fields', () => {
    const router = createPolicyRouter()

    expect(resolveSafeRedirectTarget(
      router,
      '/user/messagebox?filter=unread&conversation=account-42&token=secret#account-42'
    )).toBe('/user/messagebox?filter=unread')
    expect(resolveSafeRedirectTarget(
      router,
      '/user/manage/users?page=2&pageSize=20&status=1&keyword=alice@example.test'
    )).toBe('/user/manage/users?page=2&pageSize=20&status=1')
  })

  it('degrades memory-only and session-sensitive targets without echoing private identifiers', () => {
    const router = createPolicyRouter()

    expect(resolveSafeRedirectTarget(router, '/user/manage/article/edit/42?proof=secret#draft')).toBe('/user/manage')
    expect(resolveSafeRedirectTarget(router, '/user/identity/mfa?challenge=secret')).toBe('/user/identity')

    const dynamicRoute = router.resolve('/user/manage/article/edit/42?proof=secret#draft')
    expect(buildPrivateLoginRedirect(dynamicRoute, router)).toBe('/user/manage')
  })
})

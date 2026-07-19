import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import {
  PRIVATE_NAVIGATION_ALLOWED_FIELDS,
  resolveSafeRedirectTarget,
  sanitizePrivateRouteQuery
} from '@/security/privateNavigationPolicy'

function createPolicyRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'Home', component: { template: '<main>home</main>' } },
      { path: '/login', name: 'Login', component: { template: '<main>login</main>' } },
      { path: '/user/messagebox', name: 'UserMessage', meta: { requiresAuth: true }, component: { template: '<main>messages</main>' } },
      { path: '/user/manage/users', name: 'ManageUsers', meta: { requiresAuth: true }, component: { template: '<main>users</main>' } },
      { path: '/user/manage/article/edit/:id', name: 'ManageEditArticle', meta: { requiresAuth: true }, component: { template: '<main>edit</main>' } }
    ]
  })
}

describe('private navigation policy', () => {
  it('retains only declared private query fields and bounded values', () => {
    expect(sanitizePrivateRouteQuery('ManageUsers', {
      page: '2',
      status: 'active',
      token: 'secret',
      details: 'private',
      accountId: '42'
    })).toEqual({ page: '2', status: 'active' })
    expect(PRIVATE_NAVIGATION_ALLOWED_FIELDS.ManageUsers).toEqual([
      'page', 'pageSize', 'keyword', 'status'
    ])
  })

  it('sanitizes private redirects while preserving declared route params', () => {
    const router = createPolicyRouter()
    expect(resolveSafeRedirectTarget(
      router,
      '/user/manage/article/edit/42?preview=private&token=secret&details=raw#account-42'
    )).toBe('/user/manage/article/edit/42?preview=private')
  })

  it('rejects cross-origin-like redirects and preserves public navigation', () => {
    const router = createPolicyRouter()
    expect(resolveSafeRedirectTarget(router, '//evil.example/path')).toBe('/')
    expect(resolveSafeRedirectTarget(router, '/?page=2#top')).toBe('/?page=2#top')
  })
})

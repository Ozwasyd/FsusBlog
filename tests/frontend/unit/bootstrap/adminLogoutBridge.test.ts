import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createAdminLogoutNavigationHandler } from '@/bootstrap/adminLogoutBridge'

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<main>home</main>' } },
      { path: '/user/identity', meta: { accountArea: 'self' }, component: { template: '<main>identity</main>' } },
      { path: '/user/manage', meta: { accountArea: 'manage' }, component: { template: '<main>manage</main>' } }
    ]
  })
}

describe('admin logout navigation', () => {
  it('leaves the manage surface for the account workspace when the account session remains active', async () => {
    const router = createTestRouter()
    await router.push('/user/manage')

    createAdminLogoutNavigationHandler(router, () => true)()
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/user/identity')
  })

  it('leaves the manage surface for public home when no account session exists', async () => {
    const router = createTestRouter()
    await router.push('/user/manage')

    createAdminLogoutNavigationHandler(router, () => false)()
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/')
  })

  it('does not move an existing account self-service route', async () => {
    const router = createTestRouter()
    await router.push('/user/identity')

    createAdminLogoutNavigationHandler(router, () => true)()
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/user/identity')
  })
})

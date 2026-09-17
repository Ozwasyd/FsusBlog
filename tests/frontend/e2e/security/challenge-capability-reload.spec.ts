import { expect, test } from '@playwright/test'

test.describe('challenge capability cutover reload', () => {
  test('a stale build requests one normal full reload and then fails closed', async ({ page }) => {
    await page.route('**/__challenge-capability-reload-e2e', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><main>challenge capability reload</main>'
    }))
    await page.goto('/__challenge-capability-reload-e2e')

    const result = await page.evaluate(async () => {
      const runtime = await import('/src/security/challenge-capability-reload.ts')
      let reloadCount = 0
      const first = runtime.requestChallengeCapabilityReload('e2e-old-build', {
        storage: window.sessionStorage,
        reload: () => { reloadCount += 1 }
      })
      const second = runtime.requestChallengeCapabilityReload('e2e-old-build', {
        storage: window.sessionStorage,
        reload: () => { reloadCount += 1 }
      })
      return { first, second, reloadCount }
    })

    expect(result).toEqual({
      first: 'reload_requested',
      second: 'already_requested',
      reloadCount: 1
    })
  })
})

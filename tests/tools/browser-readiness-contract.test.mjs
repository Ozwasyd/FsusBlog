import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkBrowserReadinessContract,
  inspectBrowserReadinessSource,
  inspectMeasurementHelper
} from '../../tools/testing/check-browser-readiness-contract.mjs'
import {
  applicationReadyPredicate,
  waitForAuthPermissionReady,
  waitForNotificationSuppressed,
  waitForPublicHydration,
  waitForServiceWorkerCacheReady,
  waitForSpaRoute
} from '../frontend/support/playwright/readiness.mjs'

test('application readiness accepts a visible SPA shell once the runtime loader is closed', () => {
  const previousDocument = globalThis.document
  const previousHTMLElement = globalThis.HTMLElement
  const previousWindow = globalThis.window
  class FakeElement {}
  const app = Object.assign(new FakeElement(), {
    getBoundingClientRect: () => ({ width: 1280, height: 720 })
  })
  const spaShell = new FakeElement()
  globalThis.HTMLElement = FakeElement
  globalThis.document = {
    readyState: 'complete',
    querySelector: (selector) => selector === '#app' ? app : selector === '#fsus-aot-shell' ? spaShell : null,
    getElementById: (id) => id === 'global-loader' ? { hidden: true } : null
  }
  globalThis.window = {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  }
  try {
    assert.equal(applicationReadyPredicate(), true)
  } finally {
    globalThis.document = previousDocument
    globalThis.HTMLElement = previousHTMLElement
    globalThis.window = previousWindow
  }
})

class FakePage {
  constructor({ fail = false } = {}) {
    this.fail = fail
    this.calls = []
  }

  async waitForFunction(_predicate, _argument, options) {
    this.calls.push(['function', options.timeout])
    if (this.fail) throw new Error('fixture timeout')
  }

  async waitForURL(_predicate, options) {
    this.calls.push(['url', options.timeout])
    if (this.fail) throw new Error('fixture timeout')
  }
}

class FakeLocator {
  constructor({ fail = false } = {}) {
    this.fail = fail
  }

  async waitFor() {
    if (this.fail) throw new Error('fixture timeout')
  }
}

const categories = [
  ['hydration', (page, locator) => waitForPublicHydration(page, { timeoutMs: 17 })],
  ['SPA route', (page, locator) => waitForSpaRoute(page, '/archive', { content: locator, timeoutMs: 17 })],
  ['service worker/cache', (page, locator) => waitForServiceWorkerCacheReady(page, { timeoutMs: 17 })],
  ['notification suppression', (page, locator) => waitForNotificationSuppressed(page, { timeoutMs: 17 })],
  ['auth/permission', (page, locator) => waitForAuthPermissionReady(page, {
    pathPrefix: '/user/manage',
    content: locator,
    timeoutMs: 17
  })]
]

for (const [name, run] of categories) {
  test(`${name} readiness succeeds when its observable condition is met`, async () => {
    await run(new FakePage(), new FakeLocator())
  })

  test(`${name} readiness reports the unmet condition on timeout`, async () => {
    await assert.rejects(
      run(new FakePage({ fail: true }), new FakeLocator({ fail: true })),
      (error) => {
        assert.match(error.message, /Browser readiness condition|SPA route|authenticated permission route/u)
        assert.match(error.message, /17ms/u)
        assert.match(error.message, /fixture timeout/u)
        return true
      }
    )
  })
}

test('negative governance fixture reports file and line for forbidden waits', () => {
  const violations = inspectBrowserReadinessSource(
    "await page.goto('/', { waitUntil:\n  'networkidle' })\nawait page\n  .waitForTimeout(500)\nawait page.waitForURL('/ready')\n  .catch(() => {})\n",
    'tests/frontend/checks/runtime/fixture.mjs'
  )
  assert.deepEqual(violations, [
    'tests/frontend/checks/runtime/fixture.mjs:1: networkidle is not a correctness readiness condition',
    'tests/frontend/checks/runtime/fixture.mjs:4: direct page.waitForTimeout is forbidden in correctness assets',
    'tests/frontend/checks/runtime/fixture.mjs:5: readiness timeout must not be silently ignored'
  ])
})

test('positive governance fixture accepts the metadata-bound measurement helper', () => {
  const source = `
    async function runBrowserMeasurementWindow(page, { purpose, maxWindowMs, evidenceClass }) {
      const allowed = ['performance', 'soak']
      await page.waitForTimeout(maxWindowMs)
    }
  `
  assert.deepEqual(inspectMeasurementHelper(source), [])
})

test('current correctness assets satisfy the browser readiness policy', async () => {
  assert.deepEqual(await checkBrowserReadinessContract(), [])
})

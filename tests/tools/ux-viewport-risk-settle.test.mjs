import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveUxViewportRiskMaxWaitMs,
  settleUxViewportRiskPage
} from '../frontend/support/playwright/uxViewportRiskSettle.mjs'

test('risk settle budget expands from the live machine-to-scheduler contention ratio', () => {
  assert.equal(resolveUxViewportRiskMaxWaitMs({}, 8), 1_500)
  assert.equal(resolveUxViewportRiskMaxWaitMs({ FSUSBLOG_STEP_CPU_BUDGET: '4' }, 8), 2_122)
  assert.equal(resolveUxViewportRiskMaxWaitMs({ FSUSBLOG_STEP_CPU_BUDGET: '2' }, 8), 3_000)
  assert.equal(resolveUxViewportRiskMaxWaitMs({ FSUSBLOG_BUNDLE_CPU_UNITS: '1' }, 8), 4_243)
  assert.equal(resolveUxViewportRiskMaxWaitMs({ FSUSBLOG_UX_VIEWPORT_POOL_SIZE: '4' }, 8), 3_000)
  assert.equal(resolveUxViewportRiskMaxWaitMs({
    FSUSBLOG_STEP_CPU_BUDGET: '4',
    FSUSBLOG_UX_VIEWPORT_POOL_SIZE: '4'
  }, 8), 4_243)
  assert.equal(resolveUxViewportRiskMaxWaitMs({
    FSUSBLOG_STEP_CPU_BUDGET: '1',
    FSUSBLOG_UX_SETTLE_MAX_WAIT_MS: '2750.2'
  }, 8), 2_751)
  assert.equal(resolveUxViewportRiskMaxWaitMs({
    FSUSBLOG_STEP_CPU_BUDGET: '1',
    FSUSBLOG_STEP_DEADLINE_AT_MS: '2800'
  }, 8, 1000), 1_550)
  assert.equal(resolveUxViewportRiskMaxWaitMs({
    FSUSBLOG_STEP_CPU_BUDGET: '1',
    FSUSBLOG_STEP_DEADLINE_AT_MS: '1100'
  }, 8, 1000), 1)
})

test('risk settle survives the measured CPU1 delayed-readiness fixture without weakening readiness or stability', async () => {
  const originalDocument = globalThis.document
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  let layoutRevision = 900
  let frames = 0
  let fontsReady = false
  const fontReadyDelayMs = 1_835
  const frameDelayMs = 40
  const root = {
    clientWidth: 1280,
    clientHeight: 720,
    scrollWidth: 1280,
    get scrollHeight() { return layoutRevision }
  }
  globalThis.document = {
    fonts: {
      ready: new Promise((resolve) => {
        setTimeout(() => {
          fontsReady = true
          resolve()
        }, fontReadyDelayMs)
      })
    },
    images: [],
    documentElement: root,
    body: { scrollWidth: 1280, get scrollHeight() { return layoutRevision } },
    querySelectorAll: () => []
  }
  globalThis.requestAnimationFrame = (callback) => {
    setTimeout(() => {
      frames += 1
      if (frames <= 6) layoutRevision += 1
      callback(performance.now())
    }, frameDelayMs)
  }

  try {
    const page = {
      evaluate: async (callback, argument) => await callback(argument)
    }
    const startedAt = performance.now()
    const result = await settleUxViewportRiskPage(page, {
      maxWaitMs: resolveUxViewportRiskMaxWaitMs({ FSUSBLOG_STEP_CPU_BUDGET: '1' }, 8)
    })
    const elapsedMs = performance.now() - startedAt
    assert.equal(fontsReady, true, 'readiness must complete before settle succeeds')
    assert.equal(result.stable, true)
    const minimumPendingReadinessSamples = Math.floor(fontReadyDelayMs / frameDelayMs) - 5
    assert.ok(
      result.attempts >= minimumPendingReadinessSamples,
      `expected at least ${minimumPendingReadinessSamples} measured pending-readiness samples, got ${result.attempts}`
    )
    assert.equal(result.signatureChanges, 5)
    assert.ok(elapsedMs > 1_500, `fixture must exceed the retired fixed budget, got ${elapsedMs}`)
    assert.ok(elapsedMs < 4_243, `fixture must remain inside the CPU1 dynamic budget, got ${elapsedMs}`)
    assert.equal(result.readiness.font.status, 'ready')
  } finally {
    globalThis.document = originalDocument
    globalThis.requestAnimationFrame = originalRequestAnimationFrame
  }
})

test('risk settle awaits browser readiness without waiting for network idle', async () => {
  const originalDocument = globalThis.document
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  let fontsReady = false
  let imageDecodeCalls = 0
  let networkIdleCalls = 0
  let pendingFrames = 0
  let maximumPendingFrames = 0

  const image = {
    src: '/hero.webp',
    currentSrc: '/hero.webp',
    complete: false,
    naturalWidth: 0,
    naturalHeight: 0,
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
    decode: async () => {
      imageDecodeCalls += 1
      await new Promise((resolve) => setImmediate(resolve))
      image.complete = true
      image.naturalWidth = 640
      image.naturalHeight = 360
    }
  }
  const root = {
    clientWidth: 1280,
    clientHeight: 720,
    scrollWidth: 1280,
    scrollHeight: 900
  }

  globalThis.document = {
    fonts: {
      ready: new Promise((resolve) => {
        setImmediate(() => {
          fontsReady = true
          resolve()
        })
      })
    },
    images: [image],
    documentElement: root,
    body: { scrollWidth: 1280, scrollHeight: 900 },
    querySelectorAll: () => []
  }
  globalThis.requestAnimationFrame = (callback) => {
    pendingFrames += 1
    maximumPendingFrames = Math.max(maximumPendingFrames, pendingFrames)
    setImmediate(() => {
      pendingFrames -= 1
      callback(performance.now())
    })
  }

  try {
    const page = {
      evaluate: async (callback, argument) => await callback(argument),
      waitForLoadState: async () => {
        networkIdleCalls += 1
      }
    }
    const result = await settleUxViewportRiskPage(page, {
      stabilityWindowMs: 1,
      maxWaitMs: 100
    })

    assert.equal(result.stable, true)
    assert.equal(result.visibleImageCount, 1)
    assert.equal(fontsReady, true)
    assert.equal(imageDecodeCalls, 1)
    assert.equal(networkIdleCalls, 0)
    assert.equal(maximumPendingFrames, 1, 'animation frames must be awaited sequentially')
    assert.equal(result.readiness.font.status, 'ready')
    assert.equal(result.readiness.images[0].status, 'decoded')
    assert.equal(result.readiness.images[0].completeBefore, false)
    assert.equal(result.readiness.images[0].naturalWidthAfter, 640)

    const repeat = await settleUxViewportRiskPage(page, {
      stabilityWindowMs: 1,
      maxWaitMs: 100
    })
    assert.equal(imageDecodeCalls, 1, 'already complete images must not be decoded repeatedly')
    assert.equal(repeat.readiness.images[0].status, 'already-complete')
  } finally {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    globalThis.document = originalDocument
    globalThis.requestAnimationFrame = originalRequestAnimationFrame
  }
})

test('risk settle fails within its deadline when layout keeps changing', async () => {
  const originalDocument = globalThis.document
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  let layoutRevision = 900
  const root = {
    clientWidth: 1280,
    clientHeight: 720,
    scrollWidth: 1280,
    get scrollHeight() {
      layoutRevision += 1
      return layoutRevision
    }
  }

  globalThis.document = {
    fonts: { ready: Promise.resolve() },
    images: [],
    documentElement: root,
    body: { scrollWidth: 1280, scrollHeight: 900 },
    querySelectorAll: () => []
  }
  globalThis.requestAnimationFrame = (callback) => {
    setImmediate(() => callback(performance.now()))
  }

  try {
    const page = {
      evaluate: async (callback, argument) => await callback(argument)
    }
    const startedAt = performance.now()
    let rejection
    await assert.rejects(
      settleUxViewportRiskPage(page, {
        stabilityWindowMs: 1,
        maxWaitMs: 20
      }),
      (error) => {
        rejection = error
        return /timed out|did not stabilize/u.test(error.message)
      }
    )
    assert.doesNotMatch(rejection.message, /before layout stability frame/u)
    assert.ok(performance.now() - startedAt < 500)
  } finally {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    globalThis.document = originalDocument
    globalThis.requestAnimationFrame = originalRequestAnimationFrame
  }
})

test('risk settle samples layout while font readiness is pending without extending the deadline', async () => {
  const originalDocument = globalThis.document
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  let fontsReady = false
  let layoutRevision = 900
  let resolveFonts
  let frameCount = 0
  const root = {
    clientWidth: 1280,
    clientHeight: 720,
    scrollWidth: 1280,
    get scrollHeight() {
      return layoutRevision
    }
  }

  globalThis.document = {
    fonts: {
      ready: new Promise((resolve) => {
        resolveFonts = resolve
      })
    },
    images: [],
    documentElement: root,
    body: { scrollWidth: 1280, get scrollHeight() { return layoutRevision } },
    querySelectorAll: () => []
  }
  globalThis.requestAnimationFrame = (callback) => {
    setImmediate(() => {
      frameCount += 1
      if (frameCount === 4) {
        layoutRevision = 920
        fontsReady = true
        resolveFonts()
      }
      callback(performance.now())
    })
  }

  try {
    const page = {
      evaluate: async (callback, argument) => await callback(argument)
    }
    const startedAt = performance.now()
    const result = await settleUxViewportRiskPage(page, { maxWaitMs: 50 })
    assert.equal(fontsReady, true)
    assert.equal(result.stable, true)
    assert.ok(result.attempts > 2, 'layout sampling must begin before font readiness settles')
    assert.ok(result.signatureChanges >= 1, 'the font-driven layout change must remain observable')
    assert.ok(performance.now() - startedAt < 100, 'settle must keep the original absolute deadline')
  } finally {
    globalThis.document = originalDocument
    globalThis.requestAnimationFrame = originalRequestAnimationFrame
  }
})

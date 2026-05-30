import { mount, flushPromises } from '@vue/test-utils'
import { computed, defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHumanReadProof } from '@/composables/useHumanReadProof'
import { requestHumanReadChallenge, submitHumanReadProof } from '@/api/readProof'

vi.mock('@/api/readProof', () => ({
  requestHumanReadChallenge: vi.fn(),
  submitHumanReadProof: vi.fn()
}))

type ObserverEntry = { isIntersecting: boolean; intersectionRatio: number }
let observerCallback: ((entries: ObserverEntry[]) => void) | null = null
let nowMs = 0

class FakeIntersectionObserver {
  constructor(callback: (entries: ObserverEntry[]) => void) {
    observerCallback = callback
  }

  observe(): void {}
  disconnect(): void {}
}

describe('useHumanReadProof', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    observerCallback = null
    nowMs = 0
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs)
    vi.mocked(requestHumanReadChallenge).mockResolvedValue({
      token: 'proof-token',
      scope: 'site',
      routeKey: 'home',
      articleId: null,
      minDwellMs: 1000,
      issuedAt: '2026-05-13T00:00:00Z',
      expiresAt: '2026-05-13T00:05:00Z'
    })
    vi.mocked(submitHumanReadProof).mockResolvedValue({ counted: true, status: 'counted' })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    observerCallback = null
  })

  it('submits after visible dwell reaches the challenge minimum', async () => {
    mountHarness()
    await waitForObserver()

    observerCallback?.([{ isIntersecting: true, intersectionRatio: 0.5 }])
    nowMs = 1000
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()

    expect(submitHumanReadProof).toHaveBeenCalledTimes(1)
    expect(vi.mocked(submitHumanReadProof).mock.calls[0][0]).toMatchObject({
      token: 'proof-token',
      scope: 'site',
      routeKey: 'home'
    })
    expect(vi.mocked(submitHumanReadProof).mock.calls[0][0].dwellMs).toBeGreaterThanOrEqual(1000)
  })

  it('does not submit before the dwell threshold', async () => {
    mountHarness()
    await waitForObserver()

    observerCallback?.([{ isIntersecting: true, intersectionRatio: 0.5 }])
    nowMs = 750
    await vi.advanceTimersByTimeAsync(750)
    await flushPromises()

    expect(submitHumanReadProof).not.toHaveBeenCalled()
  })

  it('does not observe or submit when the challenge is rejected with an empty token', async () => {
    vi.mocked(requestHumanReadChallenge).mockResolvedValueOnce({
      token: '',
      scope: 'site',
      routeKey: 'home',
      articleId: null,
      minDwellMs: 1000,
      issuedAt: '2026-05-13T00:00:00Z',
      expiresAt: '2026-05-13T00:00:00Z'
    })

    mountHarness()
    await flushPromises()

    expect(observerCallback).toBeNull()
    nowMs = 2000
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()

    expect(submitHumanReadProof).not.toHaveBeenCalled()
  })

  it('restarts challenge when route key changes and keeps one submit per route key', async () => {
    const routeKey = ref('home')
    mountHarness(routeKey)
    await waitForObserver()

    observerCallback?.([{ isIntersecting: true, intersectionRatio: 0.5 }])
    nowMs = 1000
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()

    routeKey.value = 'archive'
    observerCallback = null
    nowMs = 0
    await waitForObserver()
    observerCallback?.([{ isIntersecting: true, intersectionRatio: 0.5 }])
    nowMs = 1000
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()

    expect(requestHumanReadChallenge).toHaveBeenCalledTimes(2)
    expect(submitHumanReadProof).toHaveBeenCalledTimes(2)
    expect(vi.mocked(submitHumanReadProof).mock.calls[1][0].routeKey).toBe('archive')
  })
})

async function waitForObserver(): Promise<void> {
  for (let attempt = 0; attempt < 5 && !observerCallback; attempt += 1) {
    await flushPromises()
  }

  expect(observerCallback).not.toBeNull()
}

function mountHarness(routeKey = ref('home')) {
  return mount(defineComponent({
    setup() {
      useHumanReadProof({
        scope: computed(() => 'site'),
        routeKey: computed(() => routeKey.value),
        enabled: computed(() => true)
      })
      return () => h('main', { 'data-human-read-root': '' })
    }
  }), {
    attachTo: document.body
  })
}

import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
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
let mountedWrappers: VueWrapper[] = []

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

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
    mountedWrappers = []
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
    for (const wrapper of mountedWrappers) {
      wrapper.unmount()
    }
    mountedWrappers = []
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(window, '__FSUSBLOG_DISABLE_HUMAN_READ_PROOF__')
    delete document.documentElement.dataset.fsusDisableHumanReadProof
    document.body.innerHTML = ''
    observerCallback = null
  })

  it('does not request a challenge before the readable root becomes visible', async () => {
    mountHarness()
    await waitForObserver()

    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()

    expect(requestHumanReadChallenge).not.toHaveBeenCalled()
    expect(submitHumanReadProof).not.toHaveBeenCalled()
  })

  it('does not request a challenge when the screenshot harness suppresses human-read proof', async () => {
    Object.defineProperty(window, '__FSUSBLOG_DISABLE_HUMAN_READ_PROOF__', {
      configurable: true,
      value: true
    })

    mountHarness()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()

    expect(observerCallback).toBeNull()
    expect(requestHumanReadChallenge).not.toHaveBeenCalled()
    expect(submitHumanReadProof).not.toHaveBeenCalled()
  })

  it('submits after visible dwell reaches the challenge minimum plus clock safety', async () => {
    mountHarness()
    await waitForObserver()

    await triggerReadableRootVisible()
    nowMs = 1000
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(submitHumanReadProof).not.toHaveBeenCalled()

    nowMs = 1250
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()
    expect(submitHumanReadProof).toHaveBeenCalledTimes(1)
    expect(vi.mocked(submitHumanReadProof).mock.calls[0][0]).toMatchObject({
      token: 'proof-token',
      scope: 'site',
      routeKey: 'home'
    })
    expect(vi.mocked(submitHumanReadProof).mock.calls[0][0].dwellMs).toBeGreaterThanOrEqual(1250)
  })

  it('starts submit dwell from the challenge response instead of pre-challenge visibility', async () => {
    const deferredChallenge = createDeferred<Awaited<ReturnType<typeof requestHumanReadChallenge>>>()
    vi.mocked(requestHumanReadChallenge).mockReturnValueOnce(deferredChallenge.promise)

    mountHarness()
    await waitForObserver()

    await triggerReadableRootVisible()
    nowMs = 600
    await vi.advanceTimersByTimeAsync(600)
    await flushPromises()
    expect(submitHumanReadProof).not.toHaveBeenCalled()

    deferredChallenge.resolve({
      token: 'proof-token',
      scope: 'site',
      routeKey: 'home',
      articleId: null,
      minDwellMs: 1000,
      issuedAt: '2026-05-13T00:00:00Z',
      expiresAt: '2026-05-13T00:05:00Z'
    })
    await flushPromises()

    nowMs = 1849
    await vi.advanceTimersByTimeAsync(1249)
    await flushPromises()
    expect(submitHumanReadProof).not.toHaveBeenCalled()

    nowMs = 1850
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(submitHumanReadProof).toHaveBeenCalledTimes(1)
    expect(vi.mocked(submitHumanReadProof).mock.calls[0][0].dwellMs).toBe(1250)
  })

  it('does not submit before the dwell threshold', async () => {
    mountHarness()
    await waitForObserver()

    await triggerReadableRootVisible()
    nowMs = 750
    await vi.advanceTimersByTimeAsync(750)
    await flushPromises()

    expect(submitHumanReadProof).not.toHaveBeenCalled()
  })

  it('does not submit when the visible challenge is rejected with an empty token', async () => {
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
    await waitForObserver()
    expect(requestHumanReadChallenge).not.toHaveBeenCalled()

    await triggerReadableRootVisible()
    expect(requestHumanReadChallenge).toHaveBeenCalledTimes(1)
    nowMs = 2000
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()

    expect(submitHumanReadProof).not.toHaveBeenCalled()
  })

  it('restarts challenge when route key changes and keeps one submit per route key', async () => {
    const routeKey = ref('home')
    mountHarness(routeKey)
    await waitForObserver()

    await triggerReadableRootVisible()
    nowMs = 1250
    await vi.advanceTimersByTimeAsync(1250)
    await flushPromises()

    routeKey.value = 'archive'
    observerCallback = null
    nowMs = 0
    await waitForObserver()
    await triggerReadableRootVisible()
    nowMs = 1250
    await vi.advanceTimersByTimeAsync(1250)
    await flushPromises()

    expect(requestHumanReadChallenge).toHaveBeenCalledTimes(2)
    expect(submitHumanReadProof).toHaveBeenCalledTimes(2)
    expect(vi.mocked(submitHumanReadProof).mock.calls[1][0].routeKey).toBe('archive')
  })

  it('does not read a disposed controller when disabled before the first tick settles', async () => {
    const enabled = ref(true)
    mountHarness(ref('home'), enabled)

    enabled.value = false
    await flushPromises()

    expect(observerCallback).toBeNull()
  })

  it('pauses dwell while the document is hidden and resumes after it becomes visible', async () => {
    mountHarness()
    await waitForObserver()

    await triggerReadableRootVisible()
    nowMs = 400
    setDocumentVisibility('hidden')
    nowMs = 700
    setDocumentVisibility('visible')

    nowMs = 1549
    await vi.advanceTimersByTimeAsync(849)
    await flushPromises()
    expect(submitHumanReadProof).not.toHaveBeenCalled()

    nowMs = 1550
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()

    expect(submitHumanReadProof).toHaveBeenCalledTimes(1)
    expect(vi.mocked(submitHumanReadProof).mock.calls[0][0].dwellMs).toBe(1250)
  })

  it('cancels a deferred challenge request on unmount', async () => {
    const wrapper = mountHarness()
    await waitForObserver()

    observerCallback?.([{ isIntersecting: true, intersectionRatio: 0.5 }])
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    expect(requestHumanReadChallenge).not.toHaveBeenCalled()
    expect(submitHumanReadProof).not.toHaveBeenCalled()
  })
})

async function triggerReadableRootVisible(): Promise<void> {
  observerCallback?.([{ isIntersecting: true, intersectionRatio: 0.5 }])
  await vi.advanceTimersByTimeAsync(0)
  await flushPromises()
}

function setDocumentVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value })
  document.dispatchEvent(new window.Event('visibilitychange'))
}

async function waitForObserver(): Promise<void> {
  for (let attempt = 0; attempt < 5 && !observerCallback; attempt += 1) {
    await flushPromises()
  }

  expect(observerCallback).not.toBeNull()
}

function mountHarness(routeKey = ref('home'), enabled = ref(true)) {
  const wrapper = mount(defineComponent({
    setup() {
      useHumanReadProof({
        scope: computed(() => 'site'),
        routeKey: computed(() => routeKey.value),
        enabled: computed(() => enabled.value)
      })
      return () => h('main', { 'data-human-read-root': '' })
    }
  }), {
    attachTo: document.body
  })
  mountedWrappers.push(wrapper)
  return wrapper
}

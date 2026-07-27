import { describe, expect, it, vi } from 'vitest'
import {
  PublicActivationCoordinator,
  createPublicBootActivationIntent,
  type PublicActivationIntent,
  type PublicActivationPorts,
  type PublicRoutePreparationResult
} from '@/bootstrap/publicActivationCoordinator'

type Prepared = Readonly<{ target: string }>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function createHarness(overrides: Partial<PublicActivationPorts<Prepared>> = {}) {
  let now = 0
  let nextHandle = 1
  const timers = new Map<number, () => void>()
  const frames = new Map<number, () => void>()
  const prepareRoute = vi.fn(async (): Promise<PublicRoutePreparationResult> => ({ ready: true }))
  const prepareFullApp = vi.fn(async (intent: PublicActivationIntent): Promise<Prepared> => ({
    target: intent.target
  }))
  const commit = vi.fn(async () => {})
  const navigate = vi.fn(async () => {})
  const fallback = vi.fn()
  const show = vi.fn()
  const hide = vi.fn()
  const terminal = vi.fn()
  const illegalTransition = vi.fn()
  const ports: PublicActivationPorts<Prepared> = {
    routePreparationPort: { prepare: prepareRoute },
    fullAppPort: { prepare: prepareFullApp, commit, navigate },
    feedbackPort: { show, hide },
    fallbackPort: { navigate: fallback },
    telemetryPort: {
      phase: vi.fn(),
      illegalTransition,
      terminal
    },
    clock: {
      now: () => now,
      queueMicrotask: (callback) => queueMicrotask(callback),
      setTimer: (callback) => {
        const handle = nextHandle++
        timers.set(handle, callback)
        return handle
      },
      clearTimer: (handle) => timers.delete(handle),
      requestFrame: (callback) => {
        const handle = nextHandle++
        frames.set(handle, callback)
        return handle
      },
      cancelFrame: (handle) => frames.delete(handle)
    },
    ...overrides
  }
  const coordinator = new PublicActivationCoordinator(ports)
  return {
    commit,
    coordinator,
    fallback,
    flushFeedback: () => {
      now += 120
      for (const callback of [...timers.values()]) callback()
      timers.clear()
      for (const callback of [...frames.values()]) callback()
      frames.clear()
    },
    illegalTransition,
    navigate,
    prepareFullApp,
    prepareRoute,
    show,
    terminal
  }
}

const activation = (target: string, source = 'click'): PublicActivationIntent => ({
  kind: 'navigate',
  source,
  target
})

describe('PublicActivationCoordinator', () => {
  it('warms an idle route without creating a FullApp or changing DOM ownership', async () => {
    const route = deferred<PublicRoutePreparationResult>()
    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn(() => route.promise)
      }
    })

    const warming = harness.coordinator.warm(' /archive ', ' pointerenter ')
    expect(harness.coordinator.snapshot()).toMatchObject({
      generation: 0,
      intent: {
        kind: 'activate',
        source: 'pointerenter',
        target: '/archive'
      },
      owner: 'aot',
      phase: 'silent-warming'
    })

    route.resolve({ ready: true })
    await expect(warming).resolves.toEqual({ ready: true })

    expect(harness.coordinator.snapshot()).toMatchObject({
      generation: 0,
      intent: {
        kind: 'activate',
        source: 'pointerenter',
        target: '/archive'
      },
      owner: 'aot',
      phase: 'prepared'
    })
    expect(harness.prepareFullApp).not.toHaveBeenCalled()
  })

  it('converts a BootKernel handoff into one normalized activation intent', () => {
    expect(createPublicBootActivationIntent(
      { type: 'pointerdown', timestamp: 12 },
      ' /article/7 '
    )).toEqual({
      kind: 'activate',
      source: 'boot-pointerdown',
      target: '/article/7'
    })
  })

  it('deduplicates repeated intents for the same target', async () => {
    const route = deferred<PublicRoutePreparationResult>()
    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn(() => route.promise)
      }
    })

    const first = harness.coordinator.submitIntent(activation('/archive'))
    const duplicate = harness.coordinator.submitIntent(activation('/archive', 'pointerdown'))
    expect(duplicate).toBe(first)

    route.resolve({ ready: true })
    await expect(first).resolves.toMatchObject({ status: 'interactive' })
  })

  it('reuses an in-flight warm when the same target is submitted', async () => {
    const route = deferred<PublicRoutePreparationResult>()
    const signals: AbortSignal[] = []
    const prepare = vi.fn((_intent: PublicActivationIntent, signal: AbortSignal) => {
      signals.push(signal)
      return route.promise
    })
    const harness = createHarness({ routePreparationPort: { prepare } })

    const warming = harness.coordinator.warm('/archive')
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    const activationOutcome = harness.coordinator.submitIntent(activation('/archive'))

    expect(prepare).toHaveBeenCalledOnce()
    expect(signals[0]?.aborted).toBe(false)
    route.resolve({ ready: true })

    await expect(warming).resolves.toEqual({ ready: true })
    await expect(activationOutcome).resolves.toMatchObject({ status: 'interactive' })
    expect(prepare).toHaveBeenCalledOnce()
    expect(signals[0]?.aborted).toBe(false)
    expect(harness.commit).toHaveBeenCalledOnce()
  })

  it.each([
    {
      label: 'ready',
      settle: (route: ReturnType<typeof deferred<PublicRoutePreparationResult>>) => route.resolve({ ready: true }),
      status: 'interactive',
      commitCount: 1,
      fallbackCount: 0
    },
    {
      label: 'not-ready',
      settle: (route: ReturnType<typeof deferred<PublicRoutePreparationResult>>) => route.resolve({
        ready: false,
        reason: 'snapshot-miss'
      }),
      status: 'fallback',
      commitCount: 0,
      fallbackCount: 1
    },
    {
      label: 'throw',
      settle: (route: ReturnType<typeof deferred<PublicRoutePreparationResult>>) => route.reject(new Error('prepare-failed')),
      status: 'fallback',
      commitCount: 0,
      fallbackCount: 1
    },
    {
      label: 'abort',
      settle: (route: ReturnType<typeof deferred<PublicRoutePreparationResult>>) => {
        route.reject(abortError('prepare-aborted'))
      },
      status: 'fallback',
      commitCount: 0,
      fallbackCount: 1
    }
  ])('gives an adopted $label warm result exclusively to the activation chain', async ({
    settle,
    status,
    commitCount,
    fallbackCount
  }) => {
    const route = deferred<PublicRoutePreparationResult>()
    const signals: AbortSignal[] = []
    const prepare = vi.fn((_intent: PublicActivationIntent, signal: AbortSignal) => {
      signals.push(signal)
      return route.promise
    })
    const harness = createHarness({ routePreparationPort: { prepare } })

    const warming = harness.coordinator.warm(' /missing ', ' pointerenter ')
    const outcome = harness.coordinator.submitIntent(activation(' /missing ', ' pointerdown '))
    expect(harness.coordinator.snapshot().intent).toEqual({
      kind: 'navigate',
      source: 'pointerdown',
      target: '/missing'
    })

    settle(route)
    await warming
    await expect(outcome).resolves.toMatchObject({ status })

    expect(prepare).toHaveBeenCalledOnce()
    expect(signals[0]?.aborted).toBe(false)
    expect(harness.coordinator.snapshot().intent).toEqual({
      kind: 'navigate',
      source: 'pointerdown',
      target: '/missing'
    })
    expect(harness.illegalTransition).not.toHaveBeenCalled()
    expect(harness.commit).toHaveBeenCalledTimes(commitCount)
    expect(harness.fallback).toHaveBeenCalledTimes(fallbackCount)
    expect(harness.terminal).toHaveBeenCalledOnce()
  })

  it('lets an unadopted warm failure return legally to static-visible and clear its intent', async () => {
    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn(async () => ({ ready: false, reason: 'snapshot-miss' }))
      }
    })

    await expect(harness.coordinator.warm('/missing')).resolves.toEqual({
      ready: false,
      reason: 'snapshot-miss'
    })

    expect(harness.coordinator.snapshot()).toMatchObject({
      intent: null,
      owner: 'aot',
      phase: 'static-visible'
    })
    expect(harness.illegalTransition).not.toHaveBeenCalled()
    expect(harness.fallback).not.toHaveBeenCalled()
    expect(harness.terminal).not.toHaveBeenCalled()
  })

  it('treats an active-signal AbortError from an unadopted warm as a legal warm failure', async () => {
    const signalStates: boolean[] = []
    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn(async (_intent, signal) => {
          signalStates.push(signal.aborted)
          throw abortError('warm-aborted')
        })
      }
    })

    await expect(harness.coordinator.warm('/missing')).resolves.toEqual({
      ready: false,
      reason: 'warm-aborted'
    })

    expect(signalStates).toEqual([false])
    expect(harness.coordinator.snapshot()).toMatchObject({
      intent: null,
      owner: 'aot',
      phase: 'static-visible'
    })
    expect(harness.illegalTransition).not.toHaveBeenCalled()
    expect(harness.fallback).not.toHaveBeenCalled()
    expect(harness.terminal).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'route preparation',
      overrides: (): Partial<PublicActivationPorts<Prepared>> => ({
        routePreparationPort: {
          prepare: vi.fn(async (_intent, signal) => {
            expect(signal.aborted).toBe(false)
            throw abortError('route-aborted')
          })
        }
      })
    },
    {
      label: 'FullApp preparation',
      overrides: (): Partial<PublicActivationPorts<Prepared>> => ({
        fullAppPort: {
          prepare: vi.fn(async () => { throw abortError('full-app-prepare-aborted') }),
          commit: vi.fn(),
          navigate: vi.fn()
        }
      })
    },
    {
      label: 'commit',
      overrides: (): Partial<PublicActivationPorts<Prepared>> => ({
        fullAppPort: {
          prepare: vi.fn(async (intent) => ({ target: intent.target })),
          commit: vi.fn(async () => { throw abortError('commit-aborted') }),
          navigate: vi.fn()
        }
      })
    }
  ])('falls back once for an active-signal AbortError during $label', async ({ overrides }) => {
    const harness = createHarness(overrides())

    await expect(harness.coordinator.submitIntent(activation(' /missing ', ' pointerdown '))).resolves.toMatchObject({
      status: 'fallback'
    })

    expect(harness.coordinator.snapshot()).toMatchObject({
      intent: {
        kind: 'navigate',
        source: 'pointerdown',
        target: '/missing'
      },
      owner: 'document-navigation',
      phase: 'fallback',
      replaceable: false
    })
    expect(harness.illegalTransition).not.toHaveBeenCalled()
    expect(harness.fallback).toHaveBeenCalledOnce()
    expect(harness.terminal).toHaveBeenCalledOnce()
  })

  it('aborts a replaceable preparation and lets the latest target win', async () => {
    const first = deferred<PublicRoutePreparationResult>()
    const signals: AbortSignal[] = []
    const prepare = vi.fn((intent: PublicActivationIntent, signal: AbortSignal) => {
      signals.push(signal)
      return intent.target === '/first' ? first.promise : Promise.resolve({ ready: true })
    })
    const harness = createHarness({ routePreparationPort: { prepare } })

    const stale = harness.coordinator.submitIntent(activation('/first'))
    await Promise.resolve()
    const latest = harness.coordinator.submitIntent(activation('/latest'))
    first.reject(abortError('stale-route-aborted'))

    await expect(stale).resolves.toMatchObject({
      reason: 'replaced-by-newer-intent',
      status: 'fallback'
    })
    await expect(latest).resolves.toMatchObject({ status: 'interactive' })
    expect(signals[0]?.aborted).toBe(true)
    expect(harness.commit).toHaveBeenCalledTimes(1)
    expect(harness.commit.mock.calls[0]?.[1]).toMatchObject({ target: '/latest' })
    expect(harness.terminal).toHaveBeenCalledTimes(2)
  })

  it('falls back once when route preparation cannot become ready', async () => {
    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn(async () => ({ ready: false, reason: 'snapshot-miss' }))
      }
    })

    await expect(harness.coordinator.submitIntent(activation('/missing'))).resolves.toEqual({
      generation: 1,
      reason: 'snapshot-miss',
      status: 'fallback'
    })
    await expect(harness.coordinator.submitIntent(activation('/missing'))).resolves.toMatchObject({
      status: 'rejected'
    })
    expect(harness.fallback).toHaveBeenCalledTimes(1)
    expect(harness.terminal).toHaveBeenCalledTimes(1)
  })

  it('falls back once for prepare and commit failures', async () => {
    const prepareFailure = createHarness({
      fullAppPort: {
        prepare: vi.fn(async () => { throw new Error('prepare-failed') }),
        commit: vi.fn(),
        navigate: vi.fn()
      }
    })
    await expect(prepareFailure.coordinator.submitIntent(activation('/prepare'))).resolves.toMatchObject({
      reason: 'prepare-failed',
      status: 'fallback'
    })
    expect(prepareFailure.fallback).toHaveBeenCalledTimes(1)

    const commitFailure = createHarness({
      fullAppPort: {
        prepare: vi.fn(async (intent) => ({ target: intent.target })),
        commit: vi.fn(async () => { throw new Error('commit-failed') }),
        navigate: vi.fn()
      }
    })
    await expect(commitFailure.coordinator.submitIntent(activation('/commit'))).resolves.toMatchObject({
      reason: 'commit-failed',
      status: 'fallback'
    })
    expect(commitFailure.fallback).toHaveBeenCalledTimes(1)
  })

  it('never aborts commit and queues a later intent into the interactive router', async () => {
    const commitGate = deferred<void>()
    const commit = vi.fn(() => commitGate.promise)
    const navigate = vi.fn(async () => {})
    const harness = createHarness({
      fullAppPort: {
        prepare: vi.fn(async (intent) => ({ target: intent.target })),
        commit,
        navigate
      }
    })

    const committing = harness.coordinator.submitIntent(activation('/first'))
    await vi.waitFor(() => expect(harness.coordinator.snapshot().phase).toBe('committing'))
    await expect(harness.coordinator.submitIntent(activation('/second'))).resolves.toMatchObject({
      status: 'queued'
    })
    commitGate.resolve()

    await expect(committing).resolves.toMatchObject({ status: 'interactive' })
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ target: '/second' }))
    expect(harness.fallback).not.toHaveBeenCalled()
  })

  it('rejects a queued Router failure without starting document fallback after commit', async () => {
    const commitGate = deferred<void>()
    const navigate = vi.fn(async () => { throw new Error('router-rejected') })
    const harness = createHarness({
      fullAppPort: {
        prepare: vi.fn(async (intent) => ({ target: intent.target })),
        commit: vi.fn(() => commitGate.promise),
        navigate
      }
    })

    const committing = harness.coordinator.submitIntent(activation('/first'))
    await vi.waitFor(() => expect(harness.coordinator.snapshot().phase).toBe('committing'))
    await harness.coordinator.submitIntent(activation('/second'))
    commitGate.resolve()

    await expect(committing).resolves.toMatchObject({ status: 'interactive' })
    expect(harness.coordinator.snapshot().phase).toBe('interactive')
    expect(harness.fallback).not.toHaveBeenCalled()
    expect(harness.terminal).toHaveBeenCalledTimes(1)
  })

  it('fails closed on an illegal transition without changing owner', () => {
    const harness = createHarness()
    const before = harness.coordinator.snapshot()

    expect(harness.coordinator.transition('interactive', 'test-illegal')).toBe(false)
    expect(harness.coordinator.snapshot()).toEqual(before)
    expect(harness.illegalTransition).toHaveBeenCalledWith(
      'static-visible',
      'interactive',
      'test-illegal'
    )
  })

  it('shows foreground feedback only while a slow replaceable preparation is current', async () => {
    const route = deferred<PublicRoutePreparationResult>()
    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn(() => route.promise)
      }
    })
    const outcome = harness.coordinator.submitIntent(activation('/slow'))
    await Promise.resolve()

    harness.flushFeedback()
    expect(harness.show).toHaveBeenCalledTimes(1)
    route.resolve({ ready: true })
    await outcome
    expect(harness.coordinator.snapshot()).toMatchObject({
      foregroundFeedbackVisible: false,
      phase: 'interactive'
    })
  })
})

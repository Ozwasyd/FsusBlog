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
  const warmFullApp = vi.fn(async () => {})
  const prepareFullApp = vi.fn(async (intent: PublicActivationIntent): Promise<Prepared> => ({
    target: intent.target
  }))
  const commit = vi.fn(async () => {})
  const navigate = vi.fn(async () => {})
  const fallback = vi.fn()
  const markBusy = vi.fn()
  const show = vi.fn()
  const hide = vi.fn()
  const terminal = vi.fn()
  const illegalTransition = vi.fn()
  const prepareTiming = vi.fn()
  const defaultFullAppPort = {
    warm: warmFullApp,
    prepare: prepareFullApp,
    commit,
    navigate
  }
  const defaultTelemetryPort = {
    phase: vi.fn(),
    illegalTransition,
    terminal,
    prepareTiming
  }
  const defaultFeedbackPort = { markBusy, show, hide }
  const ports: PublicActivationPorts<Prepared> = {
    routePreparationPort: { prepare: prepareRoute },
    fullAppPort: defaultFullAppPort,
    feedbackPort: defaultFeedbackPort,
    fallbackPort: { navigate: fallback },
    telemetryPort: defaultTelemetryPort,
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
    ...overrides,
    fullAppPort: {
      ...defaultFullAppPort,
      ...overrides.fullAppPort
    },
    telemetryPort: {
      ...defaultTelemetryPort,
      ...overrides.telemetryPort
    },
    feedbackPort: {
      ...defaultFeedbackPort,
      ...overrides.feedbackPort
    },
    routePreparationPort: overrides.routePreparationPort ?? { prepare: prepareRoute }
  }
  const coordinator = new PublicActivationCoordinator(ports)
  return {
    advance: (ms: number) => {
      now += ms
    },
    commit: ports.fullAppPort.commit as typeof commit,
    coordinator,
    fallback,
    flushFeedback: () => {
      for (const callback of [...frames.values()]) callback()
      frames.clear()
    },
    flushOneFrame: () => {
      const first = frames.entries().next().value as [number, () => void] | undefined
      if (!first) return false
      frames.delete(first[0])
      first[1]()
      return true
    },
    illegalTransition,
    markBusy,
    navigate: ports.fullAppPort.navigate as typeof navigate,
    pendingFrames: () => frames.size,
    prepareFullApp: ports.fullAppPort.prepare as typeof prepareFullApp,
    prepareRoute: ports.routePreparationPort.prepare as typeof prepareRoute,
    prepareTiming: (ports.telemetryPort.prepareTiming ?? prepareTiming) as typeof prepareTiming,
    show,
    hide,
    terminal: (ports.telemetryPort.terminal ?? terminal) as typeof terminal,
    warmFullApp: ports.fullAppPort.warm as typeof warmFullApp
  }
}

const activation = (target: string, source = 'click'): PublicActivationIntent => ({
  kind: 'navigate',
  source,
  target
})

describe('PublicActivationCoordinator', () => {
  it('idle core warm does not prepare a route or commit FullApp', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch must not run during idle core warm')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn(async () => {
          await fetch('/api/public/navigation-snapshot.aeds?path=%2F')
          return { ready: true }
        })
      }
    })

    await expect(harness.coordinator.warmCore()).resolves.toEqual({ ready: true })

    expect(harness.warmFullApp).toHaveBeenCalledOnce()
    expect(harness.prepareRoute).not.toHaveBeenCalled()
    expect(harness.prepareFullApp).not.toHaveBeenCalled()
    expect(harness.commit).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(
      fetchSpy.mock.calls.filter((call) => String(call[0]).includes('navigation-snapshot.aeds'))
    ).toHaveLength(0)
    expect(harness.coordinator.snapshot()).toMatchObject({
      generation: 0,
      intent: null,
      owner: 'aot',
      phase: 'static-visible'
    })
    vi.unstubAllGlobals()
  })

  it('warms a pointerenter route without creating a FullApp or changing DOM ownership', async () => {
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
    expect(harness.warmFullApp).not.toHaveBeenCalled()
  })

  it('starts FullApp prepare and route preparation before either resolves', async () => {
    const route = deferred<PublicRoutePreparationResult>()
    const core = deferred<Prepared>()
    let routeStarted = false
    let coreStarted = false
    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn(() => {
          routeStarted = true
          return route.promise
        })
      },
      fullAppPort: {
        warm: vi.fn(async () => {}),
        prepare: vi.fn(() => {
          coreStarted = true
          return core.promise
        }),
        commit: vi.fn(async () => {}),
        navigate: vi.fn(async () => {})
      }
    })

    const outcome = harness.coordinator.submitIntent(activation('/archive'))
    await vi.waitFor(() => {
      expect(routeStarted).toBe(true)
      expect(coreStarted).toBe(true)
    })
    // Barrier: both producers must already be running before either resolves.
    expect(routeStarted && coreStarted).toBe(true)

    harness.advance(40)
    route.resolve({ ready: true, routeComponentMs: 30, routeSnapshotMs: 12 })
    harness.advance(10)
    core.resolve({ target: '/archive' })

    await expect(outcome).resolves.toMatchObject({ status: 'interactive' })
    expect(harness.commit).toHaveBeenCalledOnce()
    expect(harness.prepareTiming).toHaveBeenCalledWith(expect.objectContaining({
      activation_prepare_wall_ms: expect.any(Number),
      core_prepare_ms: expect.any(Number),
      route_component_ms: 30,
      route_snapshot_ms: 12,
      target: '/archive'
    }))
    const timing = harness.prepareTiming.mock.calls[0]?.[0] as {
      activation_prepare_wall_ms: number
      core_prepare_ms: number
      route_component_ms: number | null
      route_snapshot_ms: number | null
    }
    // Wall time is the parallel barrier, not the arithmetic sum of producers.
    const producerSum = timing.core_prepare_ms
      + (timing.route_component_ms ?? 0)
      + (timing.route_snapshot_ms ?? 0)
    expect(timing.activation_prepare_wall_ms).not.toBe(producerSum)
  })

  it.each([
    {
      label: 'core fast, component slow, snapshot fast',
      routeDelay: 50,
      coreDelay: 5
    },
    {
      label: 'core slow, component fast, snapshot fast',
      routeDelay: 5,
      coreDelay: 50
    },
    {
      label: 'snapshot slow but component cached (route still ready)',
      routeDelay: 40,
      coreDelay: 10
    }
  ])('commits once after parallel producers settle ($label)', async ({ routeDelay, coreDelay }) => {
    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, routeDelay))
          return { ready: true, routeComponentMs: routeDelay, routeSnapshotMs: 1 }
        })
      },
      fullAppPort: {
        warm: vi.fn(async () => {}),
        prepare: vi.fn(async (intent) => {
          await new Promise((resolve) => setTimeout(resolve, coreDelay))
          return { target: intent.target }
        }),
        commit: vi.fn(async () => {}),
        navigate: vi.fn(async () => {})
      }
    })

    await expect(harness.coordinator.submitIntent(activation('/archive'))).resolves.toMatchObject({
      status: 'interactive'
    })
    expect(harness.commit).toHaveBeenCalledOnce()
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
          warm: vi.fn(async () => {}),
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
          warm: vi.fn(async () => {}),
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
        warm: vi.fn(async () => {}),
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
        warm: vi.fn(async () => {}),
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

  it('aborts route preparation when FullApp core prepare fails', async () => {
    const signals: AbortSignal[] = []
    let lateRouteWrite = false
    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn((_intent, signal) => new Promise<PublicRoutePreparationResult>((resolve, reject) => {
          signals.push(signal)
          signal.addEventListener('abort', () => {
            // A cancelled producer must not surface a ready seed/head artifact.
            lateRouteWrite = true
            reject(abortError('route-aborted-by-core-failure'))
          }, { once: true })
        }))
      },
      fullAppPort: {
        warm: vi.fn(async () => {}),
        prepare: vi.fn(async () => { throw new Error('core-failed') }),
        commit: vi.fn(),
        navigate: vi.fn()
      }
    })

    const outcome = harness.coordinator.submitIntent(activation('/archive'))
    await vi.waitFor(() => expect(signals[0]).toBeDefined())
    await expect(outcome).resolves.toMatchObject({
      reason: 'core-failed',
      status: 'fallback'
    })
    expect(signals[0]?.aborted).toBe(true)
    expect(lateRouteWrite).toBe(true)
    expect(harness.commit).not.toHaveBeenCalled()
  })

  it('does not write a successful commit when a superseded generation finishes late', async () => {
    const firstRoute = deferred<PublicRoutePreparationResult>()
    const firstCore = deferred<Prepared>()
    const prepare = vi.fn((intent: PublicActivationIntent, signal: AbortSignal) => {
      if (intent.target === '/first') {
        return firstRoute.promise
      }
      return Promise.resolve({ ready: true })
    })
    const prepareFullApp = vi.fn((intent: PublicActivationIntent) => {
      if (intent.target === '/first') {
        return firstCore.promise
      }
      return Promise.resolve({ target: intent.target })
    })
    const harness = createHarness({
      routePreparationPort: { prepare },
      fullAppPort: {
        warm: vi.fn(async () => {}),
        prepare: prepareFullApp,
        commit: vi.fn(async () => {}),
        navigate: vi.fn(async () => {})
      }
    })

    const stale = harness.coordinator.submitIntent(activation('/first'))
    await Promise.resolve()
    const latest = harness.coordinator.submitIntent(activation('/latest'))

    firstRoute.resolve({ ready: true })
    firstCore.resolve({ target: '/first' })

    await expect(stale).resolves.toMatchObject({
      reason: 'replaced-by-newer-intent',
      status: 'fallback'
    })
    await expect(latest).resolves.toMatchObject({ status: 'interactive' })
    expect(harness.commit).toHaveBeenCalledTimes(1)
    expect(harness.commit.mock.calls[0]?.[1]).toMatchObject({ target: '/latest' })
  })

  it('never aborts commit and queues a later intent into the interactive router', async () => {
    const commitGate = deferred<void>()
    const commit = vi.fn(() => commitGate.promise)
    const navigate = vi.fn(async () => {})
    const harness = createHarness({
      fullAppPort: {
        warm: vi.fn(async () => {}),
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
        warm: vi.fn(async () => {}),
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

  it('marks busy immediately and shows loader only after one frame while waiting', async () => {
    const route = deferred<PublicRoutePreparationResult>()
    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn(() => route.promise)
      }
    })
    const outcome = harness.coordinator.submitIntent(activation('/slow'))
    await Promise.resolve()

    expect(harness.markBusy).toHaveBeenCalledTimes(1)
    expect(harness.show).not.toHaveBeenCalled()
    expect(harness.coordinator.snapshot()).toMatchObject({
      foregroundFeedbackVisible: false,
      phase: 'foreground-wait'
    })

    expect(harness.flushOneFrame()).toBe(true)
    expect(harness.show).toHaveBeenCalledTimes(1)
    expect(harness.coordinator.snapshot()).toMatchObject({
      foregroundFeedbackVisible: true,
      phase: 'foreground-wait'
    })

    // Extra frames must not re-show.
    harness.flushFeedback()
    expect(harness.show).toHaveBeenCalledTimes(1)

    route.resolve({ ready: true })
    await outcome
    expect(harness.hide).toHaveBeenCalled()
    expect(harness.coordinator.snapshot()).toMatchObject({
      foregroundFeedbackVisible: false,
      phase: 'interactive'
    })
  })

  it('never shows the loader when takeover finishes before the feedback frame', async () => {
    const harness = createHarness()
    const outcome = harness.coordinator.submitIntent(activation('/fast'))
    expect(harness.markBusy).toHaveBeenCalledTimes(1)
    expect(harness.pendingFrames()).toBe(1)

    await outcome
    expect(harness.coordinator.snapshot().phase).toBe('interactive')
    expect(harness.show).not.toHaveBeenCalled()
    expect(harness.pendingFrames()).toBe(0)

    // Late frame callback cannot re-show after terminal clear.
    harness.flushFeedback()
    expect(harness.show).not.toHaveBeenCalled()
  })

  it('keeps a visible loader through prepared/committing without first showing at commit', async () => {
    const route = deferred<PublicRoutePreparationResult>()
    const core = deferred<Prepared>()
    let resolveCommit!: () => void
    const commitGate = new Promise<void>((resolve) => {
      resolveCommit = resolve
    })
    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn(() => route.promise)
      },
      fullAppPort: {
        warm: vi.fn(async () => {}),
        prepare: vi.fn(() => core.promise),
        commit: vi.fn(async () => {
          await commitGate
        }),
        navigate: vi.fn(async () => {})
      }
    })
    const outcome = harness.coordinator.submitIntent(activation('/hold'))
    await Promise.resolve()
    harness.flushOneFrame()
    expect(harness.show).toHaveBeenCalledTimes(1)
    expect(harness.coordinator.snapshot().foregroundFeedbackVisible).toBe(true)

    route.resolve({ ready: true })
    core.resolve({ target: '/hold' })
    await vi.waitFor(() => {
      expect(harness.coordinator.snapshot().phase).toBe('committing')
    })
    expect(harness.coordinator.snapshot().foregroundFeedbackVisible).toBe(true)
    expect(harness.show).toHaveBeenCalledTimes(1)

    resolveCommit()
    await outcome
    expect(harness.coordinator.snapshot()).toMatchObject({
      foregroundFeedbackVisible: false,
      phase: 'interactive'
    })
  })

  it('does not arm feedback during silent warming', async () => {
    const harness = createHarness()
    await harness.coordinator.warm('/archive', 'pointerenter')
    expect(harness.markBusy).not.toHaveBeenCalled()
    expect(harness.show).not.toHaveBeenCalled()
    expect(harness.pendingFrames()).toBe(0)
  })

  it('clears busy feedback on preparation failure fallback', async () => {
    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn(async () => ({ ready: false, reason: 'snapshot-failed' }))
      }
    })
    const outcome = await harness.coordinator.submitIntent(activation('/fail'))
    expect(outcome).toMatchObject({ status: 'fallback', reason: 'snapshot-failed' })
    expect(harness.markBusy).toHaveBeenCalledTimes(1)
    expect(harness.hide).toHaveBeenCalled()
    expect(harness.coordinator.snapshot().foregroundFeedbackVisible).toBe(false)
    expect(harness.fallback).toHaveBeenCalledOnce()
  })

  it('does not re-show AOT feedback after interactive SPA navigation', async () => {
    const harness = createHarness()
    await harness.coordinator.submitIntent(activation('/home'))
    expect(harness.coordinator.snapshot().phase).toBe('interactive')
    harness.show.mockClear()
    harness.markBusy.mockClear()

    await harness.coordinator.submitIntent(activation('/archive'))
    harness.flushFeedback()
    expect(harness.markBusy).not.toHaveBeenCalled()
    expect(harness.show).not.toHaveBeenCalled()
    expect(harness.navigate).toHaveBeenCalledWith(expect.objectContaining({ target: '/archive' }))
  })
})

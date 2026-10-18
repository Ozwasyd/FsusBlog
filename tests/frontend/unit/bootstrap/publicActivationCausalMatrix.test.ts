/**
 * Public bootstrap causal matrix — fake scheduler unit gate.
 *
 * Proves the full intent → feedback → parallel prepare → single commit →
 * terminal cleanup chain with controllable microtask/frame/timer scheduling.
 * Absolute long sleeps are forbidden.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  PublicActivationCoordinator,
  type PublicActivationIntent,
  type PublicActivationPorts,
  type PublicRoutePreparationResult
} from '@/bootstrap/publicActivationCoordinator'
import {
  createEmptyPublicBootstrapCausalEvidence,
  requirePublicBootstrapCausalOrder
} from '../../support/publicBootstrapCausalEvidence.mjs'

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
  const timers = new Map<number, { callback: () => void, fireAt: number }>()
  const frames = new Map<number, () => void>()
  const prepareRoute = vi.fn(async (): Promise<PublicRoutePreparationResult> => ({ ready: true }))
  const warmFullApp = vi.fn(async () => {})
  const prepareFullApp = vi.fn(async (intent: PublicActivationIntent): Promise<Prepared> => ({
    target: intent.target
  }))
  const commit = vi.fn<PublicActivationPorts<Prepared>['fullAppPort']['commit']>(async () => {})
  const navigate = vi.fn(async () => {})
  const fallback = vi.fn()
  const markBusy = vi.fn()
  const show = vi.fn()
  const hide = vi.fn()
  const terminal = vi.fn()
  const illegalTransition = vi.fn()
  const prepareTiming = vi.fn()
  const phaseEvents: Array<{ from: string, to: string, at: number }> = []

  const defaultFullAppPort = {
    warm: warmFullApp,
    prepare: prepareFullApp,
    commit,
    navigate
  }
  const defaultTelemetryPort = {
    phase: vi.fn((from: string, to: string) => {
      phaseEvents.push({ from, to, at: now })
    }),
    illegalTransition,
    terminal,
    prepareTiming
  }
  const defaultFeedbackPort = { markBusy, show, hide }

  const ports: PublicActivationPorts<Prepared> = {
    fallbackPort: { navigate: fallback },
    clock: {
      now: () => now,
      // Use real microtasks so Promise-based activation barriers settle without
      // manual pumps; frames/timers remain fake for feedback timing control.
      queueMicrotask: (callback) => queueMicrotask(callback),
      setTimer: (callback, delayMs) => {
        const handle = nextHandle++
        timers.set(handle, { callback, fireAt: now + delayMs })
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
      for (const [handle, entry] of [...timers.entries()]) {
        if (entry.fireAt <= now) {
          timers.delete(handle)
          entry.callback()
        }
      }
    },
    commit: ports.fullAppPort.commit as typeof commit,
    coordinator,
    fallback,
    flushMicrotasks: async () => {
      await Promise.resolve()
      await Promise.resolve()
    },
    flushOneFrame: () => {
      const first = frames.entries().next().value as [number, () => void] | undefined
      if (!first) return false
      frames.delete(first[0])
      first[1]()
      return true
    },
    flushFrames: () => {
      for (const callback of [...frames.values()]) callback()
      frames.clear()
    },
    hide: ports.feedbackPort.hide as typeof hide,
    markBusy: ports.feedbackPort.markBusy as typeof markBusy,
    navigate: ports.fullAppPort.navigate as typeof navigate,
    now: () => now,
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.size,
    phaseEvents,
    prepareFullApp: ports.fullAppPort.prepare as typeof prepareFullApp,
    prepareRoute: ports.routePreparationPort.prepare as typeof prepareRoute,
    prepareTiming: (ports.telemetryPort.prepareTiming ?? prepareTiming) as typeof prepareTiming,
    show: ports.feedbackPort.show as typeof show,
    terminal: (ports.telemetryPort.terminal ?? terminal) as typeof terminal,
    warmFullApp: ports.fullAppPort.warm as typeof warmFullApp
  }
}

const activation = (target: string, source = 'click'): PublicActivationIntent => ({
  kind: 'navigate',
  source,
  target
})

describe('public activation causal matrix (fake scheduler)', () => {
  it('records the full successful wait chain with causal evidence order', async () => {
    const route = deferred<PublicRoutePreparationResult>()
    const core = deferred<Prepared>()
    const clock = { now: 0 }
    const evidence = createEmptyPublicBootstrapCausalEvidence({
      route: '/archive',
      scenario: 'unit-foreground-wait-success',
      buildIdentity: 'unit-test'
    })
    let routeStartedAt: number | null = null
    let coreStartedAt: number | null = null

    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn(() => {
          routeStartedAt = clock.now
          return route.promise
        })
      },
      fullAppPort: {
        warm: vi.fn(async () => {}),
        prepare: vi.fn(() => {
          coreStartedAt = clock.now
          return core.promise
        }),
        commit: vi.fn(async () => {
          evidence.timestamps.commitStart = clock.now
        }),
        navigate: vi.fn(async () => {})
      },
      feedbackPort: {
        markBusy: vi.fn(),
        show: vi.fn(() => {
          evidence.timestamps.feedbackFirstVisible = clock.now
        }),
        hide: vi.fn(() => {
          evidence.timestamps.feedbackHidden = clock.now
        })
      }
    })

    // Keep local clock mirror in sync with harness advances.
    const advance = (ms: number) => {
      harness.advance(ms)
      clock.now = harness.now()
    }

    evidence.timestamps.intent = clock.now
    const outcome = harness.coordinator.submitIntent(activation('/archive'))
    await harness.flushMicrotasks()

    expect(routeStartedAt).not.toBeNull()
    expect(coreStartedAt).not.toBeNull()
    evidence.timestamps.componentStart = routeStartedAt
    evidence.timestamps.coreStart = coreStartedAt
    evidence.timestamps.snapshotStart = routeStartedAt

    expect(harness.markBusy).toHaveBeenCalledTimes(1)
    expect(harness.show).not.toHaveBeenCalled()
    expect(harness.coordinator.snapshot().phase).toBe('foreground-wait')

    advance(1)
    expect(harness.flushOneFrame()).toBe(true)
    expect(harness.show).toHaveBeenCalledTimes(1)

    advance(10)
    route.resolve({ ready: true, routeComponentMs: 8, routeSnapshotMs: 6 })
    evidence.timestamps.componentEnd = clock.now
    evidence.timestamps.snapshotEnd = clock.now
    advance(5)
    core.resolve({ target: '/archive' })
    evidence.timestamps.coreEnd = clock.now

    await expect(outcome).resolves.toMatchObject({ status: 'interactive' })
    evidence.timestamps.interactive = clock.now
    evidence.navigationCount = 1

    requirePublicBootstrapCausalOrder(evidence)
    expect(harness.pendingFrames()).toBe(0)
    expect(harness.pendingTimers()).toBe(0)
    expect(harness.hide).toHaveBeenCalled()
    expect(harness.terminal).toHaveBeenCalledOnce()
    expect(harness.coordinator.snapshot()).toMatchObject({
      phase: 'interactive',
      owner: 'full-app',
      foregroundFeedbackVisible: false
    })
  })

  it('cancels feedback display when terminal completes before the feedback frame', async () => {
    const harness = createHarness()
    const outcome = harness.coordinator.submitIntent(activation('/fast'))
    expect(harness.markBusy).toHaveBeenCalledTimes(1)
    expect(harness.pendingFrames()).toBe(1)

    await outcome
    expect(harness.show).not.toHaveBeenCalled()
    expect(harness.pendingFrames()).toBe(0)

    // Late rAF cannot flash after terminal.
    harness.flushFrames()
    expect(harness.show).not.toHaveBeenCalled()
    expect(harness.coordinator.snapshot().phase).toBe('interactive')
  })

  it('starts core prepare and route prepare as a parallel barrier before either resolves', async () => {
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
    await harness.flushMicrotasks()
    expect(routeStarted && coreStarted).toBe(true)
    expect(harness.commit).not.toHaveBeenCalled()

    route.resolve({ ready: true, routeComponentMs: 12, routeSnapshotMs: 9 })
    await harness.flushMicrotasks()
    expect(harness.commit).not.toHaveBeenCalled()

    core.resolve({ target: '/archive' })
    await expect(outcome).resolves.toMatchObject({ status: 'interactive' })
    expect(harness.commit).toHaveBeenCalledOnce()
  })

  it('aborts same-generation route producer when core prepare fails', async () => {
    const signals: AbortSignal[] = []
    const harness = createHarness({
      routePreparationPort: {
        prepare: vi.fn((_intent, signal) => new Promise<PublicRoutePreparationResult>((_resolve, reject) => {
          signals.push(signal)
          signal.addEventListener('abort', () => {
            reject(abortError('route-aborted-by-core-failure'))
          }, { once: true })
        }))
      },
      fullAppPort: {
        warm: vi.fn(async () => {}),
        prepare: vi.fn(async () => {
          throw new Error('core-import-error')
        }),
        commit: vi.fn(),
        navigate: vi.fn()
      }
    })

    const outcome = harness.coordinator.submitIntent(activation('/archive'))
    await harness.flushMicrotasks()
    await expect(outcome).resolves.toMatchObject({
      status: 'fallback',
      reason: 'core-import-error'
    })
    expect(signals[0]?.aborted).toBe(true)
    expect(harness.fallback).toHaveBeenCalledOnce()
    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.hide).toHaveBeenCalled()
    expect(harness.terminal).toHaveBeenCalledOnce()
  })

  it('deduplicates same-target intents and applies latest-wins across targets before commit', async () => {
    const first = deferred<PublicRoutePreparationResult>()
    const signals: AbortSignal[] = []
    const prepare = vi.fn((intent: PublicActivationIntent, signal: AbortSignal) => {
      signals.push(signal)
      return intent.target === '/first' ? first.promise : Promise.resolve({ ready: true })
    })
    const harness = createHarness({ routePreparationPort: { prepare } })

    const sameA = harness.coordinator.submitIntent(activation('/first', 'pointerdown'))
    const sameB = harness.coordinator.submitIntent(activation('/first', 'click'))
    expect(sameB).toBe(sameA)
    await harness.flushMicrotasks()
    expect(prepare).toHaveBeenCalledOnce()

    const latest = harness.coordinator.submitIntent(activation('/latest'))
    first.reject(abortError('stale'))
    await expect(sameA).resolves.toMatchObject({
      status: 'fallback',
      reason: 'replaced-by-newer-intent'
    })
    await expect(latest).resolves.toMatchObject({ status: 'interactive' })
    expect(signals[0]?.aborted).toBe(true)
    expect(harness.commit).toHaveBeenCalledTimes(1)
    expect(harness.commit.mock.calls[0]?.[1]).toMatchObject({ target: '/latest' })
    expect(harness.terminal).toHaveBeenCalledTimes(2)
  })

  it('freezes commit and queues a second intent for interactive Router only once', async () => {
    const commitGate = deferred<void>()
    const navigate = vi.fn(async () => {})
    const harness = createHarness({
      fullAppPort: {
        warm: vi.fn(async () => {}),
        prepare: vi.fn(async (intent) => ({ target: intent.target })),
        commit: vi.fn(() => commitGate.promise),
        navigate
      }
    })

    const committing = harness.coordinator.submitIntent(activation('/first'))
    await harness.flushMicrotasks()
    await vi.waitFor(() => expect(harness.coordinator.snapshot().phase).toBe('committing'))

    const queued = await harness.coordinator.submitIntent(activation('/second'))
    expect(queued).toMatchObject({ status: 'queued' })
    expect(harness.fallback).not.toHaveBeenCalled()

    commitGate.resolve()
    await expect(committing).resolves.toMatchObject({ status: 'interactive' })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ target: '/second' }))
    expect(harness.terminal).toHaveBeenCalledOnce()
  })

  it('clears feedback, timers, and frames on every prepare-stage failure path', async () => {
    for (const reason of ['entry-load-error', 'snapshot-http-error', 'route-component-error'] as const) {
      const harness = createHarness({
        routePreparationPort: {
          prepare: vi.fn(async () => ({ ready: false, reason }))
        }
      })
      const outcomePromise = harness.coordinator.submitIntent(activation('/fail'))
      await harness.flushMicrotasks()
      harness.flushOneFrame()
      await expect(outcomePromise).resolves.toMatchObject({ status: 'fallback', reason })
      expect(harness.fallback).toHaveBeenCalledOnce()
      expect(harness.hide).toHaveBeenCalled()
      expect(harness.pendingFrames()).toBe(0)
      expect(harness.pendingTimers()).toBe(0)
      expect(harness.coordinator.snapshot()).toMatchObject({
        phase: 'fallback',
        foregroundFeedbackVisible: false
      })
      await expect(harness.coordinator.submitIntent(activation('/fail'))).resolves.toMatchObject({
        status: 'rejected'
      })
      expect(harness.fallback).toHaveBeenCalledOnce()
      expect(harness.terminal).toHaveBeenCalledOnce()
    }
  })

  it('does not arm feedback during silent warm and keeps AOT ownership', async () => {
    const harness = createHarness()
    await expect(harness.coordinator.warm('/archive', 'pointerenter')).resolves.toEqual({ ready: true })
    expect(harness.markBusy).not.toHaveBeenCalled()
    expect(harness.show).not.toHaveBeenCalled()
    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.prepareFullApp).not.toHaveBeenCalled()
    expect(harness.coordinator.snapshot()).toMatchObject({
      owner: 'aot',
      phase: 'prepared'
    })
  })

  it('idle core warm never starts route snapshot producers', async () => {
    const prepareRoute = vi.fn(async () => ({ ready: true }))
    const harness = createHarness({
      routePreparationPort: { prepare: prepareRoute }
    })
    await expect(harness.coordinator.warmCore()).resolves.toEqual({ ready: true })
    expect(harness.warmFullApp).toHaveBeenCalledOnce()
    expect(prepareRoute).not.toHaveBeenCalled()
    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.coordinator.snapshot()).toMatchObject({
      generation: 0,
      phase: 'static-visible',
      owner: 'aot'
    })
  })
})

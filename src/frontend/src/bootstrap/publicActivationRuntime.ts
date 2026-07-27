import { readonly, shallowRef } from 'vue'
import {
  PublicActivationCoordinator,
  createPublicBootActivationIntent,
  type PublicActivationIntent,
  type PublicActivationOutcome,
  type PublicActivationOwner,
  type PublicRoutePreparationResult,
  type PublicActivationState
} from '@/bootstrap/publicActivationCoordinator'
import type { PublicBootIntent } from '@/bootstrap/publicBootHandoff'
import { prewarmPublicRoute } from '@/router/publicRoutePreload'
import { hideNavigationProgress, showNavigationProgress } from '@/services/navigationProgress'
import { emitTelemetry } from '@/services/telemetryBus'

type FullAppModule = typeof import('@/bootstrap/fullApp')
type PreparedFullApp = ReturnType<FullAppModule['prepareFullApp']>

const initialState: PublicActivationState = {
  generation: 0,
  intent: null,
  phase: 'static-visible',
  owner: 'aot',
  foregroundFeedbackVisible: false,
  failureReason: null,
  replaceable: true
}
const state = shallowRef<PublicActivationState>(initialState)
let preparedFullApp: PreparedFullApp | null = null
let preparedCandidate: PreparedFullApp | null = null
let bootIntentAdopted = false

function currentTarget(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}` || '/'
}

function toAbsoluteHref(target: string): string {
  return new URL(target, window.location.href).toString()
}

type FullAppActivationOwner = Exclude<PublicActivationOwner, 'document-navigation'>

function getFullAppActivationOwner(): FullAppActivationOwner {
  return state.value.owner === 'full-app' ? 'full-app' : 'aot'
}

async function loadFullApp(): Promise<FullAppModule> {
  return await import('@/bootstrap/fullApp')
}

const coordinator = new PublicActivationCoordinator<PreparedFullApp>({
  routePreparationPort: {
    prepare: async (intent, signal) => {
      const result = await prewarmPublicRoute(intent.target, {
        reason: intent.kind === 'navigate' ? 'atomic-navigation' : 'idle',
        signal
      })
      return { ready: result.status === 'ready', reason: result.status }
    }
  },
  fullAppPort: {
    prepare: async () => {
      if (preparedCandidate) {
        return preparedCandidate
      }
      const module = await loadFullApp()
      preparedCandidate = module.prepareFullApp({
        getPublicActivationOwner: getFullAppActivationOwner,
        takeover: 'public-shell'
      })
      return preparedCandidate
    },
    commit: async (prepared, intent) => {
      const module = await loadFullApp()
      await module.commitPreparedFullApp(prepared, intent.kind === 'navigate'
        ? { navigationIntent: { to: intent.target } }
        : {})
      preparedFullApp = prepared
      preparedCandidate = null
    },
    navigate: async (intent) => {
      if (!preparedFullApp) {
        throw new Error('interactive FullApp is unavailable')
      }
      await preparedFullApp.router.push(intent.target)
    }
  },
  feedbackPort: {
    show: () => showNavigationProgress(),
    hide: () => hideNavigationProgress()
  },
  fallbackPort: {
    navigate: (intent) => window.location.assign(toAbsoluteHref(intent.target))
  },
  telemetryPort: {
    phase: (from, to, snapshot, durationMs) => emitTelemetry('public_activation_phase', {
      durationMs,
      from,
      generation: snapshot.generation,
      owner: snapshot.owner,
      source: snapshot.intent?.source,
      target: snapshot.intent?.target,
      to
    }, 'info'),
    illegalTransition: (from, to, reason) => emitTelemetry('public_activation_illegal_transition', {
      from,
      reason,
      to
    }, 'warn'),
    terminal: (outcome) => emitTelemetry('public_activation_terminal', outcome, outcome.status === 'fallback' ? 'warn' : 'info')
  },
  clock: {
    now: () => performance.now(),
    queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: (handle) => window.clearTimeout(handle),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle)
  },
  onStateChange: (snapshot) => {
    state.value = snapshot
  }
})

export const publicActivationState = readonly(state)

export function getPublicActivationOwner(): PublicActivationState['owner'] {
  return state.value.owner
}

export function warmPublicActivation(
  target = currentTarget(),
  source = 'idle'
): Promise<PublicRoutePreparationResult> {
  return coordinator.warm(target, source)
}

export function submitPublicActivationIntent(intent: PublicActivationIntent): Promise<PublicActivationOutcome> {
  return coordinator.submitIntent(intent)
}

export function adoptPublicBootIntent(intent: PublicBootIntent | null): void {
  if (bootIntentAdopted || !intent) {
    return
  }
  bootIntentAdopted = true
  void coordinator.submitIntent(createPublicBootActivationIntent(intent, currentTarget()))
}

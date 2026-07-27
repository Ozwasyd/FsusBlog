import { readonly, shallowRef } from 'vue'
import { markStartup, measureStartup } from '@/bootstrap/startupProfiler'

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
  cancelIdleCallback?: (handle: number) => void
}

export type RuntimeActivationPhase = 'dormant' | 'scheduled' | 'active'

export type RuntimeActivationReason =
  | 'immediate'
  | 'takeover'
  | 'intent'
  | 'idle'
  | 'after-first-paint'

export type RuntimeActivationScheduleOptions = Readonly<{
  allowIdleActivation?: boolean
  allowScrollActivation?: boolean
  allowIntentActivation?: boolean
}>

const phase = shallowRef<RuntimeActivationPhase>('dormant')
const active = shallowRef(false)

export const runtimeActivationPhase = readonly(phase)
export const runtimeActive = readonly(active)

let intentBound = false
let idleTimer: number | null = null
let idleHandle: number | null = null
let activationQueued = false

const DEFERRED_IDLE_TIMEOUT_MS = 1800
const DEFERRED_TIMER_FALLBACK_MS = 1200
const MIN_IDLE_BUDGET_MS = 8

function clearIntentBindings(): void {
  if (!intentBound) {
    return
  }

  intentBound = false
  window.removeEventListener('pointerdown', handleIntentActivation)
  window.removeEventListener('keydown', handleIntentActivation)
  window.removeEventListener('touchstart', handleIntentActivation)
  window.removeEventListener('scroll', handleIntentActivation)
}

function clearDeferredActivationHandles(): void {
  const idleWindow = window as IdleWindow
  if (idleHandle !== null && typeof idleWindow.cancelIdleCallback === 'function') {
    idleWindow.cancelIdleCallback(idleHandle)
    idleHandle = null
  }

  if (idleTimer !== null) {
    window.clearTimeout(idleTimer)
    idleTimer = null
  }
}

function markScheduled(reason: RuntimeActivationReason): void {
  if (phase.value === 'dormant') {
    phase.value = 'scheduled'
  }
  markStartup('runtime-activation:scheduled')
  markStartup(`runtime-activation:scheduled:${reason}`)
}

function queueActivation(reason: RuntimeActivationReason): void {
  if (active.value || activationQueued) {
    return
  }

  activationQueued = true
  markScheduled(reason)

  const fallbackTimer = window.setTimeout(() => {
    if (!activationQueued) {
      return
    }
    activationQueued = false
    activateRuntime()
  }, 300)

  requestAnimationFrame(() => {
    window.clearTimeout(fallbackTimer)
    window.setTimeout(() => {
      activationQueued = false
      activateRuntime()
    }, 0)
  })
}

function handleIntentActivation(): void {
  queueActivation('intent')
}

function bindIntentActivation(options: RuntimeActivationScheduleOptions): void {
  if (intentBound || options.allowIntentActivation === false) {
    return
  }

  intentBound = true
  window.addEventListener('pointerdown', handleIntentActivation, { once: true, passive: true })
  window.addEventListener('keydown', handleIntentActivation, { once: true })
  window.addEventListener('touchstart', handleIntentActivation, { once: true, passive: true })
  if (options.allowScrollActivation !== false) {
    window.addEventListener('scroll', handleIntentActivation, { once: true, passive: true })
  }
}

function scheduleIdleActivation(): void {
  clearDeferredActivationHandles()
  const idleWindow = window as IdleWindow
  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleHandle = idleWindow.requestIdleCallback((deadline) => {
      idleHandle = null
      if (!deadline.didTimeout && deadline.timeRemaining() < MIN_IDLE_BUDGET_MS) {
        idleTimer = window.setTimeout(() => queueActivation('idle'), 120)
        return
      }

      queueActivation('idle')
    }, { timeout: DEFERRED_IDLE_TIMEOUT_MS })
    return
  }

  idleTimer = window.setTimeout(() => queueActivation('idle'), DEFERRED_TIMER_FALLBACK_MS)
}

/**
 * Final AppRuntime ownership policy: dormant → scheduled → active.
 * Composition roots call this after FullApp is interactive (or for direct SPA after mount).
 * Does not import coordinator, router, pinia, AppRuntime, or public shell.
 */
export function scheduleRuntimeActivation(
  reason: RuntimeActivationReason,
  options: RuntimeActivationScheduleOptions = {}
): void {
  if (active.value) {
    return
  }

  if (reason === 'immediate' || reason === 'takeover' || reason === 'intent') {
    queueActivation(reason)
    return
  }

  markScheduled(reason)
  bindIntentActivation(options)

  if (options.allowIdleActivation === false) {
    clearDeferredActivationHandles()
    return
  }

  scheduleIdleActivation()
}

export function activateRuntime(): void {
  if (active.value) {
    clearIntentBindings()
    clearDeferredActivationHandles()
    return
  }

  phase.value = 'active'
  active.value = true
  markStartup('runtime-activation:active')
  measureStartup('entry-to-runtime-active', 'entry', 'runtime-activation:active')
  measureStartup('runtime-activation-wait', 'runtime-activation:scheduled', 'runtime-activation:active')
  clearIntentBindings()
  clearDeferredActivationHandles()
  activationQueued = false
}

export function resetRuntimeActivationForTests(): void {
  clearIntentBindings()
  clearDeferredActivationHandles()
  activationQueued = false
  phase.value = 'dormant'
  active.value = false
}

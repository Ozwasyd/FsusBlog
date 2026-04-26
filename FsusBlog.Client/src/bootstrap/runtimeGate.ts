import { shallowRef } from 'vue'
import { getActivePinia } from 'pinia'
import { useAppShellStore } from '@/store/appShell'
import { markStartup, measureStartup } from '@/bootstrap/startupProfiler'

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
  cancelIdleCallback?: (handle: number) => void
}

export const runtimeReady = shallowRef(false)
export const runtimePhase = shallowRef<'shell-visible' | 'runtime-loading' | 'runtime-ready'>('shell-visible')

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

function activateRuntime(): void {
  if (runtimeReady.value) {
    clearIntentBindings()
    return
  }

  runtimePhase.value = 'runtime-ready'
  syncAppShellRuntimePhase('runtime-ready')
  runtimeReady.value = true
  markStartup('runtime-ready')
  measureStartup('entry-to-runtime-ready', 'entry', 'runtime-ready')
  measureStartup('runtime-gate-wait', 'runtime-gate:scheduled', 'runtime-ready')
  clearIntentBindings()
  clearDeferredActivationHandles()
}

function queueRuntimeActivation(reason: 'immediate' | 'intent' | 'idle'): void {
  if (runtimeReady.value || activationQueued) {
    return
  }

  activationQueued = true
  if (reason === 'intent') {
    runtimePhase.value = 'runtime-loading'
    syncAppShellRuntimePhase('runtime-loading')
  }
  markStartup('runtime-gate:scheduled')
  markStartup(`runtime-gate:scheduled:${reason}`)

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
  queueRuntimeActivation('intent')
}

function syncAppShellRuntimePhase(phase: 'shell-visible' | 'runtime-loading' | 'runtime-ready'): void {
  if (!getActivePinia()) {
    return
  }

  try {
    useAppShellStore().setRuntimePhase(phase)
  } catch {
    // no-op: store may be unavailable during early bootstrap
  }
}

export function enableFullAppRuntime(): void {
  queueRuntimeActivation('intent')
}

export function scheduleFullAppRuntime(defer: boolean): void {
  if (runtimeReady.value) {
    return
  }

  if (!defer) {
    queueRuntimeActivation('immediate')
    return
  }

  if (!intentBound) {
    intentBound = true
    window.addEventListener('pointerdown', handleIntentActivation, { once: true, passive: true })
    window.addEventListener('keydown', handleIntentActivation, { once: true })
    window.addEventListener('touchstart', handleIntentActivation, { once: true, passive: true })
    window.addEventListener('scroll', handleIntentActivation, { once: true, passive: true })
  }

  clearDeferredActivationHandles()
  const idleWindow = window as IdleWindow
  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleHandle = idleWindow.requestIdleCallback((deadline) => {
      idleHandle = null
      if (!deadline.didTimeout && deadline.timeRemaining() < MIN_IDLE_BUDGET_MS) {
        idleTimer = window.setTimeout(() => queueRuntimeActivation('idle'), 120)
        return
      }

      queueRuntimeActivation('idle')
    }, { timeout: DEFERRED_IDLE_TIMEOUT_MS })
    return
  }

  idleTimer = window.setTimeout(() => queueRuntimeActivation('idle'), DEFERRED_TIMER_FALLBACK_MS)
}

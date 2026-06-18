import { readonly, shallowRef } from 'vue'
import { emitTelemetry } from '@/services/telemetryBus'

export type PublicRuntimeOwner = 'aot' | 'spa'

export type PublicTakeoverPhase =
  | 'aot-idle'
  | 'prewarming'
  | 'prepared'
  | 'committing'
  | 'navigating'
  | 'spa-active'
  | 'fallback-navigation'

type PublicTakeoverTransitionDetail = Readonly<{
  reason?: string
  source?: string
  target?: string
}>

const transitionMap: Record<PublicTakeoverPhase, readonly PublicTakeoverPhase[]> = {
  'aot-idle': ['aot-idle', 'prewarming', 'committing', 'navigating', 'fallback-navigation'],
  prewarming: ['aot-idle', 'prewarming', 'prepared', 'committing', 'navigating', 'fallback-navigation'],
  prepared: ['aot-idle', 'committing', 'navigating', 'fallback-navigation'],
  committing: ['spa-active', 'fallback-navigation'],
  navigating: ['aot-idle', 'navigating', 'fallback-navigation'],
  'spa-active': ['spa-active'],
  'fallback-navigation': ['aot-idle', 'fallback-navigation']
}

const publicTakeoverPhase = shallowRef<PublicTakeoverPhase>('aot-idle')
const publicRuntimeOwner = shallowRef<PublicRuntimeOwner>('aot')

export const publicTakeoverPhaseState = readonly(publicTakeoverPhase)
export const publicRuntimeOwnerState = readonly(publicRuntimeOwner)

function resolveOwnerForPhase(phase: PublicTakeoverPhase): PublicRuntimeOwner {
  return phase === 'committing' || phase === 'spa-active' ? 'spa' : 'aot'
}

function emitIllegalTransition(
  from: PublicTakeoverPhase,
  to: PublicTakeoverPhase,
  detail: PublicTakeoverTransitionDetail
): void {
  emitTelemetry('public_takeover_illegal_transition', {
    from,
    to,
    ...detail
  }, 'warn')
}

export function getPublicTakeoverPhase(): PublicTakeoverPhase {
  return publicTakeoverPhase.value
}

export function getPublicRuntimeOwner(): PublicRuntimeOwner {
  return publicRuntimeOwner.value
}

export function canTransitionPublicTakeoverPhase(
  from: PublicTakeoverPhase,
  to: PublicTakeoverPhase
): boolean {
  return transitionMap[from].includes(to)
}

export function transitionPublicTakeoverPhase(
  to: PublicTakeoverPhase,
  detail: PublicTakeoverTransitionDetail = {}
): boolean {
  const from = publicTakeoverPhase.value
  if (!canTransitionPublicTakeoverPhase(from, to)) {
    emitIllegalTransition(from, to, detail)
    return false
  }

  publicTakeoverPhase.value = to
  publicRuntimeOwner.value = resolveOwnerForPhase(to)
  return true
}

export function beginPublicTakeoverPrewarm(detail?: PublicTakeoverTransitionDetail): boolean {
  return transitionPublicTakeoverPhase('prewarming', detail)
}

export function markPublicTakeoverPrepared(detail?: PublicTakeoverTransitionDetail): boolean {
  return transitionPublicTakeoverPhase('prepared', detail)
}

export function beginPublicTakeoverCommit(detail?: PublicTakeoverTransitionDetail): boolean {
  return transitionPublicTakeoverPhase('committing', detail)
}

export function completePublicTakeoverCommit(detail?: PublicTakeoverTransitionDetail): boolean {
  return transitionPublicTakeoverPhase('spa-active', detail)
}

export function beginPublicTakeoverNavigation(detail?: PublicTakeoverTransitionDetail): boolean {
  return transitionPublicTakeoverPhase('navigating', detail)
}

export function completePublicTakeoverNavigation(detail?: PublicTakeoverTransitionDetail): boolean {
  return transitionPublicTakeoverPhase('aot-idle', detail)
}

export function markPublicTakeoverFallback(detail?: PublicTakeoverTransitionDetail): boolean {
  emitTelemetry('public_takeover_fallback_navigation', detail, 'warn')
  return transitionPublicTakeoverPhase('fallback-navigation', detail)
}

export function resetPublicTakeover(detail?: PublicTakeoverTransitionDetail): boolean {
  publicTakeoverPhase.value = 'aot-idle'
  publicRuntimeOwner.value = 'aot'
  if (detail?.reason) {
    emitTelemetry('public_takeover_reset', detail, 'info')
  }
  return true
}

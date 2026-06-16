import { readonly, shallowRef } from 'vue'

type PublicTakeoverPhase = 'shell' | 'hydrating' | 'hydrated'

const publicTakeoverPhase = shallowRef<PublicTakeoverPhase>('shell')

export const publicTakeoverPhaseState = readonly(publicTakeoverPhase)

export function beginPublicTakeoverHydration(): void {
  publicTakeoverPhase.value = 'hydrating'
}

export function completePublicTakeoverHydration(): void {
  publicTakeoverPhase.value = 'hydrated'
}

export function resetPublicTakeoverHydration(): void {
  publicTakeoverPhase.value = 'shell'
}

import { computed, type ComputedRef } from 'vue'
import { readPublicHydrationPayload } from '@/bootstrap/publicHydrationBootstrap'
import { publicTakeoverPhaseState } from '@/bootstrap/publicTakeoverState'

const hasInitialPublicHydrationSeed = Boolean(readPublicHydrationPayload())

export function usePublicSpaNavigationMode(): ComputedRef<boolean> {
  return computed(() => !hasInitialPublicHydrationSeed || publicTakeoverPhaseState.value === 'hydrated')
}

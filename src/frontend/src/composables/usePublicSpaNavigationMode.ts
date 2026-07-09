import { computed } from 'vue'
import { readPublicHydrationPayload } from '@/bootstrap/publicHydrationBootstrap'
import { publicTakeoverPhaseState } from '@/bootstrap/publicTakeoverState'

const hasInitialPublicHydrationSeed = Boolean(readPublicHydrationPayload())

export const usePublicSpaNavigationMode = computed(() =>
  !hasInitialPublicHydrationSeed || publicTakeoverPhaseState.value === 'spa-active'
)

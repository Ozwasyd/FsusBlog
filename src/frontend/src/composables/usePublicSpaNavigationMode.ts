import { computed } from 'vue'
import { readPublicHydrationPayload } from '@/bootstrap/publicHydrationBootstrap'
import { publicActivationState } from '@/bootstrap/publicActivationRuntime'

const hasInitialPublicHydrationSeed = Boolean(readPublicHydrationPayload())

export const usePublicSpaNavigationMode = computed(() =>
  !hasInitialPublicHydrationSeed || publicActivationState.value.phase === 'interactive'
)

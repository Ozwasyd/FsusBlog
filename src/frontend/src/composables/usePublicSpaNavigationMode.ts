import { computed } from 'vue';

import { publicActivationState } from '@/bootstrap/publicActivationRuntime';
import { readPublicHydrationPayload } from '@/bootstrap/publicHydrationBootstrap';

const hasInitialPublicHydrationSeed = Boolean(readPublicHydrationPayload());

export const usePublicSpaNavigationMode = computed(() =>
    !hasInitialPublicHydrationSeed || publicActivationState.value.phase === 'interactive'
);

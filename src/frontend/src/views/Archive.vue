<template>
    <PublicArchivePageContent
        :loading="loading"
        :view="archiveView"
        :spa-navigation="spaNavigation"
        @navigate="handleNavigate"
    />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';

import PublicArchivePageContent from '@/components/public/pages/PublicArchivePageContent.vue';
import { useArchiveView } from '@/composables/useArchiveView';
import { useHumanReadProof } from '@/composables/useHumanReadProof';
import { usePublicSpaNavigationMode } from '@/composables/usePublicSpaNavigationMode';
import { buildPublicArchiveRouteKey } from '@/public-renderers/publicRouteIdentity';

const { loading, archiveView } = useArchiveView();
const router = useRouter();
const spaNavigation = usePublicSpaNavigationMode;

useHumanReadProof({
    scope: computed(() => 'site'),
    routeKey: computed(() => buildPublicArchiveRouteKey()),
    enabled: computed(() => !loading.value)
});

function handleNavigate(href: string): void
{
    void router.push(href);
}
</script>

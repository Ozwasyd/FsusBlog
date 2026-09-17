<template>
    <PublicAboutPageContent
        :view="staticPageView"
        :loading="loading"
        :error="error"
        @retry="fetchData"
    >
        <template #body>
            <MarkdownRenderer
                :content="rawMarkdown"
                mode="about"
            />
        </template>
    </PublicAboutPageContent>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import PublicAboutPageContent from '@/components/public/pages/PublicAboutPageContent.vue';
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue';
import { useHumanReadProof } from '@/composables/useHumanReadProof';
import { useStaticPage, type StaticPublicPageKind } from '@/composables/useStaticPage';
import {
    buildPublicAboutRouteKey,
    buildPublicCopyrightRouteKey,
    buildPublicGuidelinesRouteKey,
    buildPublicPrivacyRouteKey
} from '@/public-renderers/publicRouteIdentity';

const props = defineProps<{
    pageKind: StaticPublicPageKind;
    slug: string;
    title: string;
}>();

const { staticPageView, rawMarkdown, loading, error, fetchData } = useStaticPage({
    kind: props.pageKind,
    slug: props.slug,
    title: props.title
});

const routeKey = computed(() =>
{
    switch (props.pageKind)
    {
        case 'Privacy':
            return buildPublicPrivacyRouteKey();
        case 'Guidelines':
            return buildPublicGuidelinesRouteKey();
        case 'Copyright':
            return buildPublicCopyrightRouteKey();
        case 'About':
        default:
            return buildPublicAboutRouteKey();
    }
});

useHumanReadProof({
    scope: computed(() => 'site'),
    routeKey,
    enabled: computed(() => !loading.value && !error.value)
});
</script>

<style scoped>
@reference "@/assets/main.css";
</style>

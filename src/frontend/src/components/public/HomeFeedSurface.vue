<template>
    <div
        id="fsus-home-feed-layout"
        class="blog-page-shell flex flex-col lg:flex-row gap-10 lg:gap-16 xl:gap-20"
    >
        <div
            id="fsus-home-main-column"
            data-readable-region
            :class="hasAside ? 'w-full max-w-[760px] grow lg:max-w-none lg:w-2/3' : 'mx-auto w-full max-w-[760px]'"
        >
            <slot name="main" />
        </div>

        <aside
            v-if="hasAside"
            id="fsus-home-hot-articles-slot"
            class="hidden lg:block lg:w-80 shrink-0 space-y-10 xl:space-y-12 pt-8 lg:pt-0"
            aria-label="快速入口"
        >
            <slot name="aside" />
        </aside>
    </div>
</template>

<script setup lang="ts">
import { computed, useSlots } from 'vue';

const props = withDefaults(defineProps<{
    showAside?: boolean;
}>(), {
    showAside: true
});

const slots = useSlots();
const hasAside = computed(() => props.showAside && Boolean(slots.aside));
</script>

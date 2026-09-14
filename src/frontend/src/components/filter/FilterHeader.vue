<template>
    <header class="mb-6">
        <p class="mb-3 text-xs font-medium normal-case text-[var(--fsusblog-text-muted)]">
            {{ view.labelText }}
        </p>
        <ElSkeleton
            v-if="view.loadingMeta"
            class="fsusblog-skeleton-surface"
        >
            <template #template>
                <div class="w-32 h-8">
                    <ElSkeletonItem variant="h1" />
                </div>
            </template>
        </ElSkeleton>
        <template v-else>
            <h1 class="text-2xl font-bold leading-tight tracking-normal text-[var(--fsusblog-text-primary)] sm:text-3xl">
                {{ view.currentName }}
            </h1>
            <p
                v-if="normalizedDescription"
                class="mt-4 text-sm font-normal leading-6 text-[var(--fsusblog-text-muted)]"
            >
                {{ normalizedDescription }}
            </p>
        </template>
    </header>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { FilterHeaderViewContract } from '@/view-contracts/filterView';

const props = defineProps<{
    view: FilterHeaderViewContract;
}>();

const normalizedDescription = computed(() =>
{
    const raw = props.view.description;
    if (typeof raw !== 'string')
    {
        return '';
    }
    return raw.trim();
});
</script>

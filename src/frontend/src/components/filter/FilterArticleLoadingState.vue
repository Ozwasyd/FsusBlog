<template>
    <template v-if="view.loadingArticles || view.isPowCalculating">
        <ElSkeleton
            v-for="i in view.skeletonCount"
            :key="i"
            class="fsusblog-skeleton-surface"
        >
            <template #template>
                <div
                    class="flex flex-col gap-6"
                    aria-hidden="true"
                >
                    <div class="flex gap-5">
                        <div class="w-24">
                            <ElSkeletonItem variant="text" />
                        </div>
                        <div class="w-16">
                            <ElSkeletonItem variant="text" />
                        </div>
                    </div>
                    <div class="w-3/4">
                        <ElSkeletonItem variant="h3" />
                    </div>
                    <div class="space-y-2.5 mt-1">
                        <ElSkeletonItem variant="text" />
                        <div class="w-5/6">
                            <ElSkeletonItem variant="text" />
                        </div>
                    </div>
                </div>
            </template>
        </ElSkeleton>
        <p
            v-if="view.isPowCalculating"
            class="text-xs leading-4 tabular-nums text-[var(--fsusblog-text-muted)] normal-case"
        >
            {{ view.indicatorText }}
        </p>
    </template>
</template>

<script setup lang="ts">
import type { FilterLoadingStateViewContract } from '@/view-contracts/filterView';

defineProps<{
    view: FilterLoadingStateViewContract;
}>();
</script>

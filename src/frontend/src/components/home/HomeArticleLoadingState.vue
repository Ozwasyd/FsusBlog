<template>
    <div
        class="mb-4 flex justify-end"
        role="status"
        aria-live="polite"
        :aria-label="copy.feedLoadingLabel"
    >
        <span
            :class="publicPeriodMotif.loading.className"
            aria-hidden="true"
        ></span>
    </div>
    <ElSkeleton
        v-for="i in 3"
        :key="i"
        class="fsusblog-skeleton-surface"
    >
        <template #template>
            <div
                class="flex flex-col gap-6"
                aria-hidden="true"
            >
                <div class="w-32 mb-2">
                    <ElSkeletonItem variant="text" />
                </div>
                <div class="w-3/4">
                    <ElSkeletonItem variant="h3" />
                </div>
                <div class="space-y-3 mt-2">
                    <ElSkeletonItem variant="text" />
                    <div class="w-5/6">
                        <ElSkeletonItem variant="text" />
                    </div>
                </div>
            </div>
        </template>
    </ElSkeleton>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18nText } from '@/composables/useI18nText';
import { publicPeriodMotif } from '@/ui-contracts/publicPeriodMotif';

const { messages } = useI18nText();
const copy = computed(() => messages.value.layout.recommendations);
</script>

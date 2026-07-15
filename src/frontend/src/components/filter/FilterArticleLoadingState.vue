<template>
  <template v-if="view.loadingArticles || view.isPowCalculating">
    <el-skeleton
      v-for="i in view.skeletonCount"
      :key="i"
      class="fsusblog-skeleton-surface"
    >
      <template #template>
        <div class="flex flex-col gap-6" aria-hidden="true">
          <div class="flex gap-5">
            <div class="w-24">
              <el-skeleton-item variant="text" />
            </div>
            <div class="w-16">
              <el-skeleton-item variant="text" />
            </div>
          </div>
          <div class="w-3/4">
            <el-skeleton-item variant="h3" />
          </div>
          <div class="space-y-2.5 mt-1">
            <el-skeleton-item variant="text" />
            <div class="w-5/6">
              <el-skeleton-item variant="text" />
            </div>
          </div>
        </div>
      </template>
    </el-skeleton>
    <p v-if="view.isPowCalculating" class="text-xs leading-4 tabular-nums text-[var(--fsusblog-text-muted)] normal-case">
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

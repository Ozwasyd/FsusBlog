<template>
  <template v-if="view.loadingArticles || view.isPowCalculating">
    <div v-for="i in view.skeletonCount" :key="i" class="flex flex-col gap-6" aria-hidden="true">
      <div class="flex gap-5">
        <div class="h-3 bg-[#FCFCFC] w-24"></div>
        <div class="h-3 bg-[#FCFCFC] w-16"></div>
      </div>
      <div class="h-8 bg-[#FCFCFC] w-3/4 rounded-[var(--fsus-radius-sm)]" :class="{ 'animate-pulse bg-[#F4F4F5]': view.isPowCalculating }"></div>
      <div class="space-y-2.5 mt-1">
        <div class="h-4 bg-[#FCFCFC] w-full"></div>
        <div class="h-4 bg-[#FCFCFC] w-5/6"></div>
      </div>
    </div>
    <p v-if="view.isPowCalculating" class="text-[9px] font-mono text-[#A1A1AA] uppercase animate-pulse">
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

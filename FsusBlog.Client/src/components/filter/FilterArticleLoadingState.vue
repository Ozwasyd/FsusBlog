<template>
  <template v-if="view.loadingArticles || view.isPowCalculating">
    <div v-for="i in view.skeletonCount" :key="i" class="flex flex-col gap-4" aria-hidden="true">
      <div class="flex gap-3">
        <div class="h-3 bg-zinc-50 w-24"></div>
        <div class="h-3 bg-zinc-50 w-16"></div>
      </div>
      <div class="h-8 bg-zinc-50 w-3/4 rounded-sm" :class="{ 'animate-pulse bg-zinc-100': view.isPowCalculating }"></div>
      <div class="space-y-2.5 mt-1">
        <div class="h-4 bg-zinc-50 w-full"></div>
        <div class="h-4 bg-zinc-50 w-5/6"></div>
      </div>
    </div>
    <p v-if="view.isPowCalculating" class="text-[9px] font-mono text-zinc-400 uppercase tracking-widest text-center animate-pulse">
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

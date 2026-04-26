<template>
  <header class="mb-12 sm:mb-20 select-none">
    <p class="text-[10px] font-bold text-[#A1A1AA] uppercase mb-6 animate-in fade-in duration-700">
      {{ view.labelText }}
    </p>
    <h1 class="text-3xl sm:text-4xl font-bold text-[#0F0F11] animate-in fade-in slide-in-from-bottom-3 duration-1000">
      <span v-if="view.loadingMeta" class="inline-block w-32 h-8 bg-[#F4F4F5] animate-pulse rounded-[var(--fsus-radius-sm)]"></span>
      <span v-else>{{ view.currentName }}</span>
    </h1>
  </header>
</template>

<script setup lang="ts">
import type { FilterHeaderViewContract } from '@/view-contracts/filterView';

defineProps<{
  view: FilterHeaderViewContract;
}>();
</script>

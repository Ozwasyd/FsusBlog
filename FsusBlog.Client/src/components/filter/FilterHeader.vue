<template>
  <header class="mb-12 sm:mb-20 select-none">
    <p class="text-[10px] font-bold tracking-[0.3em] text-zinc-400 uppercase mb-4 animate-in fade-in duration-700">
      {{ view.labelText }}
    </p>
    <h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-950 animate-in fade-in slide-in-from-bottom-3 duration-1000">
      <span v-if="view.loadingMeta" class="inline-block w-32 h-8 bg-zinc-100 animate-pulse rounded-sm"></span>
      <template v-else>
        {{ view.currentName }}
      </template>
    </h1>
  </header>
</template>

<script setup lang="ts">
import type { FilterHeaderViewContract } from '@/view-contracts/filterView';

defineProps<{
  view: FilterHeaderViewContract;
}>();
</script>

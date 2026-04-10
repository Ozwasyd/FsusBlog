<template>
  <div class="py-32 text-center animate-in fade-in zoom-in-95 duration-1000">
    <p class="text-[10px] font-mono tracking-[0.4em] uppercase text-zinc-300 mb-8">
      {{ view.title }}
    </p>
    <router-link :to="view.actionRoute" class="text-[10px] font-bold tracking-widest uppercase py-3 px-6 border border-zinc-100 hover:bg-zinc-950 hover:text-white transition-all">
      {{ view.actionText }}
    </router-link>
  </div>
</template>

<script setup lang="ts">
import type { FilterEmptyStateViewContract } from '@/view-contracts/filterView';

defineProps<{
  view: FilterEmptyStateViewContract;
}>();
</script>

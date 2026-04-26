<template>
  <div class="py-24 sm:py-32 animate-in fade-in zoom-in-95 duration-1000">
    <p class="text-[10px] font-mono uppercase text-[#D4D4D8] mb-8">
      {{ view.title }}
    </p>
    <router-link :to="view.actionRoute" class="rounded-[8px] text-[10px] font-bold uppercase py-3 px-6 border border-[#F4F4F5] hover:border-[#2A599C] hover:text-[#2A599C] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">
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

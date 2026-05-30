<template>
  <header class="mb-12 sm:mb-20 select-none">
    <p class="text-[10px] font-bold text-[var(--fsusblog-text-muted)] normal-case mb-6 animate-in fade-in duration-[var(--fsus-motion-control-fast)]">
      {{ view.labelText }}
    </p>
    <el-skeleton v-if="view.loadingMeta" animated>
      <template #template>
        <div class="w-32 h-8">
          <el-skeleton-item variant="h1" />
        </div>
      </template>
    </el-skeleton>
    <h1 v-else class="text-3xl sm:text-4xl font-bold text-[var(--fsusblog-text-primary)] animate-in fade-in slide-in-from-bottom-3 duration-[var(--fsus-motion-control-fast)]">
      {{ view.currentName }}
    </h1>
  </header>
</template>

<script setup lang="ts">
import type { FilterHeaderViewContract } from '@/view-contracts/filterView';

defineProps<{
  view: FilterHeaderViewContract;
}>();
</script>

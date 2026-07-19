<template>
  <header class="mb-8 sm:mb-12">
    <p class="mb-3 text-xs font-medium normal-case text-[var(--fsusblog-text-muted)]">
      {{ view.labelText }}
    </p>
    <el-skeleton
      v-if="view.loadingMeta"
      class="fsusblog-skeleton-surface"
    >
      <template #template>
        <div class="w-32 h-8">
          <el-skeleton-item variant="h1" />
        </div>
      </template>
    </el-skeleton>
    <h1 v-else class="text-3xl font-bold text-[var(--fsusblog-text-primary)] sm:text-4xl">
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

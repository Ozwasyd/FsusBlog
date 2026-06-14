<template>
  <div class="grid grid-cols-1 gap-3 border-y border-[var(--fsusblog-panel-border)] py-3 md:grid-cols-2 lg:grid-cols-4 mb-10">
    <div v-for="item in view.statCards" :key="item.label" class="bg-[var(--fsusblog-page-bg)] p-6">
      <div class="flex flex-col h-full">
        <div class="flex items-center justify-between mb-5">
          <span class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
            {{ item.label }}
          </span>
          <span class="text-[var(--fsusblog-text-subtle)]" aria-hidden="true">
            <el-icon size="18">
              <component :is="iconMap[item.iconName]" />
            </el-icon>
          </span>
        </div>

        <div class="flex items-baseline gap-2">
          <span class="text-2xl font-bold tracking-normal text-[var(--fsusblog-text-primary)] tabular-nums" data-visual-dynamic>
            {{ item.value }}
          </span>
        </div>

        <p class="mt-4 max-w-[180px] text-xs leading-relaxed text-[var(--fsusblog-text-tertiary)]">
          {{ item.description }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ChatDotRound, Delete, Document, View } from '@/fsusui/icons'
import type { AdminDashboardViewContract } from '@/view-contracts/adminStats';

const iconMap = {
  document: Document,
  comments: ChatDotRound,
  views: View,
  trash: Delete
} as const;

defineProps<{
  view: AdminDashboardViewContract;
}>();
</script>

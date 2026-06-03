<template>
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-px bg-[var(--fsusblog-panel-bg-soft)] border-y border-[var(--fsusblog-panel-border)] mb-10">
    <div v-for="item in view.statCards" :key="item.label" class="bg-[var(--fsusblog-page-bg)] p-8 transition-colors hover:bg-[var(--fsusblog-panel-bg)] group">
      <div class="flex flex-col h-full">
        <div class="flex items-center justify-between mb-6">
          <span class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)] group-hover:text-[var(--fsusblog-color-primary)] transition-colors">
            {{ item.label }}
          </span>
          <span class="text-[var(--fsusblog-text-subtle)] group-hover:text-[var(--fsusblog-color-primary)] transition-colors" aria-hidden="true">
            <el-icon size="18">
              <component :is="iconMap[item.iconName]" />
            </el-icon>
          </span>
        </div>

        <div class="flex items-baseline gap-2">
          <span class="text-5xl font-bold tracking-normal text-[var(--fsusblog-text-primary)] tabular-nums" data-visual-dynamic>
            {{ item.value }}
          </span>
        </div>

        <p class="mt-4 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)] max-w-[180px]">
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

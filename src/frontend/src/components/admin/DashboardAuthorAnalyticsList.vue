<template>
  <section class="bg-[var(--fsusblog-page-bg)] p-8 min-h-72">
    <h3 class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ title }}</h3>
    <p v-if="items.length === 0" class="mt-8 text-[11px] text-[var(--fsusblog-text-tertiary)]">
      {{ emptyText }}
    </p>
    <ol v-else class="mt-6 space-y-4">
      <li
        v-for="(item, index) in items"
        :key="item.label"
        class="flex items-center justify-between gap-4 border-b border-[var(--fsusblog-panel-border)] pb-3 last:border-b-0"
      >
        <span class="min-w-0 truncate text-xs font-bold text-[var(--fsusblog-text-secondary)]">
          {{ index + 1 }}. {{ item.label }}
        </span>
        <span class="shrink-0 text-xs font-bold tabular-nums text-[var(--fsusblog-text-muted)]">
          {{ item.count }}
        </span>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import type { AuthorAnalyticsListItem } from '@/view-contracts/adminStats'

defineProps<{
  title: string
  emptyText: string
  items: readonly AuthorAnalyticsListItem[]
}>()
</script>
<template>
  <nav class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-label="审核系统栏目">
    <div class="flex gap-px overflow-x-auto bg-[var(--fsusblog-panel-bg-soft)]">
      <RouterLink
        v-for="item in items"
        :key="item.name"
        :to="{ name: item.name }"
        class="min-w-max bg-[var(--fsusblog-page-bg)] px-4 py-3 text-[12px] font-bold text-[var(--fsusblog-text-muted)] transition hover:text-[var(--fsusblog-text-primary)]"
        :class="route.name === item.name ? 'text-[var(--fsusblog-text-primary)] shadow-[inset_0_-2px_0_var(--el-color-primary)]' : ''"
      >
        {{ item.label }}
      </RouterLink>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'

const route = useRoute()

const items = [
  { label: '总览', name: 'ManageModerationDashboard' },
  { label: '评论审核', name: 'ManageModerationComments' },
  { label: '词库管理', name: 'ManageModerationDictionaries' },
  { label: '地区策略', name: 'ManageModerationPolicies' },
  { label: '策略回放', name: 'ManageModerationReplay' },
  { label: '审核模型', name: 'ManageModerationModel' },
  { label: '审核审计', name: 'ManageModerationAudit' }
] as const
</script>

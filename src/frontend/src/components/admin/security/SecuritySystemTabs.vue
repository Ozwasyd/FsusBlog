<template>
  <nav class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-label="安全系统栏目">
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
  { label: '安全总览', name: 'ManageSecurityDashboard' },
  { label: 'RiskControl', name: 'ManageSecurityRiskControl' },
  { label: '模拟器', name: 'ManageSecuritySimulator' },
  { label: '挑战状态', name: 'ManageSecurityChallenges' },
  { label: '策略版本', name: 'ManageSecurityPolicies' },
  { label: '风险事件', name: 'ManageSecurityEvents' },
  { label: 'Captcha', name: 'ManageSecurityCaptcha' },
  { label: 'PoSpace', name: 'ManageSecurityPoSpace' },
  { label: 'Perception V2', name: 'ManageSecurityPerceptionV2' },
  { label: '反爬虫系统', name: 'ManageSecurityCrawler' },
  { label: 'PoW 系统', name: 'ManageSecurityPow' }
] as const
</script>

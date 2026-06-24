<template>
  <div class="account-page security-system-page account-motion-enter w-full">
    <FsusUiPageHeader
      title="安全系统"
      content="反爬虫、PoW challenge 与统一安全风险信号在同一安全系统下并列治理。"
      class="account-page-header--compact"
    />

    <section class="admin-muted-alert admin-muted-alert--info mb-8 px-5 py-4 text-[12px] leading-6">
      <strong class="text-[var(--fsusblog-text-primary)]">PoW 不是反爬虫子配置。</strong>
      <span class="ml-2">反爬虫只产生 crawler 类风险信号；PoW 独立提供安全 challenge，并读取统一风险分。</span>
    </section>

    <AdminSystemTabs
      class="mb-8"
      :items="securitySystemTabs"
      aria-label="安全系统栏目"
    />
    <RouterView />
  </div>
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router'
import { FsusUiPageHeader } from "@/fsusui"
import AdminSystemTabs, { type AdminSystemTab } from '@/components/admin/AdminSystemTabs.vue'

const securitySystemTabs = [
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
] as const satisfies readonly AdminSystemTab[]
</script>

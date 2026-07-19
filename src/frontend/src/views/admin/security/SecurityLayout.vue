<template>
  <div class="account-page security-system-page account-motion-enter w-full">
    <FsusUiTaskPageHeader
      title="安全系统"
      description="反爬虫、PoW 验证任务与统一安全风险信号在同一安全系统下并列治理。"
      class="account-task-page-header"
      density="compact"
    />

    <section class="admin-muted-alert admin-muted-alert--info mb-8 px-5 py-4 text-[12px] leading-6">
      <strong class="text-[var(--fsusblog-text-primary)]">PoW 不是反爬虫子配置。</strong>
      <span class="ml-2">反爬虫只产生爬虫类风险信号；PoW 独立提供安全验证任务，并读取统一风险分。</span>
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
import { FsusUiTaskPageHeader } from "@/fsusui"
import AdminSystemTabs, { type AdminSystemTab } from '@/components/admin/AdminSystemTabs.vue'

const securitySystemTabs = [
  { label: '安全总览', name: 'ManageSecurityDashboard' },
  { label: '风险控制', name: 'ManageSecurityRiskControl' },
  { label: '风险模拟器', name: 'ManageSecuritySimulator' },
  { label: '验证任务', name: 'ManageSecurityChallenges' },
  { label: '策略版本', name: 'ManageSecurityPolicies' },
  { label: '风险事件', name: 'ManageSecurityEvents' },
  { label: 'Captcha', name: 'ManageSecurityCaptcha' },
  { label: 'PoSpace', name: 'ManageSecurityPoSpace' },
  { label: '人机感知验证', name: 'ManageSecurityPerceptionV2' },
  { label: '反爬虫系统', name: 'ManageSecurityCrawler' },
  { label: 'PoW 系统', name: 'ManageSecurityPow' }
] as const satisfies readonly AdminSystemTab[]
</script>

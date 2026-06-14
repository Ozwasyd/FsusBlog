<template>
  <div class="account-page security-system-page account-motion-enter w-full">
    <AccountPageHeader
      title="安全系统"
      description="反爬虫、PoW challenge 与统一安全风险信号在同一安全系统下并列治理。"
      compact
    />

    <section class="mb-8 border-l-4 border-[var(--el-color-primary)] bg-[var(--fsusblog-page-bg)] px-5 py-4 text-[12px] leading-6 text-[var(--fsusblog-text-secondary)]">
      <strong class="text-[var(--fsusblog-text-primary)]">PoW 不是反爬虫子配置。</strong>
      <span class="ml-2">反爬虫只产生 crawler 类风险信号；PoW 独立提供安全 challenge，并读取统一风险分。</span>
    </section>

    <SecuritySystemTabs class="mb-8" />
    <RouterView />
  </div>
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import SecuritySystemTabs from '@/components/admin/security/SecuritySystemTabs.vue'
</script>

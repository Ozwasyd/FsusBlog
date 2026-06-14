<template>
  <div class="account-page moderation-system-page account-motion-enter w-full">
    <AccountPageHeader
      title="审核系统"
      description="评论队列、词库资产、地区策略、回放预览、模型信号与审计证据集中治理。"
      compact
    />

    <section class="mb-8 border-l-4 border-[var(--el-color-warning)] bg-[var(--fsusblog-page-bg)] px-5 py-4 text-[12px] leading-6 text-[var(--fsusblog-text-secondary)]">
      <strong class="text-[var(--fsusblog-text-primary)]">地区法律策略优先级高于反垃圾模型。</strong>
      <span class="ml-2">模型输出只作为风险信号；最终动作来自地区策略、硬词库和管理员审核。</span>
    </section>

    <ModerationSystemTabs class="mb-8" />
    <RouterView />
  </div>
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import ModerationSystemTabs from '@/components/admin/moderation/ModerationSystemTabs.vue'
</script>

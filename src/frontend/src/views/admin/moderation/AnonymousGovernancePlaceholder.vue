<template>
  <div class="admin-data-surface anonymous-governance-placeholder">
    <AccountPageHeader
      :title="section.title"
      :description="section.description"
    />

    <WorkbenchPanel
      title="治理入口"
      :caption="section.caption"
      title-level="2"
    >
      <div class="anonymous-governance-placeholder__body">
        <p>{{ section.body }}</p>
        <ul>
          <li v-for="item in section.items" :key="item">{{ item }}</li>
        </ul>
      </div>
    </WorkbenchPanel>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'

const route = useRoute()

const sections = {
  ManageAnonymousCommentPolicy: {
    title: '匿名评论策略',
    description: '配置匿名评论、公开发送和 ZK 匿名能力的运行策略。',
    caption: '需要 anonymous.comment.configure 权限。',
    body: '该占位入口会连接匿名评论策略读取与更新 API，并保留 MFA step-up。',
    items: ['匿名评论开关', '公开发送开关', '默认作者模式', '展示语言 allowlist']
  },
  ManageAnonymousRisk: {
    title: '匿名风险',
    description: '查看匿名评论主体、声誉桶和审核风险信号。',
    caption: '不提供真实账号反查。',
    body: '该占位入口会聚合 moderation subject hash、credential level 与 account-age bucket。',
    items: ['主体风险摘要', '声誉与账号年龄桶', '最近审核命中']
  },
  ManageAnonymousCredentials: {
    title: '匿名凭证',
    description: '查看 credential 状态并执行撤销操作。',
    caption: '需要 anonymous.credential.revoke 权限。',
    body: '该占位入口会接入匿名 credential 列表和 revoke 操作。',
    items: ['credential 状态', 'credential level', '撤销记录']
  },
  ManageAnonymousNullifiers: {
    title: 'Nullifier 治理',
    description: '按 scope 内 hash 封禁匿名评论 nullifier。',
    caption: '需要 anonymous.nullifier.block 权限。',
    body: '该占位入口会接入 nullifier block API，不暴露 nullifier 原文或账号身份。',
    items: ['scope 选择', 'nullifier hash', '封禁原因', '最近使用评论']
  },
  ManageZkAnonymousStatus: {
    title: 'ZK 匿名状态',
    description: '查看 ZK anonymous verifier 与策略配置状态。',
    caption: '需要 anonymous.comment.configure 权限。',
    body: '该占位入口会展示 verifier、public inputs 和 fail-closed 状态。',
    items: ['verifier 配置', 'public inputs', 'ZK policy snapshot']
  }
} as const

type GovernanceSectionKey = keyof typeof sections

const section = computed(() => {
  const key = typeof route.name === 'string' && route.name in sections
    ? route.name as GovernanceSectionKey
    : 'ManageAnonymousCommentPolicy'
  return sections[key]
})
</script>

<style scoped>
.anonymous-governance-placeholder__body {
  display: grid;
  gap: 1rem;
  color: var(--fsusblog-text-secondary);
  font-size: 0.875rem;
  line-height: 1.7;
}

.anonymous-governance-placeholder__body ul {
  display: grid;
  gap: 0.5rem;
  padding-left: 1rem;
  color: var(--fsusblog-text-muted);
  list-style: disc;
}
</style>

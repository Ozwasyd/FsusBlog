<template>
  <div class="account-page identity-center-placeholder">
    <FsusUiPageHeader
      :title="section.title"
      :content="section.description"
    />

    <FsusUiSettingsSection
      title="当前阶段"
      :description="section.caption"
      :title-tag="'h2'"
    >
      <div class="identity-center-placeholder__body">
        <p>{{ section.body }}</p>
        <ul>
          <li v-for="item in section.items" :key="item">{{ item }}</li>
        </ul>
      </div>
    </FsusUiSettingsSection>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { FsusUiPageHeader } from "@/fsusui"
import { FsusUiSettingsSection } from '@/fsusui'

const route = useRoute()

const sections = {
  UserIdentityOverview: {
    title: '身份总览',
    description: '汇总登录方式、恢复路径、公开身份与匿名评论状态。',
    caption: '后续会接入账户快照与匿名身份策略。',
    body: '该入口先固定路由和导航结构，让身份中心可以逐步迁移现有个人资料页能力。',
    items: ['通行密钥状态', 'Recovery Key 状态', '匿名身份与公开资料', '设备会话摘要']
  },
  UserIdentityPasskeys: {
    title: '通行密钥',
    description: '管理用于登录的 Passkey 设备。',
    caption: '复用现有个人资料页的 Passkey 能力。',
    body: '后续实现会把设备列表、重命名和删除保护迁移到这里。',
    items: ['已注册设备', '设备重命名', '最后一枚 Passkey 删除保护']
  },
  UserIdentityRecoveryKey: {
    title: 'Recovery Key',
    description: '管理匿名账号恢复凭据。',
    caption: '独立于 TOTP MFA recovery code。',
    body: '后续实现会提供创建、轮换和一次性展示 Recovery Key 的流程。',
    items: ['创建 Recovery Key', '轮换恢复凭据', '恢复会话绑定新 Passkey']
  },
  UserIdentityAnonymous: {
    title: '匿名身份',
    description: '查看匿名评论作者模式、scope 与展示语言偏好。',
    caption: '不暴露真实账号身份。',
    body: '该页后续会连接 CommentPolicySnapshot 和匿名 credential 状态。',
    items: ['默认匿名模式', '匿名展示名语言', 'credential level 与声誉桶']
  },
  UserIdentityPublicProfile: {
    title: '公开资料',
    description: '管理公开发送评论时展示的身份信息。',
    caption: 'public author mode 必须显式 opt-in。',
    body: '后续实现会集中维护 public handle、公开展示说明和发送确认。',
    items: ['公开 handle', '公开发送确认', '评论作者投影预览']
  },
  UserIdentitySessions: {
    title: '设备会话',
    description: '查看并撤销当前账号的活跃设备会话。',
    caption: '沿用现有 session 管理语义。',
    body: '后续实现会把当前资料页中的会话列表迁移为独立入口。',
    items: ['当前设备', '其他活跃会话', '撤销其他设备']
  },
  UserIdentityMfa: {
    title: '二次验证',
    description: '管理 TOTP step-up 和恢复码。',
    caption: 'TOTP 是敏感操作 step-up，不是匿名账号恢复路径。',
    body: '后续实现会保留现有 MFA 启用、关闭和 recovery code 轮换能力。',
    items: ['启用二次验证', '关闭二次验证', '重新生成 MFA recovery codes']
  }
} as const

type IdentitySectionKey = keyof typeof sections

const section = computed(() => {
  const key = typeof route.name === 'string' && route.name in sections
    ? route.name as IdentitySectionKey
    : 'UserIdentityOverview'
  return sections[key]
})
</script>

<style scoped>
.identity-center-placeholder__body {
  display: grid;
  gap: 1rem;
  color: var(--fsusblog-text-secondary);
  font-size: 0.875rem;
  line-height: 1.7;
}

.identity-center-placeholder__body ul {
  display: grid;
  gap: 0.5rem;
  padding-left: 1rem;
  color: var(--fsusblog-text-muted);
  list-style: disc;
}
</style>

<template>
  <div class="admin-data-surface anonymous-governance-placeholder">
    <AccountPageHeader
      :title="section.title"
      :description="section.description"
    />

    <WorkbenchPanel
      title="运行状态"
      :caption="section.caption"
      :title-level="2"
    >
      <div class="anonymous-governance-status-grid">
        <div v-for="signal in policySignals" :key="signal.label" class="anonymous-governance-signal">
          <span>{{ signal.label }}</span>
          <strong>{{ signal.value }}</strong>
          <p>{{ signal.helper }}</p>
        </div>
      </div>
    </WorkbenchPanel>

    <WorkbenchPanel
      title="匿名评论策略"
      caption="需要 anonymous.comment.configure 权限；公开-only 模式只开放具名发送，不开放匿名主体。"
      :title-level="2"
    >
      <div class="anonymous-governance-controls">
        <label class="anonymous-governance-control">
          <span>
            <strong>匿名评论</strong>
            <small>控制匿名作者模式是否可用于评论提交。</small>
          </span>
          <el-switch
            :model-value="anonymousCommentsEnabled"
            :disabled="!canConfigureAnonymousPolicy"
            active-text="启用"
            inactive-text="关闭"
            aria-label="匿名评论开关"
            @change="(value: string | number | boolean) => updatePolicy('anonymousCommentsEnabled', value)"
          />
        </label>
        <label class="anonymous-governance-control">
          <span>
            <strong>仅公开发送</strong>
            <small>匿名关闭但公开发送开启时进入 public-only 保护。</small>
          </span>
          <el-switch
            :model-value="publicSendOptionEnabled"
            :disabled="!canConfigureAnonymousPolicy"
            active-text="允许"
            inactive-text="禁止"
            aria-label="公开发送开关"
            @change="(value: string | number | boolean) => updatePolicy('publicSendOptionEnabled', value)"
          />
        </label>
        <label class="anonymous-governance-control">
          <span>
            <strong>ZK 匿名</strong>
            <small>只影响匿名评论证明能力，不表示 ZK 登录。</small>
          </span>
          <el-switch
            :model-value="zkAnonymousEnabled"
            :disabled="!canConfigureAnonymousPolicy || !zkAnonymousConfigurable"
            active-text="可用"
            inactive-text="未启用"
            aria-label="ZK 匿名开关"
            @change="(value: string | number | boolean) => updatePolicy('zkAnonymousEnabled', value)"
          />
        </label>
      </div>
    </WorkbenchPanel>

    <WorkbenchPanel
      title="匿名风险概览"
      caption="展示 author mode、语言、scope、credential、声誉桶、账号年龄桶和风险标签；不提供从 nullifier 到账号的常规反查入口。"
      :title-level="2"
    >
      <div class="blog-scroll-x-safe anonymous-governance-table-scroll">
        <el-table :data="riskRows" row-key="subject" class="anonymous-governance-table">
          <el-table-column label="主体" min-width="190">
            <template #default="{ row }: { row: AnonymousRiskRow }">
              <div class="anonymous-governance-subject">
                <strong>{{ row.displayName }}</strong>
                <span>{{ row.subject }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="匿名信号" min-width="260">
            <template #default="{ row }: { row: AnonymousRiskRow }">
              <div class="anonymous-governance-tags">
                <el-tag size="small" type="info">{{ row.authorMode }}</el-tag>
                <el-tag size="small" type="info">{{ row.displayLanguage }}</el-tag>
                <el-tag size="small" type="info">{{ row.scope }}</el-tag>
                <el-tag size="small" type="info">{{ row.credential }}</el-tag>
                <el-tag size="small" type="info">{{ row.reputation }}</el-tag>
                <el-tag size="small" type="info">{{ row.accountAge }}</el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="风险标签" min-width="180">
            <template #default="{ row }: { row: AnonymousRiskRow }">
              <div class="anonymous-governance-tags">
                <el-tag v-for="label in row.riskLabels" :key="label" size="small" type="warning">
                  {{ label }}
                </el-tag>
              </div>
            </template>
          </el-table-column>
          <template #empty>
            <AdminInlineEmptyState title="暂无匿名风险主体" description="匿名评论进入审核队列后会在这里汇总主体信号。" />
          </template>
        </el-table>
      </div>
    </WorkbenchPanel>

    <WorkbenchPanel
      title="Nullifier 治理"
      caption="scope 内 hash 可被封禁；界面只展示治理状态，不暴露原文或账号身份。"
      :title-level="2"
    >
      <div class="blog-scroll-x-safe anonymous-governance-table-scroll">
        <el-table :data="nullifierRows" row-key="hash" class="anonymous-governance-table">
          <el-table-column prop="scope" label="scope" min-width="160" />
          <el-table-column prop="hash" label="Nullifier" min-width="220" />
          <el-table-column prop="status" label="状态" min-width="120" />
          <el-table-column label="操作" width="170" align="right">
            <template #default="{ row }: { row: AnonymousNullifierRow }">
              <el-button
                type="danger"
                plain
                size="small"
                :disabled="!canBlockAnonymousNullifier"
                @click="previewNullifierBlock(row)"
              >
                封禁 Nullifier
              </el-button>
            </template>
          </el-table-column>
          <template #empty>
            <AdminInlineEmptyState title="暂无 Nullifier 记录" description="命中封禁或观察状态的匿名 nullifier 会显示在这里。" />
          </template>
        </el-table>
      </div>
    </WorkbenchPanel>

    <WorkbenchPanel
      title="匿名凭证"
      caption="credential 状态和撤销动作独立于普通账号资料；需要 anonymous.credential.revoke 权限。"
      :title-level="2"
    >
      <div class="blog-scroll-x-safe anonymous-governance-table-scroll">
        <el-table :data="credentialRows" row-key="id" class="anonymous-governance-table">
          <el-table-column prop="id" label="credential" min-width="180" />
          <el-table-column prop="level" label="level" min-width="120" />
          <el-table-column prop="status" label="状态" min-width="120" />
          <el-table-column prop="revocation" label="撤销状态" min-width="150" />
          <el-table-column label="操作" width="170" align="right">
            <template #default="{ row }: { row: AnonymousCredentialRow }">
              <el-button
                type="danger"
                plain
                size="small"
                :disabled="!canRevokeAnonymousCredential"
                @click="previewCredentialRevoke(row)"
              >
                撤销匿名凭证
              </el-button>
            </template>
          </el-table-column>
          <template #empty>
            <AdminInlineEmptyState title="暂无匿名凭证" description="匿名凭证状态和撤销记录会显示在这里。" />
          </template>
        </el-table>
      </div>
    </WorkbenchPanel>

    <WorkbenchPanel
      title="ZK 匿名状态"
      caption="Verifier、public inputs 与 fail-closed 状态只服务匿名评论证明，不改变登录链路。"
      :title-level="2"
    >
      <div class="anonymous-governance-zk">
        <div v-for="item in zkStatusRows" :key="item.label" class="anonymous-governance-zk__row">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
          <p>{{ item.helper }}</p>
        </div>
      </div>
    </WorkbenchPanel>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import { AdminInlineEmptyState } from '@/components/admin/AdminCollectionPrimitives'
import { useAdminStore, type AnonymousCommentPolicySnapshot } from '@/store/admin'
import { showWarningToast } from '@/utils/errorPresentation'

const route = useRoute()
const adminStore = useAdminStore()

const sections = {
  ManageAnonymousCommentPolicy: {
    title: '匿名评论策略',
    description: '配置匿名评论、公开发送和 ZK 匿名能力的运行策略。',
    caption: '需要 anonymous.comment.configure 权限。'
  },
  ManageAnonymousRisk: {
    title: '匿名风险',
    description: '查看匿名评论主体、声誉桶和审核风险信号。',
    caption: '展示匿名信号，不提供真实账号反查。'
  },
  ManageAnonymousCredentials: {
    title: '匿名凭证',
    description: '查看 credential 状态并执行撤销操作。',
    caption: '需要 anonymous.credential.revoke 权限。'
  },
  ManageAnonymousNullifiers: {
    title: 'Nullifier 治理',
    description: '按 scope 内 hash 封禁匿名评论 nullifier。',
    caption: '需要 anonymous.nullifier.block 权限。'
  },
  ManageZkAnonymousStatus: {
    title: 'ZK 匿名状态',
    description: '查看 ZK anonymous verifier 与策略配置状态。',
    caption: '需要 anonymous.comment.configure 权限。'
  }
} as const

type GovernanceSectionKey = keyof typeof sections
type PolicyBooleanKey = Extract<keyof AnonymousCommentPolicySnapshot, 'anonymousCommentsEnabled' | 'publicSendOptionEnabled' | 'zkAnonymousEnabled'>

interface AnonymousRiskRow {
  subject: string
  displayName: string
  authorMode: string
  displayLanguage: string
  scope: string
  credential: string
  reputation: string
  accountAge: string
  riskLabels: string[]
}

interface AnonymousNullifierRow {
  scope: string
  hash: string
  status: string
}

interface AnonymousCredentialRow {
  id: string
  level: string
  status: string
  revocation: string
}

const section = computed(() => {
  const key = typeof route.name === 'string' && route.name in sections
    ? route.name as GovernanceSectionKey
    : 'ManageAnonymousCommentPolicy'
  return sections[key]
})

const anonymousCommentsEnabled = computed(() => adminStore.anonymousCommentsEnabled)
const publicSendOptionEnabled = computed(() => adminStore.publicSendOptionEnabled)
const zkAnonymousEnabled = computed(() => adminStore.zkAnonymousEnabled)
const zkAnonymousConfigurable = computed(() => adminStore.zkAnonymousConfigurable)
const publicOnlyMode = computed(() => adminStore.publicOnlyMode)
const canConfigureAnonymousPolicy = computed(() => adminStore.hasPermission('anonymous.comment.configure'))
const canBlockAnonymousNullifier = computed(() => adminStore.hasPermission('anonymous.nullifier.block'))
const canRevokeAnonymousCredential = computed(() => adminStore.hasPermission('anonymous.credential.revoke'))

const policySignals = computed(() => [
  {
    label: '匿名评论',
    value: anonymousCommentsEnabled.value ? '启用' : '关闭',
    helper: anonymousCommentsEnabled.value ? '匿名与强匿名主体可进入评论流。' : '匿名主体不会开放给评论提交。'
  },
  {
    label: '仅公开',
    value: publicOnlyMode.value ? '启用' : '关闭',
    helper: publicOnlyMode.value ? '匿名关闭时仍允许公开身份评论。' : '匿名策略按完整模式运行。'
  },
  {
    label: 'ZK 匿名',
    value: zkAnonymousEnabled.value ? '可用' : '未启用',
    helper: zkAnonymousConfigurable.value ? '配置入口可见，且仅用于匿名评论。' : '当前环境隐藏配置入口。'
  }
])

const riskRows: AnonymousRiskRow[] = [
  {
    subject: 'subject:article-comment',
    displayName: '强匿名评论者',
    authorMode: '强匿名',
    displayLanguage: 'zh-CN',
    scope: 'scope：article-comment',
    credential: 'credential：strong',
    reputation: '声誉桶：new',
    accountAge: '账号年龄桶：0-7d',
    riskLabels: ['link-heavy', 'new-scope']
  },
  {
    subject: 'subject:public-comment',
    displayName: 'Anonymous commenter',
    authorMode: '匿名',
    displayLanguage: 'en',
    scope: 'scope：public-comment',
    credential: 'credential：basic',
    reputation: '声誉桶：steady',
    accountAge: '账号年龄桶：30d+',
    riskLabels: ['manual-review']
  }
]

const nullifierRows: AnonymousNullifierRow[] = [
  { scope: 'article-comment', hash: 'nul_8d2f9c4a***', status: '观察中' },
  { scope: 'public-comment', hash: 'nul_42a91b7e***', status: '已封禁' }
]

const credentialRows: AnonymousCredentialRow[] = [
  { id: 'cred_strong_01', level: 'strong', status: 'active', revocation: '未撤销' },
  { id: 'cred_basic_04', level: 'basic', status: 'active', revocation: '待复核' }
]

const zkStatusRows = computed(() => [
  {
    label: 'Verifier',
    value: zkAnonymousEnabled.value ? '已启用' : '未启用',
    helper: '用于匿名评论证明校验，不参与登录认证。'
  },
  {
    label: 'public inputs',
    value: 'scope / nullifier / credential commitment',
    helper: '只展示证明所需字段，不展示账号身份。'
  },
  {
    label: 'fail-closed',
    value: zkAnonymousConfigurable.value ? '可配置' : '固定关闭',
    helper: '证明不可用时由策略决定是否拒绝强匿名提交。'
  }
])

const updatePolicy = (key: PolicyBooleanKey, value: string | number | boolean): void => {
  if (!canConfigureAnonymousPolicy.value) {
    showWarningToast('当前管理员没有匿名评论策略配置权限')
    return
  }

  adminStore.setAnonymousCommentPolicy({ [key]: Boolean(value) })
}

const previewNullifierBlock = (row: AnonymousNullifierRow): void => {
  if (!canBlockAnonymousNullifier.value) {
    showWarningToast('当前管理员没有封禁匿名 Nullifier 的权限')
    return
  }

  showWarningToast(`请在评论审核队列中选择真实匿名主体封禁 ${row.hash}；不会打开账号反查。`)
}

const previewCredentialRevoke = (row: AnonymousCredentialRow): void => {
  if (!canRevokeAnonymousCredential.value) {
    showWarningToast('当前管理员没有撤销匿名凭证的权限')
    return
  }

  showWarningToast(`请在评论审核队列中选择真实匿名主体撤销 credential ${row.id}；不会打开账号反查。`)
}
</script>

<style scoped>
.anonymous-governance-placeholder {
  display: grid;
  gap: 1.25rem;
  min-width: 0;
  max-width: 100%;
}

.anonymous-governance-placeholder > * {
  min-width: 0;
  max-width: 100%;
}

.anonymous-governance-status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
}

.anonymous-governance-signal,
.anonymous-governance-zk__row {
  display: grid;
  gap: 0.35rem;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-panel);
  padding: 0.875rem;
  background: var(--fsusblog-page-bg);
}

.anonymous-governance-signal span,
.anonymous-governance-zk__row span {
  color: var(--fsusblog-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
}

.anonymous-governance-signal strong,
.anonymous-governance-zk__row strong {
  color: var(--fsusblog-text-primary);
  font-size: 1rem;
}

.anonymous-governance-signal p,
.anonymous-governance-zk__row p {
  margin: 0;
  color: var(--fsusblog-text-secondary);
  font-size: 0.8125rem;
  line-height: 1.6;
}

.anonymous-governance-controls {
  display: grid;
  gap: 0.75rem;
}

.anonymous-governance-control {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  padding: 0.75rem 0;
}

.anonymous-governance-control:first-child {
  padding-top: 0;
}

.anonymous-governance-control:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}

.anonymous-governance-control span {
  display: grid;
  gap: 0.25rem;
}

.anonymous-governance-control strong,
.anonymous-governance-subject strong {
  color: var(--fsusblog-text-primary);
  font-size: 0.875rem;
}

.anonymous-governance-control small,
.anonymous-governance-subject span {
  color: var(--fsusblog-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.anonymous-governance-table {
  min-width: 640px;
  width: 100%;
}

.anonymous-governance-table-scroll {
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
}

.anonymous-governance-subject {
  display: grid;
  gap: 0.25rem;
}

.anonymous-governance-tags,
.anonymous-governance-zk {
  display: grid;
  gap: 0.5rem;
}

.anonymous-governance-tags {
  display: flex;
  flex-wrap: wrap;
}

@media (max-width: 767px) {
  .anonymous-governance-control {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>

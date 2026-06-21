<template>
  <div class="admin-data-surface anonymous-governance-page">
    <FsusUiPageHeader
      :title="section.title"
      :content="section.description"
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
        <el-table v-loading="loadingStatus" :data="riskRows" row-key="subject" class="anonymous-governance-table">
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
            <AdminInlineEmptyState title="暂无匿名风险主体" content="匿名评论进入审核队列后会在这里汇总主体信号。" />
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
        <el-table v-loading="loadingNullifiers" :data="nullifierRows" row-key="key" class="anonymous-governance-table">
          <el-table-column prop="scope" label="scope" min-width="160" />
          <el-table-column prop="maskedHash" label="Nullifier" min-width="220" />
          <el-table-column prop="status" label="状态" min-width="120" />
          <el-table-column label="操作" width="170" align="right">
            <template #default="{ row }: { row: AnonymousNullifierRow }">
              <el-button
                type="danger"
                plain
                size="small"
                :disabled="!canBlockAnonymousNullifier || row.status === 'blocked'"
                :loading="processingAction === row.key"
                @click="previewNullifierBlock(row)"
              >
                封禁 Nullifier
              </el-button>
            </template>
          </el-table-column>
          <template #empty>
            <AdminInlineEmptyState title="暂无 Nullifier 记录" content="命中封禁或观察状态的匿名 nullifier 会显示在这里。" />
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
        <el-table v-loading="loadingStatus" :data="credentialRows" row-key="id" class="anonymous-governance-table">
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
                :loading="processingAction === row.id"
                @click="previewCredentialRevoke(row)"
              >
                撤销匿名凭证
              </el-button>
            </template>
          </el-table-column>
          <template #empty>
            <AdminInlineEmptyState title="暂无匿名凭证" content="匿名凭证状态和撤销记录会显示在这里。" />
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
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { FsusUiPageHeader } from "@/fsusui"
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import { AdminInlineEmptyState } from '@/components/admin/AdminCollectionPrimitives'
import { useAdminStore, type AnonymousCommentPolicySnapshot } from '@/store/admin'
import {
  blockAnonymousGovernanceNullifier,
  getAnonymousGovernanceStatus,
  listAnonymousGovernanceNullifiers,
  revokeAnonymousGovernanceCredential,
  type AnonymousGovernanceStatusResponse
} from '@/api/anonymousGovernance'
import { useAdminSensitiveProof } from '@/composables/useAdminSensitiveProof'
import { isAppError } from '@/utils/appError'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { promptText, toast } from '@/fsusui/feedback'

const route = useRoute()
const adminStore = useAdminStore()
const { ensureAdminSensitiveProof } = useAdminSensitiveProof()

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
  key: string
  scope: string
  maskedHash: string
  governanceHash: string
  status: string
  useCount: number
}

interface AnonymousCredentialRow {
  id: string
  epoch: number
  rootHash: string
  revocationRootHash: string
  level: string
  status: string
  revocation: string
}

const governanceStatus = ref<AnonymousGovernanceStatusResponse | null>(null)
const nullifierRecords = ref<AnonymousNullifierRow[]>([])
const loadingStatus = ref(false)
const loadingNullifiers = ref(false)
const processingAction = ref<string | null>(null)

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
    label: 'Root epoch',
    value: governanceStatus.value?.root.credentialEpoch ? String(governanceStatus.value.root.credentialEpoch) : '未就绪',
    helper: governanceStatus.value?.root.maskedRootHash ? `root ${governanceStatus.value.root.maskedRootHash}` : '当前没有可用匿名 credential root。'
  },
  {
    label: 'ZK 匿名',
    value: governanceStatus.value?.verifier.configured ? '可用' : '未启用',
    helper: governanceStatus.value?.verifier.circuitStatus ?? (zkAnonymousConfigurable.value ? '配置入口可见，且仅用于匿名评论。' : '当前环境隐藏配置入口。')
  }
])

const riskRows = computed<AnonymousRiskRow[]>(() => {
  const stats = governanceStatus.value?.commentStats
  if (!stats) {
    return []
  }

  return [{
    subject: 'anonymous-comment-governance',
    displayName: '匿名评论主体',
    authorMode: `匿名 ${stats.totalAnonymous}`,
    displayLanguage: '按评论记录',
    scope: `待审 ${stats.pendingAnonymous}`,
    credential: `ZK ${stats.zkAnonymous}`,
    reputation: `通过 ${stats.approvedAnonymous}`,
    accountAge: `隐藏 ${stats.hiddenAnonymous}`,
    riskLabels: [
      `rejected:${stats.rejectedAnonymous}`,
      `pending:${stats.pendingAnonymous}`
    ]
  }]
})

const nullifierRows = computed(() => nullifierRecords.value)

const credentialRows = computed<AnonymousCredentialRow[]>(() =>
  (governanceStatus.value?.credentials ?? []).map(item => ({
    id: `epoch:${item.epoch}:${item.maskedRootHash}`,
    epoch: item.epoch,
    rootHash: item.rootHash,
    revocationRootHash: item.revocationRootHash,
    level: item.maskedRootHash,
    status: item.status,
    revocation: `${item.maskedRevocationRootHash} / ${item.revocationCount}`
  })))

const zkStatusRows = computed(() => [
  {
    label: 'Verifier',
    value: governanceStatus.value?.verifier.configured ? '已启用' : '未启用',
    helper: governanceStatus.value?.verifier.circuitStatus ?? '用于匿名评论证明校验，不参与登录认证。'
  },
  {
    label: 'root',
    value: governanceStatus.value?.root.maskedRootHash ?? '未就绪',
    helper: governanceStatus.value?.root.circuitId ?? '只展示公开 root 状态，不展示账号身份。'
  },
  {
    label: 'revocation',
    value: governanceStatus.value?.revocation.maskedRevocationRootHash ?? '未就绪',
    helper: governanceStatus.value?.revocation.latestRevokedAtUtc
      ? `最近撤销 ${formatDate(governanceStatus.value.revocation.latestRevokedAtUtc)}`
      : '尚无撤销记录。'
  }
])

const updatePolicy = (key: PolicyBooleanKey, value: string | number | boolean): void => {
  if (!canConfigureAnonymousPolicy.value) {
    showWarningToast('当前管理员没有匿名评论策略配置权限')
    return
  }

  adminStore.setAnonymousCommentPolicy({ [key]: Boolean(value) })
}

const loadGovernanceStatus = async (): Promise<void> => {
  if (!canConfigureAnonymousPolicy.value && !canRevokeAnonymousCredential.value) {
    return
  }

  loadingStatus.value = true
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    governanceStatus.value = await getAnonymousGovernanceStatus({ mfaProofToken })
  } catch (error) {
    showErrorToast(governanceErrorMessage(error, '匿名治理状态加载失败'), '匿名治理')
  } finally {
    loadingStatus.value = false
  }
}

const loadNullifiers = async (): Promise<void> => {
  if (!canBlockAnonymousNullifier.value) {
    nullifierRecords.value = []
    return
  }

  loadingNullifiers.value = true
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    const response = await listAnonymousGovernanceNullifiers({ mfaProofToken })
    nullifierRecords.value = response.items.map(item => ({
      key: `${item.scope}:${item.maskedHash}`,
      scope: item.scope,
      maskedHash: item.maskedHash,
      governanceHash: item.nullifierHash,
      status: item.status,
      useCount: item.useCount
    }))
  } catch (error) {
    showErrorToast(governanceErrorMessage(error, 'Nullifier 治理列表加载失败'), 'Nullifier 治理')
  } finally {
    loadingNullifiers.value = false
  }
}

const previewNullifierBlock = async (row: AnonymousNullifierRow): Promise<void> => {
  if (!canBlockAnonymousNullifier.value) {
    showWarningToast('当前管理员没有封禁匿名 Nullifier 的权限')
    return
  }

  const reason = await promptText('输入处理原因', '封禁匿名 Nullifier', {
    confirmButtonText: '封禁',
    inputPlaceholder: '说明封禁原因'
  })
  if (reason === null) {
    return
  }

  processingAction.value = row.key
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    const result = await blockAnonymousGovernanceNullifier({
      nullifierHash: row.governanceHash,
      scope: row.scope,
      reason
    }, { mfaProofToken })
    if (!result.applied) {
      throw new Error('ANONYMOUS_GOVERNANCE_NOT_APPLIED')
    }

    toast.success('匿名 Nullifier 已封禁')
    await loadNullifiers()
  } catch (error) {
    showErrorToast(governanceErrorMessage(error, '匿名 Nullifier 封禁失败'), 'Nullifier 治理')
  } finally {
    processingAction.value = null
  }
}

const previewCredentialRevoke = async (row: AnonymousCredentialRow): Promise<void> => {
  if (!canRevokeAnonymousCredential.value) {
    showWarningToast('当前管理员没有撤销匿名凭证的权限')
    return
  }

  const revocationHandleHash = await promptText('输入 revocation handle hash', '撤销匿名凭证资格', {
    confirmButtonText: '继续',
    inputPlaceholder: 'revocation handle hash'
  })
  if (revocationHandleHash === null) {
    return
  }

  const revocationRootHash = await promptText('输入更新后的 revocation root', '撤销匿名凭证资格', {
    confirmButtonText: '撤销',
    inputPlaceholder: 'revocation root hash'
  })
  if (revocationRootHash === null) {
    return
  }

  processingAction.value = row.id
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    const result = await revokeAnonymousGovernanceCredential({
      epoch: row.epoch,
      rootHash: row.rootHash,
      revocationHandleHash,
      revocationRootHash,
      reason: 'revoked_by_admin'
    }, { mfaProofToken })
    if (!result.applied) {
      throw new Error('ANONYMOUS_GOVERNANCE_NOT_APPLIED')
    }

    toast.success('匿名凭证资格已撤销')
    await loadGovernanceStatus()
  } catch (error) {
    showErrorToast(governanceErrorMessage(error, '匿名凭证撤销失败'), '匿名凭证')
  } finally {
    processingAction.value = null
  }
}

const governanceErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error) {
    if (error.message === 'MFA_PROOF_REQUIRED' || error.message === 'ADMIN_STEP_UP_CHALLENGE_REQUIRED') {
      return '管理员验证已过期，请重新完成二次验证'
    }
    if (error.message === 'ANONYMOUS_GOVERNANCE_NOT_APPLIED') {
      return '匿名治理动作未被应用，请刷新后重试'
    }
  }

  if (!isAppError(error)) {
    return fallback
  }

  if (error.status === 401) {
    return '登录状态已失效，请重新登录'
  }
  if (error.status === 403) {
    return '当前账号无权限执行匿名治理操作'
  }
  if (error.status === 428) {
    return '管理员验证已过期，请重新完成二次验证'
  }
  if (error.status === 404) {
    return '匿名治理对象不存在或已失效，请刷新'
  }
  if (error.status === 429) {
    return '匿名治理操作过于频繁，请稍后再试'
  }

  return error.message || fallback
}

const formatDate = (value: string | null | undefined): string => {
  if (!value) {
    return '未记录'
  }

  return new Date(value).toLocaleString('zh-CN')
}

onMounted(() => {
  void loadGovernanceStatus()
  void loadNullifiers()
})

watch(() => route.name, () => {
  void loadGovernanceStatus()
  void loadNullifiers()
})
</script>

<style scoped>
.anonymous-governance-page {
  display: grid;
  gap: 1.25rem;
  min-width: 0;
  max-width: 100%;
}

.anonymous-governance-page > * {
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

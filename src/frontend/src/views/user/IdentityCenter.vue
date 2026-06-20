<template>
  <div class="account-page identity-center">
    <AccountPageHeader
      :title="sectionMeta.title"
      :description="sectionMeta.description"
    />

    <template v-if="isSection('UserIdentityOverview')">
      <div class="identity-status-grid">
        <div class="identity-status-card">
          <span class="identity-status-label">Passkey</span>
          <strong>{{ identityAccountSnapshot.passkeyEnabled ? '已启用' : '未添加' }}</strong>
          <p>{{ passkeyCredentials.length }} 个登录设备</p>
        </div>
        <div class="identity-status-card">
          <span class="identity-status-label">Recovery Key</span>
          <strong>{{ identityAccountSnapshot.recoveryEnabled ? '本次已生成' : '需要创建' }}</strong>
          <p>账号恢复凭据，只在创建或轮换时显示一次。</p>
        </div>
        <div class="identity-status-card">
          <span class="identity-status-label">TOTP step-up</span>
          <strong>{{ identityAccountSnapshot.totpStepUpEnabled ? '已启用' : '未启用' }}</strong>
          <p>TOTP 是敏感操作 step-up，不是账号恢复方式。</p>
        </div>
        <div class="identity-status-card">
          <span class="identity-status-label">匿名评论</span>
          <strong>{{ identityAccountSnapshot.anonymousCredentialStatus }}</strong>
          <p>{{ identityAccountSnapshot.zkAnonymousAvailable ? 'ZK 可用' : 'ZK 尚未启用' }}</p>
        </div>
      </div>

      <WorkbenchPanel
        class="mt-8"
        title="身份工作区"
        caption="所有页面都在现有 AccountLayout 内渲染，并使用 workspace context 的功能和策略快照。"
        :title-level="2"
      >
        <div class="identity-summary-list">
          <p>账户编号：{{ identityAccountSnapshot.accountId || '未同步' }}</p>
          <p>公开称呼：{{ identityAccountSnapshot.publicHandle || '未设置，公开发送时可再填写' }}</p>
          <p>匿名评论策略：{{ identityAccountSnapshot.anonymousPolicyEnabled ? '允许匿名优先' : '当前关闭' }}</p>
          <p>公开发送选项：{{ identityAccountSnapshot.publicSendOptionEnabled ? '可显式 opt-in' : '当前不可用' }}</p>
        </div>
      </WorkbenchPanel>
    </template>

    <WorkbenchPanel
      v-else-if="isSection('UserIdentityPasskeys')"
      title="通行密钥设备"
      caption="Passkey 是匿名账号的主要登录方式；这里复用现有 Passkey client assets。"
      :title-level="2"
    >
      <div v-if="passkeyLoading" class="identity-loading-state">通行密钥加载中...</div>
      <div v-else-if="passkeyError" class="identity-error-state" role="alert">{{ passkeyError }}</div>

      <ProfileResourceList v-else-if="passkeyCredentials.length">
        <ProfileResourceListItem
          v-for="credential in passkeyCredentials"
          :key="credential.id"
        >
          <template #title>
            <div v-if="passkeyEditingId === credential.id" class="flex items-center gap-3">
              <div class="min-w-0 flex-1">
                <el-input
                  v-model="passkeyEditName"
                  maxlength="64"
                  clearable
                  aria-label="通行密钥名称"
                  @keyup.enter="savePasskeyName(credential.id)"
                  @keyup.esc="passkeyEditingId = null"
                />
              </div>
              <el-button link type="primary" @click="savePasskeyName(credential.id)">保存</el-button>
              <el-button link @click="passkeyEditingId = null">取消</el-button>
            </div>
            <div v-else class="flex items-center gap-3">
              <p class="truncate text-[14px] font-bold text-[var(--fsusblog-text-primary)]">
                {{ credential.deviceFriendlyName || '未命名通行密钥' }}
              </p>
              <el-button link @click="startEditPasskeyName(credential)">编辑</el-button>
            </div>
          </template>
          <template #meta>
            <span>创建：<SemanticTime :value="credential.createdAt" format="date" /></span>
            <span v-if="credential.lastUsedAt">活跃：<SemanticTime :value="credential.lastUsedAt" format="date" /></span>
            <span v-else>活跃：未记录</span>
            <span>{{ credential.backupEligible ? '支持同步备份' : '仅本设备' }}</span>
          </template>
          <template #actions>
              <el-button class="identity-touch-action" link type="danger" @click="confirmDeletePasskey(credential.id)">删除</el-button>
          </template>
        </ProfileResourceListItem>
      </ProfileResourceList>

      <ProfileInlineEmptyState
        v-else
        class="identity-empty-state"
        title="尚未添加通行密钥"
        description="添加后可使用设备生物识别或 PIN 登录。"
      >
        <template #actions>
          <el-button type="primary" @click="passkeyRegisterVisible = true">添加通行密钥</el-button>
        </template>
      </ProfileInlineEmptyState>

      <div v-if="passkeyCredentials.length" class="mt-6">
        <el-button type="primary" @click="passkeyRegisterVisible = true">添加通行密钥</el-button>
      </div>
    </WorkbenchPanel>

    <WorkbenchPanel
      v-else-if="isSection('UserIdentityRecoveryKey')"
      title="Recovery Key"
      caption="Recovery Key 是账号恢复凭据，不是 TOTP recovery code；Recovery Key 只显示一次。"
      :title-level="2"
    >
      <div class="identity-copy-block">
        <p>创建或轮换后请立即保存。若 Recovery Key 丢失且没有可用通行密钥，账号可能无法恢复。</p>
      </div>

      <div v-if="recoveryLoading" class="identity-loading-state">Recovery Key 操作处理中...</div>
      <div v-if="recoveryKeyError" class="identity-error-state" role="alert">{{ recoveryKeyError }}</div>

      <div v-if="recoveryKeyPlaintext" class="identity-secret-panel" aria-live="polite">
        <span class="identity-status-label">Recovery Key v{{ recoveryKeyVersion }}</span>
        <code>{{ recoveryKeyPlaintext }}</code>
        <p v-if="recoveryKeyCreatedAt">生成：{{ recoveryKeyCreatedAt }}</p>
        <el-checkbox v-model="recoveryKeySaved">我已保存 Recovery Key</el-checkbox>
        <el-button :disabled="!recoveryKeySaved" @click="clearRecoveryKeyPanel">关闭一次性展示</el-button>
      </div>

      <div v-else class="identity-empty-state">
        当前页面不会读取或保存 Recovery Key 明文；只能创建或轮换后一次性展示。
      </div>

      <div class="mt-6 flex flex-wrap gap-3">
        <el-button type="primary" :loading="recoveryLoading" @click="createRecoveryKeyForAccount">创建 Recovery Key</el-button>
        <el-button :loading="recoveryLoading" @click="rotateRecoveryKeyForAccount">轮换 Recovery Key</el-button>
      </div>
    </WorkbenchPanel>

    <WorkbenchPanel
      v-else-if="isSection('UserIdentityMfa')"
      title="TOTP step-up"
      caption="TOTP 是敏感操作 step-up，不是账号恢复方式；Recovery Key 才是账号恢复机制。"
      :title-level="2"
    >
      <div v-if="mfaLoading" class="identity-loading-state">二次验证状态加载中...</div>
      <div v-else-if="mfaError" class="identity-error-state" role="alert">{{ mfaError }}</div>
      <div v-else class="identity-state-row">
        <span>{{ mfaProfile?.enabled ? 'TOTP 已启用' : 'TOTP 未启用' }}</span>
        <span v-if="mfaProfile?.verifiedAt">最近验证：<SemanticTime :value="mfaProfile.verifiedAt" format="date" /></span>
        <span v-else>未记录最近验证时间</span>
      </div>
      <div class="mt-6 flex flex-wrap gap-3">
        <el-button
          v-if="!mfaProfile?.enabled"
          type="primary"
          :loading="mfaSetupLoading"
          @click="startMfaSetupFlow"
        >
          启用 TOTP step-up
        </el-button>
        <p v-else class="m-0 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">
          TOTP 用于敏感操作 step-up；账号恢复请使用 Recovery Key。
        </p>
      </div>
    </WorkbenchPanel>

    <WorkbenchPanel
      v-else-if="isSection('UserIdentityAnonymous')"
      title="匿名身份"
      caption="匿名评论身份来自 workspace context 的功能和策略快照，不依赖用户名或密码假设。"
      :title-level="2"
    >
      <div class="identity-status-grid">
        <div class="identity-status-card">
          <span class="identity-status-label">匿名评论</span>
          <strong>{{ workspaceFeatures.anonymousCommentsEnabled ? '已开放' : '已关闭' }}</strong>
          <p>默认评论作者模式会在评论发布页单独确认。</p>
        </div>
        <div class="identity-status-card">
          <span class="identity-status-label">治理策略</span>
          <strong>{{ workspacePolicies.anonymousCommentGovernanceAvailable ? '可治理' : '不可治理' }}</strong>
          <p>封禁与撤销由管理工作区处理。</p>
        </div>
        <div class="identity-status-card">
          <span class="identity-status-label">ZK 状态</span>
          <strong>{{ workspaceFeatures.zkAnonymousEnabled ? '可用' : '未启用' }}</strong>
          <p>{{ workspacePolicies.zkAnonymousConfigurable ? '配置入口可见' : '配置入口不可见' }}</p>
        </div>
      </div>
    </WorkbenchPanel>

    <WorkbenchPanel
      v-else-if="isSection('UserIdentityPublicProfile')"
      title="公开资料"
      caption="公开 handle 是可选项，只在你明确选择公开发送时使用。"
      :title-level="2"
    >
      <div class="space-y-5">
        <label for="public-handle-draft" class="block text-[12px] font-bold text-[var(--fsusblog-text-secondary)]">
          公开称呼草稿
        </label>
        <el-input
          id="public-handle-draft"
          v-model="publicHandleDraft"
          maxlength="20"
          placeholder="公开发送评论时可填写"
        />
        <div v-if="publicHandleError" class="identity-error-state" role="alert">{{ publicHandleError }}</div>
        <el-checkbox v-model="explicitPublicSendOptIn">
          我理解公开资料只会在显式公开发送时展示
        </el-checkbox>
        <div class="identity-state-row">
          <span>公开发送选项：{{ workspaceFeatures.publicSendOptionEnabled ? '可用' : '不可用' }}</span>
          <span>当前草稿：{{ publicHandleDraft.trim() || '未设置' }}</span>
        </div>
        <div class="flex flex-wrap gap-3">
          <el-button type="primary" :loading="publicHandleSaving" @click="savePublicHandle">保存公开称呼</el-button>
          <el-button :disabled="publicHandleSaving" @click="clearPublicHandle">清空公开称呼</el-button>
        </div>
      </div>
    </WorkbenchPanel>

    <WorkbenchPanel
      v-else-if="isSection('UserIdentitySessions')"
      title="设备会话"
      caption="查看当前账号的活跃会话，并下线不再使用的设备。"
      :title-level="2"
    >
      <div v-if="sessionLoading" class="identity-loading-state">设备会话加载中...</div>
      <div v-else-if="sessionError" class="identity-error-state" role="alert">{{ sessionError }}</div>

      <template v-else>
        <div class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p class="m-0 text-[12px] text-[var(--fsusblog-text-tertiary)]">当前共有 {{ sessions.length }} 个活跃会话</p>
          <el-button type="primary" plain :disabled="otherSessions.length === 0" @click="revokeOtherSessionDevices">
            下线其他设备
          </el-button>
        </div>

        <ProfileResourceList v-if="sessions.length">
          <ProfileResourceListItem
            v-for="session in sessions"
            :key="session.sessionId"
          >
            <template #title>
              <p class="truncate text-[14px] font-bold text-[var(--fsusblog-text-primary)]">
                {{ formatSessionDevice(session.deviceLabel, session.deviceFingerprint) }}
              </p>
            </template>
            <template #meta>
              <span>{{ session.isCurrent ? '当前设备' : '其他设备' }}</span>
              <span>IP：{{ formatSessionIp(session.lastIp) }}</span>
              <span v-if="session.lastSeenAt">活跃：<SemanticTime :value="session.lastSeenAt" format="date" /></span>
            </template>
            <template #actions>
              <el-button
                class="identity-touch-action"
                v-if="!session.isCurrent"
                link
                type="danger"
                @click="revokeSessionDevice(session.sessionId)"
              >
                下线
              </el-button>
            </template>
          </ProfileResourceListItem>
        </ProfileResourceList>

        <ProfileInlineEmptyState
          v-else
          class="identity-empty-state"
          title="暂无活跃会话"
          description="当前没有可展示的设备会话。"
        />
      </template>
    </WorkbenchPanel>

    <WorkbenchPanel
      v-else-if="isSection('UserIdentityCommentRecords')"
      title="评论记录"
      caption="这里只描述可归因评论记录的边界，实际列表沿用现有评论记录页。"
      :title-level="2"
    >
      <div class="identity-copy-block">
        <p>强匿名评论不会出现在按账号查询的评论记录中；只有选择可归因或公开发送的评论才会进入账号侧记录。</p>
        <p>管理端可以根据策略处理匿名评论，但这里不会暗示强匿名评论可由账号反查。</p>
      </div>
      <router-link class="identity-inline-link" to="/user/comments">
        查看可归因评论记录
      </router-link>
    </WorkbenchPanel>

    <PasskeyRegisterModal
      v-model:visible="passkeyRegisterVisible"
      @success="onPasskeyRegistered"
    />

    <MfaSetupModal
      v-model:visible="mfaSetupVisible"
      title="TOTP step-up 绑定"
      :loading="mfaSetupLoading"
      :secret="mfaSetupSecret"
      :otp-auth-url="mfaSetupOtpAuthUrl"
      :setup-code="mfaSetupCode"
      :recovery-codes="mfaSetupRecoveryCodes"
      :error-message="mfaSetupError"
      @update:setup-code="(value) => (mfaSetupCode = value)"
      @verify="completeMfaSetupFlow"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import MfaSetupModal from '@/components/ui/MfaSetupModal.vue'
import PasskeyRegisterModal from '@/components/ui/PasskeyRegisterModal.vue'
import SemanticTime from '@/components/ui/SemanticTime.vue'
import {
  ProfileInlineEmptyState,
  ProfileResourceList,
  ProfileResourceListItem
} from '@/components/user/ProfileSettingsPrimitives'
import {
  createRecoveryKey,
  getMfaProfile,
  listSessions,
  revokeOtherSessions as revokeOtherSessionsApi,
  revokeSession,
  rotateRecoveryKey,
  startMfaSetup,
  updatePublicHandle,
  verifyMfaSetup,
  type MfaProfile,
  type MfaSetupStart,
  type MfaSetupVerify,
  type PasskeyCredentialSummary,
  type UserSessionSummary
} from '@/api/auth'
import { usePasskeyManagement } from '@/composables/usePasskeyManagement'
import { useAccountWorkspaceContext } from '@/layouts/accountWorkspaceContext'
import { useUserStore } from '@/store/user'
import { confirmDanger, toast } from '@/fsusui/feedback'
import { toAppError } from '@/utils/appError'

const sectionMetaByRoute = {
  UserIdentityOverview: {
    title: '身份总览',
    description: '汇总登录方式、恢复路径、公开身份与匿名评论状态。'
  },
  UserIdentityPasskeys: {
    title: '通行密钥',
    description: '管理用于登录的 Passkey 设备。'
  },
  UserIdentityRecoveryKey: {
    title: 'Recovery Key',
    description: '创建或轮换匿名账号恢复凭据。'
  },
  UserIdentityAnonymous: {
    title: '匿名身份',
    description: '查看匿名评论作者模式、scope 与 ZK 可用状态。'
  },
  UserIdentityPublicProfile: {
    title: '公开资料',
    description: '管理公开发送评论时展示的身份信息。'
  },
  UserIdentitySessions: {
    title: '设备会话',
    description: '查看并撤销当前账号的活跃设备会话。'
  },
  UserIdentityMfa: {
    title: '二次验证',
    description: '管理 TOTP step-up 状态。'
  },
  UserIdentityCommentRecords: {
    title: '评论记录',
    description: '区分可归因评论记录与强匿名评论边界。'
  }
} as const

type IdentityRouteName = keyof typeof sectionMetaByRoute

const route = useRoute()
const userStore = useUserStore()
const workspaceContext = useAccountWorkspaceContext()

const {
  credentials: passkeyCredentials,
  loading: passkeyLoading,
  error: passkeyError,
  fetchPasskeys,
  removePasskey,
  renamePasskeyCredential
} = usePasskeyManagement()

const passkeyRegisterVisible = ref(false)
const passkeyEditingId = ref<number | null>(null)
const passkeyEditName = ref('')

const recoveryLoading = ref(false)
const recoveryKeyError = ref('')
const recoveryKeyPlaintext = ref('')
const recoveryKeyVersion = ref<number | null>(null)
const recoveryKeyCreatedAt = ref<string | null>(null)
const recoveryKeySaved = ref(false)
const recoveryKeyKnown = ref(false)

const mfaLoading = ref(false)
const mfaError = ref('')
const mfaProfile = ref<MfaProfile | null>(null)
const mfaSetupVisible = ref(false)
const mfaSetupLoading = ref(false)
const mfaSetupSecret = ref('')
const mfaSetupOtpAuthUrl = ref('')
const mfaSetupCode = ref('')
const mfaSetupRecoveryCodes = ref<string[]>([])
const mfaSetupError = ref('')

const sessionLoading = ref(false)
const sessionError = ref('')
const sessions = ref<UserSessionSummary[]>([])

const publicHandleDraft = ref('')
const publicHandleSaving = ref(false)
const publicHandleError = ref('')
const explicitPublicSendOptIn = ref(false)

const currentRouteName = computed<IdentityRouteName>(() => {
  const name = typeof route.name === 'string' ? route.name : ''
  return name in sectionMetaByRoute ? name as IdentityRouteName : 'UserIdentityOverview'
})

const sectionMeta = computed(() => sectionMetaByRoute[currentRouteName.value])
const isSection = (name: IdentityRouteName): boolean => currentRouteName.value === name

const workspaceFeatures = computed(() => workspaceContext.value.features)
const workspacePolicies = computed(() => workspaceContext.value.policies)
const currentSession = computed(() => sessions.value.find((session) => session.isCurrent) ?? null)
const otherSessions = computed(() => sessions.value.filter((session) => !session.isCurrent))

const identityAccountSnapshot = computed(() => {
  const features = workspaceFeatures.value
  const policies = workspacePolicies.value
  const user = userStore.userInfo

  return {
    accountId: user?.accountId ?? user?.id ?? 0,
    publicHandle: user?.publicHandle || '',
    passkeyEnabled: passkeyCredentials.value.length > 0,
    recoveryEnabled: recoveryKeyKnown.value || recoveryKeyPlaintext.value.length > 0,
    totpStepUpEnabled: mfaProfile.value?.enabled === true,
    anonymousPolicyEnabled: features.anonymousCommentsEnabled && policies.anonymousCommentGovernanceAvailable,
    anonymousCredentialStatus: features.anonymousCommentsEnabled ? '匿名评论可用' : '匿名评论关闭',
    zkAnonymousAvailable: features.zkAnonymousEnabled,
    publicSendOptionEnabled: features.publicSendOptionEnabled
  }
})

const refreshPasskeys = async (): Promise<void> => {
  await fetchPasskeys()
}

const refreshMfaProfile = async (): Promise<void> => {
  mfaLoading.value = true
  mfaError.value = ''
  try {
    mfaProfile.value = await getMfaProfile()
  } catch (error) {
    mfaError.value = toAppError(error, '二次验证状态加载失败').message || '二次验证状态加载失败'
  } finally {
    mfaLoading.value = false
  }
}

const startMfaSetupFlow = async (): Promise<void> => {
  mfaSetupVisible.value = true
  mfaSetupLoading.value = true
  mfaSetupSecret.value = ''
  mfaSetupOtpAuthUrl.value = ''
  mfaSetupCode.value = ''
  mfaSetupRecoveryCodes.value = []
  mfaSetupError.value = ''
  try {
    const response = await startMfaSetup() as MfaSetupStart
    mfaSetupSecret.value = response.secret
    mfaSetupOtpAuthUrl.value = response.otpAuthUrl
  } catch (error) {
    mfaSetupError.value = toAppError(error, 'TOTP step-up 初始化失败').message || 'TOTP step-up 初始化失败'
  } finally {
    mfaSetupLoading.value = false
  }
}

const completeMfaSetupFlow = async (): Promise<void> => {
  if (!mfaSetupCode.value.trim()) {
    return
  }

  mfaSetupLoading.value = true
  mfaSetupError.value = ''
  try {
    const response = await verifyMfaSetup(mfaSetupCode.value.trim()) as MfaSetupVerify
    mfaSetupRecoveryCodes.value = response.recoveryCodes
    await refreshMfaProfile()
    toast.success('TOTP step-up 已启用')
  } catch (error) {
    mfaSetupError.value = toAppError(error, 'TOTP step-up 验证失败').message || 'TOTP step-up 验证失败'
  } finally {
    mfaSetupLoading.value = false
  }
}

const refreshSessions = async (): Promise<void> => {
  sessionLoading.value = true
  sessionError.value = ''
  try {
    sessions.value = await listSessions()
  } catch (error) {
    sessionError.value = toAppError(error, '设备会话加载失败').message || '设备会话加载失败'
  } finally {
    sessionLoading.value = false
  }
}

const refreshIdentityData = async (): Promise<void> => {
  await Promise.all([
    refreshPasskeys(),
    refreshMfaProfile(),
    refreshSessions()
  ])
}

const startEditPasskeyName = (credential: PasskeyCredentialSummary): void => {
  passkeyEditingId.value = credential.id
  passkeyEditName.value = credential.deviceFriendlyName ?? ''
}

const savePasskeyName = async (id: number): Promise<void> => {
  if (!passkeyEditName.value.trim()) {
    return
  }

  await renamePasskeyCredential(id, passkeyEditName.value.trim())
  passkeyEditingId.value = null
}

const confirmDeletePasskey = async (id: number): Promise<void> => {
  const confirmed = await confirmDanger(
    '确认删除此通行密钥？删除后，该设备将不能继续使用此密钥登录。',
    '删除通行密钥',
    { confirmButtonText: '确认删除', cancelButtonText: '取消' }
  )
  if (!confirmed) {
    return
  }

  await removePasskey(id)
}

const onPasskeyRegistered = async (): Promise<void> => {
  passkeyRegisterVisible.value = false
  await fetchPasskeys()
}

const setRecoveryKeyResponse = (response: { recoveryKey: string; keyVersion: number; createdAt: string }): void => {
  recoveryKeyPlaintext.value = response.recoveryKey
  recoveryKeyVersion.value = response.keyVersion
  recoveryKeyCreatedAt.value = response.createdAt
  recoveryKeySaved.value = false
  recoveryKeyKnown.value = true
}

const issueRecoveryKey = async (mode: 'create' | 'rotate'): Promise<void> => {
  recoveryLoading.value = true
  recoveryKeyError.value = ''
  try {
    const response = mode === 'create'
      ? await createRecoveryKey()
      : await rotateRecoveryKey()
    setRecoveryKeyResponse(response)
    toast.success(mode === 'create' ? 'Recovery Key 已创建' : 'Recovery Key 已轮换')
  } catch (error) {
    recoveryKeyError.value = toAppError(error, 'Recovery Key 操作失败').message || 'Recovery Key 操作失败'
  } finally {
    recoveryLoading.value = false
  }
}

const createRecoveryKeyForAccount = async (): Promise<void> => {
  await issueRecoveryKey('create')
}

const rotateRecoveryKeyForAccount = async (): Promise<void> => {
  const confirmed = await confirmDanger(
    '轮换后旧 Recovery Key 将失效。确认继续？',
    '轮换 Recovery Key',
    { confirmButtonText: '确认轮换', cancelButtonText: '取消' }
  )
  if (!confirmed) {
    return
  }

  await issueRecoveryKey('rotate')
}

const clearRecoveryKeyPanel = (): void => {
  recoveryKeyPlaintext.value = ''
  recoveryKeySaved.value = false
}

const savePublicHandle = async (): Promise<void> => {
  publicHandleSaving.value = true
  publicHandleError.value = ''
  const nextPublicHandle = publicHandleDraft.value.trim()
  try {
    await updatePublicHandle({ publicHandle: nextPublicHandle || null })
    await userStore.fetchUserInfo(true)
    publicHandleDraft.value = userStore.userInfo?.publicHandle ?? ''
    toast.success(nextPublicHandle ? '公开称呼已保存' : '公开称呼已清空')
  } catch (error) {
    publicHandleError.value = toAppError(error, '公开称呼保存失败').message || '公开称呼保存失败'
  } finally {
    publicHandleSaving.value = false
  }
}

const clearPublicHandle = async (): Promise<void> => {
  publicHandleDraft.value = ''
  await savePublicHandle()
}

const revokeSessionDevice = async (sessionId: string): Promise<void> => {
  await revokeSession(sessionId)
  toast.success('设备会话已下线')
  await refreshSessions()
}

const revokeOtherSessionDevices = async (): Promise<void> => {
  if (otherSessions.value.length === 0) {
    return
  }

  await revokeOtherSessionsApi()
  toast.success('其他设备已下线')
  await refreshSessions()
}

const formatSessionIp = (value: string | null | undefined): string => value?.trim() || '未记录 IP'
const formatSessionDevice = (label: string | null | undefined, fingerprint: string | null | undefined): string =>
  label?.trim() || fingerprint?.trim() || '未记录设备信息'

onMounted(() => {
  void refreshIdentityData()
})

watch(
  () => userStore.userInfo?.publicHandle,
  (publicHandle) => {
    if (!publicHandleSaving.value) {
      publicHandleDraft.value = publicHandle ?? ''
    }
  },
  { immediate: true }
)

watch(currentRouteName, () => {
  if (currentSession.value === null || isSection('UserIdentityOverview')) {
    void refreshIdentityData()
  }
})
</script>

<style scoped>
@reference "@/assets/main.css";

.identity-center {
  display: grid;
  gap: 2rem;
}

.identity-status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 1rem;
}

.identity-status-card {
  min-width: 0;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-panel);
  background: var(--fsusblog-panel-bg-soft);
  padding: 1rem;
}

.identity-status-card strong {
  display: block;
  margin-top: 0.35rem;
  color: var(--fsusblog-text-primary);
  font-size: 0.95rem;
}

.identity-status-card p,
.identity-summary-list p,
.identity-copy-block p {
  margin: 0.35rem 0 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.78rem;
  line-height: 1.65;
}

.identity-status-label {
  display: block;
  color: var(--fsusblog-text-muted);
  font-size: 0.68rem;
  font-weight: 700;
}

.identity-summary-list,
.identity-state-row {
  display: grid;
  gap: 0.65rem;
  color: var(--fsusblog-text-secondary);
  font-size: 0.85rem;
}

.identity-loading-state,
.identity-empty-state,
.identity-error-state {
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-control);
  padding: 0.9rem 1rem;
  color: var(--fsusblog-text-secondary);
  font-size: 0.82rem;
  line-height: 1.65;
}

.identity-error-state {
  border-color: var(--fsusblog-color-error-border);
  background: var(--fsusblog-color-error-bg);
  color: var(--fsusblog-color-error);
  font-weight: 700;
}

.identity-secret-panel {
  display: grid;
  gap: 0.85rem;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-panel);
  background: var(--fsusblog-panel-bg-soft);
  padding: 1rem;
}

.identity-secret-panel code {
  overflow-wrap: anywhere;
  color: var(--fsusblog-text-primary);
  font-family: var(--fsus-font-mono);
  font-size: 0.88rem;
  line-height: 1.7;
}

.identity-inline-link {
  display: inline-flex;
  margin-top: 1rem;
  color: var(--fsusblog-color-primary);
  font-size: 0.85rem;
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 0.25rem;
}

.identity-touch-action {
  min-width: 44px;
  min-height: 36px;
  justify-content: center;
  padding-inline: 0.75rem;
}
</style>

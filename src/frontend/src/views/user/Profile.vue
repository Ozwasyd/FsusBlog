<template>
  <div class="account-page profile-page">
    <AccountPageHeader
      title="个人资料"
      description="更新账号信息、登录凭据与设备会话。"
    />

    <ProfileSectionNav :items="profileSections" aria-label="个人资料分区" />

    <div class="space-y-12">
      <ProfileSettingsSection
        id="profile-account"
        title="账号信息"
        description="更新用户名与公开身份标识，不改变既有账户权限。"
      >
        <el-form ref="usernameFormRef" :model="usernameForm" :rules="rules" label-position="top" @submit.prevent>
          <el-form-item label="用户名" prop="newUsername">
            <el-input
              v-model="usernameForm.newUsername"
              name="profileUsername"
              :disabled="isUsernameSubmitDisabled"
              placeholder="输入新用户名"
              aria-label="输入新用户名"
            />
          </el-form-item>
          <div
            v-if="showUsernameSubmitButton"
            class="mt-8"
          >
            <el-button
              :disabled="loadingName"
              :loading="loadingName"
              @click.prevent="requestUpdateUsername"
            >
              {{ usernameSubmitText }}
            </el-button>
          </div>
            <p
            v-else
            role="status"
            class="mt-8 rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-panel-border)] px-5 py-4 text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-muted)]"
          >
            {{ usernameBannedText }}
          </p>
        </el-form>
      </ProfileSettingsSection>

      <ProfileSettingsSection
        id="profile-security"
        title="安全验证"
        description="修改密码并管理二次验证。"
      >
        <div class="grid gap-10 lg:grid-cols-2">
          <el-form ref="passwordFormRef" :model="passwordForm" :rules="rules" label-position="top" @submit.prevent>
            <el-form-item label="当前密码" prop="oldPassword">
              <el-input
                v-model="passwordForm.oldPassword"
                name="profileOldPassword"
                type="password"
                show-password
                autocomplete="current-password"
                :disabled="isPasswordSubmitDisabled"
                placeholder="当前密码"
                aria-label="当前密码"
              />
            </el-form-item>

            <el-form-item label="新密码" prop="newPassword">
              <el-input
                v-model="passwordForm.newPassword"
                name="profileNewPassword"
                type="password"
                show-password
                autocomplete="new-password"
                :disabled="isPasswordSubmitDisabled"
                placeholder="新密码"
                aria-label="新密码"
              />
            </el-form-item>

            <el-form-item label="确认新密码" prop="confirmPassword">
              <el-input
                v-model="passwordForm.confirmPassword"
                name="profileConfirmPassword"
                type="password"
                show-password
                autocomplete="new-password"
                :disabled="isPasswordSubmitDisabled"
                placeholder="确认新密码"
                aria-label="确认新密码"
              />
            </el-form-item>

            <div
              v-if="showPasswordSubmitButton"
              class="mt-8"
            >
              <el-button
                type="primary"
                :disabled="isPasswordSubmitDisabled"
                :loading="isPasswordProcessing"
                @click.prevent="requestUpdatePassword"
              >
                {{ passwordSubmitText }}
              </el-button>
            </div>
            <p
              v-else
              role="status"
              class="mt-8 rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-panel-border)] px-5 py-4 text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-muted)]"
            >
              {{ passwordBannedText }}
            </p>
          </el-form>

          <div class="profile-security-card">
            <div>
              <h3>二次验证</h3>
              <p>
                状态：
                <span class="font-bold text-[var(--fsusblog-text-primary)]">{{ mfaProfile.loading ? '加载中...' : (mfaProfile.enabled ? '已启用' : '未启用') }}</span>
                <span v-if="mfaProfile.verifiedAt" class="ml-2 text-[var(--fsusblog-text-muted)]">
                  最近验证：<SemanticTime :value="mfaProfile.verifiedAt" />
                </span>
              </p>
            </div>
            <div class="mt-6 flex flex-wrap gap-3">
              <el-button
                v-if="!mfaProfile.enabled"
                type="primary"
                @click="startMfaSetupFlow"
              >
                启用二次验证
              </el-button>
              <el-button
                v-else
                @click="openDisableMfaModal"
              >
                关闭二次验证
              </el-button>
              <el-button
                v-if="mfaProfile.enabled"
                @click="openRegenerateRecoveryCodesModal"
              >
                重新生成恢复码
              </el-button>
            </div>
          </div>
        </div>
      </ProfileSettingsSection>

      <ProfileSettingsSection
        id="profile-passkeys"
        title="登录方式"
        description="管理通行密钥，使用设备生物识别或 PIN 登录。"
      >
        <div v-if="passkeyState.loading && !passkeyState.credentials.length" class="py-4 text-[12px] text-[var(--fsusblog-text-muted)]">
          加载中...
        </div>

        <ProfileResourceList v-else-if="passkeyState.credentials.length" class="mb-6">
          <ProfileResourceListItem
            v-for="cred in passkeyState.credentials"
            :key="cred.id"
          >
            <template #title>
              <div v-if="passkeyEditingId === cred.id" class="flex items-center gap-4">
                <div class="min-w-0 flex-1">
                  <el-input
                    v-model="passkeyEditName"
                    maxlength="64"
                    clearable
                    aria-label="通行密钥名称"
                    @keyup.enter="savePasskeyName(cred.id)"
                    @keyup.esc="passkeyEditingId = null"
                  />
                </div>
                <el-button class="profile-touch-action" link type="primary" @click="savePasskeyName(cred.id)">保存</el-button>
                <el-button class="profile-touch-action" link @click="passkeyEditingId = null">取消</el-button>
              </div>
              <div v-else class="flex items-center gap-3">
                <p class="truncate text-[14px] font-bold text-[var(--fsusblog-text-primary)]">
                  {{ cred.deviceFriendlyName || '未命名通行密钥' }}
                </p>
                <el-button class="profile-touch-action" link @click="startEditPasskeyName(cred)">编辑</el-button>
              </div>
            </template>
            <template #meta>
              <span>创建：<SemanticTime :value="cred.createdAt" format="date" /></span>
              <span v-if="cred.lastUsedAt">活跃：<SemanticTime :value="cred.lastUsedAt" format="date" /></span>
              <span v-else>活跃：未记录</span>
              <span v-if="cred.backupEligible" class="inline-flex items-center gap-1 text-[var(--fsusblog-color-success)]">
                <Cloudy class="h-3 w-3" aria-hidden="true" />
                已同步
              </span>
            </template>
            <template #actions>
              <el-button
                class="profile-touch-action"
                link
                type="danger"
                @click="confirmDeletePasskey(cred.id)"
              >
                删除
              </el-button>
            </template>
          </ProfileResourceListItem>
        </ProfileResourceList>
        <ProfileInlineEmptyState
          v-else
          title="尚未添加通行密钥"
          description="添加后可使用设备生物识别或 PIN 登录。"
        >
          <template #actions>
            <el-button
              type="primary"
              :disabled="passkeyState.loading"
              @click="passkeyRegisterVisible = true"
            >
              添加通行密钥
            </el-button>
          </template>
        </ProfileInlineEmptyState>

        <el-button
          v-if="passkeyState.credentials.length > 0 && passkeyState.credentials.length < 5"
          type="primary"
          :disabled="passkeyState.loading"
          @click="passkeyRegisterVisible = true"
        >
          添加通行密钥
        </el-button>
      </ProfileSettingsSection>

      <ProfileSettingsSection
        id="profile-sessions"
        title="登录设备"
        description="查看当前会话，并下线不再使用的其他设备。"
      >
      <div class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p class="m-0 text-[12px] text-[var(--fsusblog-text-tertiary)]">当前共有 {{ sessionState.list.length }} 个活跃会话</p>
        <el-button
          type="primary"
          plain
          :disabled="otherSessions.length === 0"
          @click="revokeOtherSessionDevices"
        >
          下线其他设备
        </el-button>
      </div>

      <ProfileResourceList v-if="sessionState.list.length">
        <ProfileResourceListItem
          v-if="currentSession"
          :key="currentSession.sessionId"
        >
          <template #title>
            <div class="flex items-center gap-3">
              <p class="truncate text-[14px] font-bold text-[var(--fsusblog-text-primary)]">
                {{ formatSessionIp(currentSession.lastIp) }}
              </p>
              <el-tag size="small">当前设备</el-tag>
            </div>
          </template>
          <template #meta>
            <span>{{ formatSessionDevice(currentSession.deviceLabel, currentSession.deviceFingerprint) }}</span>
            <span>最后活跃：<SemanticTime v-if="currentSession.lastSeenAt" :value="currentSession.lastSeenAt" /><span v-else>未记录</span></span>
          </template>
        </ProfileResourceListItem>

        <ProfileResourceListItem
          v-for="session in otherSessions"
          :key="session.sessionId"
        >
          <template #title>
            <p class="truncate text-[14px] font-bold text-[var(--fsusblog-text-primary)]">
              {{ formatSessionIp(session.lastIp) }}
            </p>
          </template>
          <template #meta>
            <span>{{ formatSessionDevice(session.deviceLabel, session.deviceFingerprint) }}</span>
            <span>最后活跃：<SemanticTime v-if="session.lastSeenAt" :value="session.lastSeenAt" /><span v-else>未记录</span></span>
          </template>
          <template #actions>
            <el-button
              class="profile-touch-action"
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
        v-if="sessionState.list.length > 0 && otherSessions.length === 0"
        title="暂无其他设备会话"
        description="当前只有本设备保持登录。"
      />
      </ProfileSettingsSection>

      <ProfileSettingsSection
        id="profile-danger"
        title="危险操作"
        description="注销账号前请确认影响范围。"
        danger
      >
      <div class="profile-danger-panel">
        <div>
          <strong>注销账户</strong>
          <p>
            注销后将退出所有设备，账号身份会匿名化处理，且不能恢复。确认文本固定为
            <span class="tabular-nums font-bold text-[var(--fsusblog-text-primary)] bg-[var(--fsusblog-page-bg-soft)] px-1.5 py-0.5 rounded-[var(--fsus-radius-control-small)]">{{ deleteConfirmText }}</span>。
          </p>
        </div>
        <div>
          <el-button type="danger" @click="openDeleteAccountDialog">
            注销账户
          </el-button>
        </div>
      </div>
      </ProfileSettingsSection>
    </div>

    <MfaChallengeModal
      v-model:visible="mfaPrompt.visible"
      :loading="mfaPrompt.loading"
      :error-message="mfaPrompt.errorMessage"
      description="请输入二次验证应用中的 6 位验证码，或使用恢复码完成高风险操作校验。"
      @confirm="submitMfaPrompt"
      @cancel="closeMfaPrompt(null)"
    />

    <MfaSetupModal
      v-model:visible="mfaSetupState.visible"
      :title="mfaSetupState.secret ? '二次验证绑定' : '恢复码'"
      :loading="mfaSetupState.loading"
      :secret="mfaSetupState.secret"
      :otp-auth-url="mfaSetupState.otpAuthUrl"
      :setup-code="mfaSetupState.setupCode"
      :recovery-codes="mfaSetupState.recoveryCodes"
      :error-message="mfaSetupState.errorMessage"
      @update:setup-code="(value) => (mfaSetupState.setupCode = value)"
      @verify="completeMfaSetupFlow"
    />

    <MfaCredentialModal
      v-model:visible="mfaCredentialState.visible"
      :loading="mfaCredentialState.loading"
      :title="mfaCredentialTitle"
      :description="mfaCredentialDescription"
      :error-message="mfaCredentialState.errorMessage"
      @confirm="submitMfaCredential"
      @cancel="closeMfaCredentialModal"
    />

    <PasskeyRegisterModal
      v-model:visible="passkeyRegisterVisible"
      :needs-mfa="mfaProfile.enabled"
      @success="onPasskeyRegistered"
    />

    <el-dialog
      v-model="deleteAccountState.visible"
      title="注销账户"
      width="460px"
      destroy-on-close
    >
      <div class="space-y-4">
        <p class="text-sm leading-7 text-[var(--fsusblog-text-muted)]">
          注销后，账户会立即失效，评论与历史内容会被保留但身份将匿名化。此操作不可撤销。
        </p>
        <p class="rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] px-4 py-3 text-xs font-medium tracking-normal text-[var(--fsusblog-text-secondary)]">
          确认文本必须为 <span class="font-semibold text-[var(--fsusblog-text-primary)]">{{ deleteConfirmText }}</span>
        </p>
        <label for="delete-account-password" class="sr-only">当前密码</label>
        <el-input
          id="delete-account-password"
          v-model="deleteAccountState.form.password"
          name="deleteAccountPassword"
          type="password"
          show-password
          autocomplete="current-password"
          aria-label="当前密码"
          placeholder="当前密码"
        />
        <label for="delete-account-confirm-text" class="sr-only">注销确认文本</label>
        <el-input
          id="delete-account-confirm-text"
          v-model="deleteAccountState.form.confirmText"
          name="deleteAccountConfirmText"
          aria-label="注销确认文本"
          :placeholder="`输入 ${deleteConfirmText} 确认`"
        />
        <label v-if="mfaProfile.enabled" for="delete-account-mfa-code" class="sr-only">二次验证码</label>
        <el-input
          v-if="mfaProfile.enabled"
          id="delete-account-mfa-code"
          v-model="deleteAccountState.form.code"
          name="deleteAccountMfaCode"
          autocomplete="one-time-code"
          inputmode="numeric"
          aria-label="二次验证码"
          placeholder="6 位验证码"
        />
        <label v-if="mfaProfile.enabled" for="delete-account-recovery-code" class="sr-only">恢复码</label>
        <el-input
          v-if="mfaProfile.enabled"
          id="delete-account-recovery-code"
          v-model="deleteAccountState.form.recoveryCode"
          name="deleteAccountRecoveryCode"
          autocomplete="one-time-code"
          aria-label="恢复码"
          placeholder="恢复码（可选）"
        />
      </div>

      <template #footer>
        <div class="flex justify-end gap-5">
          <el-button @click="deleteAccountState.visible = false" :disabled="deleteAccountState.loading">取消</el-button>
          <el-button type="danger" :loading="deleteAccountState.loading" @click="submitDeleteAccount">
            确认注销
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Cloudy } from '@/fsusui/icons'
import { computed, ref, onMounted } from 'vue'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import MfaChallengeModal from '@/components/ui/MfaChallengeModal.vue'
import MfaCredentialModal from '@/components/ui/MfaCredentialModal.vue'
import MfaSetupModal from '@/components/ui/MfaSetupModal.vue'
import PasskeyRegisterModal from '@/components/ui/PasskeyRegisterModal.vue'
import SemanticTime from '@/components/ui/SemanticTime.vue'
import {
  ProfileInlineEmptyState,
  ProfileResourceList,
  ProfileResourceListItem,
  ProfileSectionNav,
  ProfileSettingsSection,
  type ProfileSectionNavItem
} from '@/components/user/ProfileSettingsPrimitives'
import { useUserProfileSecurity } from '@/composables/useUserProfileSecurity'
import { usePasskeyManagement } from '@/composables/usePasskeyManagement'
import type { PasskeyCredentialSummary } from '@/api/auth'
import { confirmDanger } from '@/fsusui/feedback'

const profileSections: ProfileSectionNavItem[] = [
  { label: '账号信息', href: '#profile-account' },
  { label: '安全验证', href: '#profile-security' },
  { label: '登录方式', href: '#profile-passkeys' },
  { label: '登录设备', href: '#profile-sessions' },
  { label: '危险操作', href: '#profile-danger' }
]

const {
  isUsernameSubmitDisabled,
  isPasswordProcessing,
  isPasswordSubmitDisabled,
  usernameSubmitText,
  passwordSubmitText,
  showUsernameSubmitButton,
  showPasswordSubmitButton,
  usernameBannedText,
  passwordBannedText,
  loadingName,
  usernameFormRef,
  passwordFormRef,
  usernameForm,
  passwordForm,
  mfaPrompt,
  mfaProfile,
  mfaSetupState,
  mfaCredentialState,
  mfaCredentialTitle,
  mfaCredentialDescription,
  sessionState,
  deleteAccountState,
  deleteConfirmText,
  rules,
  requestUpdateUsername,
  requestUpdatePassword,
  submitMfaPrompt,
  closeMfaPrompt,
  startMfaSetupFlow,
  completeMfaSetupFlow,
  openDisableMfaModal,
  openRegenerateRecoveryCodesModal,
  closeMfaCredentialModal,
  submitMfaCredential,
  revokeSessionDevice,
  revokeOtherSessionDevices,
  openDeleteAccountDialog,
  submitDeleteAccount
} = useUserProfileSecurity()

void usernameFormRef
void passwordFormRef

// ── 通行密钥管理 ──
const {
  credentials: passkeyCredentials,
  loading: passkeyLoading,
  fetchPasskeys,
  removePasskey,
  renamePasskeyCredential
} = usePasskeyManagement()

const passkeyState = {
  get credentials() { return passkeyCredentials.value },
  get loading() { return passkeyLoading.value }
}

const currentSession = computed(() => sessionState.list.find((session) => session.isCurrent) ?? null)
const otherSessions = computed(() => sessionState.list.filter((session) => !session.isCurrent))
const passkeyRegisterVisible = ref(false)
const passkeyEditingId = ref<number | null>(null)
const passkeyEditName = ref('')

const startEditPasskeyName = (cred: PasskeyCredentialSummary) => {
  passkeyEditingId.value = cred.id
  passkeyEditName.value = cred.deviceFriendlyName ?? ''
}

const savePasskeyName = async (id: number) => {
  if (!passkeyEditName.value.trim()) return
  await renamePasskeyCredential(id, passkeyEditName.value.trim())
  passkeyEditingId.value = null
}

const confirmDeletePasskey = async (id: number) => {
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

const onPasskeyRegistered = async () => {
  await fetchPasskeys()
}

const formatSessionIp = (value: string | null | undefined): string => {
  return value?.trim() || '未记录 IP'
}

const formatSessionDevice = (label: string | null | undefined, fingerprint: string | null | undefined): string => {
  return label?.trim() || fingerprint?.trim() || '未记录设备信息'
}

onMounted(() => {
  fetchPasskeys()
})
</script>

<style scoped>
@reference "@/assets/main.css";

.profile-security-card {
  display: grid;
  align-content: start;
  gap: 1rem;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-control);
  padding: 1rem;
}

.profile-security-card h3 {
  margin: 0;
  color: var(--fsusblog-text-primary);
  font-size: 0.875rem;
  font-weight: 700;
}

.profile-security-card p {
  margin: 0.5rem 0 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.7;
}

.profile-danger-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  border: 1px solid var(--fsusblog-color-error);
  border-radius: var(--fsus-radius-control);
  padding: 1rem;
}

.profile-danger-panel strong {
  color: var(--fsusblog-color-error);
  font-size: 0.875rem;
}

.profile-danger-panel p {
  margin: 0.5rem 0 0;
  max-width: 42rem;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.8;
}

.profile-touch-action {
  min-width: 44px;
  min-height: 36px;
  justify-content: center;
  padding-inline: 0.75rem;
}
</style>

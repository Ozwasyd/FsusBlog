<template>
  <div class="account-page profile-page">
    <AccountPageHeader
      eyebrow="账户"
      title="个人资料"
      description="管理你的身份信息、访问凭证与在线设备。所有高危操作都在同一组界面里完成，但保持与主站一致的学术式阅读节奏。"
    />

    <nav class="profile-anchor-nav" aria-label="个人资料分区">
      <a href="#profile-identity">身份识别</a>
      <a href="#profile-password">安全验证</a>
      <a href="#profile-mfa">多因素认证</a>
      <a href="#profile-passkeys">通行密钥</a>
      <a href="#profile-sessions">设备会话</a>
      <a href="#profile-danger">危险操作</a>
    </nav>

    <div class="grid grid-cols-1 gap-x-24 gap-y-20 lg:grid-cols-2">
      <!-- 身份识别 -->
      <section id="profile-identity" class="profile-section scroll-mt-24">
        <h3 class="section-title">身份识别</h3>
        <p class="section-caption">更新用户名与公开身份标识，不改变既有账户权限。</p>
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
      </section>

      <!-- 安全验证 -->
      <section id="profile-password" class="profile-section scroll-mt-24">
        <h3 class="section-title">安全验证</h3>
        <p class="section-caption">修改密码会立即刷新身份凭证，并要求你重新登录。</p>
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
      </section>
    </div>

    <!-- MFA -->
    <section id="profile-mfa" class="profile-section mt-24 scroll-mt-24">
      <h3 class="section-title">多因素认证</h3>
      <p class="section-caption">
        状态：
        <span class="font-bold text-[var(--fsusblog-text-primary)]">{{ mfaProfile.loading ? '加载中...' : (mfaProfile.enabled ? '已启用' : '未启用') }}</span>
        <span v-if="mfaProfile.verifiedAt" class="ml-2 text-[var(--fsusblog-text-muted)]">
          最近验证：<SemanticTime :value="mfaProfile.verifiedAt" />
        </span>
      </p>
      <div class="mt-8 flex flex-wrap gap-5">
        <el-button
          v-if="!mfaProfile.enabled"
          type="primary"
          @click="startMfaSetupFlow"
        >
          启用 MFA
        </el-button>
        <el-button
          v-else
          @click="openDisableMfaModal"
        >
          关闭 MFA
        </el-button>
        <el-button
          v-if="mfaProfile.enabled"
          @click="openRegenerateRecoveryCodesModal"
        >
          重新生成恢复码
        </el-button>
      </div>
    </section>

    <!-- 通行密钥 -->
    <section id="profile-passkeys" class="profile-section mt-24 scroll-mt-24">
      <h3 class="section-title">通行密钥</h3>
      <p class="section-caption">
        使用设备生物识别或 PIN 保护，无需密码即可安全登录。
      </p>

      <div class="mt-10">
        <div v-if="passkeyState.loading && !passkeyState.credentials.length" class="py-4 text-[12px] text-[var(--fsusblog-text-muted)]">
          加载中...
        </div>

        <div v-else-if="passkeyState.credentials.length" class="mb-10 space-y-px bg-[var(--fsusblog-panel-border)] border-y border-[var(--fsusblog-panel-border)]">
          <div
            v-for="cred in passkeyState.credentials"
            :key="cred.id"
            class="flex flex-col gap-4 bg-[var(--fsusblog-page-bg)] py-8 sm:flex-row sm:items-center sm:justify-between"
          >
            <div class="min-w-0 flex-1">
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
                <el-button link type="primary" @click="savePasskeyName(cred.id)">保存</el-button>
                <el-button link @click="passkeyEditingId = null">取消</el-button>
              </div>
              <div v-else class="flex items-center gap-3">
                <p class="truncate text-[14px] font-bold text-[var(--fsusblog-text-primary)]">
                  {{ cred.deviceFriendlyName || '未命名密钥' }}
                </p>
                <el-button link @click="startEditPasskeyName(cred)">编辑</el-button>
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
                <span>创建：<SemanticTime :value="cred.createdAt" format="date" /></span>
                <span class="h-0.5 w-0.5 rounded-[var(--fsus-radius-control-small)] bg-current opacity-30"></span>
                <span v-if="cred.lastUsedAt">活跃：<SemanticTime :value="cred.lastUsedAt" format="date" /></span>
                <span v-if="cred.backupEligible" class="inline-flex items-center gap-1 text-[var(--fsusblog-color-success)]">
                  <Cloudy class="h-3 w-3" aria-hidden="true" />
                  已同步
                </span>
              </div>
            </div>
            <el-button
              link
              type="danger"
              @click="confirmDeletePasskey(cred.id)"
            >
              删除
            </el-button>
          </div>
        </div>
        <p v-else class="mb-10 text-[12px] text-[var(--fsusblog-text-muted)]">尚未注册任何通行密钥。</p>

        <el-button
          v-if="passkeyState.credentials.length < 5"
          type="primary"
          :disabled="passkeyState.loading"
          @click="passkeyRegisterVisible = true"
        >
          添加通行密钥
        </el-button>
      </div>
    </section>

    <!-- 会话管理 -->
    <section id="profile-sessions" class="profile-section mt-24 scroll-mt-24">
      <div class="flex flex-col gap-4 border-b border-[var(--fsusblog-panel-border)] pb-6 mb-10 sm:flex-row sm:items-end sm:justify-between">
        <div class="min-w-0">
          <h3 class="section-title section-title--inline">设备会话管理</h3>
          <p class="text-[12px] text-[var(--fsusblog-text-tertiary)]">当前共有 {{ sessionState.list.length }} 个活跃会话</p>
        </div>
        <el-button
          type="primary"
          plain
          @click="revokeOtherSessionDevices"
        >
          下线其他设备
        </el-button>
      </div>

      <div class="space-y-px bg-[var(--fsusblog-panel-border)] border-y border-[var(--fsusblog-panel-border)]">
        <div
          v-for="session in sessionState.list"
          :key="session.sessionId"
          class="flex flex-col gap-5 bg-[var(--fsusblog-page-bg)] py-8 sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-3">
              <p class="truncate text-[14px] font-bold text-[var(--fsusblog-text-primary)]">
                {{ session.lastIp || 'UNKNOWN IP' }}
              </p>
              <el-tag v-if="session.isCurrent" size="small">当前</el-tag>
            </div>
            <p class="mt-1 truncate text-[11px] font-medium text-[var(--fsusblog-text-tertiary)] normal-case tracking-normal">
              {{ session.deviceLabel || session.deviceFingerprint || '-' }}
            </p>
            <p class="mt-2 text-[11px] font-medium text-[var(--fsusblog-text-muted)] normal-case tracking-normal">
              最后活跃：<SemanticTime v-if="session.lastSeenAt" :value="session.lastSeenAt" /><span v-else>-</span>
            </p>
          </div>
          <el-button
            v-if="!session.isCurrent"
            link
            type="danger"
            @click="revokeSessionDevice(session.sessionId)"
          >
            下线
          </el-button>
        </div>
      </div>
    </section>

    <!-- 危险操作 -->
    <section id="profile-danger" class="profile-section mt-32 scroll-mt-24">
      <h3 class="section-title section-title--danger">危险操作</h3>
      <div class="mt-10 border-l-2 border-[var(--fsusblog-color-error)] pl-8 py-2">
        <p class="text-[13px] font-bold text-[var(--fsusblog-color-error)] normal-case tracking-normal mb-2">注销账户 (Permanent Deletion)</p>
        <p class="text-[13px] leading-relaxed text-[var(--fsusblog-text-tertiary)] max-w-2xl">
          注销后将立即退出所有设备，账户身份会匿名化处理，且不能恢复。确认文本固定为
          <span class="tabular-nums font-bold text-[var(--fsusblog-text-primary)] bg-[var(--fsusblog-panel-bg-soft)] px-1.5 py-0.5 rounded-[var(--fsus-radius-control-small)]">{{ deleteConfirmText }}</span>。
        </p>
        <div class="mt-8">
          <el-button type="danger" @click="openDeleteAccountDialog">
            注销账户
          </el-button>
        </div>
      </div>
    </section>

    <MfaChallengeModal
      v-model:visible="mfaPrompt.visible"
      :loading="mfaPrompt.loading"
      :error-message="mfaPrompt.errorMessage"
      description="请输入 Google Authenticator 6 位验证码，或使用恢复码完成高风险操作校验。"
      @confirm="submitMfaPrompt"
      @cancel="closeMfaPrompt(null)"
    />

    <MfaSetupModal
      v-model:visible="mfaSetupState.visible"
      :title="mfaSetupState.secret ? 'MFA 绑定' : '恢复码'"
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
        <label v-if="mfaProfile.enabled" for="delete-account-mfa-code" class="sr-only">MFA 验证码</label>
        <el-input
          v-if="mfaProfile.enabled"
          id="delete-account-mfa-code"
          v-model="deleteAccountState.form.code"
          name="deleteAccountMfaCode"
          autocomplete="one-time-code"
          inputmode="numeric"
          aria-label="MFA 验证码"
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
import { ElMessageBox } from '@ozwasyd/element-plus'
import { Cloudy } from '@/ui/fsusIcons'
import { ref, onMounted } from 'vue'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import MfaChallengeModal from '@/components/ui/MfaChallengeModal.vue'
import MfaCredentialModal from '@/components/ui/MfaCredentialModal.vue'
import MfaSetupModal from '@/components/ui/MfaSetupModal.vue'
import PasskeyRegisterModal from '@/components/ui/PasskeyRegisterModal.vue'
import SemanticTime from '@/components/ui/SemanticTime.vue'
import { useUserProfileSecurity } from '@/composables/useUserProfileSecurity'
import { usePasskeyManagement } from '@/composables/usePasskeyManagement'
import type { PasskeyCredentialSummary } from '@/api/auth'
import { isFsusUiOk } from '@/utils/fsusUiResult'

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
  const result = await ElMessageBox.confirm(
    '确认删除此通行密钥？删除后，该设备将不能继续使用此密钥登录。',
    '删除通行密钥',
    { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning' }
  )
  if (!isFsusUiOk(result)) {
    return
  }
  await removePasskey(id)
}

const onPasskeyRegistered = async () => {
  await fetchPasskeys()
}

onMounted(() => {
  fetchPasskeys()
})
</script>

<style scoped>
@reference "@/assets/main.css";

.section-title {
  @apply text-[11px] font-bold tracking-normal mb-10 pb-4 border-b border-[var(--fsusblog-panel-border)] text-[var(--fsusblog-text-primary)] normal-case;
  position: relative;
}

.profile-anchor-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 4rem;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  padding-bottom: 1rem;
}

.profile-anchor-nav a {
  border: 1px solid var(--fsusblog-panel-border);
  padding: 0.375rem 0.625rem;
  color: var(--fsusblog-text-secondary);
  font-size: 0.75rem;
  font-weight: 700;
}

.profile-anchor-nav a:hover {
  border-color: var(--fsusblog-color-primary);
  color: var(--fsusblog-color-primary);
}

.section-title::before {
  content: "";
  @apply absolute bottom-[-1px] left-0 h-[2px] w-8 bg-[var(--fsusblog-text-primary)];
}

.section-title--inline {
  @apply mb-2 border-none pb-0;
}

.section-title--inline::before {
  content: none;
}

.section-title--danger {
  @apply text-[var(--fsusblog-color-error)] border-[var(--fsusblog-color-error)]/20;
}

.section-title--danger::before {
  @apply bg-[var(--fsusblog-color-error)];
}

.section-caption {
  @apply text-[13px] leading-relaxed text-[var(--fsusblog-text-tertiary)] mb-10;
}

@media (max-width: 640px) {
  .section-title {
    @apply text-[11px] tracking-normal;
  }
}
</style>

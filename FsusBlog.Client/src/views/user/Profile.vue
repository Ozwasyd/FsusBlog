<template>
  <div class="account-page">
    <header class="account-page-header">
      <div class="account-page-eyebrow">账户</div>
      <h1 class="account-page-title">个人资料</h1>
      <p class="account-page-description">
        管理你的身份信息、访问凭证与在线设备。所有高危操作都在同一组界面里完成，但保持与主站一致的学术式阅读节奏。
      </p>
    </header>

    <div class="grid grid-cols-1 gap-x-20 gap-y-16 lg:grid-cols-2">
      <section class="account-section border-t-0 pt-0">
        <h3 class="account-section-title">身份识别</h3>
        <p class="account-section-caption">更新用户名与公开身份标识，不改变既有账户权限。</p>
        <el-form ref="usernameFormRef" :model="usernameForm" :rules="rules" label-position="top" @submit.prevent>
          <el-form-item label="用户名" prop="newUsername">
            <el-input
              v-model="usernameForm.newUsername"
              name="profileUsername"
              class="minimal-input"
              :disabled="isUsernameSubmitDisabled"
              placeholder="输入新用户名"
              aria-label="输入新用户名"
            />
          </el-form-item>
          <button
            v-if="showUsernameSubmitButton"
            type="button"
            class="submit-btn-minimal mt-8 bg-transparent text-[#0F0F11] hover:border-[#2A599C] hover:text-[#2A599C] focus-visible:ring-[#2A599C]"
            :disabled="loadingName"
            @click.prevent="requestUpdateUsername"
          >
            {{ usernameSubmitText }}
          </button>
          <p
            v-else
            role="alert"
            class="mt-8 rounded-[var(--fsus-radius-lg)] border border-[var(--fsus-panel-border)] px-5 py-4 text-[10px] font-bold tracking-[0.22em] text-[var(--fsus-text-muted)]"
          >
            {{ usernameBannedText }}
          </p>
        </el-form>
      </section>

      <section class="account-section border-t-0 pt-0">
        <h3 class="account-section-title">安全验证</h3>
        <p class="account-section-caption">修改密码会立即刷新身份凭证，并要求你重新登录。</p>
        <el-form ref="passwordFormRef" :model="passwordForm" :rules="rules" label-position="top" @submit.prevent>
          <el-form-item label="当前密码" prop="oldPassword">
            <el-input
              v-model="passwordForm.oldPassword"
              name="profileOldPassword"
              type="password"
              show-password
              class="minimal-input"
              :disabled="isPasswordSubmitDisabled"
              placeholder="CURRENT PASSWORD"
              aria-label="当前密码"
            />
          </el-form-item>

          <el-form-item label="新密码" prop="newPassword">
            <el-input
              v-model="passwordForm.newPassword"
              name="profileNewPassword"
              type="password"
              show-password
              class="minimal-input"
              :disabled="isPasswordSubmitDisabled"
              placeholder="NEW PASSWORD"
              aria-label="新密码"
            />
          </el-form-item>

          <el-form-item label="确认新密码" prop="confirmPassword">
            <el-input
              v-model="passwordForm.confirmPassword"
              name="profileConfirmPassword"
              type="password"
              show-password
              class="minimal-input"
              :disabled="isPasswordSubmitDisabled"
              placeholder="CONFIRM NEW"
              aria-label="确认新密码"
            />
          </el-form-item>

          <button
            v-if="showPasswordSubmitButton"
            type="button"
            class="submit-btn-minimal mt-8 bg-[#0F0F11] text-white border-[#0F0F11] hover:border-[#2A599C] hover:bg-[#2A599C] focus-visible:ring-[#2A599C]"
            :disabled="isPasswordSubmitDisabled"
            @click.prevent="requestUpdatePassword"
          >
            <span :class="passwordSubmitPulseClass">
              {{ passwordSubmitText }}
            </span>
          </button>
          <p
            v-else
            role="alert"
            class="mt-8 rounded-[var(--fsus-radius-lg)] border border-[var(--fsus-panel-border)] px-5 py-4 text-[10px] font-bold tracking-[0.22em] text-[var(--fsus-text-muted)]"
          >
            {{ passwordBannedText }}
          </p>
        </el-form>
      </section>
    </div>

    <section class="account-section mt-16 sm:mt-20">
      <h3 class="account-section-title">多因素认证</h3>
      <p class="account-section-caption">
        状态：
        <span class="font-semibold text-[#18181B]">{{ mfaProfile.loading ? '加载中...' : (mfaProfile.enabled ? '已启用' : '未启用') }}</span>
        <span v-if="mfaProfile.verifiedAt" class="ml-2 text-[var(--fsus-text-muted)]">最近验证：{{ new Date(mfaProfile.verifiedAt).toLocaleString() }}</span>
      </p>
      <div class="mt-6 flex flex-wrap gap-5 sm:mt-5">
        <button
          v-if="!mfaProfile.enabled"
          type="button"
          class="submit-btn-minimal w-auto px-6"
          @click="startMfaSetupFlow"
        >
          启用 MFA
        </button>
        <button
          v-else
          type="button"
          class="submit-btn-minimal w-auto px-6"
          @click="openDisableMfaModal"
        >
          关闭 MFA
        </button>
        <button
          v-if="mfaProfile.enabled"
          type="button"
          class="submit-btn-minimal w-auto px-6"
          @click="openRegenerateRecoveryCodesModal"
        >
          重新生成恢复码
        </button>
      </div>
    </section>

    <section class="account-section mt-16 sm:mt-20">
      <h3 class="account-section-title">设备会话管理</h3>
      <p class="account-section-caption">查看当前登录中的设备，并主动终止非当前会话。</p>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-5">
        <p class="text-[12px] text-[var(--fsus-text-tertiary)]">当前账号在线设备：{{ sessionState.list.length }}</p>
        <button
          type="button"
          class="min-h-11 self-start rounded-[var(--fsus-radius-sm)] text-[11px] font-semibold tracking-normal text-[var(--fsus-text-tertiary)] transition-colors hover:text-[#2A599C] sm:self-auto"
          :disabled="sessionState.loading"
          @click="revokeOtherSessionDevices"
        >
          下线其他设备
        </button>
      </div>
      <div class="account-soft-block overflow-hidden">
        <div
          v-for="session in sessionState.list"
          :key="session.sessionId"
          class="flex flex-col gap-5 border-b border-[var(--fsus-panel-border)] p-6 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="min-w-0">
            <p class="truncate text-[13px] font-semibold text-[#18181B]">
              {{ session.isCurrent ? '当前设备' : '其他设备' }} · {{ session.lastIp || '-' }}
            </p>
            <p class="truncate text-[11px] text-[var(--fsus-text-tertiary)]">{{ session.deviceLabel || session.deviceFingerprint || '-' }}</p>
            <p class="mt-1 text-[10px] text-[var(--fsus-text-muted)]">
              最后活跃：{{ session.lastSeenAt ? new Date(session.lastSeenAt).toLocaleString() : '-' }}
            </p>
          </div>
          <button
            v-if="!session.isCurrent"
            type="button"
            class="min-h-11 self-start rounded-[var(--fsus-radius-sm)] text-[11px] font-semibold tracking-normal text-[var(--fsus-text-tertiary)] transition-colors hover:text-[#2A599C] sm:self-auto"
            @click="revokeSessionDevice(session.sessionId)"
          >
            下线
          </button>
        </div>
        <div v-if="!sessionState.list.length" class="p-6 text-[12px] text-[var(--fsus-text-muted)]">暂无会话数据</div>
      </div>
    </section>

    <section class="account-section mt-16 sm:mt-20">
      <h3 class="account-section-title text-[#E5484D]">危险操作</h3>
      <el-alert
        title="注销后将立即退出所有设备，账户身份会匿名化处理，且不能恢复。"
        type="error"
        :closable="false"
        class="mb-6"
      />
      <div class="rounded-[var(--fsus-radius-lg)] border border-[#FECACA] bg-[#FEF2F2]/55 p-5 sm:p-6">
        <p class="text-[12px] leading-6 text-[#71717A]">
          为防止误操作，系统会要求你输入当前密码，并在已启用 MFA 时再次验证。确认文本固定为
          <span class="font-mono font-bold text-[#18181B]">{{ deleteConfirmText }}</span>。
        </p>
        <div class="mt-5">
          <button
            type="button"
            class="submit-btn-minimal border-[#E5484D] bg-[#E5484D] text-white hover:bg-[#CE2C31] hover:border-[#CE2C31] disabled:opacity-40"
            :disabled="deleteAccountState.loading"
            @click="openDeleteAccountDialog"
          >
            {{ deleteAccountState.loading ? '处理中...' : '注销账户' }}
          </button>
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

    <el-dialog
      v-model="deleteAccountState.visible"
      title="注销账户"
      width="460px"
      destroy-on-close
      align-center
    >
      <div class="space-y-4">
        <p class="text-sm leading-7 text-[#8E8E93]">
          注销后，账户会立即失效，评论与历史内容会被保留但身份将匿名化。此操作不可撤销。
        </p>
        <p class="rounded-[var(--fsus-radius-md)] border border-[#F4F4F5] bg-[#FCFCFC] px-4 py-3 text-xs font-medium tracking-[0.08em] text-[#52525B]">
          确认文本必须为 <span class="font-semibold text-[#09090B]">{{ deleteConfirmText }}</span>
        </p>
        <el-input
          v-model="deleteAccountState.form.password"
          name="deleteAccountPassword"
          type="password"
          show-password
          autocomplete="current-password"
          placeholder="当前密码"
        />
        <el-input
          v-model="deleteAccountState.form.confirmText"
          name="deleteAccountConfirmText"
          :placeholder="`输入 ${deleteConfirmText} 确认`"
        />
        <el-input
          v-if="mfaProfile.enabled"
          v-model="deleteAccountState.form.code"
          name="deleteAccountMfaCode"
          placeholder="6 位验证码"
        />
        <el-input
          v-if="mfaProfile.enabled"
          v-model="deleteAccountState.form.recoveryCode"
          name="deleteAccountRecoveryCode"
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

import MfaChallengeModal from '@/components/ui/MfaChallengeModal.vue'
import MfaCredentialModal from '@/components/ui/MfaCredentialModal.vue'
import MfaSetupModal from '@/components/ui/MfaSetupModal.vue'
import { useUserProfileSecurity } from '@/composables/useUserProfileSecurity'

const {
  isUsernameSubmitDisabled,
  isPasswordSubmitDisabled,
  usernameSubmitText,
  passwordSubmitText,
  passwordSubmitPulseClass,
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
</script>

<style scoped>
@reference "@/assets/main.css";

.section-title {
  @apply text-[11px] font-semibold tracking-[0.2em] mb-10 pb-4 border-b border-[#E4E4E7] text-[#3F3F46] uppercase dark:border-[#27272A] dark:text-[#A1A1AA];
}

.submit-btn-minimal {
  @apply w-full rounded-[var(--fsus-radius-sm)] border border-[var(--fsus-panel-border-strong)] px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] shadow-sm transition-all duration-300 active:scale-[0.98] disabled:opacity-30;
}

:deep(.el-form-item) {
  @apply mb-8 sm:mb-10;
}

:deep(.el-form-item__label) {
  @apply text-[9px] font-bold text-[#A1A1AA] uppercase tracking-[0.2em] mb-2! p-0!;
}

:deep(.el-form-item__error) {
  @apply text-[9px] font-medium tracking-wider text-[#8E8E93] mt-2;
  position: relative;
}

:deep(.el-input__wrapper) {
  @apply rounded-[var(--fsus-radius-sm)] border border-[var(--fsus-panel-border)] bg-white px-4 shadow-none transition-all duration-300;
}

:deep(.el-input__wrapper.is-focus) {
  @apply border-[#2A599C];
  box-shadow: 0 0 0 1px rgba(42, 89, 156, 0.2);
}

:deep(.el-input__inner) {
  @apply h-11 text-[#0F0F11] font-semibold text-sm placeholder:text-[#A1A1AA] placeholder:font-normal;
}

:deep(.el-input__inner::placeholder) {
  @apply uppercase tracking-[0.16em];
}

:deep(.el-input__suffix-icon) {
  @apply text-[#A1A1AA] transition-colors hover:text-[#0F0F11];
}

:deep(.el-alert) {
  border-radius: var(--fsus-radius-lg);
}
</style>

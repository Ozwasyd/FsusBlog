<template>
  <div class="max-w-3xl mx-auto w-full py-10 sm:py-16 px-6 sm:px-8">
    <header class="mb-12 sm:mb-20">
      <div class="text-[9px] sm:text-[10px] font-bold tracking-[0.3em] text-zinc-400 uppercase mb-3">账户</div>
      <h1 class="text-3xl sm:text-5xl font-bold tracking-tighter text-zinc-950 mb-6 sm:mb-8">个人资料</h1>
      <p class="text-zinc-400 max-w-[70%] leading-relaxed text-[10px] sm:text-[11px] font-medium tracking-widest">
        管理你的身份信息，并在此更新你的安全访问凭证。
      </p>
    </header>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-24 gap-y-16 sm:gap-y-20">
      <section class="animate-in fade-in slide-in-from-bottom-4 duration-500">
        <h3 class="section-title">身份识别</h3>
        <el-form ref="usernameFormRef" :model="usernameForm" :rules="rules" label-position="top" @submit.prevent>
          <el-form-item label="用户名" prop="newUsername">
            <el-input
              v-model="usernameForm.newUsername"
              class="minimal-input"
              :disabled="isUsernameSubmitDisabled"
              placeholder="输入新用户名"
              aria-label="输入新用户名"
            />
          </el-form-item>
          <div class="mt-8">
            <button
              v-if="showUsernameSubmitButton"
              type="button"
              class="submit-btn-minimal hover:bg-zinc-50 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 focus-visible:ring-offset-4"
              :disabled="loadingName"
              @click.prevent="requestUpdateUsername"
            >
              {{ usernameSubmitText }}
            </button>
            <div
              v-else
              role="alert"
              class="text-[10px] font-bold text-zinc-400 border border-zinc-100 py-4 text-center tracking-widest"
            >
              {{ usernameBannedText }}
            </div>
          </div>
        </el-form>
      </section>

      <section class="animate-in fade-in slide-in-from-bottom-4 duration-700">
        <h3 class="section-title">安全验证</h3>
        <el-form ref="passwordFormRef" :model="passwordForm" :rules="rules" label-position="top" @submit.prevent>
          <el-form-item label="当前密码" prop="oldPassword">
            <el-input
              v-model="passwordForm.oldPassword"
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
              type="password"
              show-password
              class="minimal-input"
              :disabled="isPasswordSubmitDisabled"
              placeholder="CONFIRM NEW"
              aria-label="确认新密码"
            />
          </el-form-item>

          <div class="mt-8">
            <button
              v-if="showPasswordSubmitButton"
              type="button"
              class="submit-btn-minimal bg-zinc-950 text-white active:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 focus-visible:ring-offset-4"
              :disabled="isPasswordSubmitDisabled"
              @click.prevent="requestUpdatePassword"
            >
              <span :class="passwordSubmitPulseClass">
                {{ passwordSubmitText }}
              </span>
            </button>
            <div
              v-else
              role="alert"
              class="text-[10px] font-bold text-zinc-400 border border-zinc-100 py-4 text-center tracking-widest"
            >
              {{ passwordBannedText }}
            </div>
          </div>
        </el-form>
      </section>
    </div>

    <ConfirmModal
      v-model:visible="modalState.visible"
      :title="modalState.title"
      :content="modalState.content"
      @confirm="modalState.onConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import ConfirmModal from '@/components/ui/ConfirmModal.vue'
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
  modalState,
  rules,
  requestUpdateUsername,
  requestUpdatePassword
} = useUserProfileSecurity()
</script>

<style scoped>
@reference "@/assets/main.css";

.section-title {
  @apply text-[11px] font-black tracking-[0.4em] mb-10 pb-4 border-b border-zinc-950 text-zinc-950 uppercase;
}

.submit-btn-minimal {
  @apply w-full py-4 border border-zinc-950 text-[10px] font-black tracking-[0.3em] uppercase transition-all duration-300 active:scale-[0.98] disabled:opacity-30;
}

:deep(.el-form-item) {
  @apply mb-8 sm:mb-10;
}

:deep(.el-form-item__label) {
  @apply text-[9px] font-bold text-zinc-400 uppercase tracking-[0.2em] mb-2! p-0!;
}

:deep(.el-form-item__error) {
  @apply text-[9px] font-medium tracking-wider text-zinc-500 mt-2;
  position: relative;
}

:deep(.el-input__wrapper) {
  @apply p-0 shadow-none bg-transparent border-b border-zinc-100 rounded-none transition-all duration-500;
}

:deep(.el-input__wrapper.is-focus) {
  @apply border-zinc-950;
}

:deep(.el-input__inner) {
  @apply h-11 sm:h-10 text-zinc-950 font-bold text-sm placeholder:text-zinc-200 placeholder:font-normal tracking-wider;
}

:deep(.el-input__inner::placeholder) {
  @apply uppercase;
}

:deep(.el-input__suffix-icon) {
  @apply text-zinc-300 hover:text-zinc-950 transition-colors;
}
</style>

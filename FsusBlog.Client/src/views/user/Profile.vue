<template>
  <div class="max-w-3xl mx-auto w-full py-10 sm:py-16 px-6 sm:px-8">

    <transition name="toast-fade">
      <div v-if="isToastShow"
        class="fixed top-6 sm:top-10 left-1/2 -translate-x-1/2 z-100 px-6 py-3 bg-zinc-950 text-white text-[10px] sm:text-[11px] font-bold tracking-[0.2em] uppercase shadow-2xl w-[calc(100%-3rem)] sm:w-auto text-center">
        {{ toastMessage }}
      </div>
    </transition>

    <header class="mb-12 sm:mb-20">
      <div class="text-[9px] sm:text-[10px] font-bold tracking-[0.3em] text-zinc-400 uppercase mb-3">账户</div>
      <h1 class="text-3xl sm:text-5xl font-bold tracking-tighter text-zinc-950 mb-6 sm:mb-8">个人资料</h1>
      <p class="text-zinc-400 max-w-70 leading-relaxed text-[10px] sm:text-[11px] font-medium tracking-widest">
        管理你的身份信息，并在此更新你的安全访问凭证。
      </p>
    </header>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-24 gap-y-16 sm:gap-y-20">
      <section class="animate-in fade-in slide-in-from-bottom-4 duration-500">
        <h3 class="section-title">身份识别</h3>
        <el-form :model="usernameForm" :rules="rules" ref="usernameFormRef" label-position="top">
          <el-form-item label="用户名" prop="newUsername">
            <el-input v-model="usernameForm.newUsername" class="minimal-input" :disabled="userStore.isBanned"
              placeholder="输入新用户名" />
          </el-form-item>
          <div class="mt-8">
            <button v-if="!userStore.isBanned" @click.prevent="requestUpdateUsername" :disabled="loading"
              class="submit-btn-minimal">
              保存更改
            </button>
            <div v-else
              class="text-[10px] font-bold text-zinc-400 border border-zinc-100 py-4 text-center tracking-widest">
              账号受限：暂无法修改资料
            </div>
          </div>
        </el-form>
      </section>

      <section class="animate-in fade-in slide-in-from-bottom-4 duration-700">
        <h3 class="section-title">安全验证</h3>
        <el-form :model="passwordForm" :rules="rules" ref="passwordFormRef" label-position="top">

          <el-form-item label="当前密码" prop="oldPassword">
            <el-input v-model="passwordForm.oldPassword" type="password" show-password class="minimal-input"
              :disabled="userStore.isBanned" placeholder="CURRENT PASSWORD" />
          </el-form-item>

          <el-form-item label="新密码" prop="newPassword">
            <el-input v-model="passwordForm.newPassword" type="password" show-password class="minimal-input"
              :disabled="userStore.isBanned" placeholder="NEW PASSWORD" />
          </el-form-item>

          <el-form-item label="确认新密码" prop="confirmpassword">
            <el-input v-model="passwordForm.confirmpassword" type="password" show-password class="minimal-input"
              :disabled="userStore.isBanned" placeholder="CONFIRM NEW" />
          </el-form-item>

          <div class="mt-8">
            <button v-if="!userStore.isBanned" @click.prevent="requestUpdatePassword"
              :disabled="loading || isCalculating"
              class="submit-btn-minimal bg-zinc-950 text-white active:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed">
              <template v-if="isCalculating">正在进行安全计算...</template>
              <template v-else-if="loading">提交中...</template>
              <template v-else>更新账户凭证</template>
            </button>
            <div v-else
              class="text-[10px] font-bold text-zinc-400 border border-zinc-100 py-4 text-center tracking-widest">
              账号受限：安全设置已锁定
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
import { ref, reactive } from 'vue'
import { useUserStore } from '@/store/user'
import { 
  updateUsername, 
  updatePassword, 
  type UpdateUsernameDto, 
  type UpdatePasswordDto,
  type PowRequest 
} from '@/api/auth'
import { getPowChallenge } from '@/api/auth'
import { getBrowserFp } from '@/utils/fingerprint'
import { usePow } from '@/composables/usePow'
import type { FormInstance } from 'element-plus'
import ConfirmModal from '@/components/ui/ConfirmModal.vue'

const userStore = useUserStore()
const { calculate, isCalculating } = usePow()

const loading = ref(false)
const usernameFormRef = ref<FormInstance>()
const passwordFormRef = ref<FormInstance>()

const usernameForm = reactive<UpdateUsernameDto>({
  newUsername: userStore.userInfo?.username || ''
})

// 表单状态不需要包含 PoW 字段，只包含用户输入的密码信息
const passwordForm = reactive<Omit<UpdatePasswordDto, keyof PowRequest>>({
  oldPassword: '',
  newPassword: '',
  confirmpassword: ''
})

// --- 模态框复用状态中心 ---
const modalState = reactive({
  visible: false,
  title: '',
  content: '',
  onConfirm: () => {}
})

const triggerModal = (config: { title: string, content: string, onConfirm: () => void }) => {
  modalState.title = config.title
  modalState.content = config.content
  modalState.onConfirm = () => {
    config.onConfirm()
    modalState.visible = false
  }
  modalState.visible = true
}

const toastMessage = ref('')
const isToastShow = ref(false)
const showToast = (msg: string) => {
  toastMessage.value = msg
  isToastShow.value = true
  setTimeout(() => { isToastShow.value = false }, 3000)
}

const rules = {
  newUsername: [
    { required: true, message: '请填写新的用户名', trigger: 'blur' },
    { 
      pattern: /^[\u4e00-\u9fa5a-zA-Z]+$/, 
      message: '用户名仅允许中英文字符', 
      trigger: 'blur' 
    },
    { min: 3, max: 20, message: '长度在 3 到 20 个字符', trigger: 'blur' }
  ],
  oldPassword: [{ required: true, message: '请填写当前密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请填写新密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少 6 位', trigger: 'blur' }
  ],
  confirmpassword: [
    { required: true, message: '请再次确认密码', trigger: 'blur' },
    {
      validator: (_rule: any, value: string, callback: any) => {
        if (value !== passwordForm.newPassword) {
          callback(new Error('两次输入的密码不一致'))
        } else {
          callback()
        }
      },
      trigger: 'blur'
    }
  ]
}

// --- 身份更新逻辑 ---
const requestUpdateUsername = async () => {
  if (!usernameFormRef.value) return
  await usernameFormRef.value.validate((valid) => {
    if (!valid) return
    triggerModal({
      title: '修改身份识别',
      content: `确定将用户名修改为 "${usernameForm.newUsername}" 吗？这可能会影响您的展示名称。`,
      onConfirm: handleUpdateUsername
    })
  })
}

const handleUpdateUsername = async () => {
  loading.value = true
  try {
    const payload = {
      newUsername: usernameForm.newUsername.trim()
    }
    await updateUsername(payload)
    if (userStore.userInfo) {
      userStore.setUserInfo({ ...userStore.userInfo, username: usernameForm.newUsername })
    }
    showToast('用户名已同步更新')
  } catch (error: any) {
    showToast(error.message || '用户名修改失败')
  } finally {
    loading.value = false
  }
}

// --- 密码更新逻辑 ---
const requestUpdatePassword = async () => {
  if (!passwordFormRef.value) return
  await passwordFormRef.value.validate((valid) => {
    if (!valid) return
    triggerModal({
      title: '更新安全凭证',
      content: '确定要重置您的登录密码吗？更新成功后，系统将要求您重新登录。',
      // 使用箭头函数封装，确保 retryCount 初始为 0
      onConfirm: () => handleUpdatePassword()
    })
  })
}

// 核心改造：带 PoW 验证的密码更新流程
const handleUpdatePassword = async (retryCount = 0) => {
  // 防止重复提交
  if (loading.value || isCalculating.value) return
  loading.value = true

  try {
    // 1. 获取挑战包 (Action: 'update_password')
    const challengeRes = await getPowChallenge({ action: 'update_password' })
    const { salt, difficulty, timestamp, signature } = challengeRes as any

    // 2. 算力求解 (Worker)
    const fp = getBrowserFp()
    const { nonce } = await calculate(salt, fp, difficulty)

    // 3. 提交修改 (显式构造完整 DTO，合并表单数据与 PoW 数据)
    const payload: UpdatePasswordDto = {
      ...passwordForm,
      powSalt: salt,
      powNonce: nonce,
      powTimestamp: timestamp,
      difficulty: difficulty,
      powSignature: signature,
      browserFp: fp
    }

    await updatePassword(payload)
    
    showToast('密码已重置，请重新登录')
    setTimeout(async () => {
      await userStore.logout()
    }, 1500)

  } catch (error: any) {
    console.error("Update password failed:", error)

    // 处理 403 难度提升自动重试逻辑
    if (error.response?.status === 403 && retryCount < 1) {
      showToast("安全环境波动，正在提升算力重试...")
      loading.value = false // 释放锁以允许递归调用
      await handleUpdatePassword(retryCount + 1)
      return
    }

    showToast(error.message || '密码修改失败')
  } finally {
    loading.value = false
  }
}
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

.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
  transform: translate(-50%, -20px);
}
</style>
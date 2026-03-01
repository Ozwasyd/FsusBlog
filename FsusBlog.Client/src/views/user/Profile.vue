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
      <!-- 身份识别模块 -->
      <section class="animate-in fade-in slide-in-from-bottom-4 duration-500">
        <h3 class="section-title">身份识别</h3>
        <!-- 补全 A11y 语义 -->
        <el-form :model="usernameForm" :rules="rules" ref="usernameFormRef" label-position="top" @submit.prevent>
          <el-form-item label="用户名" prop="newUsername">
            <el-input 
              v-model="usernameForm.newUsername" 
              class="minimal-input" 
              :disabled="userStore.isBanned || loadingName"
              placeholder="输入新用户名" 
              aria-label="输入新用户名"
            />
          </el-form-item>
          <div class="mt-8">
            <button 
              v-if="!userStore.isBanned" 
              type="button"
              @click.prevent="requestUpdateUsername" 
              :disabled="loadingName"
              class="submit-btn-minimal hover:bg-zinc-50 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 focus-visible:ring-offset-4"
            >
              <template v-if="loadingName">处理中...</template>
              <template v-else>保存更改</template>
            </button>
            <div v-else
              role="alert"
              class="text-[10px] font-bold text-zinc-400 border border-zinc-100 py-4 text-center tracking-widest">
              账号受限：暂无法修改资料
            </div>
          </div>
        </el-form>
      </section>

      <!-- 安全验证模块 -->
      <section class="animate-in fade-in slide-in-from-bottom-4 duration-700">
        <h3 class="section-title">安全验证</h3>
        <el-form :model="passwordForm" :rules="rules" ref="passwordFormRef" label-position="top" @submit.prevent>

          <el-form-item label="当前密码" prop="oldPassword">
            <el-input 
              v-model="passwordForm.oldPassword" 
              type="password" 
              show-password 
              class="minimal-input"
              :disabled="userStore.isBanned || loadingPwd" 
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
              :disabled="userStore.isBanned || loadingPwd" 
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
              :disabled="userStore.isBanned || loadingPwd" 
              placeholder="CONFIRM NEW" 
              aria-label="确认新密码"
            />
          </el-form-item>

          <div class="mt-8">
            <button 
              v-if="!userStore.isBanned" 
              type="button"
              @click.prevent="requestUpdatePassword"
              :disabled="loadingPwd || powProvider.isCalculating.value"
              class="submit-btn-minimal bg-zinc-950 text-white active:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 focus-visible:ring-offset-4"
            >
              <template v-if="powProvider.isCalculating.value">
                <span class="animate-pulse" aria-hidden="true">🔒 安全计算中...</span>
              </template>
              <template v-else-if="loadingPwd">
                <span class="animate-pulse">提交中...</span>
              </template>
              <template v-else>更新账户凭证</template>
            </button>
            <div v-else
              role="alert"
              class="text-[10px] font-bold text-zinc-400 border border-zinc-100 py-4 text-center tracking-widest">
              账号受限：安全设置已锁定
            </div>
          </div>
        </el-form>
      </section>
    </div>

    <!-- 统一模态框调用 -->
    <ConfirmModal 
      v-model:visible="modalState.visible"
      :title="modalState.title"
      :content="modalState.content"
      @confirm="modalState.onConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onUnmounted } from 'vue'
import { useUserStore } from '@/store/user'
import { updateUsername, updatePassword, type UpdateUsernameDto } from '@/api/auth'
import { usePow } from '@/composables/usePow'
import { toast } from '@/utils/toast' 
// [修复 2026-02-24] 明确引入了用户名校验的独立工具，防止与评论校验混用导致规则错位
import { validateUsername } from '@/utils/contentFilter' 
import type { FormInstance } from 'element-plus'
import type { AxiosRequestConfig } from 'axios'
import ConfirmModal from '@/components/ui/ConfirmModal.vue'

const userStore = useUserStore()
const powProvider = usePow()

// 逻辑自洽：拆分 loading 状态以提供精准反馈
const loadingName = ref(false)
const loadingPwd = ref(false)

const usernameFormRef = ref<FormInstance>()
const passwordFormRef = ref<FormInstance>()

// [修复 2026-02-24] P0 修复：拆分物理控制器，杜绝并发修改时的信号覆灭
let usernameController: AbortController | null = null
let passwordController: AbortController | null = null

const usernameForm = reactive<UpdateUsernameDto>({
  newUsername: userStore.userInfo?.username || ''
})

const passwordForm = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: ''
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

// [修复 2026-02-24] P0 修复：环境探针，为不支持 ES2018 的浏览器提供正则降级方案
let USERNAME_REGEX: RegExp;
try {
  USERNAME_REGEX = new RegExp('^[\\p{Script=Han}\\p{L}\\p{N}_-]+$', 'u')
} catch {
  // 物理降级：回退到基础字符集匹配，确保模块不因 SyntaxError 崩溃
  USERNAME_REGEX = /^[\u4e00-\u9fa5A-Za-z0-9_-]+$/
}

const rules = {
  newUsername: [
    { required: true, message: '请填写新的用户名', trigger: 'blur' },
    { 
      pattern: USERNAME_REGEX, 
      message: '用户名仅允许中英文字符、数字及连字符', 
      trigger: 'blur' 
    },
    { min: 3, max: 20, message: '长度在 3 到 20 个字符', trigger: 'blur' }
  ],
  oldPassword: [{ required: true, message: '请填写当前密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请填写新密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少 6 位', trigger: 'blur' }
  ],
  confirmPassword: [ 
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

// 安全异常对象解析
const extractErrorMessage = (e: unknown): string => {
  if (!e || typeof e !== 'object') return String(e ?? '未知错误')
  const anyE = e as any
  return anyE?.response?.data?.message || anyE?.message || String(anyE)
}

// ==========================================
// 身份更新逻辑
// ==========================================

const requestUpdateUsername = async () => {
  if (!usernameFormRef.value) return

  try {
    // [修复 2026-02-24] P1 修复：统一采用 Promise 风格校验，消灭回调地狱与版本不一致
    await usernameFormRef.value.validate()
    
    // 安全性保障：使用 replace 物理清洗可能的 XSS 试探输入
    const safeName = usernameForm.newUsername.replace(/["<>]/g, '');
    triggerModal({
      title: '修改身份识别',
      content: `确定将用户名修改为 "${safeName}" 吗？这可能会影响您的展示名称。`,
      onConfirm: handleUpdateUsername
    })
  } catch (err) {
    // 校验未通过，静默处理，ElementPlus 会自行展示错误气泡
  }
}

const handleUpdateUsername = async () => {
  // [修复 2026-02-24] P1 修复：引入了专用的用户名初审逻辑，确保规则语境统一
  const nameCheck = validateUsername(usernameForm.newUsername);
  if (!nameCheck.isValid) {
    toast.error(`用户名违规：${nameCheck.message}`);
    return;
  }

  if (usernameController) usernameController.abort()
  const currentController = new AbortController()
  usernameController = currentController
  const currentSignal = currentController.signal

  loadingName.value = true
  
  try {
    const payload = { newUsername: usernameForm.newUsername.trim() }
    
    await updateUsername(payload, { signal: currentSignal })
    
    if (!currentSignal.aborted) {
      // [修复 2026-02-24] P0 修复：废弃本地乐观更新，强制同步后端真实数据
      // 理由：后端可能有更严格的大小写重整、特殊字符过滤或缓存同步策略
      await userStore.fetchUserInfo(true);
      toast.success('用户名已同步更新')
    }
  } catch (error: unknown) {
    if ((error as any)?.name === 'AbortError') return
    toast.error(extractErrorMessage(error) || '用户名修改失败')
  } finally {
    if (usernameController === currentController) {
      loadingName.value = false
      usernameController = null
    }
  }
}

// ==========================================
// 密码更新逻辑
// ==========================================

const requestUpdatePassword = async () => {
  if (!passwordFormRef.value) return
  
  try {
    await passwordFormRef.value.validate()
    triggerModal({
      title: '更新安全凭证',
      content: '确定要重置您的登录密码吗？更新成功后，系统将要求您重新登录。',
      onConfirm: handleUpdatePassword
    })
  } catch (err) {
    // 校验未通过
  }
}

/**
 * 核心改造：带 PoW 验证的密码更新流程
 * 架构演进：全量废弃手动 PoW 计算，对接自动化拦截器
 */
const handleUpdatePassword = async () => {
  if (loadingPwd.value || powProvider.isCalculating.value) return
  
  if (passwordController) passwordController.abort()
  const currentController = new AbortController()
  passwordController = currentController
  const currentSignal = currentController.signal

  loadingPwd.value = true

  try {
    const payload = {
      oldPassword: passwordForm.oldPassword,
      newPassword: passwordForm.newPassword,
      confirmPassword: passwordForm.confirmPassword
    }

    // 由拦截器自动拦截请求、请求难度、调用 worker 并注入头部
    await updatePassword(payload as any, { 
        signal: currentSignal,
        requiresPow: true 
    } as AxiosRequestConfig)
    
    if (!currentSignal.aborted) {
      // 清空敏感数据
      passwordForm.oldPassword = ''
      passwordForm.newPassword = ''
      passwordForm.confirmPassword = ''

      // [修复 2026-02-24] P1 修复：确保提示能够被用户读完，再执行带有页面硬重载属性的注销操作
      toast.success('密码已重置，请重新登录')
      
      setTimeout(async () => {
        await userStore.logout()
      }, 2000)
    }

  } catch (error: unknown) {
    if ((error as any)?.name === 'AbortError') return
    const msg = extractErrorMessage(error)
    
    if (msg.includes('POW_CALCULATION_TIMEOUT')) {
       toast.error('安全环境响应超时，请刷新页面重试')
    } else {
       toast.error(msg || '密码修改失败')
    }
  } finally {
    if (passwordController === currentController) {
      loadingPwd.value = false
      passwordController = null
    }
  }
}

onUnmounted(() => {
  // 组件卸载时物理释放两路正在挂起的网络请求
  if (usernameController) usernameController.abort()
  if (passwordController) passwordController.abort()
})
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
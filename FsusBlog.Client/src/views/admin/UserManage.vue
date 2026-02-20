<template>
  <div class="user-manage-wrapper">
    <el-card shadow="never" class="action-card mb-4 sm:mb-5 border-none rounded-xl">
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 px-1">
        <div class="header-info">
          <h2 class="text-lg sm:text-xl font-bold text-zinc-800 tracking-tight flex items-center gap-2">
            用户管理
            <el-tag size="small" type="info" effect="plain" class="rounded-full border-zinc-200 text-zinc-400">
              Total: {{ total }}
            </el-tag>
          </h2>
          <p class="text-[11px] sm:text-[12px] text-zinc-400 mt-1 italic font-medium flex items-center gap-1">
            高危操作受 PoW 算力盾保护
          </p>
        </div>

        <div class="flex flex-wrap sm:flex-nowrap gap-2 w-full sm:w-auto">
          <el-select 
            v-model="queryParams.status" 
            placeholder="状态" 
            clearable 
            class="w-24 flex-1 sm:flex-none"
            @change="handleSearch"
          >
            <el-option label="正常" :value="0" />
            <el-option label="已封禁" :value="1" />
          </el-select>
          
          <el-input
            v-model="queryParams.keyword"
            placeholder="搜用户名..."
            clearable
            @clear="handleSearch"
            @keyup.enter="handleSearch"
            class="w-full sm:w-48 lg:w-64 flex-2 sm:flex-none"
          >
            <template #prefix>
              <el-icon class="text-zinc-400"><Search /></el-icon>
            </template>
          </el-input>
          
          <el-button type="primary" icon="Search" @click="handleSearch" class="shadow-md shadow-blue-50">
            查询
          </el-button>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" class="list-card border-none rounded-xl overflow-hidden min-h-125">
      <el-table 
        v-loading="loading" 
        :data="list" 
        :row-key="(row: UserListItem) => row.id"
        stripe 
        style="width: 100%"
        class="user-table"
      >
        <el-table-column prop="id" label="ID" min-width= 'max-content' align="center" class-name="font-mono text-zinc-300 hidden sm:table-cell" />
        
        <el-table-column label="用户" min-width="500">
          <template ] #default="{ row }: { row: UserListItem }">
            <div class="flex items-center gap-3 whitespace-nowrap overflow-visible">
              <el-avatar :size="32" class="bg-zinc-100 text-zinc-400 font-bold shrink-0">
                {{ row.username.substring(0, 2).toUpperCase() }}
              </el-avatar>
              <div class="flex flex-col justify-center">
                <div min-width= 'max-content' class="font-bold text-zinc-700 text-sm leading-tight">
                  {{ row.username }}
                </div>
                <div min-width= 'max-content' class="text-[10px] text-zinc-400 font-mono mt-0.5">
                  {{ row.createTime }} 注册
                </div>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column prop="role" label="角色" min-width= 'max-content' align="center">
          <template #default="{ row }: { row: UserListItem }">
            <span class="text-[10px] font-black italic uppercase" :class="row.role==='admin'?'text-red-500':'text-zinc-400'">
               {{ row.role === 'admin' ? 'ADM' : 'USR' }}
            </span>
          </template>
        </el-table-column>

        <el-table-column label="最后活动" width="160">
          <template #default="{ row }: { row: UserListItem }">
            <div v-if="row.lastLoginTime" class="flex flex-col whitespace-nowrap">
              <span class="text-[11px] text-zinc-600 font-mono">{{ row.lastLoginTime }}</span>
              <span class="text-[10px] text-zinc-300 font-mono flex items-center gap-1">
                <el-icon class="text-[8px]"><Location /></el-icon> {{ row.lastLoginIp }}
              </span>
            </div>
            <span v-else class="text-zinc-300 text-[11px] italic">--</span>
          </template>
        </el-table-column>

        <el-table-column prop="status" label="状态" width="80" align="center">
          <template #default="{ row }: { row: UserListItem }">
            <div class="flex flex-col items-center justify-center">
              <div 
                class="w-1.5 h-1.5 rounded-full mb-1" 
                :class="row.status === 0 ? 'bg-emerald-400' : 'bg-red-400'"
              ></div>
              <span class="text-[10px] font-bold" :class="row.status === 0 ? 'text-emerald-600' : 'text-red-500'">
                {{ row.status === 0 ? 'NORMAL' : 'BANNED' }}
              </span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="操作选项" width="120" align="right" :fixed="isMobile ? false : 'right'">
          <template #default="{ row }: { row: UserListItem }">
            <div class="flex justify-end items-center gap-1 pr-1" v-if="row.role !== 'admin'">
              <el-button link type="primary" icon="Key" @click="openResetDialog(row)" :disabled="isPowCalculating" size="small" />
              <el-divider direction="vertical" class="mx-0.5" />
              <el-button 
                link 
                :type="row.status === 0 ? 'danger' : 'success'" 
                :icon="row.status === 0 ? 'CircleClose' : 'CircleCheck'"
                size="small"
                :loading="processingId === row.id && isPowCalculating"
                @click="handleToggleStatus(row)"
              >
                {{ row.status === 0 ? '封禁' : '解封' }}
              </el-button>
            </div>
            <span v-else class="text-zinc-300 text-[9px] italic pr-2">PROTECTED</span>
          </template>
        </el-table-column>
      </el-table>

      <div class="flex justify-end mt-6 mb-2 px-2 sm:px-4">
        <el-pagination
          v-model:current-page="queryParams.page"
          v-model:page-size="queryParams.pageSize"
          :total="total"
          :pager-count="5"
          :layout="isMobile ? 'prev, next' : 'total, sizes, prev, pager, next'"
          background
          @size-change="fetchData"
          @current-change="fetchData"
          class="custom-pagination"
        />
      </div>
    </el-card>

    <el-dialog 
      v-model="resetDialog.visible" 
      title="高危操作：强制重置密码" 
      width="90%" 
      style="max-width: 420px"
      append-to-body
      class="custom-dialog rounded-2xl"
    >
      <div class="pt-1">
        <div class="mb-4 p-3 bg-red-50 border border-red-100 rounded-lg flex gap-3">
          <el-icon class="text-red-500 mt-0.5 shrink-0"><WarningFilled /></el-icon>
          <div class="text-[12px] text-red-600 leading-relaxed">
            <p class="font-bold mb-1">警告：该操作将记录审计日志</p>
            <p>重置后，用户 <span class="font-bold underline">{{ resetDialog.targetUser?.username }}</span> 将被强制踢出所有在线会话。</p>
          </div>
        </div>

        <el-form :model="resetDialog.form" @submit.prevent="handleResetSubmit" label-position="top">
          <el-form-item label="设置新登录密码" required>
            <el-input 
              v-model="resetDialog.form.newPassword" 
              placeholder="请输入 6 位以上密码" 
              show-password
              size="large"
            />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <div class="flex gap-3">
          <el-button @click="resetDialog.visible = false" class="flex-1 rounded-xl">取消</el-button>
          <el-button 
            type="danger" 
            class="flex-1 rounded-xl font-bold" 
            :loading="isResetting && isPowCalculating" 
            @click="handleResetSubmit"
          >
            {{ isResetting && isPowCalculating ? '验证中...' : '确认重置' }}
          </el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog 
      v-model="banDialog.visible" 
      title="账号封禁处理" 
      width="90%" 
      style="max-width: 400px"
      class="custom-dialog rounded-2xl"
    >
      <div class="pt-1">
        <div class="mb-4 flex items-center gap-3 p-3 bg-zinc-50 rounded-lg">
          <el-avatar :size="32">{{ banDialog.targetUser?.username.substring(0,2).toUpperCase() }}</el-avatar>
          <span class="font-bold text-zinc-700">{{ banDialog.targetUser?.username }}</span>
        </div>

        <el-form label-position="top">
          <el-form-item label="封禁原因 (将公示给用户)">
            <el-select v-model="banDialog.reason" placeholder="请选择或输入理由" allow-create filterable>
              <el-option v-for="item in banDialog.quickReasons" :key="item" :label="item" :value="item" />
            </el-select>
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <div class="flex gap-3">
          <el-button @click="banDialog.visible = false" class="flex-1 rounded-xl">取消</el-button>
          <el-button 
            type="danger" 
            class="flex-1 rounded-xl font-bold" 
            :loading="isPowCalculating && processingId === banDialog.targetUser?.id"
            @click="handleBanSubmit"
          >
            确认封禁
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue'
import { ElMessageBox, ElMessage } from 'element-plus'
import { 
  getAdminUserList, 
  adminChangeStatus, 
  adminResetPassword, 
  type UserListItem, 
  type UserQueryDto 
} from '@/api/admin'
import { getPowChallenge } from '@/api/auth'
import { usePow } from '@/composables/usePow'

// 导入所有必要图标，修复 [Vue warn]
import { 
  Search, 
  Location,
  WarningFilled 
} from '@element-plus/icons-vue'

// === 移动端响应式监测 ===
const screenWidth = ref(window.innerWidth)
const updateWidth = () => { screenWidth.value = window.innerWidth }
onMounted(() => window.addEventListener('resize', updateWidth))
onUnmounted(() => window.removeEventListener('resize', updateWidth))

const isMobile = computed(() => screenWidth.value < 768)

// === 状态定义 ===
const loading = ref(false)
const list = ref<UserListItem[]>([])
const total = ref(0)
const queryParams = reactive<UserQueryDto>({
  page: 1,
  pageSize: 20,
  keyword: '',
  status: undefined
})

const { calculate, isCalculating: isPowCalculating, prewarm } = usePow()

const processingId = ref<number | null>(null)
const isResetting = ref(false)

const resetDialog = reactive({
  visible: false,
  targetUser: null as UserListItem | null,
  form: {
    newPassword: ''
  }
})

const banDialog = reactive({
  visible: false,
  targetUser: null as UserListItem | null,
  reason: '',
  quickReasons: ['发布违规内容', '恶意刷屏/垃圾信息', '账号安全异常', '违反社区准则']
})

// === 核心逻辑 ===
onMounted(() => {
  prewarm()
  fetchData()
})

const fetchData = async () => {
  loading.value = true
  try {
    const res = await getAdminUserList(queryParams)
    list.value = res.items
    total.value = res.total
  } finally {
    loading.value = false
  }
}

const handleSearch = () => {
  queryParams.page = 1
  fetchData()
}

/**
 * 高危操作 PoW 校验
 */
const executeWithPow = async (): Promise<any> => {
  const browserFp = btoa(window.navigator.userAgent).substring(0, 16) + window.screen.width
  const res = await getPowChallenge({ action: 'admin_sensitive' } as any) as any
  
  const challenge = {
    powSalt: res.salt || res.Salt || res.powSalt,
    powSignature: res.signature || res.Signature || res.powSignature,
    difficulty: res.difficulty || res.Difficulty,
    powTimestamp: res.timestamp || res.Timestamp || res.powTimestamp
  }

  const powResult = await calculate(challenge.powSalt, browserFp, challenge.difficulty)

  return {
    ...challenge,
    powNonce: powResult.nonce,
    browserFp
  }
}

/**
 * 状态切换入口 (分流逻辑)
 */
const handleToggleStatus = async (row: UserListItem) => {
  if (row.status === 0) {
    // 🌟 场景 A：执行封禁
    // 不直接弹确认框，而是打开包含“理由选择”的对话框
    banDialog.targetUser = row
    banDialog.reason = '' // 重置理由
    banDialog.visible = true
  } else {
    // 🌟 场景 B：执行解封
    // 维持原有逻辑：直接弹出确认框并验证 PoW
    try {
      await ElMessageBox.confirm(
        `确定要为用户 "${row.username}" 解除封禁吗？恢复后该用户将重新获得访问权限。`,
        '系统操作确认',
        {
          confirmButtonText: '确认并验证算力',
          cancelButtonText: '取消',
          type: 'info'
        }
      )

      processingId.value = row.id 
      const powData = await executeWithPow()

      await adminChangeStatus({
        userId: row.id,
        status: 0, // 解封
        ...powData
      })

      ElMessage.success(`用户 ${row.username} 已成功解封`)
      fetchData()
    } catch (err: any) {
      if (err === 'cancel') return
      ElMessage.error(err.message || '操作失败')
    } finally {
      processingId.value = null
    }
  }
}

/**
 * 提交封禁请求
 */
const handleBanSubmit = async () => {
  if (!banDialog.targetUser) return
  
  // 理由必填校验 (UI 体验加固)
  if (!banDialog.reason.trim()) {
    ElMessage.warning('请选择或输入封禁理由，该理由将同步给被封禁用户')
    return
  }

  processingId.value = banDialog.targetUser.id
  
  try {
    // 1. 验证 PoW 算力 (高危操作防护)
    const powData = await executeWithPow()

    // 2. 调用 API 同步后端 B4 权限元数据更新
    await adminChangeStatus({
      userId: banDialog.targetUser.id,
      status: 1, // 封禁状态
      reason: banDialog.reason, // 携带理由透传
      ...powData
    })

    // 3. 成功后处理
    ElMessage.success(`用户 ${banDialog.targetUser.username} 已被强制封禁`)
    banDialog.visible = false
    fetchData() // 刷新列表状态
  } catch (err: any) {
    ElMessage.error(err.message || '封禁操作执行异常')
  } finally {
    processingId.value = null
  }
}

const openResetDialog = (row: UserListItem) => {
  resetDialog.targetUser = row
  resetDialog.form.newPassword = '' 
  resetDialog.visible = true
}

const handleResetSubmit = async () => {
  if (!resetDialog.form.newPassword || resetDialog.form.newPassword.length < 6) {
    ElMessage.warning('密码安全性不足（需6位以上）')
    return
  }
  
  if (!resetDialog.targetUser) return

  isResetting.value = true
  try {
    const powData = await executeWithPow()
    await adminResetPassword({
      userId: resetDialog.targetUser.id,
      newPassword: resetDialog.form.newPassword,
      ...powData
    })
    ElMessage.success('密码重置成功')
    resetDialog.visible = false
  } catch (err: any) {
    ElMessage.error(err.message || '操作失败')
  } finally {
    isResetting.value = false
  }
}
</script>

<style scoped>
@reference "@/assets/main.css";

/* 移动端横向滑动优化 */
.user-table :deep(.el-table__body-wrapper) {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

:deep(.el-table__inner-wrapper::before) {
  display: none;
}

:deep(.el-tag--dark.el-tag--danger) {
  background-color: #fecaca;
  border-color: #fecaca;
  color: #991b1b;
}

/* 分页页码样式微调 */
.custom-pagination :deep(.el-pager li) {
  background-color: transparent;
  color: #71717a;
  font-weight: 500;
}

.custom-pagination :deep(.el-pager li.is-active) {
  background-color: #3b82f6 !important;
  color: white !important;
  font-weight: 800;
}
</style>
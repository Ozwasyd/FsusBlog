<template>
  <div class="message-manage-wrapper">
    <!-- 头部操作面板 -->
    <el-card shadow="never" class="action-card mb-5 border-none rounded-xl">
      <div class="flex justify-between items-center px-2">
        <div class="header-info">
          <h2 class="text-xl font-bold text-zinc-800 tracking-tight flex items-center gap-2">
            站内信分发中心
            <el-tag size="small" type="primary" effect="dark" class="rounded-full border-none bg-zinc-950 tabular-nums">
              Admin
            </el-tag>
          </h2>
          <p class="text-[12px] text-zinc-400 mt-1 italic font-medium">
            安全提示：全站广播及撤回操作属于高危动作，将触发强制算力校验机制。
          </p>
        </div>
      </div>
    </el-card>

    <el-row :gutter="20">
      <el-col :md="10" :sm="24">
        <!-- 分发控制台 -->
        <el-card shadow="never" class="border-none rounded-xl p-2 mb-5">
          <el-form 
            ref="formRef" 
            :model="form" 
            :rules="rules" 
            label-position="top"
            @submit.prevent
          >
            <el-form-item label="分发模式" for="distribution-mode">
              <el-radio-group 
                v-model="sendType" 
                id="distribution-mode" 
                class="custom-radio"
                :disabled="isProcessing"
              >
                <el-radio-button value="broadcast">全站公告</el-radio-button>
                <el-radio-button value="direct">定向私信</el-radio-button>
              </el-radio-group>
            </el-form-item>

            <el-form-item 
              v-if="sendType === 'direct'" 
              label="目标用户 ID (UID)" 
              prop="targetUserId"
            >
              <el-input 
                v-model.trim="form.targetUserId" 
                placeholder="请输入接收者的数字 ID" 
                size="large" 
                clearable 
                :disabled="isProcessing"
              />
            </el-form-item>

            <el-form-item label="消息标题" prop="title">
              <el-input 
                v-model="form.title" 
                placeholder="输入消息摘要" 
                maxlength="50" 
                show-word-limit 
                size="large" 
                :disabled="isProcessing"
              />
            </el-form-item>

            <el-form-item label="消息内容" prop="content">
              <el-input 
                v-model="form.content" 
                type="textarea" 
                :rows="4" 
                placeholder="支持文本分段..." 
                resize="none" 
                maxlength="2000"
                show-word-limit
                :disabled="isProcessing"
              />
            </el-form-item>

            <el-button 
              type="primary" 
              class="w-full h-12 rounded-xl font-bold bg-zinc-950 border-none mt-4 transition-all" 
              :loading="isProcessing" 
              :disabled="broadcastCooldown > 0"
              @click="submitForm"
            >
              <template v-if="powProvider.isCalculating.value">
                安全计算中...
              </template>
              <template v-else-if="broadcastCooldown > 0 && sendType === 'broadcast'">
                广播冷却中 ({{ broadcastCooldown }}s)
              </template>
              <template v-else>
                {{ sendType === 'broadcast' ? '立即全站广播' : '确认发送私信' }}
              </template>
            </el-button>
          </el-form>
        </el-card>

        <!-- 最近分发记录 -->
        <el-card shadow="never" class="border-none rounded-xl p-2">
          <div class="flex justify-between items-center mb-4">
            <h3 class="text-sm font-bold text-zinc-800">最近分发记录</h3>
            <el-button link :icon="Refresh" @click="fetchHistory" :loading="loadingHistory" class="outline-none" />
          </div>
          <div v-loading="loadingHistory" class="history-list min-h-60">
            <!-- [修复 2026-02-24] 修正模板嵌套结构，确保标签闭合自洽 -->
            <template v-if="history.length > 0">
              <div 
                v-for="item in history" 
                :key="item.id" 
                class="history-item flex items-center justify-between p-3 mb-2 rounded-lg bg-zinc-50 border border-zinc-100 hover:border-zinc-200 transition-all"
              >
                <div class="flex-1 min-w-0 mr-4">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-zinc-200 text-zinc-600 font-bold scale-90 origin-left select-none">
                      {{ item.category === 1 ? '公告' : '私信' }}
                    </span>
                    <span class="text-xs font-bold text-zinc-700 truncate">{{ item.title }}</span>
                  </div>
                  <p class="text-[10px] text-zinc-400 tabular-nums">
                    {{ TimeUtils.toFullLocalString(item.createTime) }}
                  </p>
                </div>
                <el-popconfirm 
                  title="确认撤回此消息？该操作将从全网所有接收者的收件箱中物理抹除记录，并触发算力验证。" 
                  @confirm="handleRevoke(item.id)"
                  confirm-button-text="强制撤回"
                  cancel-button-text="保留"
                  width="220"
                >
                  <template #reference>
                    <el-button type="danger" link :icon="Delete" :disabled="isProcessing" class="outline-none" />
                  </template>
                </el-popconfirm>
              </div>
            </template>
            <el-empty v-else-if="!loadingHistory" :image-size="40" description="暂无发送记录" />
          </div>
        </el-card>
      </el-col>

      <el-col :md="14" :sm="24">
        <!-- 预览面板 -->
        <div class="preview-box h-full flex flex-col justify-center items-center bg-white border border-dashed border-zinc-200 rounded-2xl min-h-125 p-10">
          <div v-if="!form.title && !form.content" class="text-center opacity-20 select-none">
            <el-icon size="64"><ChatLineSquare /></el-icon>
            <p class="text-sm font-bold mt-4 uppercase tracking-widest">Preview Area</p>
          </div>
          <div v-else class="w-full max-w-md animate-in fade-in zoom-in-95 duration-500">
             <div class="preview-card bg-white p-8 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.05)]">
               <div class="flex justify-between items-center mb-6 select-none">
                 <span class="text-[8px] font-black px-2 py-0.5 rounded-sm bg-zinc-950 text-white uppercase tracking-widest">
                   {{ sendType === 'broadcast' ? 'Announcement' : 'Private Notice' }}
                 </span>
                 <span v-if="sendType === 'direct'" class="text-[9px] font-mono text-zinc-400">UID: {{ form.targetUserId || '?' }}</span>
               </div>
               <h4 class="text-base font-bold mb-3 wrap-break-word">{{ form.title || '标题预览' }}</h4>
               <p class="text-xs text-zinc-500 whitespace-pre-wrap wrap-break-word">{{ form.content || '内容预览...' }}</p>
             </div>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, watch, computed, onUnmounted, shallowRef } from 'vue'
import { ElMessage, type FormInstance } from 'element-plus'
import { Refresh, Delete, ChatLineSquare } from '@element-plus/icons-vue'
import { messageApi, type MessageItem } from '@/api/message'
import { TimeUtils } from '@/utils/time'
import { usePow } from '@/composables/usePow'
import type { AxiosRequestConfig } from 'axios'

const formRef = ref<FormInstance>()
const powProvider = usePow()

// 状态控制
const submitting = ref(false)
const loadingHistory = ref(false)
const lastBroadcastTime = ref(0) 
const currentTime = ref(Date.now())

const broadcastCooldown = computed(() => {
  if (lastBroadcastTime.value === 0) return 0
  const remaining = Math.ceil((lastBroadcastTime.value + 10000 - currentTime.value) / 1000)
  return remaining > 0 ? remaining : 0
})

const isProcessing = computed(() => submitting.value || powProvider.isCalculating.value)

const sendType = ref<'broadcast' | 'direct'>('broadcast')
const history = shallowRef<MessageItem[]>([])

const form = reactive({
  targetUserId: '',
  title: '',
  content: ''
})

let historyAbortController: AbortController | null = null
let submitAbortController: AbortController | null = null
let cooldownTimer: ReturnType<typeof setInterval> | null = null

watch(sendType, () => {
  formRef.value?.clearValidate('targetUserId')
})

const rules = {
  targetUserId: [
    { required: true, message: '必须指定接收者', trigger: 'blur' },
    { pattern: /^\d+$/, message: 'UID必须为纯数字', trigger: 'blur' }
  ],
  title: [
    { required: true, message: '标题不能为空', trigger: 'blur' },
    { pattern: /^[^<|>|'|"]+$/, message: '禁止包含 HTML 标签', trigger: 'blur' }
  ],
  content: [
    { required: true, message: '内容不能为空', trigger: 'blur' },
    { max: 2000, message: '内容长度不得超过 2000 字符', trigger: 'blur' }
  ]
}

/**
 * [修复 2026-02-24] 物理级防御错误对象解析
 */
const extractErrorMessage = (e: unknown): string => {
  if (!e || typeof e !== 'object') return String(e ?? '未知错误')
  const anyE = e as any
  return anyE?.response?.data?.message || anyE?.message || String(anyE)
}

const fetchHistory = async () => {
  if (historyAbortController) historyAbortController.abort()
  const currentController = new AbortController()
  historyAbortController = currentController
  const { signal } = currentController

  loadingHistory.value = true
  try {
    const res = await messageApi.adminGetHistory(1, 15, { signal } as AxiosRequestConfig)
    if (historyAbortController === currentController) {
      history.value = Array.isArray(res) ? res : []
    }
  } catch (error: any) {
    if (error.name !== 'AbortError' && historyAbortController === currentController) {
      console.error('[Admin Message] Sync failed:', error)
    }
  } finally {
    if (historyAbortController === currentController) {
      loadingHistory.value = false
      historyAbortController = null
    }
  }
}

const handleRevoke = async (id: string) => {
  if (isProcessing.value) return
  
  let currentController: AbortController | null = null
  submitting.value = true

  if (submitAbortController) submitAbortController.abort()
  currentController = new AbortController()
  submitAbortController = currentController
  const { signal } = currentController

  try {
    await messageApi.adminRevokeMessage(id, { signal } as AxiosRequestConfig)
    if (!signal.aborted) {
      ElMessage.success('消息已彻底从全网撤回')
      await fetchHistory()
    }
  } catch (err: any) {
    if (err.name !== 'AbortError' && submitAbortController === currentController) {
      console.error('[Admin Message] Revoke Error:', err)
    }
  } finally {
    if (submitAbortController === currentController) {
      submitting.value = false
      submitAbortController = null
    }
  }
}

const submitForm = async () => {
  if (!formRef.value || isProcessing.value) return
  if (sendType.value === 'broadcast' && broadcastCooldown.value > 0) return
  
  let currentController: AbortController | null = null
  
  try {
    await formRef.value.validate()
    submitting.value = true
    
    if (submitAbortController) submitAbortController.abort()
    currentController = new AbortController()
    submitAbortController = currentController
    const { signal } = currentController

    const payload = {
      title: form.title.trim(),
      content: form.content.trim()
    }

    const config: AxiosRequestConfig = { signal }

    if (sendType.value === 'broadcast') {
      await messageApi.adminPublishBroadcast(payload, config)
      lastBroadcastTime.value = Date.now()
    } else {
      await messageApi.adminSendDirect({ 
        ...payload, 
        targetUserId: form.targetUserId 
      }, config)
    }
    
    if (submitAbortController === currentController) {
      ElMessage.success('指令执行成功')
      form.title = ''; form.content = ''; form.targetUserId = ''
      formRef.value.resetFields()
      await fetchHistory() 
    }
  } catch (err: any) {
    if (err.name !== 'AbortError' && err !== 'cancel' && submitAbortController === currentController) {
      console.error('[Admin Message] Distribution Error:', extractErrorMessage(err))
    }
  } finally {
    if (submitAbortController === currentController) {
      submitting.value = false
      submitAbortController = null
    }
  }
}

onMounted(() => {
  fetchHistory()
  powProvider.prewarm()
  cooldownTimer = setInterval(() => {
    currentTime.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (historyAbortController) historyAbortController.abort()
  if (submitAbortController) submitAbortController.abort()
  if (cooldownTimer) clearInterval(cooldownTimer)
})
</script>

<style scoped>
@reference "@/assets/main.css";

.message-manage-wrapper {
  animation: slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.history-item {
  animation: slide-in 0.3s ease-out;
}

@keyframes slide-in {
  from { opacity: 0; transform: translateX(-10px); }
  to { opacity: 1; transform: translateX(0); }
}

.preview-card {
  transition: transform 0.2s ease;
}

:deep(.el-radio-button__inner) {
  border-radius: 8px !important;
  margin-right: 8px;
  border: 1px solid #e4e4e7 !important;
  background: #f4f4f5;
  color: #71717a;
}

:deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background-color: #09090b !important;
  border-color: #09090b !important;
  color: white !important;
  box-shadow: none !important;
}

.wrap-break-word {
  overflow-wrap: break-word;
  word-break: break-word;
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
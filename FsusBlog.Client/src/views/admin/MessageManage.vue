<template>
  <div class="message-manage-wrapper">
    <el-card shadow="never" class="action-card mb-5 border-none rounded-xl">
      <div class="flex justify-between items-center px-2">
        <div class="header-info">
          <h2 class="text-xl font-bold text-zinc-800 tracking-tight flex items-center gap-2">
            站内信分发中心
            <el-tag size="small" type="primary" effect="dark" class="rounded-full border-none bg-zinc-950">Admin</el-tag>
          </h2>
          <p class="text-[12px] text-zinc-400 mt-1 italic font-medium">支持全站实时广播及用户点对点精准通知</p>
        </div>
      </div>
    </el-card>

    <el-row :gutter="20">
      <el-col :md="10" :sm="24">
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
              />
            </el-form-item>

            <el-form-item label="消息标题" prop="title">
              <el-input 
                v-model="form.title" 
                placeholder="输入消息摘要" 
                maxlength="50" 
                show-word-limit 
                size="large" 
              />
            </el-form-item>

            <el-form-item label="消息内容" prop="content">
              <el-input 
                v-model="form.content" 
                type="textarea" 
                :rows="4" 
                placeholder="支持文本分段..." 
                resize="none" 
              />
            </el-form-item>

            <el-button 
              type="primary" 
              class="w-full h-12 rounded-xl font-bold bg-zinc-950 border-none mt-4" 
              :loading="submitting" 
              @click="submitForm"
            >
              {{ sendType === 'broadcast' ? '立即全站广播' : '确认发送私信' }}
            </el-button>
          </el-form>
        </el-card>

        <el-card shadow="never" class="border-none rounded-xl p-2">
          <div class="flex justify-between items-center mb-4">
            <h3 class="text-sm font-bold text-zinc-800">最近分发记录</h3>
            <el-button link :icon="Refresh" @click="fetchHistory" :loading="loadingHistory" />
          </div>
          <div v-loading="loadingHistory" class="history-list min-h-60">
            <div 
              v-for="item in history" 
              :key="item.id" 
              class="history-item flex items-center justify-between p-3 mb-2 rounded-lg bg-zinc-50 border border-zinc-100 hover:border-zinc-200 transition-all"
            >
              <div class="flex-1 min-w-0 mr-4">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-[10px] px-1.5 py-0.5 rounded bg-zinc-200 text-zinc-600 font-bold scale-90 origin-left">
                    {{ item.category === 1 ? '公告' : '私信' }}
                  </span>
                  <span class="text-xs font-bold text-zinc-700 truncate">{{ item.title }}</span>
                </div>
                <p class="text-[10px] text-zinc-400">{{ item.createTime }}</p>
              </div>
              <el-popconfirm title="确认撤回此消息？撤回后所有终端将不再可见" @confirm="handleRevoke(item.id)">
                <template #reference>
                  <el-button type="danger" link :icon="Delete" />
                </template>
              </el-popconfirm>
            </div>
            <el-empty v-if="history.length === 0" :image-size="40" description="暂无发送记录" />
          </div>
        </el-card>
      </el-col>

      <el-col :md="14" :sm="24">
        <div class="preview-box h-full flex flex-col justify-center items-center bg-white border border-dashed border-zinc-200 rounded-2xl min-h-125 p-10">
          <div v-if="!form.title && !form.content" class="text-center opacity-20">
            <el-icon size="64"><ChatLineSquare /></el-icon>
            <p class="text-sm font-bold mt-4 uppercase tracking-widest">Preview Area</p>
          </div>
          <div v-else class="w-full max-w-md">
             <div class="preview-card bg-white p-8 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.05)]">
               <div class="flex justify-between items-center mb-6">
                 <span class="text-[8px] font-black px-2 py-0.5 rounded-sm bg-zinc-950 text-white uppercase">
                   {{ sendType === 'broadcast' ? 'Announcement' : 'Private Notice' }}
                 </span>
               </div>
               <h4 class="text-base font-bold mb-3 break-all">{{ form.title || '标题预览' }}</h4>
               <p class="text-xs text-zinc-500 whitespace-pre-wrap break-all">{{ form.content || '内容预览...' }}</p>
             </div>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, watch } from 'vue'
import { ElMessage, type FormInstance } from 'element-plus'
import { Refresh, Delete, ChatLineSquare } from '@element-plus/icons-vue'
import { messageApi, type MessageItem } from '@/api/message'

const formRef = ref<FormInstance>()
const submitting = ref(false)
const loadingHistory = ref(false)
const sendType = ref<'broadcast' | 'direct'>('broadcast')
const history = ref<MessageItem[]>([])

const form = reactive({
  targetUserId: '',
  title: '',
  content: ''
})

// 逻辑自洽：切换模式时清除特定字段校验，保障安全性与用户体验
watch(sendType, () => {
  formRef.value?.clearValidate('targetUserId')
})

const rules = {
  targetUserId: [
    { required: true, message: '必须指定接收者', trigger: 'blur' },
    { pattern: /^\d+$/, message: 'UID必须为数字', trigger: 'blur' }
  ],
  title: [{ required: true, message: '标题不能为空', trigger: 'blur' }],
  content: [{ required: true, message: '内容不能为空', trigger: 'blur' }]
}

// 获取历史记录 - 增加并发控制优化
const fetchHistory = async () => {
  if (loadingHistory.value) return
  loadingHistory.value = true
  try {
    // 假设 API 返回符合 MessageItem[]
    const res = await messageApi.adminGetHistory(1, 15)
    history.value = res || []
  } catch (error) {
    console.error('Fetch error:', error)
  } finally {
    loadingHistory.value = false
  }
}

// 撤回消息
const handleRevoke = async (id: string) => {
  try {
    await messageApi.adminRevokeMessage(id)
    ElMessage.success('消息已撤回')
    await fetchHistory()
  } catch (err) {
    // 错误由拦截器处理
  }
}

const submitForm = async () => {
  if (!formRef.value || submitting.value) return
  
  try {
    await formRef.value.validate()
    submitting.value = true
    
    const payload = {
      title: form.title.trim(),
      content: form.content.trim()
    }

    if (sendType.value === 'broadcast') {
      await messageApi.adminPublishBroadcast(payload)
    } else {
      await messageApi.adminSendDirect({ 
        ...payload, 
        targetUserId: form.targetUserId 
      })
    }
    
    ElMessage.success('发送成功')
    // 重置表单，保留逻辑一致性
    form.title = ''; form.content = ''; form.targetUserId = ''
    formRef.value.resetFields()
    await fetchHistory() 
  } catch (err) {
    // 校验失败或请求失败
  } finally {
    submitting.value = false
  }
}

onMounted(fetchHistory)
</script>

<style scoped>
.history-item {
  animation: slide-in 0.3s ease-out;
}

@keyframes slide-in {
  from { opacity: 0; transform: translateX(-10px); }
  to { opacity: 1; transform: translateX(0); }
}

/* 性能：使用 transform 而非 margin 动画提升渲染效率 */
.preview-card {
  transition: transform 0.2s ease;
}

/* 保持一致的样式风格 */
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
</style>
<template>
  <div class="tag-manage-wrapper">
    <!-- 头部操作面板 -->
    <el-card shadow="never" class="action-card mb-5 border-none rounded-xl">
      <div class="flex justify-between items-center px-2">
        <div class="header-info">
          <h2 class="text-xl font-bold text-zinc-800 tracking-tight flex items-center gap-2">
            标签管理
            <el-tag size="small" type="info" effect="plain" class="rounded-full border-zinc-200 text-zinc-400 tabular-nums">
              {{ list.length }}
            </el-tag>
          </h2>
          <p class="text-[12px] text-zinc-400 mt-1 italic font-medium">
            维护博文索引关键词，高危操作将触发强制算力校验
          </p>
        </div>
        <el-button 
          type="primary" 
          size="large" 
          @click="openDialog()" 
          class="px-8 shadow-lg shadow-blue-50 transition-transform active:scale-95"
        >
          <el-icon class="mr-1"><Plus /></el-icon>创建标签
        </el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="list-card border-none rounded-xl overflow-hidden">
      <!-- 表格区域 -->
      <el-table 
        v-loading="loading" 
        :data="list" 
        :row-key="(row: TagItem) => row.id"
        stripe 
        class="tag-table w-full"
      >
        <el-table-column 
          prop="id" 
          label="ID" 
          width="100" 
          align="center" 
          class-name="font-mono text-zinc-300 hidden-sm-and-down" 
        />
        
        <el-table-column prop="name" label="标签名称">
          <template #default="{ row }: { row: TagItem }">
            <el-tag 
              size="default" 
              type="primary" 
              effect="plain" 
              class="font-bold rounded-lg border-blue-100 bg-blue-50/40 text-blue-600"
            >
              # {{ row.name }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column 
          prop="articleCount" 
          label="引用次数" 
          width="150" 
          align="center" 
          sortable
        >
          <template #default="{ row }: { row: TagItem }">
            <el-statistic 
              :value="row.articleCount" 
              :value-style="{ fontSize: '14px', fontWeight: '600', color: '#64748b' }" 
            />
          </template>
        </el-table-column>

        <el-table-column label="管理" width="180" align="right">
          <template #default="{ row }: { row: TagItem }">
            <div class="flex justify-end items-center gap-2 pr-2">
              <el-button link type="primary" @click="openDialog(row)" class="font-bold">重命名</el-button>
              <el-divider direction="vertical" />
              <el-button 
                link 
                type="danger" 
                @click="handleDelete(row)" 
                class="font-bold outline-none focus-visible:ring-1 focus-visible:ring-red-500 rounded-sm"
              >
                销毁
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 对话框 -->
    <el-dialog 
      v-model="dialogVisible" 
      :title="editingId ? '安全重命名' : '新增标签词'" 
      width="380px"
      append-to-body
      destroy-on-close
      :close-on-click-modal="false"
      class="custom-dialog rounded-2xl"
    >
      <div class="dialog-body pt-2">
        <el-form :model="form" ref="formRef" :rules="rules" @submit.prevent="submitForm">
          <el-form-item 
            prop="name" 
          >
            <el-input 
              v-model="form.name" 
              placeholder="标签名称（如：Vue3）" 
              maxlength="20"
              show-word-limit
              size="large"
              clearable
              :disabled="isProcessing"
              @keyup.enter="submitForm"
            />
          </el-form-item>
        </el-form>
        <div class="mt-4 p-3 bg-zinc-50 rounded-xl border border-zinc-100 flex gap-2 select-none">
          <el-icon class="text-zinc-400 mt-1"><InfoFilled /></el-icon>
          <p class="text-[11px] text-zinc-500 leading-relaxed">
            变更标签名会即时同步至所有关联博文。建议使用简洁、具有高辨识度的词汇。
          </p>
        </div>
      </div>
      <template #footer>
        <div class="flex gap-3 px-1">
          <el-button @click="dialogVisible = false" :disabled="isProcessing" class="flex-1 rounded-xl">取消</el-button>
          <el-button 
            type="primary" 
            class="flex-1 rounded-xl font-bold shadow-md shadow-blue-50" 
            :loading="isProcessing" 
            @click="submitForm"
          >
            {{ powProvider.isCalculating.value ? '安全计算中...' : '保存变更' }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed, shallowRef, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import { InfoFilled, Plus } from '@element-plus/icons-vue'
import { getTags, createTag, updateTag, deleteTag, type TagItem } from '@/api/tag'
import { usePow } from '@/composables/usePow'
import type { AxiosRequestConfig } from 'axios'

const list = shallowRef<TagItem[]>([])
const loading = ref(false)
const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()
const powProvider = usePow()

const isProcessing = computed(() => submitting.value || powProvider.isCalculating.value)

// 物理中断控制器
let loadController: AbortController | null = null
let submitController: AbortController | null = null

const form = reactive({ name: '' })
const rules = {
  name: [
    { required: true, message: '请输入标签名', trigger: 'blur' },
    { min: 1, max: 20, message: '长度需在 1 到 20 字符之间', trigger: 'change' },
    // [修复 2026-02-24] P1 修复：收紧正则，物理剔除控制字符
    { pattern: /^[^\p{C}<>"'`]+$/u, message: '禁止使用控制字符与 HTML 敏感字符', trigger: 'blur' }
  ]
}

/**
 * 列表加载与中断管理
 */
const loadData = async () => {
  if (loadController) loadController.abort()
  const currentController = new AbortController()
  loadController = currentController
  const { signal } = currentController
  
  loading.value = true
  try {
    const data = await getTags({ signal } as AxiosRequestConfig)
    if (loadController === currentController) {
      list.value = Array.isArray(data) ? data : []
    }
  } catch (err: any) {
    if (err.name !== 'AbortError' && loadController === currentController) {
      ElMessage.error('标签列表同步失败')
      list.value = []
    }
  } finally {
    if (loadController === currentController) {
      loading.value = false
      loadController = null
    }
  }
}

const openDialog = (row?: TagItem) => {
  editingId.value = row?.id || null
  form.name = row?.name || ''
  dialogVisible.value = true
}

/**
 * 表单提交 (Promise 风格)
 * [修复 2026-02-24] P0 修复：引入物理中断控制
 */
const submitForm = async () => {
  if (!formRef.value || isProcessing.value) return
  
  try {
    await formRef.value.validate()
    
    const cleanName = form.name.trim()
    if (!cleanName) return

    // 竞态防护
    if (submitController) submitController.abort()
    const currentController = new AbortController()
    submitController = currentController
    const { signal } = currentController
    
    submitting.value = true
    const config = { signal } as AxiosRequestConfig

    if (editingId.value) {
      await updateTag(editingId.value, cleanName, config)
      ElMessage.success('标签已重命名')
    } else {
      await createTag(cleanName, config)
      ElMessage.success('标签创建成功')
    }
    
    if (submitController === currentController) {
      dialogVisible.value = false
      // 仅在非中断时刷新
      await loadData()
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      console.error('[Tag] Submit failed:', err)
    }
  } finally {
    // 无论如何，只要不是被抢占，都应释放锁
    submitting.value = false
    submitController = null
  }
}

/**
 * 安全销毁逻辑
 * [修复 2026-02-24] P1 修复：引入物理中断控制
 */
const handleDelete = (row: TagItem) => {
  ElMessageBox.confirm(
    `您正在销毁索引词。标签「${row.name}」将被永久移除。`, 
    '安全警告', 
    {
      confirmButtonText: '确定销毁',
      cancelButtonText: '取消',
      type: 'error',
      confirmButtonClass: 'el-button--danger',
      roundButton: true,
      dangerouslyUseHTMLString: false
    }
  ).then(async () => {
    if (isProcessing.value) return

    if (submitController) submitController.abort()
    const currentController = new AbortController()
    submitController = currentController
    const { signal } = currentController
    
    submitting.value = true
    try {
      await deleteTag(row.id, { signal } as AxiosRequestConfig)
      
      if (submitController === currentController) {
        ElMessage.success('数据已彻底移除')
        await loadData()
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('[Tag] Delete failed:', err)
      }
    } finally {
      submitting.value = false
      submitController = null
    }
  }).catch(() => {})
}

onMounted(() => {
  loadData()
  powProvider.prewarm()
})

onUnmounted(() => {
  if (loadController) loadController.abort()
  if (submitController) submitController.abort()
})
</script>

<style scoped>
.tag-manage-wrapper {
  animation: slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slide-in {
  from { opacity: 0; transform: translateY(15px); }
  to { opacity: 1; transform: translateY(0); }
}

:deep(.tag-table) {
  --el-table-header-bg-color: #fafafa;
  --el-table-header-text-color: #475569;
}

@media (max-width: 640px) {
  :deep(.hidden-sm-and-down) {
    display: none !important;
  }
}

.el-button:active {
  transform: scale(0.97);
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
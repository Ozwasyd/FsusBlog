<template>
  <div class="category-manage-wrapper">
    <el-card shadow="never" class="action-card mb-5 border-none rounded-xl">
      <div class="flex justify-between items-center px-2">
        <div class="header-info">
          <h2 class="text-xl font-bold text-zinc-800 tracking-tight flex items-center gap-2">
            分类管理
            <el-tag size="small" type="info" effect="plain" class="rounded-full border-zinc-200 text-zinc-400 tabular-nums">
              {{ list.length }}
            </el-tag>
          </h2>
          <p class="text-[12px] text-zinc-400 mt-1 italic font-medium">
            <el-icon class="align-middle mr-1"><Management /></el-icon>
            安全机制：仅允许删除关联文章数为 0 的项，变更将即时同步至主站
          </p>
        </div>
        <el-button 
          type="primary" 
          size="large" 
          @click="openDialog()" 
          class="px-8 shadow-lg shadow-blue-50 transition-transform active:scale-95"
        >
          <el-icon class="mr-1"><Plus /></el-icon>新增分类
        </el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="list-card border-none rounded-xl overflow-hidden">
      <!-- 渲染模型：视为只读列表，由后端权威数据驱动 -->
      <el-table 
        v-loading="loading" 
        :data="list" 
        :row-key="(row: CategoryItem) => row.id"
        stripe 
        table-layout="fixed"
        class="category-table w-full"
      >
        <el-table-column prop="id" label="ID" width="100" align="center" class-name="font-mono text-zinc-300 hidden-sm-and-down" />
        
        <el-table-column prop="name" label="分类名称" min-width="200">
          <template #default="{ row }: { row: CategoryItem }">
            <span class="font-bold text-zinc-700 leading-6">{{ row.name }}</span>
          </template>
        </el-table-column>

        <el-table-column 
          prop="articleCount" 
          label="关联文章" 
          width="150" 
          align="center" 
          sortable
        >
          <template #default="{ row }: { row: CategoryItem }">
            <el-statistic 
              :value="row.articleCount" 
              :value-style="{ 
                fontSize: '15px', 
                fontWeight: '700', 
                color: row.articleCount > 0 ? '#3b82f6' : '#94a3b8' 
              }" 
            />
          </template>
        </el-table-column>

        <el-table-column label="管理" width="200" align="right" fixed="right">
          <template #default="{ row }: { row: CategoryItem }">
            <div class="flex justify-end items-center gap-2 pr-2">
              <!-- 统一图标组件渲染方式 -->
              <el-button link type="primary" @click="openDialog(row)" class="font-bold">
                <el-icon class="mr-1"><Edit /></el-icon>编辑
              </el-button>
              <el-divider direction="vertical" />
              
              <el-tooltip 
                v-if="row.articleCount > 0" 
                content="该分类下仍有博文挂载，系统拦截删除操作" 
                placement="top"
              >
                <el-button link type="info" class="font-bold opacity-40 cursor-not-allowed">
                  <el-icon class="mr-1"><Lock /></el-icon>锁定
                </el-button>
              </el-tooltip>
              <el-button 
                v-else 
                link 
                type="danger" 
                @click="handleDelete(row)" 
                class="font-bold"
              >
                <el-icon class="mr-1"><Delete /></el-icon>删除
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog 
      v-model="dialogVisible" 
      :title="editingId ? '修改分类属性' : '创建全站分类'" 
      width="400px"
      append-to-body
      destroy-on-close
      :close-on-click-modal="false"
      class="custom-dialog rounded-2xl overflow-hidden"
    >
      <div class="dialog-body pt-2">
        <el-form :model="form" ref="formRef" :rules="rules" label-position="top" @submit.prevent="submitForm">
          <el-form-item label="分类名称" prop="name">
            <el-input 
              v-model="form.name" 
              placeholder="请输入 2-20 个字符的名称" 
              maxlength="20"
              show-word-limit
              size="large"
              clearable
              :disabled="isProcessing"
              @keyup.enter="submitForm"
            />
          </el-form-item>
        </el-form>
        <div class="mt-4 p-4 bg-zinc-50 rounded-xl border border-zinc-100 flex gap-3 select-none">
          <el-icon class="text-zinc-400 mt-1"><InfoFilled /></el-icon>
          <p class="text-[11px] text-zinc-500 leading-relaxed italic">
            变更分类名称会即时同步至主站导航。建议使用通用、简洁的语义词汇。
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
            {{ powProvider.isCalculating.value ? '安全计算中...' : '确认提交' }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, shallowRef, computed } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import { InfoFilled, Management, Plus, Edit, Lock, Delete } from '@element-plus/icons-vue'
import { getCategories, createCategory, updateCategory, deleteCategory, type CategoryItem } from '@/api/category'
import { usePow } from '@/composables/usePow'
import type { AxiosRequestConfig } from 'axios'

const powProvider = usePow()

// --- 状态管理 ---
const list = shallowRef<CategoryItem[]>([])
const loading = ref(false)
const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()

// 并发控制器
let abortController: AbortController | null = null

// [修复 2026-02-24] 状态收敛：合并网络请求与算力计算的 loading 态，防止竞态冲突
const isProcessing = computed(() => submitting.value || powProvider.isCalculating.value)

const form = reactive({ name: '' })
const rules = {
  name: [
    { required: true, message: '名称不能为空', trigger: 'blur' },
    { min: 2, max: 20, message: '长度需在 2 到 20 字符之间', trigger: 'change' },
    // 前端基础拦截，最终防御依赖后端白名单与转义
    { pattern: /^[^<|>|'|"]+$/, message: '禁止使用特殊 HTML 字符', trigger: 'blur' }
  ]
}

/**
 * 列表加载与中断管理
 */
const loadData = async () => {
  if (abortController) abortController.abort()
  const currentController = new AbortController()
  abortController = currentController
  const { signal } = currentController

  loading.value = true
  try {
    const data = await getCategories({ signal } as AxiosRequestConfig)
    
    if (abortController === currentController) {
      // 增加基础结构断言，防止非数组返回值引发后续 map/filter 崩溃
      list.value = Array.isArray(data) ? data : []
    }
  } catch (err: any) {
    if (err.name !== 'AbortError' && abortController === currentController) {
      console.error('[Admin Category] Load failed:', err)
      ElMessage.error('无法同步全站分类数据')
      list.value = []
    }
  } finally {
    if (abortController === currentController) {
      loading.value = false
      abortController = null
    }
  }
}

const openDialog = (row?: CategoryItem) => {
  editingId.value = row?.id || null
  form.name = row?.name || ''
  dialogVisible.value = true
}

/**
 * 表单提交
 * 核心逻辑：高危写操作由底层拦截器代理执行 PoW 校验
 */
const submitForm = async () => {
  if (!formRef.value || isProcessing.value) return
  
  try {
    await formRef.value.validate()
    
    const cleanName = form.name.trim()
    submitting.value = true
    
    if (editingId.value) {
      await updateCategory(editingId.value, cleanName)
      ElMessage.success('分类元数据更新成功')
    } else {
      await createCategory(cleanName)
      ElMessage.success('全站新分类已同步')
    }
    
    dialogVisible.value = false
    await loadData()
  } catch (err: any) {
    // 拦截器内已统一处理 4xx/5xx 等异常状态及 PoW 回滚
    if (err.name !== 'AbortError') {
      console.error('[Category] Submit failed:', err)
    }
  } finally {
    submitting.value = false
  }
}

/**
 * 安全销毁逻辑
 */
const handleDelete = (row: CategoryItem) => {
  if (row.articleCount > 0) {
    return ElMessage.warning(`分类「${row.name}」正被 ${row.articleCount} 篇文章占用，禁止删除。`)
  }

  ElMessageBox.confirm(
    `确定要永久移除分类「${row.name}」吗？该操作无法撤销。`, 
    '危险操作警告', 
    {
      confirmButtonText: '确定移除',
      cancelButtonText: '取消',
      type: 'warning',
      confirmButtonClass: 'el-button--danger',
      roundButton: true,
      dangerouslyUseHTMLString: false // 禁用 HTML 渲染防范 XSS
    }
  ).then(async () => {
    try {
      await deleteCategory(row.id)
      ElMessage.success('数据已彻底移除')
      await loadData()
    } catch (err: any) {
      console.error('[Category] Delete failed:', err)
    }
  }).catch(() => {
    // [修复 2026-02-24] 明确注释：捕获用户的安全取消动作，防止 Uncaught Promise Rejection
  })
}

onMounted(loadData)

onUnmounted(() => {
  if (abortController) abortController.abort()
})
</script>

<style scoped>
/* 统一样式令牌提取 */
:root {
  --admin-card-border: #f4f4f5; /* zinc-100 */
}

.category-manage-wrapper {
  animation: slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slide-in {
  from { opacity: 0; transform: translateY(15px); }
  to { opacity: 1; transform: translateY(0); }
}

:deep(.category-table) {
  --el-table-header-bg-color: #fafafa;
  --el-table-header-text-color: #64748b;
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}

@media (max-width: 640px) {
  :deep(.hidden-sm-and-down) {
    display: none !important;
  }
}

.el-button:active {
  transform: scale(0.97);
}

.custom-dialog :deep(.el-dialog__header) {
  padding-bottom: 20px;
  border-bottom: 1px solid var(--admin-card-border);
  margin-right: 0;
}

.custom-dialog :deep(.el-dialog__footer) {
  padding-top: 20px;
  border-top: 1px solid var(--admin-card-border);
}
</style>
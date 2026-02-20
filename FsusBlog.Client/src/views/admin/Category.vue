<template>
  <div class="category-manage-wrapper">
    <el-card shadow="never" class="action-card mb-5 border-none rounded-xl">
      <div class="flex justify-between items-center px-2">
        <div class="header-info">
          <h2 class="text-xl font-bold text-zinc-800 tracking-tight flex items-center gap-2">
            分类管理
            <el-tag size="small" type="info" effect="plain" class="rounded-full border-zinc-200 text-zinc-400">
              {{ list.length }}
            </el-tag>
          </h2>
          <p class="text-[12px] text-zinc-400 mt-1 italic font-medium">
            <el-icon class="align-middle mr-1"><Management /></el-icon>
            分类删除受限：仅允许删除文章数为 0 的项
          </p>
        </div>
        <el-button 
          type="primary" 
          size="large" 
          icon="Plus" 
          @click="openDialog()" 
          class="px-8 shadow-lg shadow-blue-50 transition-transform active:scale-95"
        >
          新增分类
        </el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="list-card border-none rounded-xl overflow-hidden">
      <el-table 
        v-loading="loading" 
        :data="list" 
        :row-key="(row: CategoryItem) => row.id"
        stripe 
        table-layout="fixed"
        class="category-table w-full"
      >
        <el-table-column prop="id" label="ID" width="100" align="center" class-name="font-mono text-zinc-300 hidden-xs" />
        
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

        <el-table-column label="操作选项" width="200" align="right" fixed="right">
          <template #default="{ row }: { row: CategoryItem }">
            <div class="flex justify-end items-center gap-2 pr-2">
              <el-button link type="primary" icon="Edit" @click="openDialog(row)" class="font-bold">编辑</el-button>
              <el-divider direction="vertical" />
              
              <el-tooltip 
                v-if="row.articleCount > 0" 
                content="分类下仍有博文，暂无法删除" 
                placement="top"
              >
                <el-button link type="info" icon="Lock" class="font-bold opacity-40 cursor-not-allowed">锁定</el-button>
              </el-tooltip>
              <el-button 
                v-else 
                link 
                type="danger" 
                icon="Delete" 
                @click="handleDelete(row)" 
                class="font-bold"
              >
                删除
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
              @keyup.enter="submitForm"
            />
          </el-form-item>
        </el-form>
        <div class="mt-4 p-4 bg-zinc-50 rounded-xl border border-zinc-100 flex gap-3">
          <el-icon class="text-zinc-400 mt-1"><InfoFilled /></el-icon>
          <p class="text-[11px] text-zinc-500 leading-relaxed italic">
            变更分类名称会即时同步至主站导航。建议使用通用、简洁的语义词汇。
          </p>
        </div>
      </div>
      <template #footer>
        <div class="flex gap-3 px-1">
          <el-button @click="dialogVisible = false" class="flex-1 rounded-xl">取消操作</el-button>
          <el-button 
            type="primary" 
            class="flex-1 rounded-xl font-bold shadow-md shadow-blue-50" 
            :loading="submitting" 
            @click="submitForm"
          >
            确认提交
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import { InfoFilled, Management } from '@element-plus/icons-vue'
import { getCategories, createCategory, updateCategory, deleteCategory, type CategoryItem } from '@/api/category'

// 1. 数据状态
const list = ref<CategoryItem[]>([])
const loading = ref(false)
const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()

const form = reactive({ name: '' })
const rules = {
  name: [
    { required: true, message: '名称不能为空', trigger: 'blur' },
    { min: 2, max: 20, message: '长度需在 2 到 20 字符之间', trigger: 'change' },
    { pattern: /^[^<|>|'|"]+$/, message: '禁止使用特殊 HTML 字符', trigger: 'blur' }
  ]
}

// 2. 数据流加载
const loadData = async () => {
  loading.value = true
  try {
    const data = await getCategories()
    list.value = data
  } catch (err) {
    ElMessage.error('无法同步全站分类数据')
  } finally {
    loading.value = false
  }
}

// 3. 弹窗控制
const openDialog = (row?: CategoryItem) => {
  editingId.value = row?.id || null
  form.name = row?.name || ''
  dialogVisible.value = true
}

// 4. 表单提交 (Promise 风格修复 TS 类型报错)
const submitForm = async () => {
  if (!formRef.value || submitting.value) return
  
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
  } catch (err) {
    // 校验未通过
  } finally {
    submitting.value = false
  }
}

// 5. 安全销毁逻辑
const handleDelete = (row: CategoryItem) => {
  if (row.articleCount > 0) {
    return ElMessage.warning(`分类「${row.name}」正被 ${row.articleCount} 篇文章占用，禁止移除。`)
  }

  ElMessageBox.confirm(
    `确定要永久移除分类「${row.name}」吗？\n该操作无法撤销。`, 
    '危险操作警告', 
    {
      confirmButtonText: '确定移除',
      cancelButtonText: '点错了',
      type: 'warning',
      confirmButtonClass: 'el-button--danger',
      roundButton: true
    }
  ).then(async () => {
    try {
      await deleteCategory(row.id)
      ElMessage.success('数据已彻底移除')
      await loadData()
    } catch (err) {
      ElMessage.error('删除指令执行失败')
    }
  }).catch(() => {})
}

onMounted(loadData)
</script>

<style scoped>
.category-manage-wrapper {
  animation: slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slide-in {
  from { opacity: 0; transform: translateY(15px); }
  to { opacity: 1; transform: translateY(0); }
}

:deep(.category-table) {
  --el-table-header-bg-color: #fafafa;
  --el-table-header-text-color: #475569;
}

@media (max-width: 640px) {
  .hidden-xs {
    display: none !important;
  }
}

.el-button:active {
  transform: scale(0.97);
}
</style>
<template>
  <div class="tag-manage-wrapper">
    <el-card shadow="never" class="action-card mb-5 border-none rounded-xl">
      <div class="flex justify-between items-center px-2">
        <div class="header-info">
          <h2 class="text-xl font-bold text-zinc-800 tracking-tight flex items-center gap-2">
            标签管理
            <el-tag size="small" type="info" effect="plain" class="rounded-full border-zinc-200 text-zinc-400">
              {{ list.length }}
            </el-tag>
          </h2>
          <p class="text-[12px] text-zinc-400 mt-1 italic font-medium">维护博文索引关键词，点击表头可排序</p>
        </div>
        <el-button 
          type="primary" 
          size="large" 
          icon="Plus" 
          @click="openDialog()" 
          class="px-8 shadow-lg shadow-blue-100 transition-transform active:scale-95"
        >
          创建标签
        </el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="list-card border-none rounded-xl overflow-hidden">
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
          class-name="font-mono text-zinc-300 hidden-xs" 
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

        <el-table-column label="操作" width="180" align="right">
          <template #default="{ row }: { row: TagItem }">
            <div class="flex justify-end items-center gap-2 pr-2">
              <el-button link type="primary" @click="openDialog(row)" class="font-bold">重命名</el-button>
              <el-divider direction="vertical" />
              <el-button link type="danger" @click="handleDelete(row)" class="font-bold">销毁</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

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
        <el-form :model="form" ref="formRef" @submit.prevent="submitForm">
          <el-form-item 
            prop="name" 
            :rules="[
              { required: true, message: '请输入标签名', trigger: 'blur' },
              { min: 1, max: 20, message: '长度需在 1-20 字符', trigger: 'change' }
            ]"
          >
            <el-input 
              v-model="form.name" 
              placeholder="标签名称（如：Vue3）" 
              maxlength="20"
              show-word-limit
              size="large"
              clearable
              @keyup.enter="submitForm"
            />
          </el-form-item>
        </el-form>
        <div class="mt-4 p-3 bg-zinc-50 rounded-xl border border-zinc-100 flex gap-2">
          <el-icon class="text-zinc-400 mt-1"><InfoFilled /></el-icon>
          <p class="text-[11px] text-zinc-500 leading-relaxed">
            变更标签名会即时同步至所有关联博文。建议使用简洁、具有高辨识度的词汇。
          </p>
        </div>
      </div>
      <template #footer>
        <div class="flex gap-3 px-1">
          <el-button @click="dialogVisible = false" class="flex-1 rounded-xl">取消</el-button>
          <el-button 
            type="primary" 
            class="flex-1 rounded-xl font-bold shadow-md shadow-blue-50" 
            :loading="submitting" 
            @click="submitForm"
          >
            保存变更
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import { InfoFilled  } from '@element-plus/icons-vue'
import { getTags, createTag, updateTag, deleteTag, type TagItem } from '@/api/tag'

// 1. 响应式状态管理
const list = ref<TagItem[]>([])
const loading = ref(false)
const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()
const form = reactive({ name: '' })

// 2. 加载数据逻辑
const loadData = async () => {
  loading.value = true
  try {
    const data = await getTags()
    list.value = data
  } catch (err) {
    ElMessage.error('标签列表同步失败')
  } finally {
    loading.value = false
  }
}

// 3. 打开弹窗处理
const openDialog = (row?: TagItem) => {
  editingId.value = row?.id || null
  form.name = row?.name || ''
  dialogVisible.value = true
}

// 4. 表单提交（修复 TS 异步校验报错）
const submitForm = async () => {
  if (!formRef.value) return
  
  try {
    // 🌟 核心改进：使用 await Promise 模式解决类型不匹配
    await formRef.value.validate()
    
    const cleanName = form.name.replace(/\s+/g, ' ').trim()
    if (!cleanName) return
    
    submitting.value = true
    if (editingId.value) {
      await updateTag(editingId.value, cleanName)
      ElMessage.success('标签已重命名')
    } else {
      await createTag(cleanName)
      ElMessage.success('标签创建成功')
    }
    dialogVisible.value = false
    await loadData()
  } catch (err) {
    // 校验失败或 API 报错无需额外处理，FormItem 会显示提示
  } finally {
    submitting.value = false
  }
}

// 5. 危险删除操作
const handleDelete = (row: TagItem) => {
  ElMessageBox.confirm(
    `您正在执行销毁操作。标签「${row.name}」将被永久移除。该操作不会删除文章，但会解除关联索引。`, 
    '安全警告', 
    {
      confirmButtonText: '确定销毁',
      cancelButtonText: '点错了',
      type: 'error',
      confirmButtonClass: 'el-button--danger',
      roundButton: true
    }
  ).then(async () => {
    try {
      await deleteTag(row.id)
      ElMessage.success('数据已彻底移除')
      await loadData()
    } catch (err) {
      ElMessage.error('销毁操作失败，请重试')
    }
  }).catch(() => {})
}

onMounted(loadData)
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
  .hidden-xs {
    display: none !important;
  }
}

.el-button:active {
  transform: scale(0.97);
}
</style>
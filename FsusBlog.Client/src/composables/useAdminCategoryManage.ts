import { computed, onMounted, reactive, ref, shallowRef } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import type { AxiosRequestConfig } from 'axios'
import {
  createCategory,
  deleteCategory,
  getCategories,
  updateCategory,
  type CategoryItem
} from '@/api/category'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePow } from '@/composables/usePow'
import { getErrorMessage, isAbortError } from '@/utils/errors'

export function useAdminCategoryManage() {
  const powProvider = usePow()

  const list = shallowRef<CategoryItem[]>([])
  const loading = ref(false)
  const dialogVisible = ref(false)
  const submitting = ref(false)
  const editingId = ref<number | null>(null)
  const formRef = ref<FormInstance>()

  const loadTask = useAbortableTask()
  const submitTask = useAbortableTask()

  const isProcessing = computed(() => submitting.value || powProvider.isCalculating.value)
  const dialogTitle = computed(() => (editingId.value ? '修改分类属性' : '创建全站分类'))
  const submitButtonText = computed(() =>
    powProvider.isCalculating.value ? '安全计算中...' : '确认提交'
  )

  const form = reactive({ name: '' })
  const rules = {
    name: [
      { required: true, message: '名称不能为空', trigger: 'blur' },
      { min: 2, max: 20, message: '长度需在 2 到 20 字符之间', trigger: 'change' },
      { pattern: /^[^<|>|'|"]+$/, message: '禁止使用特殊 HTML 字符', trigger: 'blur' }
    ]
  }

  const loadData = async (): Promise<void> => {
    loading.value = true
    try {
      await loadTask.run(async (signal) => {
        const config: AxiosRequestConfig = { signal }
        const data = await getCategories(config)
        list.value = Array.isArray(data) ? data : []
      })
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return
      }

      console.error('[Admin Category] Load failed:', error)
      ElMessage.error(getErrorMessage(error, '无法同步全站分类数据'))
      list.value = []
    } finally {
      loading.value = false
    }
  }

  const openDialog = (row?: CategoryItem): void => {
    editingId.value = row?.id || null
    form.name = row?.name || ''
    dialogVisible.value = true
  }

  const submitForm = async (): Promise<void> => {
    if (!formRef.value || isProcessing.value) {
      return
    }

    try {
      await formRef.value.validate()

      const cleanName = form.name.trim()
      if (!cleanName) {
        return
      }

      submitting.value = true
      await submitTask.run(async (signal) => {
        const config: AxiosRequestConfig = { signal }
        if (editingId.value) {
          await updateCategory(editingId.value, cleanName, config)
          ElMessage.success('分类元数据更新成功')
        } else {
          await createCategory(cleanName, config)
          ElMessage.success('全站新分类已同步')
        }

        dialogVisible.value = false
        await loadData()
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        console.error('[Category] Submit failed:', error)
      }
    } finally {
      submitting.value = false
    }
  }

  const handleDelete = (row: CategoryItem): void => {
    if (row.articleCount > 0) {
      ElMessage.warning(`分类「${row.name}」正被 ${row.articleCount} 篇文章占用，禁止删除。`)
      return
    }

    void ElMessageBox.confirm(`确定要永久移除分类「${row.name}」吗？该操作无法撤销。`, '危险操作警告', {
      confirmButtonText: '确定移除',
      cancelButtonText: '取消',
      type: 'warning',
      confirmButtonClass: 'el-button--danger',
      roundButton: true,
      dangerouslyUseHTMLString: false
    }).then(async () => {
      if (isProcessing.value) {
        return
      }

      submitting.value = true
      try {
        await submitTask.run(async (signal) => {
          const config: AxiosRequestConfig = { signal }
          await deleteCategory(row.id, config)
          ElMessage.success('数据已彻底移除')
          await loadData()
        })
      } catch (error: unknown) {
        if (!isAbortError(error)) {
          console.error('[Category] Delete failed:', error)
          ElMessage.error(getErrorMessage(error, '删除分类失败'))
        }
      } finally {
        submitting.value = false
      }
    }).catch(() => undefined)
  }

  onMounted(() => {
    void loadData()
    powProvider.prewarm()
  })

  return {
    powProvider,
    list,
    loading,
    dialogVisible,
    editingId,
    dialogTitle,
    submitButtonText,
    formRef,
    isProcessing,
    form,
    rules,
    openDialog,
    submitForm,
    handleDelete
  }
}

import { computed, onMounted, reactive, ref, shallowRef } from 'vue'
import { type FormInstance } from '@ozwasyd/element-plus'
import { isFsusUiOk } from '@/utils/fsusUiResult'
import type { ApiRequestConfig } from '@/api/requestConfig'
import {
  createCategory,
  deleteCategory,
  getCategories,
  updateCategory,
  type CategoryItem
} from '@/api/category'
import { usePow } from '@/composables/usePow'
import { useMutationFlow } from '@/composables/useMutationFlow'
import { useViewTask } from '@/composables/useViewTask'
import { showWarningToast } from '@/utils/errorPresentation'

export function useAdminCategoryManage() {
  const powProvider = usePow()

  const list = shallowRef<CategoryItem[]>([])
  const loading = ref(false)
  const dialogVisible = ref(false)
  const submitting = ref(false)
  const editingId = ref<number | null>(null)
  const formRef = ref<FormInstance>()

  const loadTask = useViewTask()
  const mutation = useMutationFlow()

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

  const loadData = async (): Promise<boolean> => {
    const data = await loadTask.run(async (signal) => {
      const config: ApiRequestConfig = { signal }
      return await getCategories(config)
    }, {
      fallbackMessage: '无法同步全站分类数据',
      onError: (error) => {
        console.error('[Admin Category] Load failed:', error)
        list.value = []
      }
    })

    if (data) {
      list.value = Array.isArray(data) ? data : []
    }

    return data !== undefined
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
      const validation = await formRef.value.validate()
      if (!isFsusUiOk(validation)) {
        return
      }

      const cleanName = form.name.trim()
      if (!cleanName) {
        return
      }

      submitting.value = true
      await mutation.run(async (signal) => {
        const config: ApiRequestConfig = { signal }
        if (editingId.value) {
          await updateCategory(editingId.value, cleanName, config)
        } else {
          await createCategory(cleanName, config)
        }
      }, {
        fallbackMessage: editingId.value ? '更新分类失败' : '创建分类失败',
        successMessage: editingId.value ? '分类元数据更新成功' : '全站新分类已同步',
        postSuccessWarningMessage: '分类已保存，但列表同步失败，请稍后刷新',
        onSuccess: async () => {
          dialogVisible.value = false
          return await loadData()
        }
      })
    } catch (error: unknown) {
      console.error('[Category] Submit failed:', error)
    } finally {
      submitting.value = false
    }
  }

  const handleDelete = (row: CategoryItem): void => {
    if (row.articleCount > 0) {
      showWarningToast(`分类「${row.name}」正被 ${row.articleCount} 篇文章占用，禁止删除。`)
      return
    }

    void (async () => {
      if (isProcessing.value) {
        return
      }

      submitting.value = true
      try {
        await mutation.confirmThenRun({
          message: `确定要永久移除分类「${row.name}」吗？该操作无法撤销。`,
          title: '危险操作警告',
          confirmButtonText: '确定移除'
        }, async (signal) => {
          const config: ApiRequestConfig = { signal }
          await deleteCategory(row.id, config)
        }, {
          fallbackMessage: '删除分类失败',
          successMessage: '数据已彻底移除',
          postSuccessWarningMessage: '分类已删除，但列表同步失败，请稍后刷新',
          onSuccess: loadData
        })
      } finally {
        submitting.value = false
      }
    })()
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

import { computed, onMounted, reactive, ref, shallowRef } from 'vue'
import { type FormInstance } from '@ozwasyd/element-plus'
import { useRouter } from 'vue-router'
import { isFsusUiOk } from '@/fsusui/result'
import type { ApiRequestConfig } from '@/api/requestConfig'
import { listAdminCategories, type AdminCategoryItemResponse } from '@/api/authoring'
import {
  createCategory,
  deleteCategory,
  updateCategory,
} from '@/api/category'
import { usePow } from '@/composables/usePow'
import { useMutationFlow } from '@/composables/useMutationFlow'
import { useViewTask } from '@/composables/useViewTask'
import { showWarningToast } from '@/utils/errorPresentation'

export function useAdminCategoryManage() {
  const router = useRouter()
  const powProvider = usePow()

  const list = shallowRef<AdminCategoryItemResponse[]>([])
  const loading = ref(false)
  const dialogVisible = ref(false)
  const submitting = ref(false)
  const editingId = ref<number | null>(null)
  const formRef = ref<FormInstance>()

  const loadTask = useViewTask()
  const mutation = useMutationFlow()
  const filters = reactive({
    keyword: '',
    unusedOnly: false
  })

  const isProcessing = computed(() => submitting.value || powProvider.isCalculating.value)
  const dialogTitle = computed(() => (editingId.value ? '修改分类属性' : '创建全站分类'))
  const submitButtonText = computed(() =>
    powProvider.isCalculating.value ? '安全计算中...' : '确认提交'
  )

  const form = reactive({ name: '' })
  const filteredList = computed(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return list.value.filter((item) => {
      if (filters.unusedOnly && !item.canDelete) {
        return false
      }

      return !keyword || item.name.toLowerCase().includes(keyword) || String(item.id).includes(keyword)
    })
  })
  const rules = {
    name: [
      { required: true, message: '名称不能为空', trigger: 'blur' },
      { min: 2, max: 20, message: '长度需在 2 到 20 字符之间', trigger: 'change' },
      { pattern: /^[^<|>|'|"]+$/, message: '禁止使用特殊 HTML 字符', trigger: 'blur' }
    ]
  }

  const loadData = async (): Promise<boolean> => {
    loading.value = true
    try {
      const data = await loadTask.run(async (signal) => {
        const config: ApiRequestConfig = { signal }
        return await listAdminCategories(config)
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
    } finally {
      loading.value = false
    }
  }

  const openDialog = (row?: AdminCategoryItemResponse): void => {
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

      if (hasDuplicateName(cleanName)) {
        showWarningToast(`分类「${cleanName}」已存在，请直接编辑原分类或换用更明确的名称。`)
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

  const handleDelete = (row: AdminCategoryItemResponse): void => {
    if (!row.canDelete) {
      showWarningToast(`分类「${row.name}」正被 ${row.totalBlockingArticleCount} 篇文章占用，禁止删除。`)
      return
    }

    void (async () => {
      if (isProcessing.value) {
        return
      }

      submitting.value = true
      try {
        await mutation.confirmThenRun({
          message: `确定要删除分类「${row.name}」吗？该操作无法撤销。`,
          title: '删除分类',
          confirmButtonText: '确认删除'
        }, async (signal) => {
          const config: ApiRequestConfig = { signal }
          await deleteCategory(row.id, config)
        }, {
          fallbackMessage: '删除分类失败',
          successMessage: '分类已删除',
          postSuccessWarningMessage: '分类已删除，但列表同步失败，请稍后刷新',
          onSuccess: loadData
        })
      } finally {
        submitting.value = false
      }
    })()
  }

  const hasDuplicateName = (name: string): boolean => {
    const normalized = name.trim().toLowerCase()
    return list.value.some((item) => item.id !== editingId.value && item.name.trim().toLowerCase() === normalized)
  }

  const relationLockReason = (row: AdminCategoryItemResponse): string =>
    !row.canDelete
      ? `总引用 ${row.totalBlockingArticleCount} 篇：公开 ${row.publicArticleCount}，草稿 ${row.draftArticleCount}，定时 ${row.scheduledArticleCount}，归档 ${row.archivedArticleCount}。请先迁移后再删除。`
      : '未关联文章，可删除'

  const viewAssociatedArticles = (row: AdminCategoryItemResponse): void => {
    void router.push({
      name: 'ManageArticleList',
      query: {
        page: '1',
        size: '10',
        categoryId: String(row.id)
      }
    })
  }

  const resetFilters = (): void => {
    filters.keyword = ''
    filters.unusedOnly = false
  }

  onMounted(() => {
    void loadData()
    powProvider.prewarm()
  })

  return {
    powProvider,
    list,
    filteredList,
    loading,
    dialogVisible,
    editingId,
    dialogTitle,
    submitButtonText,
    formRef,
    isProcessing,
    filters,
    form,
    rules,
    relationLockReason,
    viewAssociatedArticles,
    resetFilters,
    openDialog,
    submitForm,
    handleDelete
  }
}

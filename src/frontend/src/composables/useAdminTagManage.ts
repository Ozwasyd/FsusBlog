import { computed, onMounted, reactive, ref, shallowRef } from 'vue'
import { type FormInstance } from '@ozwasyd/element-plus'
import { isFsusUiOk } from '@/utils/fsusUiResult'
import type { ApiRequestConfig } from '@/api/requestConfig'
import { createTag, deleteTag, getTags, updateTag, type TagItem } from '@/api/tag'
import { useMutationFlow } from '@/composables/useMutationFlow'
import { usePow } from '@/composables/usePow'
import { useViewTask } from '@/composables/useViewTask'

export function useAdminTagManage() {
  const list = shallowRef<TagItem[]>([])
  const loading = ref(false)
  const dialogVisible = ref(false)
  const submitting = ref(false)
  const editingId = ref<number | null>(null)
  const formRef = ref<FormInstance>()
  const powProvider = usePow()

  const isProcessing = computed(() => submitting.value || powProvider.isCalculating.value)
  const dialogTitle = computed(() => (editingId.value ? '安全重命名' : '新增标签词'))
  const submitButtonText = computed(() =>
    powProvider.isCalculating.value ? '安全计算中...' : '保存变更'
  )

  const loadTask = useViewTask()
  const mutation = useMutationFlow()

  const form = reactive({ name: '' })
  const rules = {
    name: [
      { required: true, message: '请输入标签名', trigger: 'blur' },
      { min: 1, max: 20, message: '长度需在 1 到 20 字符之间', trigger: 'change' },
      { pattern: /^[^\p{C}<>"'`]+$/u, message: '禁止使用控制字符与 HTML 敏感字符', trigger: 'blur' }
    ]
  }

  const loadData = async (): Promise<boolean> => {
    const data = await loadTask.run(async (signal) => {
      const config: ApiRequestConfig = { signal }
      return await getTags(config)
    }, {
      fallbackMessage: '标签列表同步失败',
      onError: () => {
        list.value = []
      }
    })

    if (data) {
      list.value = Array.isArray(data) ? data : []
    }

    return data !== undefined
  }

  const openDialog = (row?: TagItem): void => {
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
          await updateTag(editingId.value, cleanName, config)
        } else {
          await createTag(cleanName, config)
        }
      }, {
        fallbackMessage: editingId.value ? '更新标签失败' : '创建标签失败',
        successMessage: editingId.value ? '标签已重命名' : '标签创建成功',
        postSuccessWarningMessage: '标签已保存，但列表同步失败，请稍后刷新',
        onSuccess: async () => {
          dialogVisible.value = false
          return await loadData()
        }
      })
    } catch (error: unknown) {
      console.error('[Tag] Submit failed:', error)
    } finally {
      submitting.value = false
    }
  }

  const handleDelete = (row: TagItem): void => {
    void (async () => {
      if (isProcessing.value) {
        return
      }

      submitting.value = true
      try {
        await mutation.confirmThenRun({
          message: `确定要删除标签「${row.name}」吗？标签将从索引中移除。`,
          title: '删除标签',
          confirmButtonText: '确认删除'
        }, async (signal) => {
          const config: ApiRequestConfig = { signal }
          await deleteTag(row.id, config)
        }, {
          fallbackMessage: '删除标签失败',
          successMessage: '标签已删除',
          postSuccessWarningMessage: '标签已删除，但列表同步失败，请稍后刷新',
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
    list,
    loading,
    dialogVisible,
    editingId,
    dialogTitle,
    submitButtonText,
    formRef,
    powProvider,
    isProcessing,
    form,
    rules,
    openDialog,
    submitForm,
    handleDelete
  }
}

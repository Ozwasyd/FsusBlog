import { computed, onMounted, reactive, ref, shallowRef } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import type { AxiosRequestConfig } from 'axios'
import { createTag, deleteTag, getTags, updateTag, type TagItem } from '@/api/tag'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePow } from '@/composables/usePow'
import { getErrorMessage, isAbortError } from '@/utils/errors'

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

  const loadTask = useAbortableTask()
  const submitTask = useAbortableTask()

  const form = reactive({ name: '' })
  const rules = {
    name: [
      { required: true, message: '请输入标签名', trigger: 'blur' },
      { min: 1, max: 20, message: '长度需在 1 到 20 字符之间', trigger: 'change' },
      { pattern: /^[^\p{C}<>"'`]+$/u, message: '禁止使用控制字符与 HTML 敏感字符', trigger: 'blur' }
    ]
  }

  const loadData = async (): Promise<void> => {
    loading.value = true
    try {
      await loadTask.run(async (signal) => {
        const config: AxiosRequestConfig = { signal }
        const data = await getTags(config)
        list.value = Array.isArray(data) ? data : []
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        ElMessage.error(getErrorMessage(error, '标签列表同步失败'))
        list.value = []
      }
    } finally {
      loading.value = false
    }
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
      await formRef.value.validate()

      const cleanName = form.name.trim()
      if (!cleanName) {
        return
      }

      submitting.value = true
      await submitTask.run(async (signal) => {
        const config: AxiosRequestConfig = { signal }

        if (editingId.value) {
          await updateTag(editingId.value, cleanName, config)
          ElMessage.success('标签已重命名')
        } else {
          await createTag(cleanName, config)
          ElMessage.success('标签创建成功')
        }

        dialogVisible.value = false
        await loadData()
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        console.error('[Tag] Submit failed:', error)
      }
    } finally {
      submitting.value = false
    }
  }

  const handleDelete = (row: TagItem): void => {
    void ElMessageBox.confirm(`您正在销毁索引词。标签「${row.name}」将被永久移除。`, '安全警告', {
      confirmButtonText: '确定销毁',
      cancelButtonText: '取消',
      type: 'error',
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
          await deleteTag(row.id, config)
          ElMessage.success('数据已彻底移除')
          await loadData()
        })
      } catch (error: unknown) {
        if (!isAbortError(error)) {
          console.error('[Tag] Delete failed:', error)
          ElMessage.error(getErrorMessage(error, '删除标签失败'))
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

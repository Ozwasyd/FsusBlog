import { computed, onMounted, reactive, ref, shallowRef, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import { type FormInstance } from '@ozwasyd/element-plus'
import { useRouter } from 'vue-router'
import { isFsusUiOk } from '@/fsusui/result'
import type { ApiRequestConfig } from '@/api/requestConfig'
import { useMutationFlow } from '@/composables/useMutationFlow'
import { usePow } from '@/composables/usePow'
import { useViewTask } from '@/composables/useViewTask'
import { showWarningToast } from '@/utils/errorPresentation'

export type TaxonomyNameDisplay = 'text' | 'tag'

export interface AdminTaxonomyItemBase {
  id: number
  name: string
  publicArticleCount: number
  draftArticleCount: number
  scheduledArticleCount: number
  archivedArticleCount: number
  totalBlockingArticleCount: number
  canDelete: boolean
}

export type TaxonomyFormRules = {
  name: Array<{
    required?: boolean
    min?: number
    max?: number
    pattern?: RegExp
    message: string
    trigger: string
  }>
}

export interface TaxonomySchema<TItem extends AdminTaxonomyItemBase = AdminTaxonomyItemBase> {
  kind: string
  entityLabel: string
  pageClass: string
  pageTitle: string
  pageDescription: string
  summaryAriaLabel: string
  summaryDescription: string
  listTitle: string
  toolbarLabel: string
  searchPlaceholder: string
  searchAriaLabel: string
  nameColumnLabel: string
  nameInputName: string
  nameInputLabel: string
  nameInputPlaceholder: string
  dialogWidth: string
  dialogDescription: string
  dialogNoteClass: string
  dialogNoteGapClass: string
  emptyTitle: string
  filteredEmptyTitle: string
  emptyDescription: string
  filteredEmptyDescription: string
  newButtonLabel: string
  editLabel: string
  compactEditLabel: string
  compactEditIcon: boolean
  compactDeleteIcon: boolean
  fixActionColumn: boolean
  nameDisplay: TaxonomyNameDisplay
  nameColumnWidth: { compact: number; wide: number }
  relationColumnWidth: { compact: number; wide: number }
  actionColumnWidth: { compact: number; wide: number }
  articleQueryKey: string
  dialogTitle: (editing: boolean) => string
  submitButtonText: string
  rules: TaxonomyFormRules
  loadItems: (config?: ApiRequestConfig) => Promise<TItem[]>
  createItem: (name: string, config?: ApiRequestConfig) => Promise<unknown>
  updateItem: (id: number, name: string, config?: ApiRequestConfig) => Promise<unknown>
  deleteItem: (id: number, config?: ApiRequestConfig) => Promise<unknown>
  loadFallbackMessage: string
  loadFailureLog: string
  duplicateWarning: (name: string) => string
  createFallbackMessage: string
  updateFallbackMessage: string
  createSuccessMessage: string
  updateSuccessMessage: string
  postSaveWarningMessage: string
  deleteBlockedWarning: (row: TItem) => string
  deleteConfirmMessage: (row: TItem) => string
  deleteConfirmTitle: string
  deleteSuccessMessage: string
  deleteFallbackMessage: string
  postDeleteWarningMessage: string
  relationLockReason: (row: TItem) => string
}

export interface AdminTaxonomyManageState {
  list: ShallowRef<AdminTaxonomyItemBase[]>
  filteredList: ComputedRef<AdminTaxonomyItemBase[]>
  loading: Ref<boolean>
  dialogVisible: Ref<boolean>
  editingId: Ref<number | null>
  dialogTitle: ComputedRef<string>
  submitButtonText: ComputedRef<string>
  isProcessing: ComputedRef<boolean>
  filters: { keyword: string; unusedOnly: boolean }
  form: { name: string }
  rules: TaxonomyFormRules
  relationLockReason: (row: AdminTaxonomyItemBase) => string
  viewAssociatedArticles: (row: AdminTaxonomyItemBase) => void
  hasDuplicateName: (name: string) => boolean
  resetFilters: () => void
  openDialog: (row?: AdminTaxonomyItemBase) => void
  submitForm: (formInstance: FormInstance | null | undefined) => Promise<void>
  handleDelete: (row: AdminTaxonomyItemBase) => void
}

export function useAdminTaxonomyManage<TItem extends AdminTaxonomyItemBase>(
  endpoint: string,
  schema: TaxonomySchema<TItem>
): AdminTaxonomyManageState {
  const router = useRouter()
  const powProvider = usePow()
  const loadTask = useViewTask()
  const mutation = useMutationFlow()

  const list = shallowRef<AdminTaxonomyItemBase[]>([])
  const loading = ref(false)
  const dialogVisible = ref(false)
  const submitting = ref(false)
  const editingId = ref<number | null>(null)
  const filters = reactive({ keyword: '', unusedOnly: false })
  const form = reactive({ name: '' })

  const isProcessing = computed(() => submitting.value || powProvider.isCalculating.value)
  const dialogTitle = computed(() => schema.dialogTitle(Boolean(editingId.value)))
  const submitButtonText = computed(() =>
    powProvider.isCalculating.value ? '安全计算中...' : schema.submitButtonText
  )
  const filteredList = computed(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return list.value.filter((item) => {
      if (filters.unusedOnly && !item.canDelete) {
        return false
      }

      return !keyword || item.name.toLowerCase().includes(keyword) || String(item.id).includes(keyword)
    })
  })

  const loadData = async (): Promise<boolean> => {
    loading.value = true
    try {
      const data = await loadTask.run(async (signal) => {
        const config: ApiRequestConfig = { signal }
        return await schema.loadItems(config)
      }, {
        fallbackMessage: schema.loadFallbackMessage,
        onError: (error) => {
          console.error(`[Admin Taxonomy:${endpoint}] ${schema.loadFailureLog}`, error)
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

  const openDialog = (row?: AdminTaxonomyItemBase): void => {
    editingId.value = row?.id || null
    form.name = row?.name || ''
    dialogVisible.value = true
  }

  const hasDuplicateName = (name: string): boolean => {
    const normalized = name.trim().toLowerCase()
    return list.value.some((item) => item.id !== editingId.value && item.name.trim().toLowerCase() === normalized)
  }

  const submitForm = async (formInstance: FormInstance | null | undefined): Promise<void> => {
    if (!formInstance || isProcessing.value) {
      return
    }

    try {
      const validation = await formInstance.validate()
      if (!isFsusUiOk(validation)) {
        return
      }

      const cleanName = form.name.trim()
      if (!cleanName) {
        return
      }

      if (hasDuplicateName(cleanName)) {
        showWarningToast(schema.duplicateWarning(cleanName))
        return
      }

      submitting.value = true
      await mutation.run(async (signal) => {
        const config: ApiRequestConfig = { signal }
        if (editingId.value) {
          await schema.updateItem(editingId.value, cleanName, config)
        } else {
          await schema.createItem(cleanName, config)
        }
      }, {
        fallbackMessage: editingId.value ? schema.updateFallbackMessage : schema.createFallbackMessage,
        successMessage: editingId.value ? schema.updateSuccessMessage : schema.createSuccessMessage,
        postSuccessWarningMessage: schema.postSaveWarningMessage,
        onSuccess: async () => {
          dialogVisible.value = false
          return await loadData()
        }
      })
    } catch (error: unknown) {
      console.error(`[Admin Taxonomy:${endpoint}] Submit failed:`, error)
    } finally {
      submitting.value = false
    }
  }

  const runDelete = async (row: AdminTaxonomyItemBase): Promise<void> => {
    if (isProcessing.value) {
      return
    }

    submitting.value = true
    try {
      await mutation.confirmThenRun({
        message: schema.deleteConfirmMessage(row as TItem),
        title: schema.deleteConfirmTitle,
        confirmButtonText: '确认删除'
      }, async (signal) => {
        const config: ApiRequestConfig = { signal }
        await schema.deleteItem(row.id, config)
      }, {
        fallbackMessage: schema.deleteFallbackMessage,
        successMessage: schema.deleteSuccessMessage,
        postSuccessWarningMessage: schema.postDeleteWarningMessage,
        onSuccess: loadData
      })
    } finally {
      submitting.value = false
    }
  }

  const handleDelete = (row: AdminTaxonomyItemBase): void => {
    if (!row.canDelete) {
      showWarningToast(schema.deleteBlockedWarning(row as TItem))
      return
    }

    void runDelete(row).catch((error: unknown) => {
      console.error(`[Admin Taxonomy:${endpoint}] Delete failed:`, error)
    })
  }

  const relationLockReason = (row: AdminTaxonomyItemBase): string =>
    schema.relationLockReason(row as TItem)

  const viewAssociatedArticles = (row: AdminTaxonomyItemBase): void => {
    void router.push({
      name: 'ManageArticleList',
      query: {
        page: '1',
        size: '10',
        [schema.articleQueryKey]: String(row.id)
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
    list,
    filteredList,
    loading,
    dialogVisible,
    editingId,
    dialogTitle,
    submitButtonText,
    isProcessing,
    filters,
    form,
    rules: schema.rules,
    relationLockReason,
    viewAssociatedArticles,
    hasDuplicateName,
    resetFilters,
    openDialog,
    submitForm,
    handleDelete
  }
}

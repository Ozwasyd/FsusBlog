import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import type { ApiRequestConfig } from '@/api/requestConfig'
import {
  getAdminArticles,
  permanentDeleteArticle,
  restoreArticle,
  type ArticleListItemResponse
} from '@/api/article'
import { useMutationFlow } from '@/composables/useMutationFlow'
import { useViewTask } from '@/composables/useViewTask'
import { promptText } from '@/fsusui/feedback'
import { TimeUtils } from '@/utils/time'

type AdminTrashViewItem = ArticleListItemResponse & {
  createdAtText: string
  categoryName: string
  restoreActionText: string
}

export function useAdminArticleTrash() {
  const router = useRouter()

  const loading = ref(false)
  const trashList = shallowRef<ArticleListItemResponse[]>([])
  const total = ref(0)
  const submittingIds = ref<Set<number>>(new Set())

  const queryParam = reactive({
    page: 1,
    size: 10,
    isDeleted: true
  })

  const loadTask = useViewTask()
  const mutation = useMutationFlow()
  const trashListView = computed<AdminTrashViewItem[]>(() =>
    trashList.value.map((item) => ({
      ...item,
      createdAtText: TimeUtils.toFullLocalString(item.createTime),
      categoryName: item.category?.name || '无分类',
      restoreActionText: '恢复并重新发布'
    }))
  )
  const canBackToList = computed(() => !loading.value)
  const isRowSubmitting = (id: number): boolean => submittingIds.value.has(id)

  const loadData = async (): Promise<void> => {
    const paramsSnapshot = { ...queryParam }

    const response = await loadTask.run(async (signal) => {
      const config: ApiRequestConfig = { signal }
      return await getAdminArticles(paramsSnapshot, config)
    }, {
      fallbackMessage: '无法同步回收站数据',
      onError: (error) => {
        console.error('[Admin Trash] Sync error:', error)
      }
    })

    if (response) {
      trashList.value = Object.freeze(response?.items || []) as ArticleListItemResponse[]
      total.value = Number(response?.total) || 0
    }
  }

  const restoreTrashArticle = async (row: ArticleListItemResponse): Promise<void> => {
    submittingIds.value.add(row.id)
    try {
      await mutation.confirmThenRun({
        message: `确定要恢复文章《${row.title}》吗？恢复后文章将重新对外可见，并同步搜索索引。`,
        title: '恢复并重新发布',
        confirmButtonText: '恢复并重新发布'
      }, async (signal) => {
        const config: ApiRequestConfig = { signal }
        await restoreArticle(row.id, config)
      }, {
        fallbackMessage: '文章恢复失败',
        successMessage: '文章已恢复并重新发布',
        onSuccess: loadData
      })
    } finally {
      submittingIds.value.delete(row.id)
    }
  }

  const handleRestore = (row: ArticleListItemResponse): void => {
    if (submittingIds.value.has(row.id)) {
      return
    }

    void restoreTrashArticle(row)
  }

  const permanentlyDeleteTrashArticle = async (row: ArticleListItemResponse): Promise<void> => {
    submittingIds.value.add(row.id)
    try {
      if (!await requestPermanentDeleteConfirmation(row)) {
        return
      }

      await mutation.run(async (signal) => {
        const config: ApiRequestConfig = { signal }
        await permanentDeleteArticle(row.id, config)
      }, {
        fallbackMessage: '文章永久删除失败',
        successMessage: '文章已永久删除',
        successType: 'warning',
        onSuccess: loadData
      })
    } finally {
      submittingIds.value.delete(row.id)
    }
  }

  const handlePermanentDelete = (row: ArticleListItemResponse): void => {
    if (submittingIds.value.has(row.id)) {
      return
    }

    void permanentlyDeleteTrashArticle(row)
  }

  const requestPermanentDeleteConfirmation = async (row: ArticleListItemResponse): Promise<boolean> => {
    const value = await promptText(
      `此操作会永久删除文章《${row.title}》及其关联数据，无法恢复。请输入完整标题或文章 ID「${row.id}」继续。`,
      '永久删除文章',
      {
        type: 'warning',
        confirmButtonText: '确认永久删除',
        cancelButtonText: '取消',
        inputPlaceholder: `输入 ${row.id} 或完整标题`,
        inputValidator: (value: string) => {
          const text = value.trim()
          return text === String(row.id) || text === row.title
            ? true
            : '请输入完整标题或文章 ID'
        }
      }
    )

    return value === String(row.id) || value === row.title
  }

  onMounted(() => {
    void loadData()
  })

  onUnmounted(() => {
    loadTask.cancel()
    mutation.cancel()
  })

  return {
    router,
    loading,
    trashList,
    trashListView,
    total,
    canBackToList,
    submittingIds,
    isRowSubmitting,
    queryParam,
    loadData,
    handleRestore,
    handlePermanentDelete
  }
}

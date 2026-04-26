import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import type { AxiosRequestConfig } from 'axios'
import {
  getArticles,
  permanentDeleteArticle,
  restoreArticle,
  type ArticleListItemResponse
} from '@/api/article'
import { useMutationFlow } from '@/composables/useMutationFlow'
import { useViewTask } from '@/composables/useViewTask'
import { TimeUtils } from '@/utils/time'

type AdminTrashViewItem = ArticleListItemResponse & {
  createdAtText: string
  categoryName: string
}

const FOOTER_WATERMARK = 'FsusBlog Archive Storage / Secured'

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
      categoryName: item.category?.name || '无分类'
    }))
  )
  const pendingCountText = computed(() => `${total.value} 篇待处理`)
  const canBackToList = computed(() => !loading.value)
  const footerWatermark = FOOTER_WATERMARK
  const isRowSubmitting = (id: number): boolean => submittingIds.value.has(id)

  const loadData = async (): Promise<void> => {
    const paramsSnapshot = { ...queryParam }

    const response = await loadTask.run(async (signal) => {
      const config: AxiosRequestConfig = { signal }
      return await getArticles(paramsSnapshot, config)
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

  const handleRestore = (row: ArticleListItemResponse): void => {
    if (submittingIds.value.has(row.id)) {
      return
    }

    void (async () => {
      submittingIds.value.add(row.id)
      try {
        await mutation.confirmThenRun({
          message: `确定要恢复文章《${row.title}》吗？`,
          title: '恢复确认',
          confirmButtonText: '立即恢复',
          type: 'success'
        }, async (signal) => {
          const config: AxiosRequestConfig = { signal }
          await restoreArticle(row.id, config)
        }, {
          fallbackMessage: '文章恢复失败',
          successMessage: '文章已恢复',
          onSuccess: loadData
        })
      } finally {
        submittingIds.value.delete(row.id)
      }
    })()
  }

  const handlePermanentDelete = (row: ArticleListItemResponse): void => {
    if (submittingIds.value.has(row.id)) {
      return
    }

    void (async () => {
      submittingIds.value.add(row.id)
      try {
        await mutation.confirmThenRun({
          message: `确定要彻底抹除文章《${row.title}》吗？此操作不可逆。`,
          title: '物理销毁警示',
          confirmButtonText: '确定抹除',
          type: 'error',
          confirmButtonClass: 'el-button--danger'
        }, async (signal) => {
          const config: AxiosRequestConfig = { signal }
          await permanentDeleteArticle(row.id, config)
        }, {
          fallbackMessage: '文章彻底抹除失败',
          successMessage: '数据已彻底抹除',
          successType: 'warning',
          onSuccess: loadData
        })
      } finally {
        submittingIds.value.delete(row.id)
      }
    })()
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
    pendingCountText,
    canBackToList,
    footerWatermark,
    submittingIds,
    isRowSubmitting,
    queryParam,
    loadData,
    handleRestore,
    handlePermanentDelete
  }
}

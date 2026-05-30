import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import type { ApiRequestConfig } from '@/api/requestConfig'
import {
  ArticlePublishStatus,
  deleteArticle,
  getArticles,
  permanentDeleteArticle,
  type ArticleListItemResponse
} from '@/api/article'
import { useMutationFlow } from '@/composables/useMutationFlow'
import { useViewTask } from '@/composables/useViewTask'
import { showErrorToast } from '@/utils/errorPresentation'
import { TimeUtils } from '@/utils/time'

type AdminArticleListViewItem = ArticleListItemResponse & {
  createdAtText: string
  categoryName: string
  statusText: string
  statusTagType: 'success' | 'warning' | 'info' | 'danger'
}

const PAGE_SIZE_OPTIONS = [10, 20, 50]
const STATUS_FILTERS = [
  { label: '全部', value: undefined },
  { label: '草稿', value: ArticlePublishStatus.Draft },
  { label: '定时', value: ArticlePublishStatus.Scheduled },
  { label: '已发布', value: ArticlePublishStatus.Published },
  { label: '归档', value: ArticlePublishStatus.Archived }
] as const

const statusText = (status: ArticlePublishStatus | undefined): string => {
  if (status === ArticlePublishStatus.Draft) return '草稿'
  if (status === ArticlePublishStatus.Scheduled) return '定时'
  if (status === ArticlePublishStatus.Archived) return '归档'
  if (status === ArticlePublishStatus.Deleted) return '删除'
  return '已发布'
}

const statusTagType = (status: ArticlePublishStatus | undefined): AdminArticleListViewItem['statusTagType'] => {
  if (status === ArticlePublishStatus.Draft) return 'info'
  if (status === ArticlePublishStatus.Scheduled) return 'warning'
  if (status === ArticlePublishStatus.Archived) return 'danger'
  if (status === ArticlePublishStatus.Deleted) return 'danger'
  return 'success'
}

export function useAdminArticleList() {
  const router = useRouter()

  const loading = ref(false)
  const articleList = shallowRef<ArticleListItemResponse[]>([])
  const total = ref(0)

  const queryParam = reactive({
    page: 1,
    size: 10,
    keyword: '',
    categoryId: undefined as number | undefined,
    status: undefined as ArticlePublishStatus | undefined
  })

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const loadTask = useViewTask()
  const mutation = useMutationFlow()
  const articleListView = computed<AdminArticleListViewItem[]>(() =>
    articleList.value.map((item) => ({
      ...item,
      createdAtText: TimeUtils.toFullLocalString(item.createTime),
      categoryName: item.category?.name || '未分类',
      statusText: statusText(item.status),
      statusTagType: statusTagType(item.status)
    }))
  )
  const totalText = computed(() => `检索到 ${total.value} 篇记录`)
  const isBusy = computed(() => loading.value)

  const loadData = async (): Promise<void> => {
    const paramsSnapshot = { ...queryParam }

    loading.value = true
    try {
      const response = await loadTask.run(async (signal) => {
        const config: ApiRequestConfig = { signal }
        return await getArticles(paramsSnapshot, config)
      }, {
        fallbackMessage: '无法同步文章列表，请检查网络契约',
        onError: (error) => {
          console.error('[Admin List] Sync Error:', error)
          articleList.value = []
          total.value = 0
          showErrorToast('无法同步文章列表，请检查网络契约', '无法同步文章列表，请检查网络契约')
        }
      })

      if (!response) {
        return
      }

      if (!Array.isArray(response.items)) {
        articleList.value = []
        total.value = 0
        showErrorToast('无法同步文章列表，请检查网络契约', '无法同步文章列表，请检查网络契约')
        return
      }

      articleList.value = Object.freeze(response.items) as ArticleListItemResponse[]
      total.value = Number(response.total) || 0
    } finally {
      loading.value = false
    }
  }

  const loadDataWithDebounce = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(() => {
      void loadData()
    }, 100)
  }

  const handleSearch = (): void => {
    queryParam.page = 1
    void loadData()
  }

  const resetQuery = (): void => {
    queryParam.keyword = ''
    queryParam.categoryId = undefined
    queryParam.status = undefined
    handleSearch()
  }

  const setStatusFilter = (status: ArticlePublishStatus | undefined): void => {
    queryParam.status = status
    handleSearch()
  }

  const handleEdit = (id: number): void => {
    void router.push({ path: `/user/manage/article/edit/${id}` })
  }

  const safeDelete = (row: ArticleListItemResponse): void => {
    void (async () => {
      if (loading.value) {
        return
      }

      loading.value = true
      try {
        await mutation.confirmThenRun({
          message: `确定要将文章《${row.title}》存入回收站吗？`,
          title: '内容存档确认',
          confirmButtonText: '确定存档',
          cancelButtonText: '取消'
        }, async (signal) => {
          await deleteArticle(row.id, { signal })
        }, {
          fallbackMessage: '文章归档失败',
          successMessage: '文章已进入回收站',
          onSuccess: loadData
        })
      } finally {
        loading.value = false
      }
    })()
  }

  const safePermanentDelete = (row: ArticleListItemResponse): void => {
    void (async () => {
      if (loading.value) {
        return
      }

      loading.value = true
      try {
        await mutation.confirmThenRun(
          {
            message: `警告：此操作将永久抹除博文《${row.title}》及其所有关联数据，不可恢复！`,
            title: '物理销毁警示',
            confirmButtonText: '确定永久销毁',
            cancelButtonText: '放弃'
          },
          async (signal) => {
            await permanentDeleteArticle(row.id, { signal })
          },
          {
            fallbackMessage: '博文永久删除失败',
            successMessage: '博文已彻底从数据库抹除',
            onSuccess: loadData
          }
        )
      } finally {
        loading.value = false
      }
    })()
  }

  const handleMoreCommand = (command: string, row: ArticleListItemResponse): void => {
    if (command === 'view') {
      window.open(`/article/${row.id}`, '_blank', 'noopener,noreferrer')
      return
    }

    if (command === 'delete') {
      safeDelete(row)
      return
    }

    if (command === 'permanent') {
      safePermanentDelete(row)
    }
  }

  onMounted(() => {
    void loadData()
  })

  onUnmounted(() => {
    loadTask.cancel()
    mutation.cancel()
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  })

  return {
    router,
    loading,
    articleList,
    articleListView,
    total,
    totalText,
    isBusy,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    statusFilters: STATUS_FILTERS,
    queryParam,
    setStatusFilter,
    loadDataWithDebounce,
    handleSearch,
    resetQuery,
    handleEdit,
    handleMoreCommand
  }
}

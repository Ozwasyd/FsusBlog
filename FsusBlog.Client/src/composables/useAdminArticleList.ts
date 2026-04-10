import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { AxiosRequestConfig } from 'axios'
import {
  deleteArticle,
  getArticles,
  permanentDeleteArticle,
  type ArticleListItem
} from '@/api/article'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { getErrorMessage, isAbortError } from '@/utils/errors'
import { TimeUtils } from '@/utils/time'

type AdminArticleListViewItem = ArticleListItem & {
  createdAtText: string
  categoryName: string
}

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const

export function useAdminArticleList() {
  const router = useRouter()

  const loading = ref(false)
  const articleList = shallowRef<ArticleListItem[]>([])
  const total = ref(0)

  const queryParam = reactive({
    page: 1,
    size: 10,
    keyword: '',
    categoryId: undefined as number | undefined
  })

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const loadTask = useAbortableTask()
  const submitTask = useAbortableTask()
  const articleListView = computed<AdminArticleListViewItem[]>(() =>
    articleList.value.map((item) => ({
      ...item,
      createdAtText: TimeUtils.toFullLocalString(item.createTime),
      categoryName: item.category?.name || '未分类'
    }))
  )
  const totalText = computed(() => `检索到 ${total.value} 篇记录`)
  const isBusy = computed(() => loading.value)

  const loadData = async (): Promise<void> => {
    const paramsSnapshot = { ...queryParam }

    loading.value = true
    try {
      await loadTask.run(async (signal) => {
        const config: AxiosRequestConfig = { signal }
        const response = await getArticles(paramsSnapshot, config)

        if (!response || !Array.isArray(response.items)) {
          articleList.value = []
          total.value = 0
          ElMessage.error('无法同步文章列表，请检查网络契约')
          return
        }

        articleList.value = Object.freeze(response.items) as ArticleListItem[]
        total.value = Number(response.total) || 0
      })
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return
      }

      console.error('[Admin List] Sync Error:', error)
      ElMessage.error('无法同步文章列表，请检查网络契约')
      articleList.value = []
      total.value = 0
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
    handleSearch()
  }

  const handleEdit = (id: number): void => {
    void router.push({ path: '/admin/article/write', query: { id } })
  }

  const safeDelete = (row: ArticleListItem): void => {
    void ElMessageBox.confirm(`确定要将文章《${row.title}》存入回收站吗？`, '内容存档确认', {
      confirmButtonText: '确定存档',
      cancelButtonText: '取消',
      type: 'warning',
      roundButton: true,
      dangerouslyUseHTMLString: false
    }).then(async () => {
      if (loading.value) {
        return
      }

      loading.value = true
      try {
        await submitTask.run(async (signal) => {
          await deleteArticle(row.id, { signal })
          ElMessage.success('文章已进入回收站')
          await loadData()
        })
      } catch (error: unknown) {
        if (!isAbortError(error)) {
          ElMessage.error(getErrorMessage(error, '文章归档失败'))
        }
      } finally {
        loading.value = false
      }
    }).catch(() => undefined)
  }

  const safePermanentDelete = (row: ArticleListItem): void => {
    void ElMessageBox.confirm(
      `警告：此操作将永久抹除博文《${row.title}》及其所有关联数据，不可恢复！`,
      '物理销毁警示',
      {
        confirmButtonText: '确定永久销毁',
        cancelButtonText: '放弃',
        confirmButtonClass: 'el-button--danger',
        type: 'error',
        roundButton: true,
        center: true,
        dangerouslyUseHTMLString: false
      }
    ).then(async () => {
      if (loading.value) {
        return
      }

      loading.value = true
      try {
        await submitTask.run(async (signal) => {
          await permanentDeleteArticle(row.id, { signal })
          ElMessage.success('博文已彻底从数据库抹除')
          await loadData()
        })
      } catch (error: unknown) {
        if (!isAbortError(error)) {
          ElMessage.error(getErrorMessage(error, '博文永久删除失败'))
        }
      } finally {
        loading.value = false
      }
    }).catch(() => undefined)
  }

  const handleMoreCommand = (command: string, row: ArticleListItem): void => {
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
    submitTask.cancel()
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
    queryParam,
    loadDataWithDebounce,
    handleSearch,
    resetQuery,
    handleEdit,
    handleMoreCommand
  }
}

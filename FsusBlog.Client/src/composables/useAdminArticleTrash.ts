import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { AxiosRequestConfig } from 'axios'
import {
  getArticles,
  permanentDeleteArticle,
  restoreArticle,
  type ArticleListItem
} from '@/api/article'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { getErrorMessage, isAbortError } from '@/utils/errors'
import { TimeUtils } from '@/utils/time'

type AdminTrashViewItem = ArticleListItem & {
  createdAtText: string
  categoryName: string
}

const FOOTER_WATERMARK = 'FsusBlog Archive Storage / Secured'

export function useAdminArticleTrash() {
  const router = useRouter()

  const loading = ref(false)
  const trashList = shallowRef<ArticleListItem[]>([])
  const total = ref(0)
  const submittingIds = ref<Set<number>>(new Set())

  const queryParam = reactive({
    page: 1,
    size: 10,
    isDeleted: true
  })

  const loadTask = useAbortableTask()
  const submitTask = useAbortableTask()
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

    loading.value = true
    try {
      await loadTask.run(async (signal) => {
        const config: AxiosRequestConfig = { signal }
        const response = await getArticles(paramsSnapshot, config)
        trashList.value = Object.freeze(response?.items || []) as ArticleListItem[]
        total.value = Number(response?.total) || 0
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        console.error('[Admin Trash] Sync error:', error)
        ElMessage.error('无法同步回收站数据')
      }
    } finally {
      loading.value = false
    }
  }

  const handleRestore = (row: ArticleListItem): void => {
    if (submittingIds.value.has(row.id)) {
      return
    }

    void ElMessageBox.confirm(`确定要恢复文章《${row.title}》吗？`, '恢复确认', {
      confirmButtonText: '立即恢复',
      cancelButtonText: '取消',
      type: 'success',
      roundButton: true,
      dangerouslyUseHTMLString: false
    }).then(async () => {
      submittingIds.value.add(row.id)
      try {
        await submitTask.run(async (signal) => {
          const config: AxiosRequestConfig = { signal }
          await restoreArticle(row.id, config)
          ElMessage.success('文章已恢复')
          await loadData()
        })
      } catch (error: unknown) {
        if (!isAbortError(error)) {
          console.error('[Admin Trash] Restore error:', error)
          ElMessage.error(getErrorMessage(error, '文章恢复失败'))
        }
      } finally {
        submittingIds.value.delete(row.id)
      }
    }).catch(() => undefined)
  }

  const handlePermanentDelete = (row: ArticleListItem): void => {
    if (submittingIds.value.has(row.id)) {
      return
    }

    void ElMessageBox.confirm(`确定要彻底抹除文章《${row.title}》吗？此操作不可逆。`, '物理销毁警示', {
      confirmButtonText: '确定抹除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'error',
      roundButton: true,
      dangerouslyUseHTMLString: false
    }).then(async () => {
      submittingIds.value.add(row.id)
      try {
        await submitTask.run(async (signal) => {
          const config: AxiosRequestConfig = { signal }
          await permanentDeleteArticle(row.id, config)
          ElMessage.warning('数据已彻底抹除')
          await loadData()
        })
      } catch (error: unknown) {
        if (!isAbortError(error)) {
          console.error('[Admin Trash] Delete error:', error)
          ElMessage.error(getErrorMessage(error, '文章彻底抹除失败'))
        }
      } finally {
        submittingIds.value.delete(row.id)
      }
    }).catch(() => undefined)
  }

  onMounted(() => {
    void loadData()
  })

  onUnmounted(() => {
    loadTask.cancel()
    submitTask.cancel()
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

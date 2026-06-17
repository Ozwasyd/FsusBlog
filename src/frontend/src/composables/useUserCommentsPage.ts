import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { deleteComment, getMyComments } from '@/api/comment'
import { requestGlobalConfirm } from '@/composables/useGlobalConfirm'
import { useMutationFlow } from '@/composables/useMutationFlow'
import { usePagedListState } from '@/composables/usePagedListState'
import { useViewTask } from '@/composables/useViewTask'
import { showErrorToast } from '@/utils/errorPresentation'
import {
  createUserCommentViewContract,
  type CommentThreadItemContract
} from '@/view-contracts/commentDetail'

type CommentTimeFilter = 'all' | '7d' | '30d'

export function useUserCommentsPage() {
  const list = shallowRef<CommentThreadItemContract[]>([])
  const { loading, hasMore, beginLoading, endLoading, setError } = usePagedListState()
  const cursor = ref<string | undefined>(undefined)
  const isError = ref(false)
  const searchKeyword = ref('')
  const timeFilter = ref<CommentTimeFilter>('all')

  const pendingDeleteId = ref<string | null>(null)

  const existingIds = new Set<string>()
  const commentTask = useViewTask()
  const deleteTask = useMutationFlow()
  const showLoadMoreButton = computed(() => hasMore.value)
  const showEndHint = computed(() => !hasMore.value && list.value.length > 0)
  const loadMoreButtonText = computed(() => (loading.value ? '加载中...' : '加载更多记录'))
  const endHintText = '上面的评论已为最后一条评论。'
  const hasActiveFilter = computed(() => searchKeyword.value.trim().length > 0 || timeFilter.value !== 'all')
  const filteredList = computed(() => {
    const keyword = searchKeyword.value.trim().toLowerCase()
    const now = Date.now()
    const timeLimit = timeFilter.value === '7d'
      ? now - 7 * 24 * 60 * 60 * 1000
      : timeFilter.value === '30d'
        ? now - 30 * 24 * 60 * 60 * 1000
        : 0

    return list.value.filter((item) => {
      if (keyword) {
        const haystack = [
          item.content,
          item.article?.title ?? '',
          item.moderation?.statusLabel ?? '',
          item.moderation?.reasonText ?? ''
        ].join(' ').toLowerCase()
        if (!haystack.includes(keyword)) {
          return false
        }
      }

      if (timeLimit > 0) {
        const createdAt = new Date(item.time.isoTime).getTime()
        if (!Number.isFinite(createdAt) || createdAt < timeLimit) {
          return false
        }
      }

      return true
    })
  })

  const clearFilters = (): void => {
    searchKeyword.value = ''
    timeFilter.value = 'all'
  }

  const fetchComments = async (): Promise<void> => {
    if (loading.value) {
      return
    }

    beginLoading()
    isError.value = false

    const response = await commentTask.run(
      async (signal) => await getMyComments(cursor.value, 10, { signal }),
      {
        fallbackMessage: '加载失败',
        onError: (error) => {
          console.error('[Comment] Fetch fail:', error)
          setError('加载失败')
          isError.value = true
        }
      }
    )

    try {
      if (response) {
        const uniqueNew = response.data.filter((item) => !existingIds.has(String(item.id)))
        uniqueNew.forEach((item) => existingIds.add(String(item.id)))

        list.value = [...list.value, ...uniqueNew.map(createUserCommentViewContract)]

        cursor.value = response.nextCursor ? String(response.nextCursor) : undefined
        hasMore.value = response.hasMore
      }
    } finally {
      endLoading()
    }
  }

  const onDelete = async (id: string): Promise<void> => {
    pendingDeleteId.value = String(id)
    const confirmed = await requestGlobalConfirm({
      title: '删除评论',
      content: '确定要永久移除这条评论吗？此操作无法撤销。',
      confirmText: '删除',
      cancelText: '取消'
    })

    if (!confirmed) {
      pendingDeleteId.value = null
      return
    }

    await executeDelete()
  }

  const executeDelete = async (): Promise<void> => {
    if (!pendingDeleteId.value) {
      return
    }

    const targetId = pendingDeleteId.value
    const originalList = list.value

    list.value = list.value.filter((item) => String(item.id) !== targetId)
    existingIds.delete(targetId)

    try {
      await deleteTask.run(async () => {
        await deleteComment(targetId)
      }, {
        fallbackMessage: '删除失败，请稍后重试',
        successMessage: '评论已移除'
      })

      if (deleteTask.errorMessage.value) {
        list.value = originalList
        existingIds.add(targetId)
        showErrorToast(deleteTask.errorMessage.value, '删除失败，请稍后重试')
      }
    } finally {
      pendingDeleteId.value = null
    }
  }

  onMounted(() => {
    void fetchComments()
  })

  onUnmounted(() => {
    commentTask.cancel()
    deleteTask.cancel()
  })

  return {
    list,
    filteredList,
    loading,
    searchKeyword,
    timeFilter,
    hasActiveFilter,
    showLoadMoreButton,
    showEndHint,
    loadMoreButtonText,
    endHintText,
    isError,
    fetchComments,
    clearFilters,
    onDelete,
    executeDelete
  }
}

import { computed, onMounted, ref, shallowRef } from 'vue'
import { deleteComment, getMyComments } from '@/api/comment'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePagedListState } from '@/composables/usePagedListState'
import { getErrorMessage, isAbortError } from '@/utils/errors'
import { toast } from '@/utils/toast'
import {
  createUserCommentViewContract,
  type CommentThreadItemContract
} from '@/view-contracts/commentDetail'

export function useUserCommentsPage() {
  const list = shallowRef<CommentThreadItemContract[]>([])
  const { loading, hasMore, beginLoading, endLoading, setError, resetCursorState } = usePagedListState()
  const cursor = ref<string | undefined>(undefined)
  const isError = ref(false)

  const showConfirm = ref(false)
  const pendingDeleteId = ref<string | null>(null)

  const existingIds = new Set<string>()
  const commentTask = useAbortableTask()
  const showLoadMoreButton = computed(() => hasMore.value)
  const showEndHint = computed(() => !hasMore.value && list.value.length > 0)
  const loadMoreButtonText = computed(() => (loading.value ? '加载中...' : '加载更多记录'))
  const endHintText = '上面的评论已为最后一条评论。'

  const fetchComments = async (): Promise<void> => {
    if (loading.value) {
      return
    }

    beginLoading()
    isError.value = false

    try {
      const response = await commentTask.run(
        async (signal) => await getMyComments(cursor.value, 10, { signal })
      )

      if (response) {
        const uniqueNew = response.data.filter((item) => !existingIds.has(String(item.id)))
        uniqueNew.forEach((item) => existingIds.add(String(item.id)))

        list.value = [...list.value, ...uniqueNew.map(createUserCommentViewContract)]

        cursor.value = response.nextCursor ? String(response.nextCursor) : undefined
        hasMore.value = response.hasMore
      }
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        console.error('[Comment] Fetch fail:', error)
        setError('加载失败')
        isError.value = true
      }
    } finally {
      endLoading()
    }
  }

  const resetAndFetchComments = (): void => {
    list.value = []
    existingIds.clear()
    cursor.value = undefined
    resetCursorState()
    void fetchComments()
  }

  const onDelete = (id: string): void => {
    pendingDeleteId.value = String(id)
    showConfirm.value = true
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
      await deleteComment(targetId)
      toast.success('评论已移除')
    } catch (error: unknown) {
      list.value = originalList
      existingIds.add(targetId)

      toast.error(getErrorMessage(error, '删除失败，请稍后重试'))
      console.error('Delete fail:', error)
    } finally {
      showConfirm.value = false
      pendingDeleteId.value = null
    }
  }

  onMounted(() => {
    void fetchComments()
  })

  return {
    list,
    loading,
    showLoadMoreButton,
    showEndHint,
    loadMoreButtonText,
    endHintText,
    isError,
    showConfirm,
    fetchComments,
    onDelete,
    executeDelete
  }
}

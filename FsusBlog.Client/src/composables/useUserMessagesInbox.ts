import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { messageApi, type MessageItem } from '@/api/message'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { useNotification } from '@/composables/useNotification'
import { useWindowEvents } from '@/composables/useWindowEvents'
import { getErrorMessage, isAbortError } from '@/utils/errors'
import { toast } from '@/utils/toast'
import { createUserMessagesPageViewContract, type UserMessagesPageViewContract } from '@/view-contracts/userMessages'

const INBOX_PAGE_SIZE = 10

export function useUserMessagesInbox() {
  const { unreadCount } = useNotification()

  const messages = shallowRef<MessageItem[]>([])
  const pageView = computed<UserMessagesPageViewContract>(() =>
    createUserMessagesPageViewContract({
      unreadCount: unreadCount.value,
      messages: messages.value,
      showLoadMoreButton: hasMore.value || loadingMore.value,
      showEndHint: !hasMore.value && messages.value.length > 0,
      loadingMore: loadingMore.value
    })
  )

  const loading = ref(false)
  const loadingMore = ref(false)

  const page = ref(1)
  const hasMore = ref(true)

  const showConfirm = ref(false)
  const pendingDeleteId = ref<string | null>(null)

  const existingIds = new Set<string>()
  const pendingReadIds = new Set<string>()
  const pendingDeleteIds = new Set<string>()

  const refreshTask = useAbortableTask()
  const paginationTask = useAbortableTask()

  let isMounted = false

  const applyOptimisticState = (items: MessageItem[]): MessageItem[] =>
    items
      .filter((message) => !pendingDeleteIds.has(String(message.id)))
      .map((message) =>
        pendingReadIds.has(String(message.id)) ? { ...message, isRead: true } : message
      )

  const refreshMessages = async (silent = false): Promise<void> => {
    if (!silent) {
      loading.value = true
    }

    try {
      await refreshTask.run(async (signal) => {
        const data = await messageApi.getInbox(1, INBOX_PAGE_SIZE, { signal })

        if (signal.aborted) {
          return
        }

        const processed = applyOptimisticState(data)
        messages.value = Object.freeze(processed.slice()) as MessageItem[]

        existingIds.clear()
        processed.forEach((message) => existingIds.add(String(message.id)))

        page.value = 1
        hasMore.value = data.length === INBOX_PAGE_SIZE
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        console.error('[Inbox] Refresh Error:', getErrorMessage(error, 'unknown'))
        if (!silent) {
          toast.error('获取通知失败')
        }
      }
    } finally {
      loading.value = false
    }
  }

  const loadMore = async (): Promise<void> => {
    if (loadingMore.value || !hasMore.value) {
      return
    }

    loadingMore.value = true

    try {
      await paginationTask.run(async (signal) => {
        const nextPage = page.value + 1
        const data = await messageApi.getInbox(nextPage, INBOX_PAGE_SIZE, { signal })

        if (signal.aborted) {
          return
        }

        const uniqueNew = data.filter((item) => !existingIds.has(String(item.id)))
        const processed = applyOptimisticState(uniqueNew)

        processed.forEach((message) => existingIds.add(String(message.id)))
        messages.value = Object.freeze([...messages.value, ...processed]) as MessageItem[]

        page.value = nextPage
        hasMore.value = data.length === INBOX_PAGE_SIZE
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        console.error('[Inbox] Pagination Error:', getErrorMessage(error, 'unknown'))
      }
    } finally {
      loadingMore.value = false
    }
  }

  const handleRefreshInbox = (): void => {
    if (isMounted) {
      void refreshMessages(true)
    }
  }

  useWindowEvents([{ name: 'signalr:refresh-inbox', handler: handleRefreshInbox }])

  const handleMarkRead = async (id: string): Promise<void> => {
    const targetId = String(id)
    const itemIndex = messages.value.findIndex((message) => String(message.id) === targetId)
    if (itemIndex === -1) {
      return
    }

    const item = messages.value[itemIndex]
    if (!item || item.isRead) {
      return
    }

    pendingReadIds.add(targetId)
    const newMessages = [...messages.value]
    newMessages[itemIndex] = { ...item, isRead: true }
    messages.value = Object.freeze(newMessages) as MessageItem[]

    unreadCount.value = Math.max(0, unreadCount.value - 1)

    try {
      await messageApi.markAsRead(targetId)
    } catch {
      pendingReadIds.delete(targetId)
      if (isMounted) {
        const rollbackMessages = [...messages.value]
        const currentIndex = rollbackMessages.findIndex((message) => String(message.id) === targetId)
        if (currentIndex !== -1) {
          rollbackMessages[currentIndex] = { ...item, isRead: false }
          messages.value = Object.freeze(rollbackMessages) as MessageItem[]
        }
        unreadCount.value++
        toast.error('操作失败，请重试')
      }
    }
  }

  const handleReadAll = async (): Promise<void> => {
    if (unreadCount.value === 0) {
      return
    }

    const previousCount = unreadCount.value
    const previousMessages = [...messages.value]

    unreadCount.value = 0
    const processed = messages.value.map((message) => {
      pendingReadIds.add(String(message.id))
      return { ...message, isRead: true }
    })
    messages.value = Object.freeze(processed) as MessageItem[]

    try {
      await messageApi.markAllRead()
      toast.success('已标记全部')
    } catch {
      if (isMounted) {
        unreadCount.value = previousCount
        messages.value = Object.freeze(previousMessages) as MessageItem[]
        messages.value.forEach((message) => pendingReadIds.delete(String(message.id)))
        toast.error('标记失败')
        void refreshMessages(true)
      }
    }
  }

  const requestDelete = (id: string): void => {
    pendingDeleteId.value = String(id)
    showConfirm.value = true
  }

  const executeDelete = async (): Promise<void> => {
    if (!pendingDeleteId.value) {
      return
    }

    const id = pendingDeleteId.value
    const item = messages.value.find((message) => String(message.id) === id)
    const wasUnread = item && !item.isRead

    pendingDeleteIds.add(id)
    messages.value = Object.freeze(
      messages.value.filter((message) => String(message.id) !== id)
    ) as MessageItem[]

    if (wasUnread) {
      unreadCount.value = Math.max(0, unreadCount.value - 1)
    }

    try {
      await messageApi.deleteMessage(id)
      toast.success('已移除')
    } catch (error: unknown) {
      pendingDeleteIds.delete(id)
      if (isMounted) {
        if (wasUnread) {
          unreadCount.value++
        }
        toast.error(getErrorMessage(error, '操作受限'))
        void refreshMessages(true)
      }
    } finally {
      pendingDeleteId.value = null
    }
  }

  onMounted(() => {
    isMounted = true
    void refreshMessages()
  })

  onUnmounted(() => {
    isMounted = false
    refreshTask.cancel()
    paginationTask.cancel()
  })

  return {
    messages,
    pageView,
    loading,
    loadingMore,
    showConfirm,
    handleReadAll,
    handleMarkRead,
    requestDelete,
    executeDelete,
    loadMore
  }
}

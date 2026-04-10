import { ref, shallowRef, watch } from 'vue'
import { getComments, type CommentItem } from '@/api/comment'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { isAbortError } from '@/utils/errors'

type UseArticleCommentStreamOptions = Readonly<{
  getArticleId: () => number | null
  isMounted: () => boolean
  pageSize?: number
}>

export function useArticleCommentStream(options: UseArticleCommentStreamOptions) {
  const pageSize = options.pageSize ?? 10
  const comments = shallowRef<CommentItem[]>([])
  const visibleComments = shallowRef<CommentItem[]>([])
  const paddingTop = ref(0)
  const paddingBottom = ref(0)
  const nextCursor = ref<string | null>(null)
  const hasMore = ref(true)
  const loadingComments = ref(false)
  const loadMoreTrigger = ref<HTMLElement | null>(null)
  const virtualListRef = ref<HTMLElement | null>(null)

  const commentIdSet = new Set<string>()
  const loadTask = useAbortableTask()
  const itemHeight = 120
  const bufferSize = 12
  let scrollRAF: number | null = null
  let observer: IntersectionObserver | null = null

  const updateVirtualScroll = () => {
    const total = comments.value.length
    if (total === 0) {
      visibleComments.value = []
      paddingTop.value = 0
      paddingBottom.value = 0
      return
    }

    const scrollY = window.scrollY
    const winHeight = window.innerHeight
    const containerTop = virtualListRef.value
      ? virtualListRef.value.getBoundingClientRect().top + scrollY
      : 0

    let startIdx = 0
    if (scrollY > containerTop && containerTop !== 0) {
      startIdx = Math.floor((scrollY - containerTop) / itemHeight) - bufferSize
    }
    startIdx = Math.max(0, startIdx)

    let endIdx = startIdx + Math.ceil(winHeight / itemHeight) + (bufferSize * 2)
    endIdx = Math.min(total, endIdx)

    visibleComments.value = comments.value.slice(startIdx, endIdx)
    paddingTop.value = startIdx * itemHeight
    paddingBottom.value = (total - endIdx) * itemHeight
  }

  const handleVirtualScroll = () => {
    if (scrollRAF !== null) {
      return
    }

    scrollRAF = requestAnimationFrame(() => {
      updateVirtualScroll()
      scrollRAF = null
    })
  }

  const updateComments = (nextItems: CommentItem[]) => {
    comments.value = nextItems
    commentIdSet.clear()
    for (const item of nextItems) {
      commentIdSet.add(String(item.id))
    }
  }

  const clearCommentState = () => {
    updateComments([])
    nextCursor.value = null
    hasMore.value = true
  }

  const appendUniqueComments = (incoming: ReadonlyArray<CommentItem>) => {
    if (incoming.length === 0) {
      return 0
    }

    const merged = [...comments.value]
    let added = 0
    for (const item of incoming) {
      const id = String(item.id)
      if (commentIdSet.has(id)) {
        continue
      }
      merged.push(item)
      commentIdSet.add(id)
      added++
    }

    if (added > 0) {
      comments.value = merged
    }
    return added
  }

  const prependCommentIfAbsent = (incoming: CommentItem, limit = 500) => {
    const incomingId = String(incoming.id)
    if (commentIdSet.has(incomingId)) {
      return false
    }

    const merged = [incoming, ...comments.value]
    if (merged.length > limit) {
      const tail = merged.pop()
      if (tail) {
        commentIdSet.delete(String(tail.id))
      }
    }

    comments.value = merged
    commentIdSet.add(incomingId)
    return true
  }

  const removeCommentById = (id: string | number) => {
    const targetId = String(id)
    if (!commentIdSet.has(targetId)) {
      return false
    }

    comments.value = comments.value.filter((item) => String(item.id) !== targetId)
    commentIdSet.delete(targetId)
    return true
  }

  const loadMoreComments = async () => {
    const articleId = options.getArticleId()
    if (!articleId || loadingComments.value || !hasMore.value) {
      return
    }

    loadTask.cancel()
    loadingComments.value = true
    try {
      const res = await loadTask.run(async (signal) =>
        await getComments(articleId, nextCursor.value, pageSize, { signal }))

      if (!options.isMounted()) {
        return
      }

      if (res.data && res.data.length > 0) {
        appendUniqueComments(res.data)
        nextCursor.value = res.nextCursor ? String(res.nextCursor) : null
        hasMore.value = res.hasMore
      } else {
        hasMore.value = false
      }
    } catch (error: unknown) {
      if (!isAbortError(error) && options.isMounted()) {
        console.error('[Comments] Load failed:', error)
      }
    } finally {
      if (options.isMounted()) {
        loadingComments.value = false
      }
    }
  }

  const initObserver = () => {
    if (!loadMoreTrigger.value) {
      return
    }

    if (observer) {
      observer.disconnect()
    }

    observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && hasMore.value && !loadingComments.value) {
        void loadMoreComments()
      }
    }, { rootMargin: '400px' })

    observer.observe(loadMoreTrigger.value)
  }

  const dispose = () => {
    if (scrollRAF !== null) {
      cancelAnimationFrame(scrollRAF)
      scrollRAF = null
    }

    if (observer) {
      observer.disconnect()
      observer = null
    }

    loadTask.cancel()
  }

  watch(comments, () => {
    updateVirtualScroll()
  })

  return {
    comments,
    visibleComments,
    paddingTop,
    paddingBottom,
    nextCursor,
    hasMore,
    loadingComments,
    loadMoreTrigger,
    virtualListRef,
    handleVirtualScroll,
    clearCommentState,
    loadMoreComments,
    prependCommentIfAbsent,
    removeCommentById,
    initObserver,
    dispose
  }
}

import { reactive, ref, shallowRef } from 'vue'
import {
  getComments,
  getThreadReplies,
  type CommentReplyPreviewItem,
  type CommentThreadItem
} from '@/api/comment'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { isAbortError } from '@/utils/errors'

type UseArticleCommentStreamOptions = Readonly<{
  getArticleId: () => number | null
  isMounted: () => boolean
  pageSize?: number
  replyPageSize?: number
}>

type CommentPushLike = {
  id: string
  content: string
  createTime: string
  userName: string
  parentId?: string | null
  rootId?: string | null
  replyToUserId?: number | null
  replyToCommentId?: string | null
  depth?: number
  isDeleted?: boolean
}

export function useArticleCommentStream(options: UseArticleCommentStreamOptions) {
  const pageSize = options.pageSize ?? 10
  const replyPageSize = options.replyPageSize ?? 20

  const threads = shallowRef<CommentThreadItem[]>([])
  const hasMore = ref(true)
  const nextCursor = ref<string | null>(null)
  const loadingComments = ref(false)
  const loadingReplies = reactive<Record<string, boolean>>({})
  const loadMoreTrigger = ref<HTMLElement | null>(null)

  const threadIdSet = new Set<string>()
  const threadIndexByRoot = new Map<string, number>()
  const replyIdSetByRoot = new Map<string, Set<string>>()
  const replyCursorByRoot = new Map<string, string | null>()
  const replyHasMoreByRoot = new Map<string, boolean>()

  const loadTask = useAbortableTask()
  const replyTask = useAbortableTask()
  let observer: IntersectionObserver | null = null

  const updateReplySet = (rootId: string, replies: ReadonlyArray<CommentReplyPreviewItem>) => {
    const set = new Set<string>()
    for (const item of replies) {
      set.add(String(item.id))
    }
    replyIdSetByRoot.set(rootId, set)
  }

  const rebuildThreadIndexes = (items: ReadonlyArray<CommentThreadItem>): void => {
    threadIndexByRoot.clear()
    for (let index = 0; index < items.length; index += 1) {
      threadIndexByRoot.set(String(items[index].rootId), index)
    }
  }

  const updateThreads = (nextItems: CommentThreadItem[]) => {
    threads.value = nextItems
    threadIdSet.clear()
    threadIndexByRoot.clear()
    replyIdSetByRoot.clear()
    replyCursorByRoot.clear()
    replyHasMoreByRoot.clear()

    for (const item of nextItems) {
      threadIdSet.add(String(item.id))
      const rootId = String(item.rootId)
      threadIndexByRoot.set(rootId, threadIndexByRoot.size)
      updateReplySet(rootId, item.repliesPreview)
      replyCursorByRoot.set(rootId, item.repliesPreview.length > 0 ? String(item.repliesPreview[item.repliesPreview.length - 1]?.id ?? '') : null)
      replyHasMoreByRoot.set(rootId, item.hasMoreReplies)
    }
  }

  const clearCommentState = () => {
    updateThreads([])
    hasMore.value = true
    nextCursor.value = null
    for (const key of Object.keys(loadingReplies)) {
      delete loadingReplies[key]
    }
  }

  const appendThreads = (incoming: ReadonlyArray<CommentThreadItem>) => {
    const merged = [...threads.value]
    let appended = 0

    for (const item of incoming) {
      const id = String(item.id)
      if (threadIdSet.has(id)) {
        continue
      }
      merged.push(item)
      threadIdSet.add(id)
      const rootId = String(item.rootId)
      threadIndexByRoot.set(rootId, merged.length - 1)
      updateReplySet(rootId, item.repliesPreview)
      replyCursorByRoot.set(rootId, item.repliesPreview.length > 0 ? String(item.repliesPreview[item.repliesPreview.length - 1]?.id ?? '') : null)
      replyHasMoreByRoot.set(rootId, item.hasMoreReplies)
      appended++
    }

    if (appended > 0) {
      threads.value = merged
    }
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
        await getComments(articleId, nextCursor.value, pageSize, { signal })
      )

      if (!options.isMounted()) {
        return
      }

      appendThreads(res.data)
      nextCursor.value = res.nextCursor ? String(res.nextCursor) : null
      hasMore.value = res.hasMore
    } catch (error: unknown) {
      if (!isAbortError(error) && options.isMounted()) {
        console.error('[Comments] Load threads failed:', error)
      }
    } finally {
      if (options.isMounted()) {
        loadingComments.value = false
      }
    }
  }

  const loadMoreReplies = async (rootId: string) => {
    const articleId = options.getArticleId()
    if (!articleId || !rootId) {
      return
    }

    if (loadingReplies[rootId] === true) {
      return
    }

    if (replyHasMoreByRoot.get(rootId) === false) {
      return
    }

    const cursor = replyCursorByRoot.get(rootId) ?? null
    loadingReplies[rootId] = true

    replyTask.cancel()

    try {
      const res = await replyTask.run(async (signal) =>
        await getThreadReplies(articleId, rootId, cursor, replyPageSize, { signal })
      )

      if (!options.isMounted()) {
        return
      }

      const nextThreads = [...threads.value]
      const targetIndex = threadIndexByRoot.get(rootId) ?? -1
      if (targetIndex === -1) {
        return
      }

      const seen = replyIdSetByRoot.get(rootId) ?? new Set<string>()
      const mergedReplies = [...nextThreads[targetIndex].repliesPreview]
      for (const reply of res.data) {
        const id = String(reply.id)
        if (seen.has(id)) {
          continue
        }
        mergedReplies.push(reply)
        seen.add(id)
      }

      replyIdSetByRoot.set(rootId, seen)
      replyCursorByRoot.set(rootId, res.nextCursor ? String(res.nextCursor) : null)
      replyHasMoreByRoot.set(rootId, res.hasMore)

      nextThreads[targetIndex] = {
        ...nextThreads[targetIndex],
        repliesPreview: mergedReplies,
        hasMoreReplies: res.hasMore
      }
      threads.value = nextThreads
    } catch (error: unknown) {
      if (!isAbortError(error) && options.isMounted()) {
        console.error('[Comments] Load replies failed:', error)
      }
    } finally {
      if (options.isMounted()) {
        delete loadingReplies[rootId]
      }
    }
  }

  const prependCommentIfAbsent = (incoming: CommentPushLike, limit = 200) => {
    const incomingId = String(incoming.id)
    const rootId = String(incoming.rootId ?? incoming.id)

    if (!incoming.parentId) {
      if (threadIdSet.has(incomingId)) {
        return false
      }

      const thread: CommentThreadItem = {
        id: incomingId,
        content: incoming.content,
        createTime: incoming.createTime,
        userName: incoming.userName,
        rootId,
        isDeleted: incoming.isDeleted === true,
        replyCount: 0,
        hasMoreReplies: false,
        repliesPreview: []
      }

      const merged = [thread, ...threads.value]
      if (merged.length > limit) {
        const removed = merged.pop()
        if (removed) {
          threadIdSet.delete(String(removed.id))
          replyIdSetByRoot.delete(String(removed.rootId))
          replyCursorByRoot.delete(String(removed.rootId))
          replyHasMoreByRoot.delete(String(removed.rootId))
        }
      }

      threadIdSet.add(incomingId)
      replyIdSetByRoot.set(rootId, new Set())
      replyCursorByRoot.set(rootId, null)
      replyHasMoreByRoot.set(rootId, false)
      rebuildThreadIndexes(merged)
      threads.value = merged
      return true
    }

    const targetIndex = threadIndexByRoot.get(rootId) ?? -1
    if (targetIndex === -1) {
      return false
    }

    const seen = replyIdSetByRoot.get(rootId) ?? new Set<string>()
    if (seen.has(incomingId)) {
      return false
    }

    const reply: CommentReplyPreviewItem = {
      id: incomingId,
      content: incoming.content,
      createTime: incoming.createTime,
      userName: incoming.userName,
      replyToUserName: null,
      isDeleted: incoming.isDeleted === true
    }

    const nextThreads = [...threads.value]
    const target = nextThreads[targetIndex]
    nextThreads[targetIndex] = {
      ...target,
      replyCount: target.replyCount + 1,
      repliesPreview: [...target.repliesPreview, reply]
    }

    seen.add(incomingId)
    replyIdSetByRoot.set(rootId, seen)
    replyCursorByRoot.set(rootId, incomingId)
    threads.value = nextThreads
    return true
  }

  const removeCommentById = (id: string | number, rootId?: string | null, parentId?: string | null) => {
    const targetId = String(id)

    if (!parentId) {
      if (!threadIdSet.has(targetId)) {
        return false
      }

      const nextThreads = [...threads.value]
      const rootIndex = threadIndexByRoot.get(String(rootId ?? targetId))
      const index = rootIndex ?? nextThreads.findIndex((item) => String(item.id) === targetId)
      if (index === -1) {
        return false
      }

      nextThreads[index] = {
        ...nextThreads[index],
        isDeleted: true,
        content: '该回复已删除'
      }
      threads.value = nextThreads
      return true
    }

    const rootKey = String(rootId ?? '')
    if (!rootKey) {
      return false
    }

    const nextThreads = [...threads.value]
    const index = threadIndexByRoot.get(rootKey) ?? -1
    if (index === -1) {
      return false
    }

    const replies = [...nextThreads[index].repliesPreview]
    const replyIndex = replies.findIndex((item) => String(item.id) === targetId)
    if (replyIndex === -1) {
      return false
    }

    replies[replyIndex] = {
      ...replies[replyIndex],
      isDeleted: true,
      content: '该回复已删除'
    }

    nextThreads[index] = {
      ...nextThreads[index],
      repliesPreview: replies
    }
    threads.value = nextThreads
    return true
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
    if (observer) {
      observer.disconnect()
      observer = null
    }
    loadTask.cancel()
    replyTask.cancel()
  }

  return {
    threads,
    hasMore,
    nextCursor,
    loadingComments,
    loadingReplies,
    loadMoreTrigger,
    clearCommentState,
    loadMoreComments,
    loadMoreReplies,
    prependCommentIfAbsent,
    removeCommentById,
    initObserver,
    dispose
  }
}

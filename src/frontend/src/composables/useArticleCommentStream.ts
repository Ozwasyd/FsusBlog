import { reactive, ref, shallowRef, triggerRef } from 'vue'
import {
  getComments,
  getThreadReplies,
  resolveCommentAuthorView,
  type CommentAuthorView,
  type CommentReplyPreviewItem,
  type CommentThreadItem
} from '@/api/comment'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { COMMENT_CONTENT_CONSTRAINT } from '@/utils/contentFilter'
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
  author?: CommentAuthorView | null
  parentId?: string | null
  rootId?: string | null
  replyToAuthor?: CommentAuthorView | null
  replyToCommentId?: string | null
  depth?: number
  isDeleted?: boolean
}

const deletedCommentAuthor: CommentAuthorView = {
  mode: 'legacy_server_visible_pseudonymous',
  displayName: '已删除评论',
  displayLanguage: 'zh-CN',
  badge: null,
  scopeLabel: null
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
  let threadIndexByRoot = new Map<string, number>()
  const replyIdSetByRoot = new Map<string, Set<string>>()
  const replyCursorByRoot = new Map<string, string | null>()
  const replyHasMoreByRoot = new Map<string, boolean>()
  const replyControllerByRoot = new Map<string, AbortController>()

  const loadTask = useAbortableTask()
  let observer: IntersectionObserver | null = null

  const notifyThreadsChanged = () => triggerRef(threads)

  const updateReplySet = (rootId: string, replies: ReadonlyArray<CommentReplyPreviewItem>) => {
    replyIdSetByRoot.set(rootId, new Set(replies.map((item) => String(item.id))))
  }

  const rebuildThreadIndexes = (items: ReadonlyArray<CommentThreadItem>): void => {
    threadIndexByRoot = new Map(items.map((item, index): [string, number] => [String(item.rootId), index]))
  }

  const updateThreads = (nextItems: CommentThreadItem[]) => {
    threads.value = nextItems
    threadIdSet.clear()
    replyIdSetByRoot.clear()
    replyCursorByRoot.clear()
    replyHasMoreByRoot.clear()
    for (const controller of replyControllerByRoot.values()) {
      controller.abort()
    }
    replyControllerByRoot.clear()

    rebuildThreadIndexes(nextItems)
    for (const item of nextItems) {
      threadIdSet.add(String(item.id))
      const rootId = String(item.rootId)
      updateReplySet(rootId, item.repliesPreview)
      replyCursorByRoot.set(rootId, item.repliesPreview.length > 0 ? String(item.repliesPreview[item.repliesPreview.length - 1]?.id ?? '') : null)
      replyHasMoreByRoot.set(rootId, item.hasMoreReplies && item.repliesPreview.length < COMMENT_CONTENT_CONSTRAINT.replyRenderLimit)
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
    let appended = 0

    for (const item of incoming) {
      const id = String(item.id)
      if (threadIdSet.has(id)) {
        continue
      }
      threads.value.push(item)
      threadIdSet.add(id)
      const rootId = String(item.rootId)
      threadIndexByRoot.set(rootId, threads.value.length - 1)
      updateReplySet(rootId, item.repliesPreview)
      replyCursorByRoot.set(rootId, item.repliesPreview.length > 0 ? String(item.repliesPreview[item.repliesPreview.length - 1]?.id ?? '') : null)
      replyHasMoreByRoot.set(rootId, item.hasMoreReplies && item.repliesPreview.length < COMMENT_CONTENT_CONSTRAINT.replyRenderLimit)
      appended++
    }

    if (appended > 0) {
      notifyThreadsChanged()
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

  const reconcileCommentsAfterMutation = async (): Promise<void> => {
    const articleId = options.getArticleId()
    if (!articleId || !options.isMounted()) {
      return
    }

    loadTask.cancel()
    loadingComments.value = true
    try {
      const res = await loadTask.run(async (signal) =>
        await getComments(articleId, null, pageSize, { signal })
      )
      if (!options.isMounted()) {
        return
      }

      updateThreads(res.data)
      nextCursor.value = res.nextCursor ? String(res.nextCursor) : null
      hasMore.value = res.hasMore
    } catch (error: unknown) {
      if (!isAbortError(error) && options.isMounted()) {
        console.error('[Comments] Reconcile after mutation failed:', error)
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
    const controller = new AbortController()
    replyControllerByRoot.set(rootId, controller)

    try {
      const res = await getThreadReplies(articleId, rootId, cursor, replyPageSize, { signal: controller.signal })

      if (!options.isMounted()) {
        return
      }

      const targetIndex = threadIndexByRoot.get(rootId) ?? -1
      if (targetIndex === -1) {
        return
      }

      const seen = replyIdSetByRoot.get(rootId) ?? new Set<string>()
      const target = threads.value[targetIndex]
      const mergedReplies = target.repliesPreview
      for (const reply of res.data) {
        const id = String(reply.id)
        if (seen.has(id)) {
          continue
        }
        mergedReplies.push(reply)
        seen.add(id)
      }

      const cappedReplies = mergedReplies.slice(0, COMMENT_CONTENT_CONSTRAINT.replyRenderLimit)
      const reachedRenderLimit = cappedReplies.length >= COMMENT_CONTENT_CONSTRAINT.replyRenderLimit
      updateReplySet(rootId, cappedReplies)
      replyCursorByRoot.set(rootId, res.nextCursor ? String(res.nextCursor) : null)
      replyHasMoreByRoot.set(rootId, res.hasMore && !reachedRenderLimit)

      target.repliesPreview = cappedReplies
      target.hasMoreReplies = res.hasMore && !reachedRenderLimit
      notifyThreadsChanged()
    } catch (error: unknown) {
      if (!isAbortError(error) && options.isMounted()) {
        console.error('[Comments] Load replies failed:', error)
      }
    } finally {
      replyControllerByRoot.delete(rootId)
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
        author: resolveCommentAuthorView({ author: incoming.author ?? null }),
        rootId,
        isDeleted: incoming.isDeleted === true,
        replyCount: 0,
        hasMoreReplies: false,
        repliesPreview: []
      }

      threads.value.unshift(thread)
      if (threads.value.length > limit) {
        const removed = threads.value.pop()
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
      rebuildThreadIndexes(threads.value)
      notifyThreadsChanged()
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
      author: resolveCommentAuthorView({ author: incoming.author ?? null }),
      replyToAuthor: incoming.replyToAuthor ?? null,
      isDeleted: incoming.isDeleted === true
    }

    const target = threads.value[targetIndex]
    target.replyCount += 1
    if (target.repliesPreview.length < COMMENT_CONTENT_CONSTRAINT.replyRenderLimit) {
      target.repliesPreview.push(reply)
    }

    seen.add(incomingId)
    replyIdSetByRoot.set(rootId, seen)
    replyCursorByRoot.set(rootId, incomingId)
    notifyThreadsChanged()
    return true
  }

  const removeCommentById = (id: string | number, rootId?: string | null, parentId?: string | null) => {
    const targetId = String(id)

    if (!parentId) {
      if (!threadIdSet.has(targetId)) {
        return false
      }

      const rootIndex = threadIndexByRoot.get(String(rootId ?? targetId))
      const index = rootIndex ?? threads.value.findIndex((item) => String(item.id) === targetId)
      if (index === -1) {
        return false
      }

      threads.value[index].isDeleted = true
      threads.value[index].content = '该回复已删除'
      threads.value[index].author = { ...deletedCommentAuthor }
      notifyThreadsChanged()
      return true
    }

    const rootKey = String(rootId ?? '')
    if (!rootKey) {
      return false
    }

    const index = threadIndexByRoot.get(rootKey) ?? -1
    if (index === -1) {
      return false
    }

    const replies = threads.value[index].repliesPreview
    const replyIndex = replies.findIndex((item) => String(item.id) === targetId)
    if (replyIndex === -1) {
      return false
    }

    replies[replyIndex].isDeleted = true
    replies[replyIndex].content = '该回复已删除'
    replies[replyIndex].author = { ...deletedCommentAuthor }
    notifyThreadsChanged()
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
    for (const controller of replyControllerByRoot.values()) {
      controller.abort()
    }
    replyControllerByRoot.clear()
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
    reconcileCommentsAfterMutation,
    loadMoreReplies,
    prependCommentIfAbsent,
    removeCommentById,
    initObserver,
    dispose
  }
}

import { nextTick, reactive, ref, shallowRef, triggerRef } from 'vue'
import {
  getCommentChildren,
  getCommentPermalinkContext,
  getComments,
  resolveCommentAuthorView,
  type CommentAuthorView,
  type CommentPermalinkStatus,
  type CommentTreeNode,
  type CommentTreeRoot
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

export type CommentTreeViewNode = CommentTreeNode & {
  children: CommentTreeViewNode[]
  childrenExpanded: boolean
}

const deletedCommentAuthor: CommentAuthorView = {
  mode: 'legacy_server_visible_pseudonymous',
  displayName: '已删除评论',
  displayLanguage: 'zh-CN',
  badge: null,
  scopeLabel: null
}

const toViewNode = (node: CommentTreeNode, children: ReadonlyArray<CommentTreeNode> = []): CommentTreeViewNode => ({
  ...node,
  children: children.map((child) => toViewNode(child)),
  childrenExpanded: children.length > 0
})

const compareCommentIds = (left: string, right: string): number => {
  const leftId = BigInt(left)
  const rightId = BigInt(right)
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

export function useArticleCommentStream(options: UseArticleCommentStreamOptions) {
  const pageSize = options.pageSize ?? 10
  const childPageSize = options.replyPageSize ?? 20
  const threads = shallowRef<CommentTreeViewNode[]>([])
  const hasMore = ref(true)
  const nextCursor = ref<string | null>(null)
  const loadingComments = ref(false)
  const loadingReplies = reactive<Record<string, boolean>>({})
  const loadMoreTrigger = ref<HTMLElement | null>(null)
  const permalinkStatus = ref<CommentPermalinkStatus | null>(null)

  const nodeById = new Map<string, CommentTreeViewNode>()
  const childCursorByParent = new Map<string, string | null>()
  const childHasMoreByParent = new Map<string, boolean>()
  const childControllerByParent = new Map<string, AbortController>()
  const loadTask = useAbortableTask()
  let observer: IntersectionObserver | null = null
  let permalinkResolved = false

  const notifyThreadsChanged = () => triggerRef(threads)

  const indexBranch = (node: CommentTreeViewNode): void => {
    nodeById.set(node.id, node)
    const lastChild = node.children.at(-1)
    childCursorByParent.set(node.id, lastChild?.id ?? null)
    childHasMoreByParent.set(node.id, node.hasMoreChildren)
    for (const child of node.children) indexBranch(child)
  }

  const rebuildIndexes = (): void => {
    nodeById.clear()
    childCursorByParent.clear()
    childHasMoreByParent.clear()
    for (const root of threads.value) indexBranch(root)
  }

  const updateThreads = (items: ReadonlyArray<CommentTreeRoot>): void => {
    threads.value = items.map((item) => toViewNode(item.node, item.childrenPreview))
    rebuildIndexes()
    for (const controller of childControllerByParent.values()) controller.abort()
    childControllerByParent.clear()
  }

  const appendThreads = (incoming: ReadonlyArray<CommentTreeRoot>): void => {
    for (const item of incoming) {
      if (nodeById.has(item.node.id)) continue
      const root = toViewNode(item.node, item.childrenPreview)
      threads.value.push(root)
      indexBranch(root)
    }
    notifyThreadsChanged()
  }

  const mergeChildren = (parent: CommentTreeViewNode, incoming: ReadonlyArray<CommentTreeNode>): void => {
    const seen = new Set(parent.children.map((child) => child.id))
    for (const item of incoming) {
      const existing = nodeById.get(item.id)
      if (existing) {
        Object.assign(existing, item)
        continue
      }
      if (seen.has(item.id)) continue
      const child = toViewNode(item)
      parent.children.push(child)
      indexBranch(child)
      seen.add(child.id)
    }
    parent.children.sort((left, right) => compareCommentIds(left.id, right.id))
    parent.childrenExpanded = true
  }

  const loadMoreReplies = async (parentId: string) => {
    const articleId = options.getArticleId()
    const parent = nodeById.get(parentId)
    if (!articleId || !parent || loadingReplies[parentId] || childHasMoreByParent.get(parentId) === false) return

    loadingReplies[parentId] = true
    const controller = new AbortController()
    childControllerByParent.set(parentId, controller)
    try {
      const response = await getCommentChildren(
        articleId,
        parentId,
        childCursorByParent.get(parentId) ?? null,
        childPageSize,
        { signal: controller.signal }
      )
      if (!options.isMounted()) return
      mergeChildren(parent, response.data)
      childCursorByParent.set(parentId, response.nextCursor)
      childHasMoreByParent.set(parentId, response.hasMore)
      parent.hasMoreChildren = response.hasMore
      notifyThreadsChanged()
    } catch (error: unknown) {
      if (!isAbortError(error) && options.isMounted()) console.error('[Comments] Load child branch failed:', error)
    } finally {
      childControllerByParent.delete(parentId)
      if (options.isMounted()) delete loadingReplies[parentId]
    }
  }

  const installPermalinkContext = async (): Promise<void> => {
    if (permalinkResolved || typeof window === 'undefined') return
    const match = /^#comment-(\d+)$/u.exec(window.location.hash)
    if (!match) return
    permalinkResolved = true
    const articleId = options.getArticleId()
    if (!articleId) return
    try {
      const context = await getCommentPermalinkContext(articleId, match[1]!, 8)
      permalinkStatus.value = context.status
      if (context.status !== 'found' || !context.target) return

      const chain = [...context.ancestors, context.target]
      let parent: CommentTreeViewNode | null = null
      for (const item of chain) {
        let current = nodeById.get(item.id)
        if (!current) {
          current = toViewNode(item)
          if (parent) parent.children.push(current)
          else threads.value.unshift(current)
          indexBranch(current)
        }
        if (parent) parent.childrenExpanded = true
        parent = current
      }
      const targetParent = context.target.parentId ? nodeById.get(context.target.parentId) : null
      if (targetParent) {
        mergeChildren(targetParent, context.siblings)
      } else {
        for (const sibling of context.siblings) {
          if (nodeById.has(sibling.id)) continue
          const siblingRoot = toViewNode(sibling)
          threads.value.push(siblingRoot)
          indexBranch(siblingRoot)
        }
        threads.value.sort((left, right) => compareCommentIds(right.id, left.id))
      }
      notifyThreadsChanged()
      await nextTick()
      const targetElement = document.getElementById(`comment-${context.target.id}`)
      targetElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      targetElement?.focus({ preventScroll: true })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        permalinkStatus.value = 'unavailable'
        console.error('[Comments] Resolve permalink failed:', error)
      }
    }
  }

  const loadMoreComments = async () => {
    const articleId = options.getArticleId()
    if (!articleId || loadingComments.value || !hasMore.value) return
    loadTask.cancel()
    loadingComments.value = true
    try {
      const response = await loadTask.run((signal) => getComments(articleId, nextCursor.value, pageSize, { signal }))
      if (!options.isMounted()) return
      appendThreads(response.data)
      nextCursor.value = response.nextCursor
      hasMore.value = response.hasMore
      await installPermalinkContext()
    } catch (error: unknown) {
      if (!isAbortError(error) && options.isMounted()) console.error('[Comments] Load roots failed:', error)
    } finally {
      if (options.isMounted()) loadingComments.value = false
    }
  }

  const reconcileCommentsAfterMutation = async (): Promise<void> => {
    const articleId = options.getArticleId()
    if (!articleId || !options.isMounted()) return
    loadTask.cancel()
    loadingComments.value = true
    try {
      const response = await loadTask.run((signal) => getComments(articleId, null, pageSize, { signal }))
      if (!options.isMounted()) return
      updateThreads(response.data)
      nextCursor.value = response.nextCursor
      hasMore.value = response.hasMore
      await installPermalinkContext()
    } catch (error: unknown) {
      if (!isAbortError(error) && options.isMounted()) console.error('[Comments] Reconcile failed:', error)
    } finally {
      if (options.isMounted()) loadingComments.value = false
    }
  }

  const prependCommentIfAbsent = (incoming: CommentPushLike, limit = 200) => {
    if (nodeById.has(incoming.id)) return false
    const rootId = String(incoming.rootId ?? incoming.id)
    const node = toViewNode({
      id: incoming.id,
      content: incoming.content,
      createTime: incoming.createTime,
      author: resolveCommentAuthorView({ author: incoming.author ?? null }),
      replyToAuthor: incoming.replyToAuthor ?? null,
      parentId: incoming.parentId ?? null,
      rootId,
      replyToCommentId: incoming.replyToCommentId ?? incoming.parentId ?? null,
      depth: Math.max(0, incoming.depth ?? 0),
      isDeleted: incoming.isDeleted === true,
      childCount: 0,
      hasMoreChildren: false
    })
    if (!incoming.parentId) {
      threads.value.unshift(node)
      if (threads.value.length > limit) threads.value.pop()
    } else {
      const parent = nodeById.get(incoming.parentId)
      if (!parent) return false
      parent.childCount += 1
      parent.children.push(node)
      parent.childrenExpanded = true
    }
    indexBranch(node)
    notifyThreadsChanged()
    return true
  }

  const removeCommentById = (id: string | number, _rootId?: string | null, _parentId?: string | null) => {
    const node = nodeById.get(String(id))
    if (!node) return false
    node.isDeleted = true
    node.content = '该回复已删除'
    node.author = { ...deletedCommentAuthor }
    node.replyToAuthor = null
    notifyThreadsChanged()
    return true
  }

  const clearCommentState = () => {
    threads.value = []
    hasMore.value = true
    nextCursor.value = null
    permalinkStatus.value = null
    permalinkResolved = false
    rebuildIndexes()
  }

  const initObserver = () => {
    if (!loadMoreTrigger.value) return
    observer?.disconnect()
    observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && hasMore.value && !loadingComments.value) void loadMoreComments()
    }, { rootMargin: '400px' })
    observer.observe(loadMoreTrigger.value)
  }

  const dispose = () => {
    observer?.disconnect()
    observer = null
    loadTask.cancel()
    for (const controller of childControllerByParent.values()) controller.abort()
    childControllerByParent.clear()
  }

  return {
    threads,
    hasMore,
    nextCursor,
    loadingComments,
    loadingReplies,
    loadMoreTrigger,
    permalinkStatus,
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

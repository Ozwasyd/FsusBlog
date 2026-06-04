import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getRelatedReading, type ArticleDetailResponse, type RelatedReadingResponse } from '@/api/article'
import { toBootstrapArticleDetail } from '@/bootstrap/publicAotBootstrap'
import { createComment, deleteComment } from '@/api/comment'
import { useUserStore } from '@/store/user'
import { useArticleBinaryStore } from '@/store/article'
import type MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import { toast } from '@/fsusui/feedback'
import { usePow } from '@/composables/usePow'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { useArticleCommentStream } from '@/composables/useArticleCommentStream'
import { usePublicPageLifecycle } from '@/composables/usePublicPageLifecycle'
import { consumePublicPageSeed } from '@/public-renderers/pageSeed'
import { validateCommentContent } from '@/utils/contentFilter'
import { isAbortError } from '@/utils/errors'
import { showErrorToast } from '@/utils/errorPresentation'
import { alertInfo } from '@/fsusui/feedback'
import { requestGlobalConfirm } from '@/composables/useGlobalConfirm'
import type { SseArticleRenderPatch, SseCommentRenderPatch } from '@/services/sseTypes'
import { useSseStore } from '@/store/sse'
import {
  createArticleDetailPageViewContract,
  createArticleDetailHeaderViewContract,
  emptyArticleDetailHeaderView,
  emptyArticleDetailPageView
} from '@/view-contracts/articleDetail'

type ArticleSignalPayload = { articleId: string | number }

type CommentAddedSignalPayload = ArticleSignalPayload & {
  comment: {
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
}

type CommentDeletedSignalPayload = ArticleSignalPayload & {
  commentId: string | number
  rootId?: string | null
  parentId?: string | null
}

type ReplyTarget = {
  id: string
  rootId: string
  userName: string
  depth: number
} | null

const COMMENT_SUMMARY_LIMIT = 48

export function useArticleDetailView() {
  const route = useRoute()
  const router = useRouter()
  const sseStore = useSseStore()
  const { bootstrap: initialBootstrap } = consumePublicPageSeed('ArticleDetail')
  const userStore = useUserStore()
  const articleStore = useArticleBinaryStore()
  const powProvider = usePow()
  const initialRouteId = Number(route.params.id)
  const initialBootstrapArticle = initialBootstrap?.article &&
    Number.isFinite(initialRouteId) &&
    Number(initialBootstrap.article.id) === initialRouteId
      ? toBootstrapArticleDetail(initialBootstrap.article)
      : null
  const initialBootstrapRelatedReading = initialBootstrapArticle ? initialBootstrap?.relatedReading ?? null : null

  const article = ref<ArticleDetailResponse | null>(initialBootstrapArticle)
  const relatedReading = ref<RelatedReadingResponse | null>(initialBootstrapRelatedReading)
  const loading = ref(!initialBootstrapArticle)
  const isError = ref(false)
  const spaReady = ref(false)
  const articleLoadTask = useAbortableTask()
  const relatedLoadTask = useAbortableTask()
  const commentSubmitTask = useAbortableTask()

  const articleRendererRef = ref<InstanceType<typeof MarkdownRenderer> | null>(null)
  const commentContent = ref('')
  const submittingComment = ref(false)
  const replyTarget = ref<ReplyTarget>(null)

  let bootstrapApplied = Boolean(initialBootstrapArticle)
  let routeInitVersion = 0
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const lifecycle = usePublicPageLifecycle({
    onDispose: () => {
      debounceTimers.forEach((timer) => clearTimeout(timer))
      debounceTimers.clear()
      disposeCommentStream()
      articleLoadTask.cancel()
      relatedLoadTask.cancel()
      commentSubmitTask.cancel()
    }
  })

  const {
    threads,
    hasMore,
    loadingComments,
    loadingReplies,
    loadMoreTrigger,
    clearCommentState,
    loadMoreComments,
    loadMoreReplies,
    prependCommentIfAbsent,
    removeCommentById,
    initObserver,
    dispose: disposeCommentStream
  } = useArticleCommentStream({
    getArticleId: () => article.value?.id ?? null,
    isMounted: () => lifecycle.isActive(),
    pageSize: 10,
    replyPageSize: 20
  })

  const articleView = computed(() =>
    article.value ? createArticleDetailHeaderViewContract(article.value) : emptyArticleDetailHeaderView
  )

  const totalCommentCount = computed(() => threads.value.reduce((acc, item) => acc + 1 + item.replyCount, 0))

  const detailView = computed(() =>
    article.value
      ? createArticleDetailPageViewContract(
          article.value,
          totalCommentCount.value,
          hasMore.value,
          relatedReading.value
        )
      : emptyArticleDetailPageView
  )

  const resolveActiveRouteId = (): number | null => {
    const id = Number(route.params.id)
    return Number.isFinite(id) ? id : null
  }

  const hydrateCommentStream = async (): Promise<void> => {
    if (!lifecycle.isActive() || !article.value) {
      return
    }

    const articleId = article.value.id
    clearCommentState()
    await nextTick()
    if (!lifecycle.isActive() || article.value?.id !== articleId) {
      return
    }

    await loadMoreComments()
    if (!lifecycle.isActive() || article.value?.id !== articleId) {
      return
    }

    await nextTick()
    initObserver()
  }

  const runSmoothUpdate = async (updateAction: () => Promise<void>): Promise<void> => {
    const containerRef = articleRendererRef.value?.rootEl as HTMLElement | { value?: HTMLElement | null } | null | undefined
    const container = containerRef instanceof HTMLElement ? containerRef : containerRef?.value ?? null
    if (!container || !article.value) {
      await updateAction()
      return
    }

    const children = Array.from(container.children)
    let anchorIndex = -1
    let anchorOffset = 0

    const foundAnchor = children.find((element, index) => {
      const rect = element.getBoundingClientRect()
      if (rect.top >= 0) {
        anchorIndex = index
        anchorOffset = rect.top
        return true
      }
      return false
    })

    await updateAction()

    if (foundAnchor && anchorIndex !== -1) {
      await nextTick()
      const freshContainerRef = articleRendererRef.value?.rootEl as HTMLElement | { value?: HTMLElement | null } | null | undefined
      const freshContainer = freshContainerRef instanceof HTMLElement ? freshContainerRef : freshContainerRef?.value ?? null
      if (freshContainer && freshContainer.children.length > anchorIndex) {
        const targetElement = freshContainer.children[anchorIndex] as HTMLElement
        if (targetElement) {
          const newRect = targetElement.getBoundingClientRect()
          const diff = newRect.top - anchorOffset
          window.scrollBy(0, diff)
        } else {
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
    }
  }

  const loadRelatedReading = async (articleId: number): Promise<void> => {
    try {
      const response = await relatedLoadTask.run(
        async (signal) => await getRelatedReading(articleId, { signal })
      )
      if (lifecycle.isActive() && article.value?.id === articleId) {
        relatedReading.value = response
      }
    } catch (error: unknown) {
      if (import.meta.env.DEV && !isAbortError(error) && lifecycle.isActive() && article.value?.id === articleId) {
        console.warn('[Article] Related reading failed:', error)
      }
    }
  }

  const loadArticle = async (silent = false, loadComments = true, loadRelated = true): Promise<void> => {
    const id = resolveActiveRouteId()
    if (id === null) {
      article.value = null
      relatedReading.value = null
      isError.value = false
      loading.value = false
      return
    }

    articleLoadTask.cancel()

    if (!silent) {
      loading.value = true
      isError.value = false
    }

    const action = async (): Promise<void> => {
      try {
        const response = await articleLoadTask.run(
          async (signal) => await articleStore.fetchArticleById(id, signal)
        )
        if (!lifecycle.isActive() || resolveActiveRouteId() !== id) {
          return
        }

        if (response) {
          article.value = response
          if (loadRelated) {
            await loadRelatedReading(response.id)
          }
          if (!silent && loadComments) {
            clearCommentState()
            await loadMoreComments()
          }
        }
      } catch (error: unknown) {
        if (!isAbortError(error) && lifecycle.isActive()) {
          console.error('[Article] Load failed:', error)
          isError.value = true
        }
      }
    }

    if (silent) {
      await runSmoothUpdate(action)
    } else {
      await action()
      if (lifecycle.isActive() && resolveActiveRouteId() === id) {
        await nextTick()
        if (loadComments) {
          initObserver()
        }
      }
    }

    if (lifecycle.isActive() && !silent && resolveActiveRouteId() === id) {
      loading.value = false
    }
  }

  const initializeArticleRoute = async (): Promise<void> => {
    const initVersion = ++routeInitVersion
    const routeId = resolveActiveRouteId()
    const canReuseHydratedBootstrap =
      bootstrapApplied &&
      article.value !== null
      && routeId !== null
      && article.value.id === routeId

    spaReady.value = false
    isError.value = false
    disposeCommentStream()
    relatedLoadTask.cancel()
    clearCommentState()
    clearReplyTarget()

    if (!canReuseHydratedBootstrap) {
      article.value = null
      relatedReading.value = null
    } else {
      relatedReading.value = initialBootstrapRelatedReading
    }

    const bootstrapArticle = !bootstrapApplied &&
      initialBootstrap?.article &&
      routeId !== null &&
      Number(initialBootstrap.article.id) === routeId
      ? initialBootstrap.article
      : null

    if (canReuseHydratedBootstrap) {
      loading.value = false
    } else if (bootstrapArticle) {
      article.value = toBootstrapArticleDetail(bootstrapArticle)
      relatedReading.value = initialBootstrap?.relatedReading ?? null
      loading.value = false
      bootstrapApplied = true
    } else {
      await loadArticle(false, false)
    }

    if (!lifecycle.isActive() || initVersion !== routeInitVersion) {
      return
    }

    if (!article.value) {
      loading.value = false
      return
    }

    if (canReuseHydratedBootstrap || bootstrapArticle) {
      await loadArticle(true, false, relatedReading.value === null)
      if (!lifecycle.isActive() || initVersion !== routeInitVersion || !article.value) {
        return
      }
    }

    await nextTick()
    if (!lifecycle.isActive() || initVersion !== routeInitVersion || !article.value) {
      return
    }

    spaReady.value = true
    await hydrateCommentStream()
    if (lifecycle.isActive() && initVersion === routeInitVersion && article.value) {
      powProvider.prewarm()
    }
  }

  const handleRenderComplete = (): void => {
    // no-op, kept for renderer event contract
  }

  const commentsRedirectPath = (): string => {
    const current = route.fullPath.split('#')[0] || route.path
    return `${current}#comments`
  }

  const redirectToCommentLogin = (): void => {
    void router.push({
      path: '/login',
      query: {
        redirect: commentsRedirectPath()
      }
    })
  }

  const handleRemoteArticleUpdated = (data: ArticleSignalPayload): void => {
    if (!data?.articleId || !article.value) {
      return
    }

    const articleId = String(data.articleId)
    if (articleId !== String(article.value.id)) {
      return
    }

    if (debounceTimers.has(articleId)) {
      clearTimeout(debounceTimers.get(articleId))
    }

    const timer = setTimeout(async () => {
      if (lifecycle.isActive()) {
        await loadArticle(true)
        toast.info('内容已实时同步')
      }
      debounceTimers.delete(articleId)
    }, 500)

    debounceTimers.set(articleId, timer)
  }

  const handleRemoteArticleDeleted = (data: ArticleSignalPayload): void => {
    if (!data?.articleId) {
      return
    }

    const targetId = String(data.articleId)
    if (article.value && targetId === String(article.value.id)) {
      if (debounceTimers.has(targetId)) {
        clearTimeout(debounceTimers.get(targetId))
        debounceTimers.delete(targetId)
      }
      article.value = null

      void (async () => {
        const confirmed = await alertInfo('该文章内容已被作者移除，正在为您返回首页。', '文章已被删除', {
          confirmButtonText: '确定'
        })
        if (confirmed) {
          void router.replace('/')
        }
      })()
    }
  }

  const handleSignalRReconnected = (): void => {
    if (lifecycle.isActive() && article.value) {
      void loadArticle(true)
    }
  }

  const submitComment = async (): Promise<void> => {
    if (!commentContent.value.trim() || !article.value) {
      return
    }

    const checkResult = validateCommentContent(commentContent.value)
    if (!checkResult.isValid) {
      showErrorToast(checkResult.message)
      return
    }

    if (submittingComment.value || powProvider.isCalculating.value) {
      return
    }
    submittingComment.value = true

    commentSubmitTask.cancel()

    try {
      await commentSubmitTask.run(
        async (signal) =>
          await createComment(
            {
              articleId: article.value!.id,
              content: commentContent.value,
              parentId: replyTarget.value?.id ?? null,
              rootId: replyTarget.value?.rootId ?? null,
              replyToCommentId: replyTarget.value?.id ?? null
            },
            { signal }
          )
      )

      if (lifecycle.isActive()) {
        toast.success('已提交审核')
        commentContent.value = ''
        clearReplyTarget()
      }
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        console.error('[Comment] Submit failed:', error)
        showErrorToast(error, '评论发布失败')
      }
    } finally {
      if (lifecycle.isActive()) {
        submittingComment.value = false
      }
    }
  }

  const setReplyTarget = (payload: { id: string; rootId: string; userName: string; depth: number }): void => {
    if (!userStore.isLoggedIn) {
      redirectToCommentLogin()
      return
    }

    replyTarget.value = payload
  }

  const clearReplyTarget = (): void => {
    replyTarget.value = null
  }

  const handleRemoteAdd = (data: CommentAddedSignalPayload): void => {
    if (!data?.articleId || !data.comment?.id) {
      return
    }

    if (article.value && String(data.articleId) === String(article.value.id)) {
      prependCommentIfAbsent(data.comment)
    }
  }

  const handleRemoteDelete = (data: CommentDeletedSignalPayload): void => {
    if (!data?.articleId || !data.commentId) {
      return
    }

    if (article.value && String(data.articleId) === String(article.value.id)) {
      removeCommentById(data.commentId, data.rootId ?? null, data.parentId ?? null)
    }
  }

  const summarizeCommentContent = (content: string): string => {
    const normalized = content.replace(/\s+/g, ' ').trim()
    if (!normalized) {
      return '无内容摘要'
    }

    return normalized.length > COMMENT_SUMMARY_LIMIT
      ? `${normalized.slice(0, COMMENT_SUMMARY_LIMIT)}...`
      : normalized
  }

  const handleCommentDelete = (payload: { id: string; rootId: string; parentId: string | null; content: string }): void => {
    const targetId = String(payload.id)
    const isAdmin = userStore.isAdmin
    const summary = summarizeCommentContent(payload.content)

    void (async () => {
      const confirmed = await requestGlobalConfirm({
        title: isAdmin ? '管理员操作' : '删除评论',
        content: isAdmin
          ? `确定要删除这条评论吗？操作记录将被审计。内容摘要：${summary}`
          : `确定要删除这条评论吗？内容摘要：${summary}`,
        confirmText: '删除'
      })
      if (!confirmed) {
        return
      }

      try {
        await deleteComment(targetId)
        toast.success('已移除')
        removeCommentById(targetId, payload.rootId, payload.parentId)
      } catch (error: unknown) {
        showErrorToast(error, '操作失败')
      }
    })()
  }

  const handleArticleBatch = (patches: readonly SseArticleRenderPatch[]): void => {
    for (const patch of patches) {
      if (patch.kind === 'reconnected') {
        handleSignalRReconnected()
        continue
      }

      const payload = patch.event?.payload
      if (!payload) {
        continue
      }

      if (payload.action === 'Deleted') {
        handleRemoteArticleDeleted(payload)
        continue
      }

      if (payload.action === 'Updated' || payload.action === 'Restored') {
        handleRemoteArticleUpdated(payload)
      }
    }
  }

  const handleCommentBatch = (patches: readonly SseCommentRenderPatch[]): void => {
    for (const patch of patches) {
      const payload = patch.event.payload
      if (patch.kind === 'added') {
        handleRemoteAdd(payload as CommentAddedSignalPayload)
        continue
      }

      handleRemoteDelete(payload as CommentDeletedSignalPayload)
    }
  }

  onMounted(() => {
    void initializeArticleRoute()
  })

  watch(
    () => route.params.id,
    (nextId, prevId) => {
      if (!lifecycle.isActive() || nextId === prevId) {
        return
      }

      void initializeArticleRoute()
    }
  )

  watch(
    () => sseStore.articleRevision,
    () => {
      if (!lifecycle.isActive()) {
        return
      }

      handleArticleBatch(sseStore.articleBatch)
    }
  )

  watch(
    () => sseStore.commentRevision,
    () => {
      if (!lifecycle.isActive()) {
        return
      }

      handleCommentBatch(sseStore.commentBatch)
    }
  )

  return {
    route,
    userStore,
    powProvider,
    initialBootstrapArticle,
    article,
    articleView,
    detailView,
    loading,
    isError,
    articleRendererRef,
    commentContent,
    submittingComment,
    threads,
    hasMore,
    loadingComments,
    loadingReplies,
    loadMoreTrigger,
    replyTarget,
    setReplyTarget,
    clearReplyTarget,
    loadMoreReplies,
    loadMoreComments,
    loadArticle,
    handleRenderComplete,
    submitComment,
    handleCommentDelete,
    spaReady
  }
}

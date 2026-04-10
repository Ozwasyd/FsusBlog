import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ArticleDetail } from '@/api/article'
import { consumePublicAotBootstrap, toBootstrapArticleDetail } from '@/bootstrap/publicAotBootstrap'
import { createComment, deleteComment, type CommentItem } from '@/api/comment'
import { useUserStore } from '@/store/user'
import { useArticleBinaryStore } from '@/store/article'
import type MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import { toast } from '@/utils/toast'
import { usePow } from '@/composables/usePow'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { useAotRenderBridge } from '@/composables/useAotRenderBridge'
import { useArticleCommentStream } from '@/composables/useArticleCommentStream'
import { useWindowEvents } from '@/composables/useWindowEvents'
import { validateCommentContent } from '@/utils/contentFilter'
import { FrameType } from '@wasm/protocol/frame'
import { getErrorMessage, isAbortError } from '@/utils/errors'
import {
  createArticleDetailPageViewContract,
  createArticleDetailHeaderViewContract,
  emptyArticleDetailHeaderView,
  emptyArticleDetailPageView
} from '@/view-contracts/articleDetail'

type ArticleSignalPayload = { articleId: string | number }
type CommentAddedSignalPayload = ArticleSignalPayload & { comment: CommentItem }
type CommentDeletedSignalPayload = ArticleSignalPayload & { commentId: string | number }

const SIGNALS = {
  UPDATED: 'signalr:article-updated',
  DELETED: 'signalr:article-deleted',
  RESTORED: 'signalr:article-restored',
  RECONNECTED: 'signalr:reconnected',
  COMMENT_ADD: 'signalr:comment-added',
  COMMENT_DEL: 'signalr:comment-removed'
} as const

export function useArticleDetailView() {
  const route = useRoute()
  const router = useRouter()
  const initialBootstrap = consumePublicAotBootstrap('ArticleDetail')
  const userStore = useUserStore()
  const articleStore = useArticleBinaryStore()
  const powProvider = usePow()

  const article = ref<ArticleDetail | null>(null)
  const loading = ref(true)
  const isError = ref(false)
  const spaReady = ref(false)
  const articleLoadTask = useAbortableTask()
  const commentSubmitTask = useAbortableTask()
  const { aotRenderedHtml, clearAotHtml } = useAotRenderBridge({
    frameType: FrameType.ArticleDetail,
    onRefresh: () => {
      void loadArticle(false)
    },
    cooldownMs: 300
  })

  const articleRendererRef = ref<InstanceType<typeof MarkdownRenderer> | null>(null)
  const commentContent = ref('')
  const submittingComment = ref(false)
  const virtualListStyle = computed(() => ({
    paddingTop: `${paddingTop.value}px`,
    paddingBottom: `${paddingBottom.value}px`
  }))

  let isMounted = false
  let bootstrapApplied = false
  let routeInitVersion = 0
  const {
    comments,
    visibleComments,
    paddingTop,
    paddingBottom,
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
    dispose: disposeCommentStream
  } = useArticleCommentStream({
    getArticleId: () => article.value?.id ?? null,
    isMounted: () => isMounted,
    pageSize: 10
  })
  const articleView = computed(() =>
    article.value ? createArticleDetailHeaderViewContract(article.value) : emptyArticleDetailHeaderView
  )
  const detailView = computed(() =>
    article.value
      ? createArticleDetailPageViewContract(
          article.value,
          comments.value.length,
          hasMore.value
        )
      : emptyArticleDetailPageView
  )

  const resolveActiveRouteId = (): number | null => {
    const id = Number(route.params.id)
    return Number.isFinite(id) ? id : null
  }

  const hydrateCommentStream = async (): Promise<void> => {
    if (!isMounted || !article.value) {
      return
    }

    const articleId = article.value.id
    clearCommentState()
    await nextTick()
    if (!isMounted || article.value?.id !== articleId) {
      return
    }

    await loadMoreComments()
    if (!isMounted || article.value?.id !== articleId) {
      return
    }

    await nextTick()
    initObserver()
    handleVirtualScroll()
  }

  const getSignalDetail = <T>(event: Event): T | null => {
    const detail = (event as CustomEvent).detail
    if (!detail || typeof detail !== 'object') {
      return null
    }
    return detail as T
  }

  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const modalState = ref({
    visible: false,
    title: '',
    content: '',
    onConfirm: () => {},
    onCancel: () => {}
  })

  const triggerModal = (config: {
    title: string
    content: string
    onConfirm: () => void
    onCancel?: () => void
  }): void => {
    modalState.value = {
      visible: true,
      title: config.title,
      content: config.content,
      onConfirm: config.onConfirm,
      onCancel: config.onCancel || (() => {
        modalState.value.visible = false
      })
    }
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

  const loadArticle = async (silent = false, loadComments = true): Promise<void> => {
    const id = resolveActiveRouteId()
    if (id === null) {
      article.value = null
      isError.value = false
      loading.value = false
      return
    }

    articleLoadTask.cancel()

    if (!silent) {
      loading.value = true
      isError.value = false
    }
    clearAotHtml()

    const action = async (): Promise<void> => {
      try {
        const response = await articleLoadTask.run(
          async (signal) => await articleStore.fetchArticleById(id, signal)
        )
        if (!isMounted || resolveActiveRouteId() !== id) {
          return
        }

        if (response) {
          article.value = response
          if (!silent && loadComments) {
            clearCommentState()
            await loadMoreComments()
          }
        }
      } catch (error: unknown) {
        if (!isAbortError(error) && isMounted) {
          console.error('[Article] Load failed:', error)
          isError.value = true
        }
      }
    }

    if (silent) {
      await runSmoothUpdate(action)
    } else {
      await action()
      if (isMounted && resolveActiveRouteId() === id) {
        await nextTick()
        if (loadComments) {
          initObserver()
        }
      }
    }

    if (isMounted && !silent && resolveActiveRouteId() === id) {
      loading.value = false
    }
  }

  const initializeArticleRoute = async (): Promise<void> => {
    const initVersion = ++routeInitVersion
    spaReady.value = false
    isError.value = false
    article.value = null
    clearAotHtml()
    disposeCommentStream()
    clearCommentState()

    const routeId = resolveActiveRouteId()
    const bootstrapArticle = !bootstrapApplied &&
      initialBootstrap?.article &&
      routeId !== null &&
      Number(initialBootstrap.article.id) === routeId
      ? initialBootstrap.article
      : null

    if (bootstrapArticle) {
      article.value = toBootstrapArticleDetail(bootstrapArticle)
      loading.value = false
      bootstrapApplied = true
    } else {
      await loadArticle(false, false)
    }

    if (!isMounted || initVersion !== routeInitVersion) {
      return
    }

    if (!article.value) {
      loading.value = false
      return
    }

    await nextTick()
    if (!isMounted || initVersion !== routeInitVersion || !article.value) {
      return
    }

    spaReady.value = true
    await hydrateCommentStream()
    if (isMounted && initVersion === routeInitVersion && article.value) {
      powProvider.prewarm()
    }
  }

  const handleRenderComplete = (): void => {
    handleVirtualScroll()
  }

  const handleRemoteArticleUpdated = (event: Event): void => {
    const data = getSignalDetail<ArticleSignalPayload>(event)
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
      if (isMounted) {
        await loadArticle(true)
        toast.info('内容已实时同步')
      }
      debounceTimers.delete(articleId)
    }, 500)
    debounceTimers.set(articleId, timer)
  }

  const handleRemoteArticleDeleted = (event: Event): void => {
    const data = getSignalDetail<ArticleSignalPayload>(event)
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

      triggerModal({
        title: '文章已被删除',
        content: '该文章内容已被作者移除，正在为您返回首页。',
        onConfirm: () => {
          modalState.value.visible = false
          void router.replace('/')
        },
        onCancel: () => {
          modalState.value.visible = false
          void router.replace('/')
        }
      })
    }
  }

  const handleSignalRReconnected = (): void => {
    if (isMounted && article.value) {
      void loadArticle(true)
    }
  }

  const submitComment = async (): Promise<void> => {
    if (!commentContent.value.trim() || !article.value) {
      return
    }

    const checkResult = validateCommentContent(commentContent.value)
    if (!checkResult.isValid) {
      toast.error(checkResult.message)
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
              content: commentContent.value
            },
            { signal }
          )
      )

      if (isMounted) {
        toast.success('发送成功')
        commentContent.value = ''
      }
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        console.error('[Comment] Submit failed:', error)
        toast.error(getErrorMessage(error, '评论发布失败'))
      }
    } finally {
      if (isMounted) {
        submittingComment.value = false
      }
    }
  }

  const handleRemoteAdd = (event: Event): void => {
    const data = getSignalDetail<CommentAddedSignalPayload>(event)
    if (!data?.articleId || !data.comment?.id) {
      return
    }

    if (article.value && String(data.articleId) === String(article.value.id)) {
      prependCommentIfAbsent(data.comment)
    }
  }

  const handleRemoteDelete = (event: Event): void => {
    const data = getSignalDetail<CommentDeletedSignalPayload>(event)
    if (!data?.articleId || !data.commentId) {
      return
    }

    if (article.value && String(data.articleId) === String(article.value.id)) {
      removeCommentById(data.commentId)
    }
  }

  const handleCommentDelete = (id: string): void => {
    const targetId = String(id)
    const isAdmin = userStore.isAdmin

    triggerModal({
      title: isAdmin ? '管理员操作' : '删除评论',
      content: isAdmin ? '确定要删除这条评论吗？操作记录将被审计。' : '确定要删除这条评论吗？',
      onConfirm: async () => {
        try {
          await deleteComment(targetId)
          toast.success('已移除')
          removeCommentById(targetId)
        } catch (error: unknown) {
          toast.error(getErrorMessage(error, '操作失败'))
        } finally {
          modalState.value.visible = false
        }
      }
    })
  }

  const signalListeners: ReadonlyArray<[string, (event: Event) => void]> = [
    [SIGNALS.COMMENT_ADD, handleRemoteAdd],
    [SIGNALS.COMMENT_DEL, handleRemoteDelete],
    [SIGNALS.UPDATED, handleRemoteArticleUpdated],
    [SIGNALS.RESTORED, handleRemoteArticleUpdated],
    [SIGNALS.DELETED, handleRemoteArticleDeleted],
    [SIGNALS.RECONNECTED, handleSignalRReconnected]
  ]

  useWindowEvents([
    { name: 'scroll', handler: handleVirtualScroll, options: { passive: true } },
    { name: 'resize', handler: handleVirtualScroll, options: { passive: true } },
    ...signalListeners.map(([name, handler]) => ({ name, handler }))
  ])

  onMounted(() => {
    isMounted = true
    void initializeArticleRoute()
  })

  watch(
    () => route.params.id,
    (nextId, prevId) => {
      if (!isMounted || nextId === prevId) {
        return
      }

      void initializeArticleRoute()
    }
  )

  onUnmounted(() => {
    isMounted = false
    debounceTimers.forEach((timer) => clearTimeout(timer))
    debounceTimers.clear()

    disposeCommentStream()
    articleLoadTask.cancel()
    commentSubmitTask.cancel()
  })

  return {
    route,
    userStore,
    powProvider,
    article,
    articleView,
    detailView,
    loading,
    isError,
    aotRenderedHtml,
    articleRendererRef,
    commentContent,
    submittingComment,
    comments,
    visibleComments,
    paddingTop,
    paddingBottom,
    hasMore,
    loadingComments,
    loadMoreTrigger,
    virtualListRef,
    loadArticle,
    handleRenderComplete,
    submitComment,
    handleCommentDelete,
    modalState,
    virtualListStyle,
    spaReady
  }
}

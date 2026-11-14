import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { getArticleById, getRelatedReading, type ArticleDetailResponse, type RelatedReadingResponse } from '@/api/article';
import {
    createAnonymousComment,
    createPublicComment,
    deleteAnonymousComment,
    deleteComment,
    deleteCommentAsAuthor,
    editCommentAsAuthor,
    getCommentPolicySnapshot,
    getMyArticleComments,
    issueCommentManagementChallenge,
    type CommentAuthorMode,
    type CommentAuthorView,
    type CommentDisplayLanguage,
    type CommentPolicySnapshot
} from '@/api/comment';
import { toBootstrapArticleDetail } from '@/bootstrap/publicAotBootstrap';
import { markCurrentRouteContentReady, markCurrentRouteFailed } from '@/bootstrap/routeReadiness';
import type MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue';
import { useAbortableTask } from '@/composables/useAbortableTask';
import { useArticleCommentStream, type CommentTreeViewNode } from '@/composables/useArticleCommentStream';
import { requestGlobalConfirm } from '@/composables/useGlobalConfirm';
import { usePow } from '@/composables/usePow';
import { usePublicPageLifecycle } from '@/composables/usePublicPageLifecycle';
import { useRiskChallengeCommand } from '@/composables/useRiskChallengeCommand';
import { alertInfo, promptText, toast  } from '@/fsusui/feedback'
import { useNotificationStreamStore } from '@/store/notificationStream';
import { isStrongAnonymousCommentAvailable } from '@/policies/commentPolicy';
import {
  createAnonymousThreadScope,
  createAnonymousTopLevelScope
} from '@/privacy/commentAnonymousScope'
import {
  createArticleDetailPageViewContract,
  createArticleDetailHeaderViewContract,
  emptyArticleDetailHeaderView,
  emptyArticleDetailPageView
} from '@/view-contracts/articleDetail'
import {
  COMMENT_MANAGEMENT_CAPABILITY_LOSS_NOTICE,
  getCommentManagementCapabilityVault
} from '@/privacy/commentManagementCapabilityVault'
import {
  getCommentPrivacyRuntime,
  type CommentPrivacyPreparedTicket,
  type CommentPrivacyUiState
} from '@/privacy/commentPrivacyRuntime'
import { consumePublicPageSeed } from '@/public-renderers/pageSeed';
import { fixedRiskChallengeContext, riskChallengeRoutes } from '@/security/risk-challenge-routes';
import type { NotificationStreamArticleRenderPatch, NotificationStreamCommentRenderPatch } from '@/services/notificationStreamTypes';
import { isPublicReadHydrationSuppressed } from '@/services/publicReadHydrationGuard';
import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime';
import { useUserStore } from '@/store/user';
import { normalizeCommentContentPolicy, validateCommentContent } from '@/utils/contentFilter';
import { showErrorToast } from '@/utils/errorPresentation';
import { isAbortError } from '@/utils/errors';

interface ArticleSignalPayload { articleId: string | number; }

type CommentAddedSignalPayload = ArticleSignalPayload & {
    comment: {
        id: string;
        content: string;
        createTime: string;
        author?: CommentAuthorView | null;
        parentId?: string | null;
        rootId?: string | null;
        replyToAuthor?: CommentAuthorView | null;
        replyToCommentId?: string | null;
        depth?: number;
        isDeleted?: boolean;
    };
};

type CommentDeletedSignalPayload = ArticleSignalPayload & {
    commentId: string | number;
    rootId?: string | null;
    parentId?: string | null;
};

type ReplyTarget = {
    id: string;
    rootId: string;
    author: CommentAuthorView;
    depth: number;
} | null;

const COMMENT_SUMMARY_LIMIT = 48;

export function useArticleDetailView()
{
    const route = useRoute();
    const router = useRouter();
    const notificationStreamStore = useNotificationStreamStore();
    const { bootstrap: initialBootstrap } = consumePublicPageSeed('ArticleDetail', { fullPath: route?.fullPath });
    const userStore = useUserStore();
    const powProvider = usePow();
    const initialRouteId = Number(route.params.id);
    const initialBootstrapArticle = initialBootstrap?.article &&
    Number.isFinite(initialRouteId) &&
    Number(initialBootstrap.article.id) === initialRouteId
        ? toBootstrapArticleDetail(initialBootstrap.article)
        : null;
    const initialBootstrapRelatedReading = initialBootstrapArticle ? initialBootstrap?.relatedReading ?? null : null;

    const article = ref<ArticleDetailResponse | null>(initialBootstrapArticle);
    const relatedReading = ref<RelatedReadingResponse | null>(initialBootstrapRelatedReading);
    const loading = ref(!initialBootstrapArticle);
    const isError = ref(false);
    const spaReady = ref(false);
    const articleLoadTask = useAbortableTask();
    const relatedLoadTask = useAbortableTask();
    const commentPolicyTask = useAbortableTask();
    const commentSubmitTask = useAbortableTask();
    const commentOwnershipTask = useAbortableTask();
    const commentPrivacyRuntime = getCommentPrivacyRuntime();
    const commentRiskChallenge = useRiskChallengeCommand();
    const anonymousSubmitScopesInFlight = new Set<string>();
    const ownedCommentIds = ref<ReadonlySet<string>>(new Set());

    const clearCommentOwnership = (): void =>
    {
        commentOwnershipTask.cancel();
        ownedCommentIds.value = new Set();
    };

    const addOwnedComment = (commentId: string | number): void =>
    {
        const next = new Set(ownedCommentIds.value);
        next.add(String(commentId));
        ownedCommentIds.value = next;
    };

    const removeOwnedComment = (commentId: string | number): void =>
    {
        const next = new Set(ownedCommentIds.value);
        next.delete(String(commentId));
        ownedCommentIds.value = next;
    };

    const refreshCommentOwnership = async (): Promise<void> =>
    {
        const articleId = article.value?.id ?? null;
        if (!articleId || !lifecycle.isActive() || !userStore.isLoggedIn || userStore.isAdmin)
        {
            clearCommentOwnership();
            return;
        }

        try
        {
            const ids = await commentOwnershipTask.run(async (signal) =>
            {
                const next = new Set<string>();
                let cursor: string | null = null;
                do
                {
                    const response = await getMyArticleComments(articleId, cursor, 100, { signal });
                    for (const item of response.data)
                    {
                        next.add(String(item.id));
                    }
                    cursor = response.hasMore ? response.nextCursor : null;
                } while (cursor && !signal.aborted);
                return next;
            });

            if (lifecycle.isActive() && article.value?.id === articleId && userStore.isLoggedIn && !userStore.isAdmin)
            {
                ownedCommentIds.value = ids;
            }
        }
        catch (error: unknown)
        {
            if (!isAbortError(error) && lifecycle.isActive())
            {
                console.error('[Comments] Ownership overlay failed:', error);
                ownedCommentIds.value = new Set();
            }
        }
    };

    const articleRendererRef = ref<InstanceType<typeof MarkdownRenderer> | null>(null);
    const commentContent = ref('');
    const commentAuthorMode = ref<CommentAuthorMode>('zk_anonymous');
    const publicSendConfirmed = ref(false);
    const commentDisplayLanguage = ref<CommentDisplayLanguage>('zh-CN');
    const anonymousCommentsEnabled = ref(true);
    const publicCommentsEnabled = ref(true);
    const zkAnonymousEnabled = ref(false);
    const commentMaxChars = ref(1000);
    const commentMaxUtf8Bytes = ref(4096);
    const commentPolicySnapshotHash = ref('');
    const commentPrivacyUiState = ref<CommentPrivacyUiState>(commentPrivacyRuntime.getUiState());
    const submittingComment = ref(false);
    const replyTarget = ref<ReplyTarget>(null);

    let bootstrapApplied = Boolean(initialBootstrapArticle);
    let routeInitVersion = 0;
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const lifecycle = usePublicPageLifecycle({
        onDispose: () =>
        {
            debounceTimers.forEach((timer) => clearTimeout(timer));
            debounceTimers.clear();
            disposeCommentStream();
            articleLoadTask.cancel();
            relatedLoadTask.cancel();
            commentPolicyTask.cancel();
            commentSubmitTask.cancel();
            commentOwnershipTask.cancel();
            commentRiskChallenge.handleCancel();
            anonymousSubmitScopesInFlight.clear();
            unsubscribeCommentPrivacyRuntime();
        }
    });
    const unsubscribeCommentPrivacyRuntime = commentPrivacyRuntime.subscribe((state) =>
    {
        commentPrivacyUiState.value = state;
    });
    const markRouteReady = (): void =>
    {
        markCurrentRouteContentReady(route);
    };
    const markRouteFailed = (): void =>
    {
        markCurrentRouteFailed(route);
    };

    const {
        threads,
        hasMore,
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
        dispose: disposeCommentStream
    } = useArticleCommentStream({
        getArticleId: () => article.value?.id ?? null,
        isMounted: () => lifecycle.isActive(),
        pageSize: 10,
        replyPageSize: 20
    });

    const articleView = computed(() =>
    article.value ? createArticleDetailHeaderViewContract(article.value) : emptyArticleDetailHeaderView
    );

    const countLoadedBranch = (node: CommentTreeViewNode): number =>
        1 + node.children.reduce((total, child) => total + countLoadedBranch(child), 0);
    const totalCommentCount = computed(() => threads.value.reduce((total, root) => total + countLoadedBranch(root), 0));
    const commentAnonymousScope = computed(() =>
    {
        if (!article.value)
        {
            return '';
        }

        return replyTarget.value
            ? createAnonymousThreadScope(article.value.id, replyTarget.value.rootId)
            : createAnonymousTopLevelScope(article.value.id);
    });
    const commentChallengeAttributes = computed<Record<string, unknown>>(() => ({
        surface: 'article-detail-comment',
        authorMode: resolveCommentAuthorModeForPolicy(),
        reply: Boolean(replyTarget.value)
    }));

    const detailView = computed(() =>
    article.value
        ? createArticleDetailPageViewContract(
          article.value,
          totalCommentCount.value,
          hasMore.value,
          relatedReading.value
        )
        : emptyArticleDetailPageView
    );

    const resolveActiveRouteId = (): number | null =>
    {
        const id = Number(route.params.id);
        return Number.isFinite(id) ? id : null;
    };

    const hydrateCommentStream = async (): Promise<void> =>
    {
        if (!lifecycle.isActive() || !article.value)
        {
            return;
        }

        if (isPublicReadHydrationSuppressed())
        {
            clearCommentState();
            return;
        }

        const articleId = article.value.id;
        clearCommentState();
        await nextTick();
        if (!lifecycle.isActive() || article.value?.id !== articleId)
        {
            return;
        }

        await loadMoreComments();
        if (!lifecycle.isActive() || article.value?.id !== articleId)
        {
            return;
        }

        await refreshCommentOwnership();
        if (!lifecycle.isActive() || article.value?.id !== articleId)
        {
            return;
        }

        await nextTick();
        initObserver();
    };

    const runSmoothUpdate = async (updateAction: () => Promise<void>): Promise<void> =>
    {
        const containerRef = articleRendererRef.value?.rootEl as HTMLElement | { value?: HTMLElement | null; } | null | undefined;
        const container = containerRef instanceof HTMLElement ? containerRef : containerRef?.value ?? null;
        if (!container || !article.value)
        {
            await updateAction();
            return;
        }

        const children = Array.from(container.children);
        let anchorIndex = -1;
        let anchorOffset = 0;

        const foundAnchor = children.find((element, index) =>
        {
            const rect = element.getBoundingClientRect();
            if (rect.top >= 0)
            {
                anchorIndex = index;
                anchorOffset = rect.top;
                return true;
            }
            return false;
        });

        await updateAction();

        if (foundAnchor && anchorIndex !== -1)
        {
            await nextTick();
            const freshContainerRef = articleRendererRef.value?.rootEl as HTMLElement | { value?: HTMLElement | null; } | null | undefined;
            const freshContainer = freshContainerRef instanceof HTMLElement ? freshContainerRef : freshContainerRef?.value ?? null;
            if (freshContainer && freshContainer.children.length > anchorIndex)
            {
                const targetElement = freshContainer.children[anchorIndex] as HTMLElement;
                if (targetElement)
                {
                    const newRect = targetElement.getBoundingClientRect();
                    const diff = newRect.top - anchorOffset;
                    window.scrollBy(0, diff);
                }
                else
                {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                }
            }
            else
            {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }
    };

    const loadRelatedReading = async (articleId: number): Promise<void> =>
    {
        if (isPublicReadHydrationSuppressed())
        {
            relatedReading.value = null;
            return;
        }

        try
        {
            const response = await relatedLoadTask.run(
                async (signal) => await getRelatedReading(articleId, { signal })
            );
            if (lifecycle.isActive() && article.value?.id === articleId)
            {
                relatedReading.value = response;
            }
        }
        catch (error: unknown)
        {
            if (import.meta.env.DEV && !isAbortError(error) && lifecycle.isActive() && article.value?.id === articleId)
            {
                console.warn('[Article] Related reading failed:', error);
            }
        }
    };

    const loadCommentPolicySnapshot = async (): Promise<void> =>
    {
        try
        {
            const policy = await commentPolicyTask.run(
                async (signal) => await getCommentPolicySnapshot(
                    { signal },
                    article.value?.id,
                    replyTarget.value?.rootId ?? null
                )
            );
            if (lifecycle.isActive())
            {
                applyCommentPolicySnapshot(policy);
            }
        }
        catch (error: unknown)
        {
            if (import.meta.env.DEV && !isAbortError(error) && lifecycle.isActive())
            {
                console.warn('[Comment] Policy snapshot failed:', error);
            }
        }
    };

    const applyCommentPolicySnapshot = (policy: CommentPolicySnapshot): void =>
    {
        anonymousCommentsEnabled.value = policy.anonymousCommentsEnabled;
        publicCommentsEnabled.value = policy.publicCommentsEnabled;
        const commentPolicy = normalizeCommentContentPolicy({
            maxChars: policy.commentMaxChars,
            maxUtf8Bytes: policy.commentMaxUtf8Bytes
        });
        commentMaxChars.value = commentPolicy.maxChars;
        commentMaxUtf8Bytes.value = commentPolicy.maxUtf8Bytes;
        commentPolicySnapshotHash.value = policy.snapshotHash;
        const wasZkAnonymousEnabled = zkAnonymousEnabled.value;
        zkAnonymousEnabled.value = isStrongAnonymousCommentAvailable(policy);
        if (wasZkAnonymousEnabled && !zkAnonymousEnabled.value)
        {
            void clearPrivateBrowserState('feature-disabled');
        }
        applySupportedCommentDisplayLanguage(policy.supportedDisplayLanguages);

        if (commentAuthorMode.value === 'public' && !publicCommentsEnabled.value)
        {
            commentAuthorMode.value = 'zk_anonymous';
        }

        if (commentAuthorMode.value !== 'public')
        {
            publicSendConfirmed.value = false;
        }
    };

    const applySupportedCommentDisplayLanguage = (languages: readonly string[]): void =>
    {
        if (languages.includes(commentDisplayLanguage.value))
        {
            return;
        }

        commentDisplayLanguage.value = languages.includes('zh-CN') ? 'zh-CN' : 'en';
    };

    const loadArticle = async (silent = false, loadComments = true, loadRelated = true): Promise<void> =>
    {
        const id = resolveActiveRouteId();
        if (id === null)
        {
            article.value = null;
            relatedReading.value = null;
            isError.value = false;
            loading.value = false;
            markRouteFailed();
            return;
        }

        articleLoadTask.cancel();

        if (!silent)
        {
            loading.value = true;
            isError.value = false;
        }

        const action = async (): Promise<void> =>
        {
            try
            {
                const response = await articleLoadTask.run(
                    async (signal) => await getArticleById(id, { signal })
                );
                if (!lifecycle.isActive() || resolveActiveRouteId() !== id)
                {
                    return;
                }

                if (response)
                {
                    article.value = response;
                    if (loadRelated)
                    {
                        await loadRelatedReading(response.id);
                    }
                    if (!silent && loadComments)
                    {
                        clearCommentState();
                        await loadMoreComments();
                    }
                }
            }
            catch (error: unknown)
            {
                if (!isAbortError(error) && lifecycle.isActive())
                {
                    console.error('[Article] Load failed:', error);
                    isError.value = true;
                    markRouteFailed();
                }
            }
        };

        if (silent)
        {
            await runSmoothUpdate(action);
        }
        else
        {
            await action();
            if (lifecycle.isActive() && resolveActiveRouteId() === id)
            {
                await nextTick();
                if (loadComments)
                {
                    initObserver();
                }
            }
        }

        if (lifecycle.isActive() && !silent && resolveActiveRouteId() === id)
        {
            loading.value = false;
        }
    };

    const initializeArticleRoute = async (): Promise<void> =>
    {
        const initVersion = ++routeInitVersion;
        const routeId = resolveActiveRouteId();
        const canReuseHydratedBootstrap =
            bootstrapApplied &&
      article.value !== null
      && routeId !== null
      && article.value.id === routeId;

        spaReady.value = false;
        isError.value = false;
        disposeCommentStream();
        relatedLoadTask.cancel();
        commentPolicyTask.cancel();
        clearCommentState();
        clearCommentOwnership();
        clearReplyTarget();

        await loadCommentPolicySnapshot();
        if (!lifecycle.isActive() || initVersion !== routeInitVersion)
        {
            return;
        }

        if (!canReuseHydratedBootstrap)
        {
            article.value = null;
            relatedReading.value = null;
        }
        else
        {
            relatedReading.value = initialBootstrapRelatedReading;
        }

        const bootstrapArticle = !bootstrapApplied &&
      initialBootstrap?.article &&
      routeId !== null &&
      Number(initialBootstrap.article.id) === routeId
            ? initialBootstrap.article
            : null;

        if (canReuseHydratedBootstrap)
        {
            loading.value = false;
        }
        else if (bootstrapArticle)
        {
            article.value = toBootstrapArticleDetail(bootstrapArticle);
            relatedReading.value = initialBootstrap?.relatedReading ?? null;
            loading.value = false;
            bootstrapApplied = true;
        }
        else
        {
            await loadArticle(false, false);
        }

        if (!lifecycle.isActive() || initVersion !== routeInitVersion)
        {
            return;
        }

        if (!article.value)
        {
            loading.value = false;
            markRouteFailed();
            return;
        }

        if (canReuseHydratedBootstrap || bootstrapArticle)
        {
            await loadArticle(true, false, relatedReading.value === null);
            if (!lifecycle.isActive() || initVersion !== routeInitVersion || !article.value)
            {
                return;
            }
        }

        await nextTick();
        if (!lifecycle.isActive() || initVersion !== routeInitVersion || !article.value)
        {
            return;
        }

        spaReady.value = true;
        markRouteReady();
        await hydrateCommentStream();
        if (lifecycle.isActive() && initVersion === routeInitVersion && article.value)
        {
            if (userStore.isLoggedIn && anonymousCommentsEnabled.value)
            {
                powProvider.prewarm();
                if (zkAnonymousEnabled.value)
                {
                    void commentPrivacyRuntime.preloadPrivacyMetadata(article.value.id);
                    void commentPrivacyRuntime.prewarmProver();
                }
            }
        }
    };

    const handleRenderComplete = (): void =>
    {
    // no-op, kept for renderer event contract
    };

    const commentsRedirectPath = (): string =>
    {
        const current = route.fullPath.split('#')[0] || route.path;
        return `${current}#comments`;
    };

    const redirectToCommentLogin = (): void =>
    {
        void router.push({
            path: '/login',
            query: {
                redirect: commentsRedirectPath()
            }
        });
    };

    const handleRemoteArticleUpdated = (data: ArticleSignalPayload): void =>
    {
        if (!data?.articleId || !article.value)
        {
            return;
        }

        const articleId = String(data.articleId);
        if (articleId !== String(article.value.id))
        {
            return;
        }

        if (debounceTimers.has(articleId))
        {
            clearTimeout(debounceTimers.get(articleId));
        }

        const timer = setTimeout(async () =>
        {
            if (lifecycle.isActive())
            {
                await loadArticle(true);
                toast.info('内容已实时同步');
            }
            debounceTimers.delete(articleId);
        }, 500);

        debounceTimers.set(articleId, timer);
    };

    const confirmDeletedArticleNavigation = async (): Promise<void> =>
    {
        const confirmed = await alertInfo('该文章内容已被作者移除，正在为您返回首页。', '文章已被删除', {
            confirmButtonText: '确定'
        });
        if (confirmed)
        {
            void router.replace('/');
        }
    };

    const handleRemoteArticleDeleted = (data: ArticleSignalPayload): void =>
    {
        if (!data?.articleId)
        {
            return;
        }

        const targetId = String(data.articleId);
        if (article.value && targetId === String(article.value.id))
        {
            if (debounceTimers.has(targetId))
            {
                clearTimeout(debounceTimers.get(targetId));
                debounceTimers.delete(targetId);
            }
            article.value = null;

            void confirmDeletedArticleNavigation();
        }
    };

    const handleSignalRReconnected = (): void =>
    {
        if (lifecycle.isActive() && article.value)
        {
            void loadArticle(true);
        }
    };

    const resolveCommentAuthorModeForPolicy = (): CommentAuthorMode =>
    {
        return commentAuthorMode.value;
    };

    const canAttemptStrongAnonymousSubmit = (): boolean =>
        zkAnonymousEnabled.value && commentPrivacyUiState.value !== 'unavailable';

    const submitComment = async (persistedClientMutationId?: string): Promise<void> =>
    {
        if (!commentContent.value.trim() || !article.value)
        {
            return;
        }

        const checkResult = validateCommentContent(commentContent.value, {
            maxChars: commentMaxChars.value,
            maxUtf8Bytes: commentMaxUtf8Bytes.value
        });
        if (!checkResult.isValid)
        {
            showErrorToast(checkResult.message);
            return;
        }

        if (submittingComment.value || powProvider.isCalculating.value)
        {
            return;
        }

        const selectedAuthorMode = resolveCommentAuthorModeForPolicy();
        if (selectedAuthorMode === 'public' && !publicSendConfirmed.value)
        {
            showErrorToast('请先勾选公开显示我的名称。');
            return;
        }

        if (selectedAuthorMode === 'public' && !publicCommentsEnabled.value)
        {
            showErrorToast('公开评论已被管理员关闭。');
            return;
        }

        if (selectedAuthorMode === 'zk_anonymous' && !zkAnonymousEnabled.value)
        {
            showErrorToast('强匿名发布暂不可用，评论未发送。');
            return;
        }

        const anonymousSubmitScope = selectedAuthorMode === 'zk_anonymous'
            ? commentAnonymousScope.value
            : null;
        if (anonymousSubmitScope && anonymousSubmitScopesInFlight.has(anonymousSubmitScope))
        {
            return;
        }

        if (anonymousSubmitScope)
        {
            anonymousSubmitScopesInFlight.add(anonymousSubmitScope);
        }

        submittingComment.value = true;

        commentSubmitTask.cancel();
        let commentMutationSubmitted = false;
        let createdPublicCommentId: string | null = null;
        const publicCommentPayload = selectedAuthorMode === 'public'
            ? {
          articleId: article.value.id,
          content: commentContent.value,
          parentId: replyTarget.value?.id ?? null,
          rootId: replyTarget.value?.rootId ?? null,
          replyToCommentId: replyTarget.value?.id ?? null,
          authorMode: 'public' as const,
          publicSendExplicitlySelected: true,
          displayLanguage: commentDisplayLanguage.value
        }
            : null;
        const commentMutationIdentity = persistedClientMutationId ?? globalThis.crypto?.randomUUID?.() ?? '';

        try
        {
            await commentSubmitTask.run(
                async (signal) =>
                {
                    if (selectedAuthorMode === 'zk_anonymous')
                    {
                        let privacyTicket: CommentPrivacyPreparedTicket | null =
              canAttemptStrongAnonymousSubmit()
                  ? commentPrivacyRuntime.consumePreparedTicket(commentAnonymousScope.value)
                  : null;
                        if (!privacyTicket && canAttemptStrongAnonymousSubmit())
                        {
                            await commentPrivacyRuntime.prepareAnonymousTicket(commentAnonymousScope.value);
                            privacyTicket = commentPrivacyRuntime.consumePreparedTicket(commentAnonymousScope.value);
                        }

                        if (!privacyTicket)
                        {
                            throw new Error('strong_anonymous_ticket_unavailable');
                        }

                        const result = await createAnonymousComment(
                            {
                                articleId: article.value!.id,
                                content: commentContent.value,
                                parentId: replyTarget.value?.id ?? null,
                                rootId: replyTarget.value?.rootId ?? null,
                                replyToCommentId: replyTarget.value?.id ?? null,
                                anonymousScope: commentAnonymousScope.value,
                                displayLanguage: commentDisplayLanguage.value
                            },
                            privacyTicket,
                            { signal }
                        );
                        if (result.managementSecret)
                        {
                            getCommentManagementCapabilityVault().put(result.commentId, result.managementSecret);
                        }
                        toast.warning(COMMENT_MANAGEMENT_CAPABILITY_LOSS_NOTICE, 9000);
                        commentMutationSubmitted = true;
                        return;
                    }

                    if (!publicCommentPayload)
                    {
                        return;
                    }

                    await commentRiskChallenge.run(
                        fixedRiskChallengeContext(
                            riskChallengeRoutes.commentCreate,
                            commentChallengeAttributes.value
                        ),
                        { kind: 'mutation_with_identity', mutationIdentity: commentMutationIdentity },
                        async (challengeLease) =>
                        {
                            if (signal.aborted)
                            {
                                challengeLease?.settle('before_send_cancelled');
                                return;
                            }
                            const result = await createPublicComment(
                                { ...publicCommentPayload, clientMutationId: commentMutationIdentity },
                                { signal, riskChallengeProof: challengeLease }
                            );
                            createdPublicCommentId = result.commentId;
                        }
                    );
                    commentMutationSubmitted = true;
                }
            );

            if (lifecycle.isActive() && commentMutationSubmitted)
            {
                if (createdPublicCommentId)
                {
                    addOwnedComment(createdPublicCommentId);
                }
                toast.success('已提交审核');
                commentContent.value = '';
                commentAuthorMode.value = 'zk_anonymous';
                publicSendConfirmed.value = false;
                clearReplyTarget();
            }
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                console.error('[Comment] Submit failed:', error);
                showErrorToast(error, selectedAuthorMode === 'zk_anonymous' ? '强匿名评论发布失败，未进行降级发送' : '评论发布失败');
            }
        }
        finally
        {
            if (anonymousSubmitScope)
            {
                anonymousSubmitScopesInFlight.delete(anonymousSubmitScope);
            }
            if (lifecycle.isActive())
            {
                submittingComment.value = false;
            }
        }
    };

    const setReplyTarget = (payload: { id: string; rootId: string; author: CommentAuthorView; depth: number; }): void =>
    {
        if (!userStore.isLoggedIn)
        {
            redirectToCommentLogin();
            return;
        }

        replyTarget.value = payload;
    };

    const clearReplyTarget = (): void =>
    {
        replyTarget.value = null;
    };

    const prepareCommentPrivacyTicket = (): void =>
    {
        if (!userStore.isLoggedIn || !article.value || !anonymousCommentsEnabled.value || !zkAnonymousEnabled.value)
        {
            return;
        }

        void commentPrivacyRuntime.prepareAnonymousTicket(commentAnonymousScope.value);
    };

    const handleRemoteAdd = (data: CommentAddedSignalPayload): void =>
    {
        if (!data?.articleId || !data.comment?.id)
        {
            return;
        }

        if (article.value && String(data.articleId) === String(article.value.id))
        {
            prependCommentIfAbsent(data.comment);
            if (userStore.isLoggedIn && !userStore.isAdmin)
            {
                void refreshCommentOwnership();
            }
        }
    };

    const handleRemoteDelete = (data: CommentDeletedSignalPayload): void =>
    {
        if (!data?.articleId || !data.commentId)
        {
            return;
        }

        if (article.value && String(data.articleId) === String(article.value.id))
        {
            removeCommentById(data.commentId, data.rootId ?? null, data.parentId ?? null);
            removeOwnedComment(data.commentId);
            void reconcileCommentsAfterMutation();
            if (userStore.isLoggedIn && !userStore.isAdmin)
            {
                void refreshCommentOwnership();
            }
        }
    };

    const summarizeCommentContent = (content: string): string =>
    {
        const normalized = content.replace(/\s+/g, ' ').trim();
        if (!normalized)
        {
            return '无内容摘要';
        }

        return normalized.length > COMMENT_SUMMARY_LIMIT
            ? `${normalized.slice(0, COMMENT_SUMMARY_LIMIT)}...`
            : normalized;
    };

    const handleCommentDelete = (payload: { id: string; rootId: string; parentId: string | null; content: string; }): void =>
    {
        const targetId = String(payload.id);
        const isAdmin = userStore.isAdmin;
        const summary = summarizeCommentContent(payload.content);

        const deleteSelectedComment = async (): Promise<void> =>
        {
            const confirmed = await requestGlobalConfirm({
                title: isAdmin ? '管理员操作' : '删除评论',
                content: isAdmin
                    ? `确定要删除这条评论吗？操作记录将被审计。内容摘要：${summary}`
                    : `确定要删除这条评论吗？内容摘要：${summary}`,
                confirmText: '删除'
            });
            if (!confirmed)
            {
                return;
            }

            try
            {
                const capabilitySecret = getCommentManagementCapabilityVault().get(targetId);
                if (capabilitySecret)
                {
                    const challenge = await issueCommentManagementChallenge(targetId, 'delete', capabilitySecret);
                    await deleteAnonymousComment(targetId, capabilitySecret, challenge.challenge);
                    getCommentManagementCapabilityVault().remove(targetId);
                }
                else if (!isAdmin && ownedCommentIds.value.has(targetId))
                {
                    const challenge = await issueCommentManagementChallenge(targetId, 'delete', null);
                    await deleteCommentAsAuthor(targetId, challenge.challenge);
                }
                else
                {
                    await deleteComment(targetId);
                }
                toast.success('已移除');
                removeCommentById(targetId, payload.rootId, payload.parentId);
                removeOwnedComment(targetId);
                void reconcileCommentsAfterMutation();
            }
            catch (error: unknown)
            {
                showErrorToast(error, '操作失败');
            }
        };

        void deleteSelectedComment();
    };

    const handleCommentEdit = (payload: { id: string; content: string; }): void =>
    {
        const editSelectedComment = async (): Promise<void> =>
        {
            const nextContent = await promptText(
                '编辑后会重新经过内容、地区与模型审核，公开状态可能变为待审核或隐藏。',
                '编辑评论',
                { inputValue: payload.content, inputType: 'textarea' }
            );
            if (nextContent === null || nextContent === payload.content)
            {
                return;
            }

            const validation = validateCommentContent(nextContent);
            if (!validation.isValid)
            {
                showErrorToast(new Error(validation.message), '评论内容不符合要求');
                return;
            }

            try
            {
                const capabilitySecret = getCommentManagementCapabilityVault().get(payload.id);
                const challenge = await issueCommentManagementChallenge(payload.id, 'edit', capabilitySecret);
                await editCommentAsAuthor(payload.id, {
                    expectedVersion: challenge.currentVersion,
                    content: nextContent,
                    challenge: challenge.challenge,
                    ...(capabilitySecret ? { capabilitySecret } : {})
                });
                toast.success('评论已更新并重新提交审核');
                await reconcileCommentsAfterMutation();
            }
            catch (error: unknown)
            {
                showErrorToast(error, '编辑失败');
            }
        };

        void editSelectedComment();
    };

    const handleArticleBatch = (patches: readonly NotificationStreamArticleRenderPatch[]): void =>
    {
        for (const patch of patches)
        {
            if (patch.kind === 'reconnected')
            {
                handleSignalRReconnected();
                continue;
            }

            const payload = patch.event?.payload;
            if (!payload)
            {
                continue;
            }

            if (payload.action === 'Deleted')
            {
                handleRemoteArticleDeleted(payload);
                continue;
            }

            if (payload.action === 'Updated' || payload.action === 'Restored')
            {
                handleRemoteArticleUpdated(payload);
            }
        }
    };

    const handleCommentBatch = (patches: readonly NotificationStreamCommentRenderPatch[]): void =>
    {
        for (const patch of patches)
        {
            const payload = patch.event.payload;
            if (patch.kind === 'added')
            {
                handleRemoteAdd(payload as CommentAddedSignalPayload);
                continue;
            }

            handleRemoteDelete(payload as CommentDeletedSignalPayload);
        }
    };

    onMounted(() =>
    {
        void initializeArticleRoute();
    });

    watch(
        () => `${userStore.isLoggedIn}:${userStore.isAdmin}:${userStore.userInfo?.accountId ?? ''}`,
        () =>
        {
            clearCommentOwnership();
            if (lifecycle.isActive() && article.value && userStore.isLoggedIn && !userStore.isAdmin)
            {
                void refreshCommentOwnership();
            }
        }
    );

    watch(
        () => route.params.id,
        (nextId, prevId) =>
        {
            if (!lifecycle.isActive() || nextId === prevId)
            {
                return;
            }

            void initializeArticleRoute();
        }
    );

    watch(
        () => notificationStreamStore.articleRevision,
        () =>
        {
            if (!lifecycle.isActive())
            {
                return;
            }

            handleArticleBatch(notificationStreamStore.articleBatch);
        }
    );

    watch(
        () => notificationStreamStore.commentRevision,
        () =>
        {
            if (!lifecycle.isActive())
            {
                return;
            }

            handleCommentBatch(notificationStreamStore.commentBatch);
            void loadCommentPolicySnapshot();
        }
    );

    watch(
        () => notificationStreamStore.commentPolicyRevision,
        () =>
        {
            if (lifecycle.isActive() && article.value?.id)
            {
                void loadCommentPolicySnapshot();
            }
        }
    );

    watch(
        () => replyTarget.value?.rootId ?? null,
        () =>
        {
            if (lifecycle.isActive() && article.value?.id)
            {
                void loadCommentPolicySnapshot();
            }
        }
    );

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
        commentAuthorMode,
        publicSendConfirmed,
        commentDisplayLanguage,
        commentAnonymousScope,
        anonymousCommentsEnabled,
        publicCommentsEnabled,
        zkAnonymousEnabled,
        commentMaxChars,
        commentMaxUtf8Bytes,
        commentPolicySnapshotHash,
        commentPrivacyUiState,
        submittingComment,
        threads,
        ownedCommentIds,
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
        prepareCommentPrivacyTicket,
        handleCommentEdit,
        handleCommentDelete,
        spaReady
    };
}

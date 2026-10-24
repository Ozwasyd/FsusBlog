import { computed, nextTick, onMounted, ref, watch, onUnmounted } from 'vue';
import { useRoute, useRouter, type LocationQuery } from 'vue-router';

import { toPublicArticleListCardProjection, type PublicArticleListCardProjection } from '@/adapters/binary/articleProjectionReader';
import { getFeaturedArticles, getHotArticles, getPublicArticleCardProjections, type FeaturedArticleItem, type PopularArticleSummaryResponse } from '@/api/article';
import { toBootstrapArticleListItem } from '@/bootstrap/publicAotBootstrap';
import { markCurrentRouteContentReady, markCurrentRouteFailed } from '@/bootstrap/routeReadiness';
import { useAbortableTask } from '@/composables/useAbortableTask';
import { usePagedListState } from '@/composables/usePagedListState';
import { usePublicPageLifecycle } from '@/composables/usePublicPageLifecycle';
import { consumePublicPageSeed } from '@/public-renderers/pageSeed';
import { createPublicSeedRenderTimeOptions } from '@/public-renderers/publicRenderClock';
import { buildPublicHomePaginationHref, parsePublicPaginationCursor } from '@/public-renderers/publicRouteIdentity';
import { upsertArticlePreview, removeArticlePreview } from '@/services/notificationStreamArticlePatch';
import type { ArticleUpdatePayload, NotificationStreamArticleRenderPatch } from '@/services/notificationStreamTypes';
import { useNotificationStreamStore } from '@/store/notificationStream';
import { AppErrorCode, createAppError, toAppError } from '@/utils/appError';
import { isAbortError } from '@/utils/errors';
import { createArticleListViewContract, type ArticleListCardViewContract } from '@/view-contracts/articleList';
import { createStableArticleCardMapper } from '@/view-contracts/articleListStableCache';

const HOME_FEATURED_ARTICLE_COUNT = 1;
const HOME_FEATURED_ARTICLE_PREFETCH_COUNT = 3;
const HOME_HOT_ARTICLE_PREFETCH_COUNT = 10;
const HOME_SECONDARY_CONTENT_SENTINEL_ID = 'fsus-home-secondary-content-sentinel';
const HOME_SECONDARY_LIST_ROOT_MARGIN = '600px 0px 600px 0px';
const HOME_SECONDARY_LIST_FALLBACK_DELAY_MS = 2500;
const HOME_ARTICLE_BATCH_REFRESH_DELAY_MS = 100;
const HOME_SECONDARY_REFRESH_DELAY_MS = 500;

const parsePageQuery = (value: LocationQuery[string] | undefined): number =>
{
    const raw = Array.isArray(value) ? value[0] : value;
    const parsed = Number.parseInt(String(raw ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const firstArrayOf = <T>(...candidates: (readonly T[] | null | undefined)[]): T[] =>
{
    const selected = candidates.find((candidate): candidate is readonly T[] => Array.isArray(candidate));
    return selected ? [...selected] : [];
};

export function useHomeView()
{
    const route = useRoute();
    const router = useRouter();
    const notificationStreamStore = useNotificationStreamStore();
    const { bootstrap: initialBootstrap, hydration: initialHydrationPayload } = consumePublicPageSeed('Home', { fullPath: route?.fullPath });
    const initialHydrationView = initialHydrationPayload?.view ?? null;
    const hasInitialRouteSeed = Boolean(initialBootstrap) || Boolean(initialHydrationView);
    const seedRenderTimeOptions = createPublicSeedRenderTimeOptions(initialHydrationPayload, initialBootstrap);
    const useSeedRenderTime = ref(Boolean(seedRenderTimeOptions));
    const initialFeaturedArticles = firstArrayOf(
        initialHydrationPayload?.featuredArticles,
        initialBootstrap?.featuredArticles
    );
    const initialHotArticles = firstArrayOf(
        initialHydrationPayload?.hotArticles,
        initialBootstrap?.hotArticles
    );

    const articleItems = ref<PublicArticleListCardProjection[]>([]);
    const featuredArticles = ref<FeaturedArticleItem[]>(initialFeaturedArticles);
    const hotArticles = ref<PopularArticleSummaryResponse[]>(initialHotArticles);
    const featuredLoading = ref(false);
    const initialViewItems = ref<readonly ArticleListCardViewContract[] | null>(
    initialHydrationView && Array.isArray(initialHydrationView.items)
        ? initialHydrationView.items
        : null
    );
    const mapArticleCards = createStableArticleCardMapper(() => useSeedRenderTime.value ? seedRenderTimeOptions : undefined);
    const articleCursorByPage = new Map<number, string | null>([[1, null]]);
    const articleCursorRevision = ref(0);
    const {
        currentPage,
        pageSize,
        total,
        totalPages,
        loading,
        error,
        beginLoading,
        endLoading,
        setError,
        setPageTotal
    } = usePagedListState({ pageSize: 10 });
    const isError = computed(() => error.value !== null);
    const pageIndicatorText = computed(() => `${currentPage.value} / ${totalPages.value}`);
    const articles = computed<ArticleListCardViewContract[]>(() =>
    initialViewItems.value
        ? [...initialViewItems.value]
        : mapArticleCards(articleItems.value)
    );
    const listView = computed(() =>
    initialViewItems.value && initialHydrationView
        ? {
          ...initialHydrationView,
          items: [...initialViewItems.value],
          pagination: {
            ...initialHydrationView.pagination
          }
        }
        : createArticleListViewContract(
          {
            items: articleItems.value,
            total: total.value
          },
          {
            currentPage: currentPage.value,
            pageSize: pageSize.value,
            pageHref: (page) => buildPublicHomePaginationHref(page, articleCursorByPage.get(page)),
            canGoPrev: canGoPrev.value,
            canGoNext: canGoNext.value,
            time: useSeedRenderTime.value ? seedRenderTimeOptions : undefined
          }
        )
    );
    const canGoPrev = computed(() =>
    {
        void articleCursorRevision.value;
        const previousPage = currentPage.value - 1;
        return previousPage >= 1
      && !loading.value
      && (previousPage === 1 || articleCursorByPage.has(previousPage));
    });
    const canGoNext = computed(() =>
    {
        void articleCursorRevision.value;
        return currentPage.value < totalPages.value
      && !loading.value
      && articleCursorByPage.has(currentPage.value + 1);
    });

    const articleTask = useAbortableTask();
    const featuredTask = useAbortableTask();
    const homeRuntimeMetrics = {
        patchApplied: 0,
        fallbackSync: 0,
        secondaryRefresh: 0,
        stalePageMarks: 0
    };
    const pendingArticleBatchRefresh = {
        syncList: false,
        refreshSecondary: false
    };
    let articleRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let secondaryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let secondaryListObserver: IntersectionObserver | null = null;
    let secondaryListFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let secondaryListsLoaded = initialFeaturedArticles.length > 0 || initialHotArticles.length > 0;
    let secondaryListRequestInFlight = false;

    const lifecycle = usePublicPageLifecycle({
        onDispose: () =>
        {
            articleTask.cancel();
            featuredTask.cancel();
            if (articleRefreshTimer)
            {
                clearTimeout(articleRefreshTimer);
            }
            if (secondaryRefreshTimer)
            {
                clearTimeout(secondaryRefreshTimer);
            }
            clearSecondaryListFallbackTimer();
            disconnectSecondaryListObserver();
        }
    });
    const markRouteReadyIfSettled = (): void =>
    {
        if (isError.value)
        {
            markCurrentRouteFailed(route);
            return;
        }

        if (!loading.value)
        {
            markCurrentRouteContentReady(route);
        }
    };

    if (initialBootstrap)
    {
        articleItems.value = initialBootstrap.articles
            .map((article) => toPublicArticleListCardProjection(toBootstrapArticleListItem(article)));
        setPageTotal(Number(initialBootstrap.total) || 0);
    }
    if (initialHydrationView)
    {
        currentPage.value = Math.max(1, Number(initialHydrationPayload?.currentPage) || 1);
        pageSize.value = Math.max(1, Number(initialHydrationPayload?.pageSize) || pageSize.value);
        setPageTotal(Number(initialHydrationPayload?.total) || 0);
    }

    const seededNextCursor = parsePublicPaginationCursor(
        initialHydrationPayload?.nextCursor ?? initialBootstrap?.nextCursor
    );
    if (seededNextCursor)
    {
        articleCursorByPage.set(2, seededNextCursor);
        articleCursorRevision.value++;
    }

    const initialRoutePage = parsePageQuery(route.query.page);
    const initialRouteCursor = parsePublicPaginationCursor(route.query.cursor);
    currentPage.value = initialRoutePage;
    if (currentPage.value > 1 && initialRouteCursor)
    {
        articleCursorByPage.set(currentPage.value, initialRouteCursor);
        articleCursorRevision.value++;
    }

    const syncPageQuery = (page: number): boolean =>
    {
        const nextQuery = { ...route.query };
        if (page <= 1)
        {
            delete nextQuery.page;
            delete nextQuery.cursor;
        }
        else
        {
            const cursor = articleCursorByPage.get(page);
            if (!cursor)
            {
                return false;
            }
            nextQuery.page = String(page);
            nextQuery.cursor = cursor;
        }

        void router.push({ path: route.path, query: nextQuery, hash: route.hash });
        return true;
    };

    const handlePageChange = (page: number): void =>
    {
        if (page < 1 || page > totalPages.value || loading.value)
        {
            return;
        }
        if (syncPageQuery(page))
        {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    };

    const loadArticles = async (showLoading = true): Promise<void> =>
    {
        if (showLoading)
        {
            beginLoading();
        }
        else
        {
            error.value = null;
        }

        try
        {
            const routeHasCursor = Object.prototype.hasOwnProperty.call(route.query, 'cursor');
            const requestCursor = articleCursorByPage.get(currentPage.value);
            if ((currentPage.value === 1 && routeHasCursor)
        || (currentPage.value > 1 && !requestCursor))
            {
                throw createAppError(AppErrorCode.Validation, 'article_cursor_required');
            }
            const response = await articleTask.run(
                async (signal) =>
                    await getPublicArticleCardProjections(
                        {
                            page: currentPage.value,
                            size: pageSize.value,
                            cursor: requestCursor
                        },
                        { signal }
                    )
            );

            if (lifecycle.isActive() && response)
            {
                if (Array.isArray(response.items))
                {
                    initialViewItems.value = null;
                    useSeedRenderTime.value = false;
                    articleItems.value = response.items;
                    setPageTotal(Number(response.total) || 0);
                    if (response.hasMore && response.nextCursor)
                    {
                        articleCursorByPage.set(currentPage.value + 1, response.nextCursor);
                    }
                    else
                    {
                        articleCursorByPage.delete(currentPage.value + 1);
                    }
                    articleCursorRevision.value++;
                    error.value = null;
                }
                else
                {
                    throw createAppError(AppErrorCode.ProtocolFailure, 'home_articles_response_invalid');
                }
            }
        }
        catch (caught: unknown)
        {
            if (isAbortError(caught))
            {
                return;
            }

            if (lifecycle.isActive())
            {
                const normalized = toAppError(caught, 'home_articles_load_failed');
                console.error('[Home] Data loading error:', normalized.message);
                setError(normalized.code === AppErrorCode.ProtocolFailure ? '内容格式不一致' : '内容不可用');
                articleItems.value = [];
                setPageTotal(0);
                markCurrentRouteFailed(route);
            }
        }
        finally
        {
            if (lifecycle.isActive() && showLoading)
            {
                endLoading();
            }
            if (lifecycle.isActive())
            {
                markRouteReadyIfSettled();
            }
        }
    };

    const clearSecondaryListFallbackTimer = (): void =>
    {
        if (!secondaryListFallbackTimer)
        {
            return;
        }

        clearTimeout(secondaryListFallbackTimer);
        secondaryListFallbackTimer = null;
    };

    const disconnectSecondaryListObserver = (): void =>
    {
        secondaryListObserver?.disconnect();
        secondaryListObserver = null;
    };

    const loadHomeSecondaryArticles = async (showLoading = true): Promise<void> =>
    {
        if (secondaryListRequestInFlight)
        {
            return;
        }

        secondaryListRequestInFlight = true;
        if (showLoading)
        {
            featuredLoading.value = true;
        }

        try
        {
            const [featuredResult, hotResult] = await featuredTask.run(
                async (signal) => await Promise.allSettled([
                    getFeaturedArticles(HOME_FEATURED_ARTICLE_PREFETCH_COUNT, { signal }),
                    getHotArticles(HOME_HOT_ARTICLE_PREFETCH_COUNT, { signal })
                ])
            );

            if (hotResult.status === 'rejected')
            {
                throw hotResult.reason;
            }
            let featured: FeaturedArticleItem[] = [];
            if (featuredResult.status === 'fulfilled')
            {
                featured = featuredResult.value || [];
            }
            else
            {
                const featuredError = toAppError(featuredResult.reason, 'home_featured_load_failed');
                if (featuredError.code !== AppErrorCode.NotFound && featuredError.status !== 404)
                {
                    throw featuredResult.reason;
                }
            }
            const hot = hotResult.value;

            if (lifecycle.isActive())
            {
                // Keep source order intact here. One shared editorial selector owns
                // lead/secondary/feed deduplication for SSR, hydration, and SPA.
                featuredArticles.value = (featured || []).slice(0, HOME_FEATURED_ARTICLE_COUNT);
                hotArticles.value = (hot || []).slice(0, HOME_HOT_ARTICLE_PREFETCH_COUNT);
                secondaryListsLoaded = true;
                homeRuntimeMetrics.secondaryRefresh++;
            }
        }
        catch (caught: unknown)
        {
            if (isAbortError(caught))
            {
                return;
            }
            console.error('[Home] Featured articles load error:', caught);
        }
        finally
        {
            secondaryListRequestInFlight = false;
            if (lifecycle.isActive())
            {
                featuredLoading.value = false;
            }
        }
    };

    const triggerSecondaryListLoad = (showLoading = true): void =>
    {
        clearSecondaryListFallbackTimer();
        disconnectSecondaryListObserver();
        void loadHomeSecondaryArticles(showLoading);
    };

    const scheduleSecondaryListLoad = async (): Promise<void> =>
    {
        if (secondaryListsLoaded || secondaryListRequestInFlight || secondaryListObserver || secondaryListFallbackTimer)
        {
            return;
        }

        await nextTick();
        if (!lifecycle.isActive() || loading.value || isError.value || listView.value.items.length === 0)
        {
            return;
        }

        const target = typeof document === 'undefined'
            ? null
            : document.getElementById(HOME_SECONDARY_CONTENT_SENTINEL_ID);
        if (!target)
        {
            return;
        }

        if (typeof IntersectionObserver === 'undefined')
        {
            secondaryListFallbackTimer = setTimeout(() =>
            {
                secondaryListFallbackTimer = null;
                triggerSecondaryListLoad(true);
            }, HOME_SECONDARY_LIST_FALLBACK_DELAY_MS);
            return;
        }

        secondaryListObserver = new IntersectionObserver((entries) =>
        {
            if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0))
            {
                triggerSecondaryListLoad(true);
            }
        }, {
            root: null,
            rootMargin: HOME_SECONDARY_LIST_ROOT_MARGIN,
            threshold: 0
        });
        secondaryListObserver.observe(target);
    };

    const scheduleHomeSecondaryRefresh = (showLoading = false): void =>
    {
        if (!secondaryListsLoaded && !secondaryListRequestInFlight)
        {
            return;
        }

        if (secondaryRefreshTimer)
        {
            clearTimeout(secondaryRefreshTimer);
        }

        secondaryRefreshTimer = setTimeout(() =>
        {
            void loadHomeSecondaryArticles(showLoading);
            secondaryRefreshTimer = null;
        }, HOME_SECONDARY_REFRESH_DELAY_MS);
    };

    const scheduleArticleBatchRefresh = (request: { syncList: boolean; refreshSecondary: boolean; }): void =>
    {
        pendingArticleBatchRefresh.syncList ||= request.syncList;
        pendingArticleBatchRefresh.refreshSecondary ||= request.refreshSecondary;

        if (articleRefreshTimer)
        {
            clearTimeout(articleRefreshTimer);
        }

        articleRefreshTimer = setTimeout(() =>
        {
            const shouldSyncList = pendingArticleBatchRefresh.syncList;
            const shouldRefreshSecondary = pendingArticleBatchRefresh.refreshSecondary;
            pendingArticleBatchRefresh.syncList = false;
            pendingArticleBatchRefresh.refreshSecondary = false;
            articleRefreshTimer = null;

            if (!lifecycle.isActive())
            {
                return;
            }

            if (shouldSyncList)
            {
                homeRuntimeMetrics.fallbackSync++;
                lifecycle.scheduleSync(() =>
                {
                    void loadArticles(false);
                });
            }

            if (shouldRefreshSecondary)
            {
                scheduleHomeSecondaryRefresh(false);
            }
        }, HOME_ARTICLE_BATCH_REFRESH_DELAY_MS);
    };

    const applyArticlePatch = (payload: ArticleUpdatePayload): boolean =>
    {
        const exists = articleItems.value.some((article) => article.id === payload.articleId);

        if (payload.action === 'Created' || payload.action === 'Restored')
        {
            if (!payload.preview)
            {
                return false;
            }

            if (!exists)
            {
                setPageTotal(total.value + 1);
            }

            if (currentPage.value === 1)
            {
                initialViewItems.value = null;
                articleItems.value = upsertArticlePreview(
                    articleItems.value,
                    toPublicArticleListCardProjection(payload.preview)
                ).slice(0, pageSize.value);
                homeRuntimeMetrics.patchApplied++;
            }
            else
            {
                homeRuntimeMetrics.stalePageMarks++;
            }

            return true;
        }

        if (payload.action === 'Updated')
        {
            if (!payload.preview)
            {
                return false;
            }

            if (!exists && currentPage.value !== 1)
            {
                homeRuntimeMetrics.stalePageMarks++;
                return true;
            }

            if (!exists)
            {
                return false;
            }

            articleItems.value = upsertArticlePreview(
                articleItems.value,
                toPublicArticleListCardProjection(payload.preview)
            );
            initialViewItems.value = null;
            homeRuntimeMetrics.patchApplied++;
            return true;
        }

        if (!exists)
        {
            return false;
        }

        articleItems.value = removeArticlePreview(articleItems.value, payload.articleId);
        initialViewItems.value = null;
        setPageTotal(Math.max(0, total.value - 1));
        homeRuntimeMetrics.patchApplied++;
        if (currentPage.value !== 1)
        {
            homeRuntimeMetrics.stalePageMarks++;
            return true;
        }

        return currentPage.value === 1 && articleItems.value.length >= pageSize.value;
    };

    const handleArticleBatch = (patches: readonly NotificationStreamArticleRenderPatch[]): void =>
    {
        let needsSync = false;
        let needsFeaturedSync = false;

        for (const patch of patches)
        {
            if (patch.kind === 'reconnected')
            {
                needsSync = true;
                needsFeaturedSync = true;
                continue;
            }

            if (!patch.event)
            {
                needsSync = true;
                needsFeaturedSync = true;
                continue;
            }

            const action = patch.event.payload.action;
            if (action === 'Created' || action === 'Deleted' || action === 'Restored')
            {
                needsFeaturedSync = true;
            }

            if (!applyArticlePatch(patch.event.payload))
            {
                needsSync = true;
            }
        }

        if ((needsSync || needsFeaturedSync) && lifecycle.isActive())
        {
            scheduleArticleBatchRefresh({
                syncList: needsSync,
                refreshSecondary: needsFeaturedSync
            });
        }
    };

    watch(
        () => [route.query.page, route.query.cursor] as const,
        () =>
        {
            const nextPage = parsePageQuery(route.query.page);
            const nextCursor = parsePublicPaginationCursor(route.query.cursor);
            if (nextPage > 1 && !nextCursor)
            {
                initialViewItems.value = null;
                currentPage.value = nextPage;
                setError('分页参数无效');
                markCurrentRouteFailed(route);
                return;
            }

            if (nextPage > 1 && nextCursor)
            {
                articleCursorByPage.set(nextPage, nextCursor);
                articleCursorRevision.value++;
            }
            initialViewItems.value = null;
            currentPage.value = nextPage;
            void loadArticles();
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

    onMounted(() =>
    {
        void scheduleSecondaryListLoad();

        if (!hasInitialRouteSeed)
        {
            initialViewItems.value = null;
            void loadArticles();
        }

        void nextTick(markRouteReadyIfSettled);
    });

    watch(
        () => [loading.value, isError.value, initialViewItems.value?.length, articleItems.value.length] as const,
        () =>
        {
            markRouteReadyIfSettled();
            void scheduleSecondaryListLoad();
        },
        { flush: 'post' }
    );

    onUnmounted(() =>
    {
        if (articleRefreshTimer)
        {
            clearTimeout(articleRefreshTimer);
        }
        if (secondaryRefreshTimer)
        {
            clearTimeout(secondaryRefreshTimer);
        }
        clearSecondaryListFallbackTimer();
        disconnectSecondaryListObserver();
    });

    return {
        listView,
        articles,
        featuredArticles,
        hotArticles,
        featuredLoading,
        currentPage,
        totalPages,
        loading,
        isError,
        pageIndicatorText,
        canGoPrev,
        canGoNext,
        handlePageChange,
        loadArticles,
        loadHomeSecondaryArticles
    };
}

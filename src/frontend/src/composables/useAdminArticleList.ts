import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue';
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router';

import {
    ArticlePublishStatus,
    deleteArticle,
    getAdminArticles,
    type ArticleListItemResponse
} from '@/api/article';
import { getCategories, type CategoryItem } from '@/api/category';
import type { ApiRequestConfig } from '@/api/requestConfig';
import { getTags, type TagItem } from '@/api/tag';
import { useMutationFlow } from '@/composables/useMutationFlow';
import { useRowStateMotion } from '@/composables/useRowStateMotion';
import { useViewTask } from '@/composables/useViewTask';
import { articleRecoveryJournal } from '@/services/articleRecoveryJournal';
import {
    articleWorkspaceTabRouter,
    createArticleWorkspaceOpenInput
} from '@/services/authoring/articleWorkspaceTabRouter';
import { showErrorToast } from '@/utils/errorPresentation';
import { TimeUtils } from '@/utils/time';

type FilterChipKey = 'keyword' | 'status' | 'categoryId' | 'tagId';

interface ActiveFilterChip {
    key: FilterChipKey;
    label: string;
}

type ArticleListCommand = 'view' | 'delete';

type AdminArticleListViewItem = ArticleListItemResponse & {
    createdAtText: string;
    categoryName: string;
    statusText: string;
    statusTagType: 'success' | 'warning' | 'info' | 'danger';
    statusTimeLabel: string;
    statusTimeText: string;
    statusTimeValue: string;
    primaryActionLabel: string;
    previewActionLabel: string;
    publicPreviewAvailable: boolean;
};

const PAGE_SIZE_OPTIONS = [10, 20, 50];
const STATUS_FILTERS = [
    { label: '全部', value: undefined },
    { label: '草稿', value: ArticlePublishStatus.Draft },
    { label: '定时', value: ArticlePublishStatus.Scheduled },
    { label: '已发布', value: ArticlePublishStatus.Published },
    { label: '归档', value: ArticlePublishStatus.Archived }
] as const;

const statusText = (status: ArticlePublishStatus | undefined): string =>
{
    if (status === ArticlePublishStatus.Draft)
    {
        return '草稿';
    }
    if (status === ArticlePublishStatus.Scheduled)
    {
        return '定时';
    }
    if (status === ArticlePublishStatus.Archived)
    {
        return '归档';
    }
    if (status === ArticlePublishStatus.Deleted)
    {
        return '删除';
    }
    return '已发布';
};

const statusTagType = (status: ArticlePublishStatus | undefined): AdminArticleListViewItem['statusTagType'] =>
{
    if (status === ArticlePublishStatus.Draft)
    {
        return 'info';
    }
    if (status === ArticlePublishStatus.Scheduled)
    {
        return 'warning';
    }
    if (status === ArticlePublishStatus.Archived)
    {
        return 'danger';
    }
    if (status === ArticlePublishStatus.Deleted)
    {
        return 'danger';
    }
    return 'success';
};

const primaryActionLabel = (status: ArticlePublishStatus | undefined): string =>
{
    if (status === ArticlePublishStatus.Draft)
    {
        return '继续写作';
    }
    if (status === ArticlePublishStatus.Scheduled)
    {
        return '调整排期';
    }
    if (status === ArticlePublishStatus.Archived)
    {
        return '查看并恢复';
    }
    return '编辑';
};

const isDateDue = (value: string | null | undefined, nowMs: number): boolean =>
{
    if (!value)
    {
        return true;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed <= nowMs;
};

export const isPubliclyVisibleArticle = (item: ArticleListItemResponse, nowMs = Date.now()): boolean =>
    !item.isDeleted
  && item.status === ArticlePublishStatus.Published
  && isDateDue(item.publishedAt, nowMs)
  && isDateDue(item.scheduledPublishAt, nowMs);

const statusTimeMeta = (item: ArticleListItemResponse): Pick<AdminArticleListViewItem, 'statusTimeLabel' | 'statusTimeText' | 'statusTimeValue'> =>
{
    const value = item.status === ArticlePublishStatus.Scheduled && item.scheduledPublishAt
        ? item.scheduledPublishAt
        : item.publishedAt || item.createTime;
    const label = item.status === ArticlePublishStatus.Scheduled && item.scheduledPublishAt
        ? '计划发布'
        : item.publishedAt
      ? '发布时间'
      : '创建时间';

    return {
        statusTimeLabel: label,
        statusTimeValue: value,
        statusTimeText: TimeUtils.toFullLocalString(value)
    };
};

const firstQueryValue = (value: unknown): string =>
{
    if (Array.isArray(value))
    {
        return value[0] == null ? '' : String(value[0]);
    }

    return value == null ? '' : String(value);
};

const parsePositiveInt = (value: unknown, fallback?: number): number | undefined =>
{
    const text = firstQueryValue(value).trim();
    if (!text)
    {
        return fallback;
    }

    const parsed = Number.parseInt(text, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseStatus = (value: unknown): ArticlePublishStatus | undefined =>
{
    const text = firstQueryValue(value).trim();
    if (!text)
    {
        return undefined;
    }

    const parsed = Number.parseInt(text, 10);
    return parsed >= ArticlePublishStatus.Draft && parsed <= ArticlePublishStatus.Archived
        ? parsed as ArticlePublishStatus
        : undefined;
};

export function useAdminArticleList()
{
    const router = useRouter();
    const route = useRoute();

    const loading = ref(false);
    const articleList = shallowRef<ArticleListItemResponse[]>([]);
    const categories = shallowRef<CategoryItem[]>([]);
    const tags = shallowRef<TagItem[]>([]);
    const total = ref(0);

    const queryParam = reactive({
        page: 1,
        size: 10,
        keyword: '',
        categoryId: undefined as number | undefined,
        tagId: undefined as number | undefined,
        status: undefined as ArticlePublishStatus | undefined
    });

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const loadTask = useViewTask();
    const taxonomyTask = useViewTask();
    const mutation = useMutationFlow();
    const rowMotion = useRowStateMotion({ visibleLimit: 20 });
    const articleListView = computed<AdminArticleListViewItem[]>(() =>
    {
        const nowMs = Date.now();
        return articleList.value.map((item) =>
        {
            const publicPreviewAvailable = isPubliclyVisibleArticle(item, nowMs);
            return {
                ...item,
                createdAtText: TimeUtils.toFullLocalString(item.createTime),
                categoryName: item.category?.name || '未分类',
                statusText: statusText(item.status),
                statusTagType: statusTagType(item.status),
                primaryActionLabel: primaryActionLabel(item.status),
                previewActionLabel: publicPreviewAvailable ? '前台预览' : '管理预览',
                publicPreviewAvailable,
                ...statusTimeMeta(item)
            };
        });
    });
    const totalText = computed(() => `文章列表 · ${total.value} 条结果`);
    const isBusy = computed(() => loading.value || taxonomyTask.loading.value);

    const categoryNameById = computed(() => new Map(categories.value.map((item) => [item.id, item.name])));
    const tagNameById = computed(() => new Map(tags.value.map((item) => [item.id, item.name])));
    const activeFilterChips = computed<ActiveFilterChip[]>(() =>
    {
        const chips: ActiveFilterChip[] = [];
        const keyword = queryParam.keyword.trim();
        if (keyword)
        {
            chips.push({ key: 'keyword', label: `标题：${keyword}` });
        }

        if (queryParam.status !== undefined)
        {
            chips.push({ key: 'status', label: `状态：${statusText(queryParam.status)}` });
        }

        if (queryParam.categoryId !== undefined)
        {
            chips.push({ key: 'categoryId', label: `分类：${categoryNameById.value.get(queryParam.categoryId) ?? `#${queryParam.categoryId}`}` });
        }

        if (queryParam.tagId !== undefined)
        {
            chips.push({ key: 'tagId', label: `标签：${tagNameById.value.get(queryParam.tagId) ?? `#${queryParam.tagId}`}` });
        }

        return chips;
    });

    const hydrateQueryFromRoute = (): void =>
    {
        queryParam.page = parsePositiveInt(route.query.page, 1) ?? 1;
        queryParam.size = parsePositiveInt(route.query.size, 10) ?? 10;
        queryParam.categoryId = parsePositiveInt(route.query.categoryId);
        queryParam.tagId = parsePositiveInt(route.query.tagId);
        queryParam.status = parseStatus(route.query.status);
    };

    const buildRouteQuery = (): LocationQueryRaw =>
    {
        const query: LocationQueryRaw = {
            page: String(queryParam.page),
            size: String(queryParam.size)
        };
        if (queryParam.status !== undefined)
        {
            query.status = String(queryParam.status);
        }
        if (queryParam.categoryId !== undefined)
        {
            query.categoryId = String(queryParam.categoryId);
        }
        if (queryParam.tagId !== undefined)
        {
            query.tagId = String(queryParam.tagId);
        }
        return query;
    };

    const syncQueryToRoute = (): void =>
    {
        void router.replace({ name: 'ManageArticleList', query: buildRouteQuery() }).catch(() => undefined);
    };

    const loadData = async (): Promise<void> =>
    {
        syncQueryToRoute();
        const paramsSnapshot = {
            ...queryParam,
            keyword: queryParam.keyword.trim() || undefined
        };

        loading.value = true;
        try
        {
            const response = await loadTask.run(async (signal) =>
            {
                const config: ApiRequestConfig = { signal };
                return await getAdminArticles(paramsSnapshot, config);
            }, {
                fallbackMessage: '无法同步文章列表，请检查网络契约',
                onError: (error) =>
                {
                    console.error('[Admin List] Sync Error:', error);
                    articleList.value = [];
                    total.value = 0;
                    showErrorToast('无法同步文章列表，请检查网络契约', '无法同步文章列表，请检查网络契约');
                }
            });

            if (!response)
            {
                return;
            }

            if (!Array.isArray(response.items))
            {
                articleList.value = [];
                total.value = 0;
                showErrorToast('无法同步文章列表，请检查网络契约', '无法同步文章列表，请检查网络契约');
                return;
            }

            articleList.value = Object.freeze(response.items) as ArticleListItemResponse[];
            total.value = Number(response.total) || 0;
            rowMotion.markUpdated(response.items.slice(0, 20).map((item) => item.id), `文章列表 · ${total.value} 条结果`);
        }
        finally
        {
            loading.value = false;
        }
    };

    const loadTaxonomy = async (): Promise<void> =>
    {
        const data = await taxonomyTask.run(async (signal) =>
        {
            const config: ApiRequestConfig = { signal };
            const [categoryItems, tagItems] = await Promise.all([
                getCategories(config),
                getTags(config)
            ]);
            return { categoryItems, tagItems };
        }, {
            fallbackMessage: '无法同步分类与标签筛选项',
            onError: (error) =>
            {
                console.error('[Admin List] Taxonomy sync error:', error);
            }
        });

        if (data)
        {
            categories.value = Array.isArray(data.categoryItems) ? data.categoryItems : [];
            tags.value = Array.isArray(data.tagItems) ? data.tagItems : [];
        }
    };

    const loadDataWithDebounce = (): void =>
    {
        if (debounceTimer)
        {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() =>
        {
            void loadData();
        }, 100);
    };

    const handleSearch = (): void =>
    {
        queryParam.page = 1;
        void loadData();
    };

    const resetQuery = (): void =>
    {
        queryParam.keyword = '';
        queryParam.categoryId = undefined;
        queryParam.tagId = undefined;
        queryParam.status = undefined;
        handleSearch();
    };

    const setStatusFilter = (status: ArticlePublishStatus | undefined): void =>
    {
        queryParam.status = status;
        handleSearch();
    };

    const setCategoryFilter = (categoryId: number | undefined): void =>
    {
        queryParam.categoryId = categoryId;
        handleSearch();
    };

    const setTagFilter = (tagId: number | undefined): void =>
    {
        queryParam.tagId = tagId;
        handleSearch();
    };

    const removeFilter = (key: FilterChipKey): void =>
    {
        if (key === 'keyword')
        {
            queryParam.keyword = '';
        }
        if (key === 'status')
        {
            queryParam.status = undefined;
        }
        if (key === 'categoryId')
        {
            queryParam.categoryId = undefined;
        }
        if (key === 'tagId')
        {
            queryParam.tagId = undefined;
        }
        handleSearch();
    };

    const handlePageSizeChange = (): void =>
    {
        queryParam.page = 1;
        void loadData();
    };

    const handlePageChange = (): void =>
    {
        loadDataWithDebounce();
    };

    const openArticleWorkspaceRoute = (
        row: ArticleListItemResponse,
        options: { preview: boolean; entrypoint: 'internal-link' | 'rail' | 'quick-switcher' | 'recent-restore'; }
    ): void =>
    {
        const location = {
            name: 'ManageEditArticle',
            params: { id: String(row.id) },
            query: {
                from: route.fullPath,
                ...(options.preview ? { preview: 'private' } : {})
            }
        } as const;
        const routePath = router.resolve(location).fullPath;
        const identity = {
            articleId: row.id,
            draftId: `draft:article:${row.id}`,
            documentId: `document:article:${row.id}`
        };
        const status = {
            dirty: false,
            saving: false,
            conflict: false,
            recovery: false,
            pendingAttachments: false,
            permission: 'allowed' as const,
            lifecycle: row.isDeleted
                ? 'deleted' as const
                : row.status === ArticlePublishStatus.Archived
                    ? 'archived' as const
                    : 'current' as const,
            statusRef: `workspace-status:article:${row.id}`
        };
        const input = createArticleWorkspaceOpenInput(
            identity,
            {
                documentEpoch: 1,
                sourceRevision: row.currentRevisionId?.trim()
                    ? `revision:source:${row.currentRevisionId.trim()}`
                    : `source:article:${row.id}`,
                draftRevision: typeof row.revisionNo === 'number'
                    ? `revision:article:${row.id}:${row.revisionNo}`
                    : `draft:article:${row.id}`
            },
            row.title,
            status,
            {
                tabKind: options.preview ? 'preview' : 'pinned',
                entrypoint: options.entrypoint,
                route: routePath
            }
        );
        void articleWorkspaceTabRouter.openOrActivateAndNavigate(input, {
            currentFullPath: route.fullPath,
            push: (target) => router.push(target)
        });
    };

    const handleEdit = (id: number): void =>
    {
        const row = articleList.value.find((item) => item.id === id);
        if (!row)
        {
            return;
        }
        openArticleWorkspaceRoute(row, { preview: false, entrypoint: 'internal-link' });
    };

    const safeDelete = async (row: ArticleListItemResponse): Promise<void> =>
    {
        if (loading.value)
        {
            return;
        }

        loading.value = true;
        rowMotion.markPending(row.id, '正在移入回收站');
        try
        {
            await mutation.confirmThenRun({
                message: `确定要将文章《${row.title}》移入回收站吗？文章会从公开列表下线，仍可在回收站恢复。`,
                title: '移入回收站',
                confirmButtonText: '移入回收站',
                cancelButtonText: '取消'
            }, async (signal) =>
            {
                await deleteArticle(row.id, { signal });
            }, {
                fallbackMessage: '文章移入回收站失败',
                successMessage: '文章已移入回收站',
                onSuccess: async () =>
                {
                    await articleRecoveryJournal.clearArticle(row.id);
                    return loadData();
                }
            });
        }
        finally
        {
            rowMotion.clear(row.id);
            loading.value = false;
        }
    };

    const handleMoreCommand = (command: ArticleListCommand, row: ArticleListItemResponse): void =>
    {
        const actionDispatch: Record<ArticleListCommand, () => void> = {
            view: () =>
            {
                if (isPubliclyVisibleArticle(row))
                {
                    window.open(`/article/${row.id}`, '_blank', 'noopener,noreferrer');
                    return;
                }

                openArticleWorkspaceRoute(row, { preview: true, entrypoint: 'internal-link' });
            },
            delete: () =>
            {
                void safeDelete(row);
            }
        };

        actionDispatch[command]?.();
    };

    onMounted(() =>
    {
        hydrateQueryFromRoute();
        void loadTaxonomy();
        void loadData();
    });

    onUnmounted(() =>
    {
        loadTask.cancel();
        taxonomyTask.cancel();
        mutation.cancel();
        if (debounceTimer)
        {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
    });

    return {
        router,
        loading,
        articleList,
        articleListView,
        categories,
        tags,
        total,
        totalText,
        isBusy,
        pageSizeOptions: PAGE_SIZE_OPTIONS,
        statusFilters: STATUS_FILTERS,
        activeFilterChips,
        rowMotion,
        queryParam,
        setStatusFilter,
        setCategoryFilter,
        setTagFilter,
        removeFilter,
        loadDataWithDebounce,
        handlePageSizeChange,
        handlePageChange,
        handleSearch,
        resetQuery,
        handleEdit,
        handleMoreCommand
    };
}

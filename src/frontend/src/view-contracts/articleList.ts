import type { ArticleListItemResponse, BinaryPageResponse as PageResponse } from '@/contracts/binaryApi';
import { createPublicArticleDetailNavigationTarget } from '@/public-renderers/publicNavigationTargets';
import { buildPublicCategoryHref, buildPublicHomePaginationHref, buildPublicTagHref } from '@/public-renderers/publicRouteIdentity';
import type { CardContract, PaginationContract } from '@/ui-contracts/primitives';
import { TimeUtils, type TimeRenderOptions } from '@/utils/time';

export type PublicArticleListCardProjection = Readonly<{
    id: number;
    createTime: string;
    category: Readonly<{ id: number; name: string; }>;
    title: string;
    summary: string;
    tags: readonly Readonly<{ id: number; name: string; }>[];
}>;

export type PublicArticleListProjectionPage = Readonly<{
    items: readonly PublicArticleListCardProjection[];
    total: number;
    nextCursor?: string | null;
    hasMore?: boolean;
    decodePath: 'projection';
}>;

const DEFAULT_CATEGORY = '通用类';
const MAX_TAGS_DISPLAY = 5;

export type ArticleListCardViewContract = Readonly<{
    card: CardContract;
    id: number;
    href: string;
    title: string;
    summary: string;
    meta: Readonly<{
        isoTime: string;
        displayTime: string;
        fullTime: string;
        categoryName: string;
        categoryHref?: string;
    }>;
    tags: readonly ArticleTagViewContract[];
}>;

type ArticleTagViewContract = Readonly<{
    label: string;
    href: string;
    hiddenOnMobile?: boolean;
}>;

type ArticleListEmptyStateViewContract = Readonly<{
    title: string;
    body?: string;
}>;

export type ArticleListViewContract = Readonly<{
    items: readonly ArticleListCardViewContract[];
    pagination: PaginationContract;
    showPagination: boolean;
    emptyState: ArticleListEmptyStateViewContract;
    searchKeyword: string;
}>;

function toArticleTagView(id: number, name: string): ArticleTagViewContract
{
    return {
        label: `#${name}`,
        href: buildPublicTagHref(id),
        hiddenOnMobile: true
    };
}

export function createArticleListCardViewContract(
    article: ArticleListItemResponse | PublicArticleListCardProjection,
    index = 0,
    timeOptions?: TimeRenderOptions
): ArticleListCardViewContract
{
    const articleTarget = createPublicArticleDetailNavigationTarget(article.id);
    return {
        card: {
            kind: 'article-list-card',
            index
        },
        id: article.id,
        href: articleTarget.href,
        title: article.title,
        summary: article.summary || '',
        meta: {
            isoTime: article.createTime,
            displayTime: TimeUtils.toSmartTime(article.createTime, timeOptions),
            fullTime: TimeUtils.toFullLocalString(article.createTime, timeOptions),
            categoryName: article.category?.name || DEFAULT_CATEGORY,
            categoryHref: article.category ? buildPublicCategoryHref(article.category.id) : undefined
        },
        tags: (article.tags || []).slice(0, MAX_TAGS_DISPLAY).map((tag) => toArticleTagView(tag.id, tag.name))
    };
}

export function createArticleListViewContract(
    response: PageResponse<ArticleListItemResponse | PublicArticleListCardProjection>,
    options: {
        currentPage: number;
        pageSize: number;
        searchKeyword?: string;
        time?: TimeRenderOptions;
        pageHref?: (page: number) => string;
        canGoPrev?: boolean;
        canGoNext?: boolean;
    }
): ArticleListViewContract
{
    const total = Number(response.total) || 0;
    const currentPage = Math.max(1, options.currentPage);
    const pageSize = Math.max(1, options.pageSize);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const pageHref = options.pageHref ?? buildPublicHomePaginationHref;

    return {
        items: response.items.map((article, index) => createArticleListCardViewContract(article, index, options.time)),
        pagination: {
            previous: {
                label: '上一页',
                href: pageHref(Math.max(1, currentPage - 1)),
                disabled: options.canGoPrev === undefined ? currentPage <= 1 : !options.canGoPrev,
                action: { action: 'page-prev' }
            },
            next: {
                label: '下一页',
                href: pageHref(Math.min(totalPages, currentPage + 1)),
                disabled: options.canGoNext === undefined ? currentPage >= totalPages : !options.canGoNext,
                action: { action: 'page-next' }
            },
            indicator: `${currentPage} / ${totalPages}`
        },
        showPagination: totalPages > 1,
        emptyState: {
            title: '这里还没有文章'
        },
        searchKeyword: options.searchKeyword?.trim() ?? ''
    };
}

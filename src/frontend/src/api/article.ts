import type { BinaryRouteRequest } from '@/contracts/binaryTransport';
import { requestBinaryOnly } from '@/composition/binaryTransport';
import {
    ArticlePublishStatus,
    type ArticleDetailResponse,
    type ArticleListItemResponse,
    type ArticleRightsRequest,
    type ArticleTag,
    type ArticleWriteRequest,
    type BinaryPageResponse,
    type FeaturedArticleItem,
    type PopularArticleSummaryResponse,
    type RelatedReadingResponse
} from '@/contracts/binaryApi';
import { AEDS_ACCESS_PROFILE } from '@/generated/aedsAccessProfiles';
import { AppErrorCode, createAppError } from '@/utils/appError';
import type { PublicArticleListProjectionPage } from '@/view-contracts/articleList';

import { FrameType } from '@wasm/protocol/frame';

import { encodeAedsFrame } from './binaryFrame';


import type { ApiRequestConfig } from './requestConfig';

export { ArticlePublishStatus };
export type {
    ArticleDetailResponse,
    ArticleListItemResponse,
    ArticleRightsRequest,
    ArticleRightsResponse,
    ArticleWriteRequest,
    FeaturedArticleItem,
    PopularArticleSummaryResponse,
    RelatedReadingItemResponse,
    RelatedReadingResponse
} from '@/contracts/binaryApi';
export type Tag = ArticleTag;
export type PageResponse<T> = BinaryPageResponse<T>;

// ================= API 方法 =================

/**
 * 所有方法接受可选的 config.signal，以便调用方通过 AbortSignal 中断请求。
 */

/** 获取文章列表 */
export const getArticles = (
    params: { page?: number; size?: number; categoryId?: number; tagId?: number; keyword?: string | null; sort?: 'relevance' | 'latest' | 'hot' | null; cursor?: string | null; listKind?: 'home' | 'archive'; },
    config?: ApiRequestConfig
) =>
{
    const normalized = {
        page: params.page ?? 1,
        size: params.size ?? 10,
        categoryId: params.categoryId,
        tagId: params.tagId,
        keyword: params.keyword,
        sort: params.sort,
        cursor: params.cursor,
        listKind: params.listKind
    };

    return requestBinaryOnly<PageResponse<ArticleListItemResponse>>({
        binaryRoute: buildPublicArticleListRoute(normalized),
        frameType: FrameType.ArticleList,
        requestOptions: { },
        signal: config?.signal
    });
};

/** 获取公开首页卡片投影；不构造完整 ArticleListItemResponse。 */
export const getPublicArticleCardProjections = (
    params: { page?: number; size?: number; cursor?: string | null; },
    config?: ApiRequestConfig
): Promise<PublicArticleListProjectionPage> =>
{
    const normalized = {
        page: params.page ?? 1,
        size: params.size ?? 10,
        cursor: params.cursor,
        listKind: 'home' as const
    };
    return requestBinaryOnly<PublicArticleListProjectionPage>({
        binaryRoute: buildPublicArticleListRoute(normalized),
        frameType: FrameType.ArticleList,
        accessProfile: AEDS_ACCESS_PROFILE.publicArticleListCard,
        requestOptions: { },
        signal: config?.signal
    });
};

/** 获取详情 */
export const getArticleById = (id: number, config?: ApiRequestConfig) =>
{
    return requestBinaryOnly<ArticleDetailResponse>({
        binaryRoute: {
            operationId: 'binary_get_article_id_aeds',
            params: { id: normalizePositiveInt(id, 1) }
        },
        frameType: FrameType.ArticleDetail,
        requestOptions: { },
        signal: config?.signal
    });
};

export const getRelatedReading = (id: number, config?: ApiRequestConfig): Promise<RelatedReadingResponse> =>
{
    return requestBinaryOnly<RelatedReadingResponse>({
        binaryRoute: {
            operationId: 'binary_get_article_articleId_int_related_aeds',
            params: { articleId: normalizePositiveInt(id, 1) }
        },
        frameType: FrameType.ArticleRelatedReading,
        requestOptions: { },
        signal: config?.signal
    });
};

/** 热门排行 */
export const getHotArticles = (size = 10, config?: ApiRequestConfig) =>
{
    const count = normalizeSize(size, 10);
    return requestBinaryOnly<PopularArticleSummaryResponse[]>({
        binaryRoute: {
            operationId: 'binary_get_article_hot_size_aeds',
            params: { size: count }
        },
        frameType: FrameType.ArticleHot,
        requestOptions: { },
        signal: config?.signal
    });
};

/** 精选文章 */
export const getFeaturedArticles = (size = 3, config?: ApiRequestConfig) =>
{
    const count = normalizeSize(size, 3);
    return requestBinaryOnly<FeaturedArticleItem[]>({
        binaryRoute: {
            operationId: 'binary_get_article_featured_size_aeds',
            params: { size: count }
        },
        frameType: FrameType.ArticleFeatured,
        requestOptions: { },
        signal: config?.signal
    });
};

// ================= 管理端 =================

export const getAdminArticles = (
    params: { page?: number; size?: number; keyword?: string; categoryId?: number; tagId?: number; isDeleted?: boolean; status?: ArticlePublishStatus; },
    config?: ApiRequestConfig
) =>
{
    const search = new URLSearchParams();
    search.set('page', String(params.page ?? 1));
    search.set('size', String(params.size ?? 10));
    search.set('isDeleted', String(params.isDeleted ?? false));
    const keyword = params.keyword?.trim();
    if (keyword)
    {
        search.set('keyword', keyword);
    }
    if (params.categoryId !== undefined)
    {
        search.set('categoryId', String(params.categoryId));
    }
    if (params.tagId !== undefined)
    {
        search.set('tagId', String(params.tagId));
    }
    if (params.status !== undefined)
    {
        search.set('status', String(params.status));
    }

    return requestBinaryOnly<PageResponse<ArticleListItemResponse>>({
        binaryRoute: {
            operationId: 'binary_get_admin_article',
            query: search
        },
        frameType: FrameType.ArticleList,
        signal: config?.signal
    });
};

export const getAdminArticleById = (id: number, config?: ApiRequestConfig) =>
{
    return requestBinaryOnly<ArticleDetailResponse>({
        binaryRoute: {
            operationId: 'binary_get_admin_article_id_int',
            params: { id: normalizePositiveInt(id, 1) }
        },
        frameType: FrameType.ArticleDetail,
        signal: config?.signal
    });
};

/**
 * 创建文章
 * 创建请求必须携带 PoW 证明，以限制自动化滥用。
 */
export interface ArticleMutationResponse {
    id: number;
    articleId?: number;
    revisionId: number;
    revisionNo: number;
    releaseId: number;
    releaseNo: number;
    status: number;
    rightsSnapshotId: number;
    rightsRevisionNo: number;
    idempotencyReplay: boolean;
    outcome?: 'applied' | 'no_change';
    errorCode: number;
}

const pendingArticleMutationIds = new Map<string, string>();

export const createArticle = (data: ArticleWriteRequest & { clientMutationId?: string; }, config?: ApiRequestConfig) =>
{
    const identityKey = JSON.stringify(data, (key, value: unknown) => key === 'clientMutationId' ? undefined : value);
    const clientMutationId = data.clientMutationId ?? pendingArticleMutationIds.get(identityKey) ?? crypto.randomUUID().toLowerCase();
    pendingArticleMutationIds.set(identityKey, clientMutationId);
    const request = requestBinaryOnly<ArticleMutationResponse>({
        binaryRoute: { operationId: 'binary_post_admin_article' },
        frameType: FrameType.MutationId,
        signal: config?.signal,
        requestOptions: {
            headers: { 'X-Fsus-Client-Mutation-Id': clientMutationId },
            body: encodeAedsFrame(FrameType.ArticleWriteRequest, encodeArticleWriteRequest(data))
        }
    });
    return request.then((result) =>
    {
        pendingArticleMutationIds.delete(identityKey);
        return result;
    });
};

/**
 * 更新文章
 */
export const updateArticle = (id: number, data: ArticleWriteRequest, config?: ApiRequestConfig) =>
    requestBinaryOnly<ArticleMutationResponse>({
        binaryRoute: {
            operationId: 'binary_put_admin_article_id_int',
            params: { id }
        },
        frameType: FrameType.MutationId,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.ArticleWriteRequest, encodeArticleWriteRequest(data))
        }
    });

export const deleteArticle = (id: number, config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: {
            operationId: 'binary_delete_admin_article_id_int',
            params: { id }
        },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
        }
    });

export const restoreArticle = (id: number, config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: {
            operationId: 'binary_put_admin_article_restore_id_int',
            params: { id }
        },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
        }
    });

export const permanentDeleteArticle = (id: number, config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: {
            operationId: 'binary_delete_admin_article_permanent_id_int',
            params: { id }
        },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
        }
    });

function buildPublicArticleListRoute(params: { page: number; size: number; categoryId?: number; tagId?: number; keyword?: string | null; sort?: 'relevance' | 'latest' | 'hot' | null; cursor?: string | null; listKind?: 'home' | 'archive'; })
{
    const page = normalizePositiveInt(params.page, 1);
    const size = normalizeSize(params.size, 10);
    const hasCursor = typeof params.cursor === 'string' && params.cursor.trim().length > 0;
    if (page === 1 && hasCursor)
    {
        throw createAppError(AppErrorCode.Validation, 'article_cursor_not_allowed_on_first_page');
    }
    if (page > 1 && !hasCursor)
    {
        throw createAppError(AppErrorCode.Validation, 'article_cursor_required');
    }
    if (params.categoryId !== undefined)
    {
        return withArticleCursorQuery({
            operationId: 'binary_get_article_list_category_categoryId_page_size_aeds' as const,
            params: { categoryId: normalizePositiveInt(params.categoryId, 1), page, size }
        }, params.cursor, params.keyword, params.sort);
    }

    if (params.tagId !== undefined)
    {
        return withArticleCursorQuery({
            operationId: 'binary_get_article_list_tag_tagId_page_size_aeds' as const,
            params: { tagId: normalizePositiveInt(params.tagId, 1), page, size }
        }, params.cursor, params.keyword, params.sort);
    }

    return withArticleCursorQuery({
        operationId: params.listKind === 'archive'
            ? 'binary_get_article_list_archive_page_size_aeds' as const
            : 'binary_get_article_list_home_page_size_aeds' as const,
        params: { page, size }
    }, params.cursor, params.keyword, params.sort);
}

function withArticleCursorQuery(
    route: BinaryRouteRequest,
    cursor?: string | null,
    keyword?: string | null,
    sort?: 'relevance' | 'latest' | 'hot' | null
): BinaryRouteRequest
{
    const normalizedKeyword = keyword?.trim();
    if (!cursor && !normalizedKeyword && !sort)
    {
        return route;
    }

    const query = new URLSearchParams();
    if (cursor)
    {
        query.set('cursor', cursor);
    }
    if (normalizedKeyword)
    {
        query.set('keyword', normalizedKeyword);
    }
    if (sort)
    {
        query.set('sort', sort);
    }
    route.query = query;
    return route;
}

function normalizePositiveInt(value: number, fallback: number): number
{
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function normalizeSize(value: number, fallback: number): number
{
    const normalized = normalizePositiveInt(value, fallback);
    return Math.min(Math.max(normalized, 1), 100);
}

const ArticleWriteRequestVersion = 5;
const ArticleRightsMutationPreserve = 0;
const ArticleRightsMutationReplace = 1;
const ArticleRightsMutationReset = 2;
const RightsFlagEnabled = 1 << 0;
const RightsFlagAllowCodeCopy = 1 << 1;
const RightsFlagShowPublicBadge = 1 << 2;
const RightsFlagProofBindingEnabled = 1 << 3;
const RightsFlagHasCopyrightYear = 1 << 4;

function encodeArticleWriteRequest(data: ArticleWriteRequest): Uint8Array
{
    const encoder = new TextEncoder();
    const textParts = [
        encoder.encode(data.title ?? ''),
        encoder.encode(data.content ?? ''),
        encoder.encode(data.summary ?? ''),
        encoder.encode(data.coverImageUrl ?? '')
    ];
    const rightsMutation = resolveArticleRightsMutation(data);
    const rights = normalizeArticleRightsRequest(data.rights);
    const rightsTextParts = [
        encoder.encode(rights.licenseType),
        encoder.encode(rights.copyrightHolder),
        encoder.encode(rights.rightsStatement),
        encoder.encode(rights.attributionTemplate),
        encoder.encode(rights.copyPolicy)
    ];
    const blobLength = textParts.reduce((sum, part) => sum + part.byteLength, 0);
    const rightsBlobLength = rightsTextParts.reduce((sum, part) => sum + part.byteLength, 0);
    const tagIds = Array.isArray(data.tagIds) ? data.tagIds : [];
    const tagBytesLength = tagIds.length * 4;
    const bytes = new Uint8Array(40 + tagBytesLength + 4 + blobLength + 76 + rightsBlobLength + 8);
    const view = new DataView(bytes.buffer);

    view.setInt32(0, data.categoryId ?? 0, true);
    view.setInt32(4, tagIds.length, true);

    let blobOffset = 0;
    for (let i = 0; i < textParts.length; i += 1)
    {
        const part = textParts[i];
        const refOffset = 8 + i * 8;
        view.setInt32(refOffset, blobOffset, true);
        view.setInt32(refOffset + 4, part.byteLength, true);
        blobOffset += part.byteLength;
    }

    let cursor = 40;
    for (const tagId of tagIds)
    {
        view.setInt32(cursor, tagId, true);
        cursor += 4;
    }

    view.setInt32(cursor, blobLength, true);
    cursor += 4;
    for (const part of textParts)
    {
        bytes.set(part, cursor);
        cursor += part.byteLength;
    }

    view.setInt32(cursor, data.status ?? ArticlePublishStatus.Published, true);
    cursor += 4;
    view.setBigInt64(cursor, BigInt(toScheduledPublishAtUnixMs(data.scheduledPublishAt)), true);
    cursor += 8;
    view.setInt32(cursor, ArticleWriteRequestVersion, true);
    cursor += 4;
    view.setInt32(cursor, rightsMutation, true);
    cursor += 4;
    view.setInt32(cursor, buildRightsFlags(rights), true);
    cursor += 4;
    view.setInt32(cursor, rights.copyrightYear ?? 0, true);
    cursor += 4;
    view.setInt32(cursor, rights.maxExcerptChars, true);
    cursor += 4;

    let rightsBlobOffset = 0;
    for (const part of rightsTextParts)
    {
        view.setInt32(cursor, rightsBlobOffset, true);
        view.setInt32(cursor + 4, part.byteLength, true);
        cursor += 8;
        rightsBlobOffset += part.byteLength;
    }

    view.setInt32(cursor, rightsBlobLength, true);
    cursor += 4;
    for (const part of rightsTextParts)
    {
        bytes.set(part, cursor);
        cursor += part.byteLength;
    }

    const baseRevisionId = data.baseRevisionId == null ? 0n : BigInt(data.baseRevisionId);
    if (baseRevisionId < 0n)
    {
        throw createAppError(AppErrorCode.Validation, 'article_base_revision_invalid');
    }
    view.setBigInt64(cursor, baseRevisionId, true);

    return bytes;
}

function resolveArticleRightsMutation(data: ArticleWriteRequest): number
{
    if (data.resetRights === true)
    {
        if (data.rights != null)
        {
            throw createAppError(AppErrorCode.Validation, 'article_rights_reset_payload_conflict');
        }
        return ArticleRightsMutationReset;
    }

    return data.rights == null
        ? ArticleRightsMutationPreserve
        : ArticleRightsMutationReplace;
}

interface NormalizedArticleRightsRequest {
    enabled: boolean;
    licenseType: string;
    copyrightHolder: string;
    copyrightYear: number | null;
    rightsStatement: string;
    attributionTemplate: string;
    copyPolicy: string;
    maxExcerptChars: number;
    allowCodeCopy: boolean;
    showPublicBadge: boolean;
    proofBindingEnabled: boolean;
}

function normalizeArticleRightsRequest(value: ArticleRightsRequest | null | undefined): NormalizedArticleRightsRequest
{
    const rawCopyrightYear = value?.copyrightYear;
    const rawMaxExcerptChars = value?.maxExcerptChars;
    const copyrightYear = typeof rawCopyrightYear === 'number' && Number.isFinite(rawCopyrightYear)
        ? Math.trunc(rawCopyrightYear)
        : null;
    const maxExcerptChars = typeof rawMaxExcerptChars === 'number' && Number.isFinite(rawMaxExcerptChars)
        ? Math.max(0, Math.trunc(rawMaxExcerptChars))
        : 300;

    return {
        enabled: value?.enabled ?? true,
        licenseType: normalizeRightsToken(value?.licenseType, 'all-rights-reserved'),
        copyrightHolder: value?.copyrightHolder ?? '',
        copyrightYear,
        rightsStatement: value?.rightsStatement ?? '',
        attributionTemplate: value?.attributionTemplate ?? '',
        copyPolicy: normalizeRightsToken(value?.copyPolicy, 'append-attribution'),
        maxExcerptChars,
        allowCodeCopy: value?.allowCodeCopy ?? true,
        showPublicBadge: value?.showPublicBadge ?? true,
        proofBindingEnabled: value?.proofBindingEnabled ?? true
    };
}

function normalizeRightsToken(value: string | null | undefined, fallback: string): string
{
    return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function buildRightsFlags(value: NormalizedArticleRightsRequest): number
{
    let flags = 0;
    if (value.enabled)
    {
        flags |= RightsFlagEnabled;
    }
    if (value.allowCodeCopy)
    {
        flags |= RightsFlagAllowCodeCopy;
    }
    if (value.showPublicBadge)
    {
        flags |= RightsFlagShowPublicBadge;
    }
    if (value.proofBindingEnabled)
    {
        flags |= RightsFlagProofBindingEnabled;
    }
    if (value.copyrightYear !== null)
    {
        flags |= RightsFlagHasCopyrightYear;
    }
    return flags;
}

function toScheduledPublishAtUnixMs(value: string | null | undefined): number
{
    if (!value)
    {
        return 0;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

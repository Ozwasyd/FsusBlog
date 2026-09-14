import { normalizeFilterDescription } from '@/view-contracts/filterView';

import {
    buildPublicAboutRouteKey,
    buildPublicArchiveRouteKey,
    buildPublicArticleRouteKey,
    buildPublicCopyrightRouteKey,
    buildPublicFilterRouteKey,
    buildPublicGuidelinesRouteKey,
    buildPublicHomeRouteKey,
    buildPublicPrivacyRouteKey,
    parsePositiveInt,
    parsePublicFilterRouteKey
} from './publicRouteIdentity';

import type {
    PublicArchiveHydrationPayload,
    PublicArticleDetailHydrationPayload,
    PublicFilterHydrationPayload,
    PublicHomeHydrationPayload,
    PublicHydrationPayload,
    PublicPassiveHydrationPayload
} from './types';

export type PublicPayloadNormalizer = (payload: PublicHydrationPayload) => PublicHydrationPayload;

function normalizeRouteKey(payload: PublicHydrationPayload): string
{
    const routeKey = payload.routeKey?.trim();
    if (routeKey)
    {
        return routeKey;
    }

    switch (payload.pageKind)
    {
        case 'Home':
            return buildPublicHomeRouteKey();
        case 'ArticleDetail':
            return buildPublicArticleRouteKey(payload.articleId);
        case 'Archive':
            return buildPublicArchiveRouteKey();
        case 'Filter': {
            const filterPayload = payload.filter ?? {};
            return buildPublicFilterRouteKey({
                filterType: payload.filterType ?? filterPayload.filterType,
                filterKey: payload.filterKey ?? filterPayload.filterKey,
                filterId: payload.filterId ?? filterPayload.filterId,
                filterName: payload.filterName ?? filterPayload.filterName,
                routeKey: payload.filter?.filterKey ?? payload.routeKey,
                searchKeyword: payload.filterName ?? filterPayload.filterName
            });
        }
        case 'About':
            return buildPublicAboutRouteKey();
        case 'Privacy':
            return buildPublicPrivacyRouteKey();
        case 'Guidelines':
            return buildPublicGuidelinesRouteKey();
        case 'Copyright':
            return buildPublicCopyrightRouteKey();
        default:
            return buildPublicAboutRouteKey();
    }
}

function requireArray<T>(value: unknown, fieldName: string): readonly T[]
{
    if (!Array.isArray(value))
    {
        throw new Error(`public_aot_payload_missing_array:${fieldName}`);
    }

    return value as readonly T[];
}

function requireObject<T extends object>(value: unknown, fieldName: string): T
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error(`public_aot_payload_missing_object:${fieldName}`);
    }

    return value as T;
}

export const normalizePublicHydrationPayload: PublicPayloadNormalizer = (payload) =>
{
    const routeKey = normalizeRouteKey(payload);

    switch (payload.pageKind)
    {
        case 'Home':
            return {
                ...payload,
                routeKey,
                currentPage: Number.isFinite(payload.currentPage) && payload.currentPage > 0 ? Math.trunc(payload.currentPage) : 1,
                pageSize: Number.isFinite(payload.pageSize) && payload.pageSize > 0 ? Math.trunc(payload.pageSize) : 10,
                total: Number.isFinite(payload.total) && payload.total >= 0 ? Math.trunc(payload.total) : 0,
                featuredArticles: requireArray(payload.featuredArticles, 'Home.featuredArticles'),
                hotArticles: requireArray(payload.hotArticles, 'Home.hotArticles')
            } as PublicHomeHydrationPayload;
        case 'ArticleDetail':
            requireObject(payload.rights, 'ArticleDetail.rights');
            requireObject(payload.detailView, 'ArticleDetail.detailView');
            requireObject(payload.detailView.rights, 'ArticleDetail.detailView.rights');
            return {
                ...payload,
                routeKey,
                articleId: parsePositiveInt(payload.articleId)
            };
        case 'Archive':
            return {
                ...payload,
                routeKey,
                total: Number.isFinite(payload.total) ? Number(payload.total) : (payload.articles?.length ?? 0)
            };
        case 'Filter': {
            const filterPayload = payload.filter ?? {};
            const identity = parsePublicFilterRouteKey(
                payload.filterKey
          ?? filterPayload.filterKey
          ?? payload.routeKey
            );

            return {
                ...payload,
                routeKey,
                filterType: payload.filterType ?? filterPayload.filterType ?? identity.filterType,
                filterKey: payload.filterKey ?? filterPayload.filterKey ?? identity.filterKey,
                filterId: Number.isFinite(payload.filterId) ? Number(payload.filterId) : Number.isFinite(filterPayload.filterId) ? Number(filterPayload.filterId) : identity.filterId,
                filterName: payload.filterName ?? filterPayload.filterName ?? identity.filterName,
                isInvalidTarget: Boolean(payload.isInvalidTarget ?? filterPayload.isInvalidTarget),
                filter: {
                    ...filterPayload,
                    filterType: filterPayload.filterType ?? payload.filterType ?? identity.filterType,
                    filterKey: filterPayload.filterKey ?? payload.filterKey ?? identity.filterKey,
                    filterId: Number.isFinite(filterPayload.filterId) ? Number(filterPayload.filterId) : Number.isFinite(payload.filterId) ? Number(payload.filterId) : identity.filterId,
                    filterName: filterPayload.filterName ?? payload.filterName ?? identity.filterName,
                    description: normalizeFilterDescription(filterPayload.description),
                    isInvalidTarget: Boolean(filterPayload.isInvalidTarget ?? payload.isInvalidTarget),
                    pageIndex: Number.isFinite(filterPayload.pageIndex) && Number(filterPayload.pageIndex) > 0
                        ? Math.trunc(Number(filterPayload.pageIndex))
                        : 1,
                    pageSize: Number.isFinite(filterPayload.pageSize) && Number(filterPayload.pageSize) > 0
                        ? Math.trunc(Number(filterPayload.pageSize))
                        : 10,
                    total: Number.isFinite(filterPayload.total) && Number(filterPayload.total) >= 0
                        ? Math.trunc(Number(filterPayload.total))
                        : 0
                }
            };
        }
        case 'About':
        case 'Privacy':
        case 'Guidelines':
        case 'Copyright':
        default:
            return {
                ...payload,
                routeKey
            };
    }
};

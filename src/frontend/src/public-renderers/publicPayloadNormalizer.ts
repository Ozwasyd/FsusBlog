import type {
  PublicArchiveHydrationPayload,
  PublicArticleDetailHydrationPayload,
  PublicFilterHydrationPayload,
  PublicHomeHydrationPayload,
  PublicHydrationPayload,
  PublicPassiveHydrationPayload
} from './types';
import {
  buildPublicAboutRouteKey,
  buildPublicArchiveRouteKey,
  buildPublicArticleRouteKey,
  buildPublicFilterRouteKey,
  buildPublicHomeRouteKey,
  parsePublicFilterRouteKey
} from './publicRouteIdentity';

export type PublicPayloadNormalizer = (payload: PublicHydrationPayload) => PublicHydrationPayload;

function normalizeRouteKey(payload: PublicHydrationPayload): string {
  const routeKey = payload.routeKey?.trim();
  if (routeKey) {
    return routeKey;
  }

  switch (payload.pageKind) {
    case 'Home':
      return buildPublicHomeRouteKey();
    case 'ArticleDetail':
      return buildPublicArticleRouteKey(payload.articleId);
    case 'Archive':
      return buildPublicArchiveRouteKey();
    case 'Filter':
      return buildPublicFilterRouteKey({
        filterType: payload.filterType,
        filterKey: payload.filterKey,
        filterId: payload.filterId,
        filterName: payload.filterName,
        routeKey: payload.filter?.filterKey,
        searchKeyword: payload.filterName
      });
    case 'About':
    default:
      return buildPublicAboutRouteKey();
  }
}

export const normalizePublicHydrationPayload: PublicPayloadNormalizer = (payload) => {
  const routeKey = normalizeRouteKey(payload);

  switch (payload.pageKind) {
    case 'Home':
      return {
        ...payload,
        routeKey,
        currentPage: Number.isFinite(payload.currentPage) && payload.currentPage > 0 ? Math.trunc(payload.currentPage) : 1,
        pageSize: Number.isFinite(payload.pageSize) && payload.pageSize > 0 ? Math.trunc(payload.pageSize) : 10,
        total: Number.isFinite(payload.total) && payload.total >= 0 ? Math.trunc(payload.total) : 0
      } as PublicHomeHydrationPayload;
    case 'ArticleDetail':
      return {
        ...payload,
        routeKey,
        articleId: Number(payload.articleId) || payload.articleId
      } as PublicArticleDetailHydrationPayload;
    case 'Archive':
      return {
        ...payload,
        routeKey,
        total: Number.isFinite(payload.total) ? Number(payload.total) : (payload.articles?.length ?? 0)
      } as PublicArchiveHydrationPayload;
    case 'Filter':
      {
        const identity = parsePublicFilterRouteKey(payload.filterKey ?? payload.routeKey)
      return {
        ...payload,
        routeKey,
        filterType: payload.filterType ?? identity.filterType,
        filterKey: payload.filterKey ?? identity.filterKey,
        filterId: Number.isFinite(payload.filterId) ? Number(payload.filterId) : identity.filterId,
        filterName: payload.filterName ?? identity.filterName,
        isInvalidTarget: Boolean(payload.isInvalidTarget ?? payload.filter?.isInvalidTarget),
        filter: payload.filter
          ? {
              ...payload.filter,
              filterType: payload.filter.filterType ?? payload.filterType ?? identity.filterType,
              filterKey: payload.filter.filterKey ?? payload.filterKey ?? identity.filterKey,
              filterId: Number.isFinite(payload.filter.filterId) ? Number(payload.filter.filterId) : Number.isFinite(payload.filterId) ? Number(payload.filterId) : identity.filterId,
              filterName: payload.filter.filterName ?? payload.filterName ?? identity.filterName,
              isInvalidTarget: Boolean(payload.filter.isInvalidTarget ?? payload.isInvalidTarget),
              pageIndex: Number.isFinite(payload.filter.pageIndex) && Number(payload.filter.pageIndex) > 0
                ? Math.trunc(Number(payload.filter.pageIndex))
                : 1,
              pageSize: Number.isFinite(payload.filter.pageSize) && Number(payload.filter.pageSize) > 0
                ? Math.trunc(Number(payload.filter.pageSize))
                : 10,
              total: Number.isFinite(payload.filter.total) && Number(payload.filter.total) >= 0
                ? Math.trunc(Number(payload.filter.total))
                : 0
            }
          : payload.filter
      } as PublicFilterHydrationPayload;
      }
    case 'About':
    default:
      return {
        ...payload,
        routeKey
      } as PublicPassiveHydrationPayload;
  }
};

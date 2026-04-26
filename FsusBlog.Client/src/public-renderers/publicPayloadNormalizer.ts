import type { PublicHydrationPayload } from './types';

export type PublicPayloadNormalizer = (payload: PublicHydrationPayload) => PublicHydrationPayload;

function normalizeRouteKey(payload: PublicHydrationPayload): string {
  return payload.routeKey?.trim() || `${payload.pageKind.toLowerCase()}:unknown`;
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
      };
    case 'ArticleDetail':
      return {
        ...payload,
        routeKey,
        articleId: Number(payload.articleId) || payload.articleId
      };
    case 'Archive':
      return {
        ...payload,
        routeKey,
        total: Number.isFinite(payload.total) ? Number(payload.total) : (payload.articles?.length ?? 0)
      };
    case 'Filter':
      return {
        ...payload,
        routeKey,
        filter: payload.filter
          ? {
              ...payload.filter,
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
      };
    case 'About':
    default:
      return {
        ...payload,
        routeKey
      };
  }
};

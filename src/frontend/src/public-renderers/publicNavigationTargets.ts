import { buildPublicArticleHref } from '@/public-renderers/publicRouteIdentity';
import { PUBLIC_FIXED_PATHS } from '@/public-renderers/publicRoutePaths';
import { PUBLIC_SEO_ROUTE_NAMES } from '@/public-renderers/publicRouteRegistry';

export type PublicHomeNavigationTarget = Readonly<{
    href: typeof PUBLIC_FIXED_PATHS.home;
    route: Readonly<{
        name: typeof PUBLIC_SEO_ROUTE_NAMES.home;
    }>;
}>;

export type PublicArticleDetailNavigationTarget = Readonly<{
    href: string;
    route: Readonly<{
        name: typeof PUBLIC_SEO_ROUTE_NAMES.articleDetail;
        params: Readonly<{
            id: string;
        }>;
    }>;
}>;

function normalizePositiveRouteParam(value: number | string): string
{
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : '0';
}

export function createPublicHomeNavigationTarget(): PublicHomeNavigationTarget
{
    return {
        href: PUBLIC_FIXED_PATHS.home,
        route: {
            name: PUBLIC_SEO_ROUTE_NAMES.home
        }
    };
}

export function createPublicArticleDetailNavigationTarget(articleId: number | string): PublicArticleDetailNavigationTarget
{
    const normalizedId = normalizePositiveRouteParam(articleId);
    return {
        href: buildPublicArticleHref(normalizedId),
        route: {
            name: PUBLIC_SEO_ROUTE_NAMES.articleDetail,
            params: {
                id: normalizedId
            }
        }
    };
}

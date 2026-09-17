import {
    PUBLIC_PAGE_MANIFEST
} from '@/public-renderers/generated/publicPageManifest';
import type { PublicPageKind } from '@/public-renderers/publicRenderBase';
import {
    getPublicSeoRouteNamesByKind,
    PUBLIC_SEARCH_ROUTE_NAME,
    PUBLIC_SHELL_ONLY_ROUTE_NAMES
} from '@/public-renderers/publicRouteRegistry';
import type { PublicActiveNav } from '@/public-renderers/publicShellState';

export type { PublicPageKind } from '@/public-renderers/publicRenderBase';

type PublicPageDefinition = Readonly<{
    kind: PublicPageKind;
    routeNames: readonly string[];
    activeNav: PublicActiveNav;
}>;

type LocalPublicRouteDefinition = Readonly<{
    activeNav: PublicActiveNav;
}>;

const PUBLIC_ROUTE_DEFINITIONS = {
    Home: {
        activeNav: 'home'
    },
    ArticleDetail: {
        activeNav: 'none'
    },
    Filter: {
        activeNav: 'none'
    },
    Archive: {
        activeNav: 'archive'
    },
    About: {
        activeNav: 'about'
    },
    Privacy: {
        activeNav: 'none'
    },
    Guidelines: {
        activeNav: 'none'
    },
    Copyright: {
        activeNav: 'none'
    }
} as const satisfies Record<PublicPageKind, LocalPublicRouteDefinition>;

const SHARED_SEO_PAGE_KINDS = Object.freeze(
    Object.values(PUBLIC_PAGE_MANIFEST)
        .filter((definition) => definition.seoEligible)
        .map((definition) => definition.kind)
) as readonly PublicPageKind[];

function createPublicPageDefinition(kind: PublicPageKind): PublicPageDefinition
{
    const localDefinition = PUBLIC_ROUTE_DEFINITIONS[kind];

    return {
        kind,
        routeNames: getPublicSeoRouteNamesByKind(kind),
        activeNav: localDefinition.activeNav
    };
}

const missingLocalBindings = SHARED_SEO_PAGE_KINDS.filter((kind) => !(kind in PUBLIC_ROUTE_DEFINITIONS));
if (missingLocalBindings.length > 0)
{
    throw new Error(`publicPageModel is missing route bindings for shared SEO pages: ${missingLocalBindings.join(', ')}`);
}

const PUBLIC_PAGE_DEFINITIONS = SHARED_SEO_PAGE_KINDS.map(createPublicPageDefinition) satisfies readonly PublicPageDefinition[];

const PUBLIC_PAGE_DEFINITION_MAP = Object.freeze(
    Object.fromEntries(
        PUBLIC_PAGE_DEFINITIONS.map((definition) => [definition.kind, definition])
    ) as Record<PublicPageKind, PublicPageDefinition>
);

const PUBLIC_SHELL_ROUTE_NAMES = new Set<string>([
    ...PUBLIC_PAGE_DEFINITIONS.flatMap((definition) => definition.routeNames),
    ...PUBLIC_SHELL_ONLY_ROUTE_NAMES
]);

/**
 * Vue 路由名称 → PublicPageKind 的权威映射
 * BlogLayout 和 SSR 渲染器共用此表，新增路由只需在此维护
 */
const ROUTE_NAME_TO_PAGE_KIND: Readonly<Record<string, PublicPageKind>> = Object.freeze(
    Object.fromEntries(
        PUBLIC_PAGE_DEFINITIONS.flatMap((definition) => definition.routeNames.map((routeName) => [routeName, definition.kind]))
    ) as Record<string, PublicPageKind>
);

function getPublicPageDefinition(kind: PublicPageKind): PublicPageDefinition
{
    return PUBLIC_PAGE_DEFINITION_MAP[kind];
}

export function resolvePublicPageKind(routeName: unknown): PublicPageKind | null
{
    if (typeof routeName !== 'string')
    {
        return null;
    }

    return ROUTE_NAME_TO_PAGE_KIND[routeName] ?? null;
}

export function isPublicSeoRouteName(routeName: unknown): boolean
{
    return resolvePublicPageKind(routeName) !== null;
}

export function isPublicShellRouteName(routeName: unknown): boolean
{
    return typeof routeName === 'string' && PUBLIC_SHELL_ROUTE_NAMES.has(routeName);
}

export function isPublicSearchRouteName(routeName: unknown): routeName is typeof PUBLIC_SEARCH_ROUTE_NAME
{
    return routeName === PUBLIC_SEARCH_ROUTE_NAME;
}

/**
 * 给定页面类型，返回对应的导航高亮项
 * SSR 渲染器与 BlogLayout 共用此函数，确保两侧高亮逻辑一致
 */
export function getActiveNavForKind(kind: PublicPageKind): PublicActiveNav
{
    return getPublicPageDefinition(kind).activeNav;
}

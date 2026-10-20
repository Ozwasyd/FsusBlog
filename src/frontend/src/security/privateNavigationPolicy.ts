import type { LocationQuery, LocationQueryRaw, RouteLocationNormalizedLoaded, RouteLocationResolved, Router } from 'vue-router';

export type RouteStateClass =
  | 'public-shareable'
  | 'private-recoverable'
  | 'session-sensitive'
  | 'memory-only';

type QueryValueNormalizer = (value: unknown) => string | undefined;
type PrivateRouteQueryPolicy = Readonly<Record<string, QueryValueNormalizer>>;

function firstString(value: unknown): string | undefined
{
    const candidate: unknown = Array.isArray(value) ? value[0] : value;
    return typeof candidate === 'string' ? candidate : undefined;
}

function hasControlCharacters(value: string): boolean
{
    for (const character of value)
    {
        const code = character.charCodeAt(0);
        if (code <= 0x1f || code === 0x7f)
        {
            return true;
        }
    }
    return false;
}

function enumValue(...allowed: readonly string[]): QueryValueNormalizer
{
    const values = new Set(allowed);
    return (value) =>
    {
        const candidate = firstString(value);
        return candidate !== undefined && values.has(candidate) ? candidate : undefined;
    };
}

function positiveInteger(maximum: number): QueryValueNormalizer
{
    return (value) =>
    {
        const candidate = firstString(value);
        if (!candidate || !/^[1-9]\d*$/u.test(candidate))
        {
            return undefined;
        }
        const parsed = Number(candidate);
        return Number.isSafeInteger(parsed) && parsed <= maximum ? String(parsed) : undefined;
    };
}

function lowCardinalityToken(maximumLength = 64): QueryValueNormalizer
{
    return (value) =>
    {
        const candidate = firstString(value);
        return candidate !== undefined
      && candidate.length > 0
      && candidate.length <= maximumLength
      && /^[a-zA-Z0-9_.:-]+$/u.test(candidate)
            ? candidate
            : undefined;
    };
}

function boundedSearchText(maximumLength = 80): QueryValueNormalizer
{
    return (value) =>
    {
        const candidate = firstString(value)?.trim();
        return candidate
      && candidate.length <= maximumLength
      && !hasControlCharacters(candidate)
      && !/[<>`\\]/u.test(candidate)
            ? candidate
            : undefined;
    };
}

function isoDate(value: unknown): string | undefined
{
    const candidate = firstString(value);
    return candidate && /^\d{4}-\d{2}-\d{2}$/u.test(candidate) ? candidate : undefined;
}

const PRIVATE_ROUTE_QUERY_POLICIES = Object.freeze<Record<string, PrivateRouteQueryPolicy>>({
    UserMessage: Object.freeze({ filter: enumValue('all', 'unread', 'system', 'open', 'pending', 'closed') }),
    ManageUsers: Object.freeze({
        page: positiveInteger(100_000),
        pageSize: enumValue('10', '20', '50'),
        status: enumValue('0', '1', '2')
    }),
    ManageArticleList: Object.freeze({
        page: positiveInteger(100_000),
        size: enumValue('10', '20', '50'),
        categoryId: positiveInteger(Number.MAX_SAFE_INTEGER),
        tagId: positiveInteger(Number.MAX_SAFE_INTEGER),
        status: enumValue('0', '1', '2', '3')
    }),
    ManageModerationComments: Object.freeze({
        status: enumValue('0', '1', '2', '3'),
        q: boundedSearchText(),
        article: boundedSearchText(),
        user: boundedSearchText(),
        reason: lowCardinalityToken(),
        region: lowCardinalityToken(32),
        model: lowCardinalityToken(32),
        runtime: lowCardinalityToken(32),
        from: isoDate,
        to: isoDate
    }),
    ManageWriteArticle: Object.freeze({ preview: enumValue('private') }),
    ManageEditArticle: Object.freeze({ preview: enumValue('private') }),
    ManageModerationRegions: Object.freeze({ region: lowCardinalityToken(32) }),
    ManageAuditLog: Object.freeze({
        action: lowCardinalityToken(),
        outcome: lowCardinalityToken(32),
        severity: lowCardinalityToken(32),
        source: lowCardinalityToken(),
        type: lowCardinalityToken(),
        targetType: lowCardinalityToken()
    })
});

export const PRIVATE_NAVIGATION_ALLOWED_FIELDS = Object.freeze(
    Object.fromEntries(
        Object.entries(PRIVATE_ROUTE_QUERY_POLICIES).map(([routeName, policy]) => [
            routeName,
            Object.freeze(Object.keys(policy))
        ])
    )
) as Readonly<Record<string, readonly string[]>>;

function isPrivateRoute(route: Pick<RouteLocationNormalizedLoaded, 'path' | 'meta'>): boolean
{
    return route.path.startsWith('/user')
    || route.meta.routeState === 'private-recoverable'
    || route.meta.routeState === 'session-sensitive'
    || route.meta.routeState === 'memory-only'
    || route.meta.requiresAuth === true
    || route.meta.requiresAccountSession === true
    || route.meta.requiresAdminSession === true
    || route.meta.requiresConfirmedIdentity === true;
}

function privateFallback(route: Pick<RouteLocationNormalizedLoaded, 'path' | 'meta'>, fallback: string): string
{
    if (route.meta.accountArea === 'manage' || route.path.startsWith('/user/manage'))
    {
        return '/user/manage';
    }
    if (route.path.startsWith('/user'))
    {
        return '/user/identity';
    }
    return fallback;
}

export function sanitizePrivateRouteQuery(
    routeName: unknown,
    query: LocationQuery | LocationQueryRaw
): LocationQueryRaw
{
    const policy = typeof routeName === 'string'
        ? PRIVATE_ROUTE_QUERY_POLICIES[routeName]
        : undefined;
    if (!policy)
    {
        return {};
    }

    const sanitized: LocationQueryRaw = {};
    for (const [key, normalize] of Object.entries(policy))
    {
        const value = normalize(query[key]);
        if (value !== undefined)
        {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

export function privateQueryNeedsSanitizing(
    routeName: unknown,
    query: LocationQuery | LocationQueryRaw
): boolean
{
    const sanitized = sanitizePrivateRouteQuery(routeName, query);
    return JSON.stringify(sanitized) !== JSON.stringify(query);
}

function resolveAllowlistedPrivateTarget(
    router: Router,
    route: Pick<RouteLocationResolved, 'name' | 'path' | 'query' | 'meta'>,
    fallback: string
): string
{
    if (typeof route.name !== 'string'
    || route.meta.routeState !== 'private-recoverable'
    || route.meta.allowLoginRedirect !== true)
    {
        return privateFallback(route, fallback);
    }

    try
    {
        return router.resolve({
            name: route.name,
            query: sanitizePrivateRouteQuery(route.name, route.query),
            hash: ''
        }).fullPath;
    }
    catch
    {
    // A newly introduced dynamic route must be explicitly redesigned before it
    // can participate in login recovery. Never copy object params by default.
        return privateFallback(route, fallback);
    }
}

export function resolveSafeRedirectTarget(router: Router, target: unknown, fallback = '/'): string
{
    if (typeof target !== 'string'
    || !target.startsWith('/')
    || target.startsWith('//')
    || target.includes('\\')
    || hasControlCharacters(target))
    {
        return fallback;
    }

    const resolved = router.resolve(target);
    if (!isPrivateRoute(resolved))
    {
        return resolved.fullPath;
    }
    return resolveAllowlistedPrivateTarget(router, resolved, fallback);
}

export function sanitizeGuestRouteQuery(
    routeName: unknown,
    query: LocationQuery | LocationQueryRaw,
    router: Router
): LocationQueryRaw
{
    if (routeName !== 'Login' && routeName !== 'Register')
    {
        return {};
    }

    const redirect = resolveSafeRedirectTarget(router, firstString(query.redirect), '');
    return redirect ? { redirect } : {};
}

export function guestQueryNeedsSanitizing(
    routeName: unknown,
    query: LocationQuery | LocationQueryRaw,
    router: Router
): boolean
{
    return JSON.stringify(sanitizeGuestRouteQuery(routeName, query, router)) !== JSON.stringify(query);
}

export function buildPrivateLoginRedirect(
    route: Pick<RouteLocationResolved, 'name' | 'path' | 'query' | 'meta'>,
    router: Router
): string
{
    return resolveAllowlistedPrivateTarget(router, route, '/');
}

import type { LocaleDomain } from './localeDomains';

export type LocaleRouteDescriptor = Readonly<{
    name?: string | symbol | null;
    path: string;
    meta: Readonly<Record<string, unknown>>;
}>;

export type LocaleRoutePreparationPort = (
    domains: readonly LocaleDomain[],
    signal?: AbortSignal
) => Promise<Readonly<{
    snapshot: Readonly<{
        locale: string;
        domains: readonly LocaleDomain[];
    }>;
    commit: () => void;
    rollback: () => void;
}>>;

// The application-level SecurityChallengeDialogHost can be activated by any
// route command, so every full-app route must prepare its copy before mount.
// AccountLayout also keeps PolicyModal mounted for its header command on every
// account and admin route, so those shells must prepare auth copy as well.
// Public AOT/SSR and hydration do not mount that application-level host.
const PUBLIC_SHELL_DOMAINS = Object.freeze(['common', 'layout', 'public'] as const);
const PUBLIC_APP_DOMAINS = append(PUBLIC_SHELL_DOMAINS, 'security');
const AUTH_DOMAINS = Object.freeze(['common', 'layout', 'public', 'auth', 'errors', 'security'] as const);
const ACCOUNT_SHELL_DOMAINS = Object.freeze(['common', 'layout', 'admin', 'auth', 'errors', 'security'] as const);
const ADMIN_SHELL_DOMAINS = Object.freeze(['common', 'layout', 'admin', 'auth', 'errors', 'security'] as const);
const ERROR_DOMAINS = Object.freeze(['common', 'layout', 'errors', 'security'] as const);

function append(
    base: readonly LocaleDomain[],
    ...domains: readonly LocaleDomain[]
): readonly LocaleDomain[]
{
    return Object.freeze([...new Set([...base, ...domains])]);
}

/**
 * This is the sole route/surface-to-locale-domain authority. It deliberately
 * consumes route facts only; it does not import Router or the bundle store.
 */
export function requiredLocaleDomainsForRoute(
    route: LocaleRouteDescriptor
): readonly LocaleDomain[]
{
    const name = route.name === undefined || route.name === null ? '' : String(route.name);
    const accountArea = route.meta.accountArea;

    if (route.meta.guestOnly === true)
    {
        return AUTH_DOMAINS;
    }
    if (accountArea === 'self')
    {
        if (name === 'UserMessage')
        {
            return append(ACCOUNT_SHELL_DOMAINS, 'messages');
        }
        if (name.startsWith('UserIdentity') || name === 'UserProfile')
        {
            return name.includes('Passkey') || name.includes('Mfa')
                ? append(ACCOUNT_SHELL_DOMAINS, 'identity', 'security')
                : append(ACCOUNT_SHELL_DOMAINS, 'identity');
        }
        if (name === 'UserComments')
        {
            return append(ACCOUNT_SHELL_DOMAINS, 'article');
        }
        return ACCOUNT_SHELL_DOMAINS;
    }
    if (accountArea === 'manage')
    {
        if (name.startsWith('ManageSecurity'))
        {
            return append(ADMIN_SHELL_DOMAINS, 'security');
        }
        if (name.startsWith('ManageArticle') || name === 'ManageWriteArticle' || name === 'ManageEditArticle')
        {
            return append(ADMIN_SHELL_DOMAINS, 'article');
        }
        if (name === 'ManageMessages')
        {
            return append(ADMIN_SHELL_DOMAINS, 'messages');
        }
        if (name === 'ManageUsers')
        {
            return append(ADMIN_SHELL_DOMAINS, 'identity');
        }
        return ADMIN_SHELL_DOMAINS;
    }
    if (name === 'Forbidden' || name === 'NotFound')
    {
        return ERROR_DOMAINS;
    }
    if (name === 'ArticleDetail')
    {
        return append(PUBLIC_APP_DOMAINS, 'article');
    }
    if (name.length > 0 && route.meta.routeState === 'public-shareable')
    {
        return PUBLIC_APP_DOMAINS;
    }
    if (name === 'Home' || name === 'Archive' || name === 'About' || name === 'Privacy'
    || name === 'Guidelines' || name === 'Copyright' || name === 'Category'
    || name === 'TagById' || name === 'Tag' || name === 'Search')
    {
        return PUBLIC_APP_DOMAINS;
    }
    throw new Error(`locale_route_domains_missing:${name || route.path}`);
}

export function requiredLocaleDomainsForPublicPage(
    pageKind: 'Home' | 'ArticleDetail' | 'Archive' | 'About' | 'Privacy'
    | 'Guidelines' | 'Copyright' | 'Filter'
): readonly LocaleDomain[]
{
    return pageKind === 'ArticleDetail'
        ? append(PUBLIC_SHELL_DOMAINS, 'article')
        : PUBLIC_SHELL_DOMAINS;
}

export async function prepareLocaleRoute(
    port: LocaleRoutePreparationPort,
    route: LocaleRouteDescriptor,
    signal?: AbortSignal
): ReturnType<LocaleRoutePreparationPort>
{
    return await port(requiredLocaleDomainsForRoute(route), signal);
}

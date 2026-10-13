import {
    createMemoryHistory,
    createRouter,
    createWebHistory,
    type Router,
    type RouterHistory,
    type RouteLocationNormalized
} from 'vue-router';

import { hasServerAotShell } from '@/bootstrap/publicShellPrimitives';
import { resolveMotionScrollBehavior } from '@/composables/useMotionPreference';
import { useSessionBootstrap } from '@/composables/useSessionBootstrap';
import {
    prepareLocaleRoute,
    type LocaleRoutePreparationPort
} from '@/locales/routeLocaleDomains';
import { isPublicSearchRouteName, isPublicSeoRouteName, isPublicShellRouteName } from '@/public-renderers/publicPageModel';
import { PUBLIC_SEARCH_ROUTE_NAME } from '@/public-renderers/publicRouteRegistry';
import { normalizePublicSearchQuery } from '@/public-renderers/publicSearchRoutePolicy';
import {
    assertAccountLeafRouteMeta
} from '@/router/accountRouteMeta';
import { APP_ROUTE_RECORDS } from '@/router/appRouteRecords';
import type { PublicRoutePrewarmPort } from '@/router/publicRoutePreload';
import {
    clearPublicSearchNoIndexHead,
    clearPublicSeoHead,
    commitPublicSearchNoIndexHead,
    commitPreparedPublicSeoHead,
    hasPreparedPublicSeoHead
} from '@/router/publicSeoHead';
import { assertRouteTitleContracts } from '@/router/routeTitleContract';
import {
    buildPrivateLoginRedirect,
    guestQueryNeedsSanitizing,
    privateQueryNeedsSanitizing,
    sanitizeGuestRouteQuery,
    sanitizePrivateRouteQuery
} from '@/security/privateNavigationPolicy';
import {
    activateLocalFixtureSession,
    buildLocalFixtureAdminUrl,
    createLocalFixtureAccountSnapshot,
    createLocalFixtureAdminPrincipal,
    ensureLocalFixtureSessionCookies,
    hasCompleteFixtureCookies,
    isLocalFixtureAdminSessionActive,
    isLocalFixtureQueryEnabled,
    isLocalFixtureSessionActive,
    readFixtureStatus
} from '@/services/localFixtureSession';
import {
    hideNavigationProgress,
    showNavigationProgress
} from '@/services/navigationProgress';
import { useAdminStore } from '@/store/admin';

const PROGRESS_DELAY_MS = 120;
let progressTimer: number | undefined;
let progressVisible = false;
let progressRequestId = 0;

function scheduleProgressForSlowNavigation(): void
{
    if (typeof window === 'undefined')
    {
        return;
    }

    const requestId = ++progressRequestId;
    if (progressTimer)
    {
        window.clearTimeout(progressTimer);
    }

    progressTimer = window.setTimeout(() =>
    {
        progressTimer = undefined;
        if (requestId !== progressRequestId)
        {
            return;
        }

        progressVisible = true;
        showNavigationProgress();
    }, PROGRESS_DELAY_MS);
}

function finishProgressNavigation(): void
{
    if (typeof window === 'undefined')
    {
        return;
    }

    progressRequestId++;
    if (progressTimer)
    {
        window.clearTimeout(progressTimer);
        progressTimer = undefined;
    }

    if (progressVisible)
    {
        progressVisible = false;
        hideNavigationProgress();
    }
}

export { APP_ROUTE_RECORDS } from '@/router/appRouteRecords';

if (import.meta.env.DEV)
{
    assertAccountLeafRouteMeta(APP_ROUTE_RECORDS);
    assertRouteTitleContracts(APP_ROUTE_RECORDS);
}

export type RouterFactoryOptions = Readonly<{
    history?: RouterHistory;
    ssr?: boolean;
    prewarmPublicRoute?: PublicRoutePrewarmPort;
    prepareLocaleDomains?: LocaleRoutePreparationPort;
    getPublicActivationOwner?: () => 'aot' | 'full-app';
    /**
   * Injected progress policy for coordinator-owned Public AOT takeover.
   * Router must not import the activation composition root.
   */
    shouldSuppressNavigationProgress?: () => boolean;
}>;

function readRouteRequiredPermissions(route: RouteLocationNormalized): string[]
{
    const value = route.meta.requiredAdminPermissions;
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : [];
}

function readAccountShellRouteKey(route: RouteLocationNormalized): string | null
{
    const accountRootIndex = route.matched.findIndex((record) => record.path === '/user');
    if (accountRootIndex < 0)
    {
        return null;
    }

    // AccountLayout renders an area frame first; the frame renders this record.
    const shellRecord = route.matched[accountRootIndex + 2];
    return shellRecord?.name !== undefined ? String(shellRecord.name) : shellRecord?.path ?? null;
}

function isSameAccountShellChildSwitch(to: RouteLocationNormalized, from: RouteLocationNormalized): boolean
{
    const toShellKey = readAccountShellRouteKey(to);
    const fromShellKey = readAccountShellRouteKey(from);
    if (!toShellKey || toShellKey !== fromShellKey)
    {
        return false;
    }

    const toAccountRootIndex = to.matched.findIndex((record) => record.path === '/user');
    const fromAccountRootIndex = from.matched.findIndex((record) => record.path === '/user');
    return to.matched.length > toAccountRootIndex + 3
    || from.matched.length > fromAccountRootIndex + 3;
}

function applyRouteGuards(router: Router, options: RouterFactoryOptions = {}): void
{
    type LocaleTransaction = Awaited<ReturnType<LocaleRoutePreparationPort>>;
    type LocaleSnapshot = LocaleTransaction['snapshot'];
    let acceptedLocaleTransaction: LocaleTransaction | null = null;

    const runApplicationRouteGuard = async (
        to: RouteLocationNormalized,
        from: RouteLocationNormalized,
        preparedLocaleSnapshot?: LocaleSnapshot
    ) =>
    {
        if (isPublicSearchRouteName(to.name))
        {
            const normalized = normalizePublicSearchQuery(to.query);
            if (normalized.invalidKeyword || normalized.shouldRedirect)
            {
                return {
                    name: PUBLIC_SEARCH_ROUTE_NAME,
                    query: normalized.query,
                    hash: to.hash,
                    replace: true
                };
            }
        }

        const sessionBootstrap = useSessionBootstrap();
        const { userStore } = sessionBootstrap;
        const adminStore = useAdminStore();
        const accountRoute = to.meta.requiresAccountSession === true || to.meta.requiresAuth === true;
        const manageRoute = to.meta.requiresAdminSession === true;
        const identityRootRoute = to.path === '/user' && to.meta.requiresConfirmedIdentity === true;
        const fixtureQueryEnabled = isLocalFixtureQueryEnabled(to.query.fsusLocalFixtureLogin);
        if (!options.ssr && fixtureQueryEnabled)
        {
            activateLocalFixtureSession();
        }
        const forceLocalFixtureSession = !options.ssr && isLocalFixtureSessionActive();
        const fixtureRouteNeedsCookies = forceLocalFixtureSession && (accountRoute || manageRoute || identityRootRoute);
        const fixtureCredentialRouteNeedsCookies = forceLocalFixtureSession && Boolean(to.meta.localFixtureCredentialBootstrap);

        if (fixtureRouteNeedsCookies || fixtureCredentialRouteNeedsCookies)
        {
            const status = await readFixtureStatus();
            if ((!status || !hasCompleteFixtureCookies(status)) && !await ensureLocalFixtureSessionCookies(to.fullPath))
            {
                if (typeof window !== 'undefined')
                {
                    window.location.replace(buildLocalFixtureAdminUrl(to.fullPath));
                }
                return false;
            }

            userStore.markAuthenticated(createLocalFixtureAccountSnapshot());
            if (isLocalFixtureAdminSessionActive())
            {
                adminStore.setAdminPrincipal(createLocalFixtureAdminPrincipal());
            }
            else
            {
                adminStore.clearAdminPrincipal('missing');
            }
            sessionBootstrap.syncAuthPhase();
        }

        const nonPublicRoute = to.meta.routeState !== 'public-shareable';
        const routeQueryNeedsSanitizing = to.meta.guestOnly === true
            ? guestQueryNeedsSanitizing(to.name, to.query, router)
            : privateQueryNeedsSanitizing(to.name, to.query);
        if (nonPublicRoute && (routeQueryNeedsSanitizing || Boolean(to.hash)))
        {
            return {
                name: to.name ?? undefined,
                path: to.name ? undefined : to.path,
                params: to.params,
                query: to.meta.guestOnly === true
                    ? sanitizeGuestRouteQuery(to.name, to.query, router)
                    : sanitizePrivateRouteQuery(to.name, to.query),
                hash: '',
                // Replace an address-bar/refresh entry, but keep the previous safe
                // entry when an in-app navigation was redirected before commit.
                replace: from.matched.length === 0
            };
        }

        const publicShellRoute = isPublicShellRouteName(to.name);
        const publicSeoRoute = isPublicSeoRouteName(to.name);
        const appRoot = typeof document !== 'undefined' ? document.getElementById('app') : null;
        const shouldDeferPublicBootstrap =
            !options.ssr
      && publicSeoRoute
      && hasServerAotShell(appRoot);
        const fullAppOwnsPublicRoute =
            options.getPublicActivationOwner?.() === 'full-app'
      || (appRoot !== null && !hasServerAotShell(appRoot) && from.matched.length > 0);

        if (!options.ssr && publicSeoRoute &&
        fullAppOwnsPublicRoute && to.fullPath !== from.fullPath &&
      !hasPreparedPublicSeoHead(to.fullPath))
        {
            if (!options.prewarmPublicRoute)
            {
                window.location.assign(to.fullPath);
                return false;
            }

            const prewarm = await options.prewarmPublicRoute(to.fullPath, {
                reason: 'atomic-navigation',
                ...(preparedLocaleSnapshot ? { preparedLocaleSnapshot } : {})
            });
            if (prewarm.status !== 'ready')
            {
                window.location.assign(to.fullPath);
                return false;
            }
        }

        const suppressCoordinatorProgress = options.shouldSuppressNavigationProgress?.() === true;
        if (
            !options.ssr
      && !shouldDeferPublicBootstrap
      && !suppressCoordinatorProgress
      && !isSameAccountShellChildSwitch(to, from)
        )
        {
            scheduleProgressForSlowNavigation();
        }

        if (!options.ssr && !shouldDeferPublicBootstrap && publicShellRoute)
        {
            await sessionBootstrap.ensurePublicShell();
        }
        else if (!options.ssr && !shouldDeferPublicBootstrap && sessionBootstrap.needsBootstrap())
        {
            await sessionBootstrap.ensureBootstrap();
        }

        if (publicShellRoute)
        {
            return true;
        }

        if (to.meta.guestOnly)
        {
            await sessionBootstrap.ensureAccountSession({ reason: 'route' });
        }
        else if (manageRoute || identityRootRoute)
        {
            if (forceLocalFixtureSession)
            {
                userStore.markAuthenticated(createLocalFixtureAccountSnapshot());
                if (isLocalFixtureAdminSessionActive())
                {
                    adminStore.setAdminPrincipal(createLocalFixtureAdminPrincipal());
                }
                else
                {
                    adminStore.clearAdminPrincipal('missing');
                }
                sessionBootstrap.syncAuthPhase();
            }
            else
            {
                await Promise.all([
                    sessionBootstrap.ensureAccountSession({ reason: 'route' }),
                    sessionBootstrap.ensureAdminSession({ reason: 'route' })
                ]);
            }
        }
        else if (accountRoute)
        {
            await sessionBootstrap.ensureAccountSession({ reason: 'route' });
        }

        const { isLoggedIn } = userStore;

        if (to.meta.guestOnly && isLoggedIn)
        {
            return adminStore.adminState === 'active' ? '/user/manage' : '/user/identity';
        }

        if (accountRoute && !isLoggedIn)
        {
            return { path: '/login', query: { redirect: buildPrivateLoginRedirect(to, router) } };
        }

        if (manageRoute)
        {
            if (adminStore.adminState !== 'active')
            {
                return isLoggedIn
                    ? '/403'
                    : { path: '/login', query: { redirect: buildPrivateLoginRedirect(to, router) } };
            }

            const requiredPermissions = readRouteRequiredPermissions(to);
            if (requiredPermissions.length === 0
        || !requiredPermissions.every((permission) => adminStore.hasPermission(permission)))
            {
                return '/403';
            }
        }

        if (identityRootRoute)
        {
            if (adminStore.adminState === 'active')
            {
                return '/user/manage';
            }
            if (isLoggedIn)
            {
                return '/user/identity';
            }
            return { path: '/login', query: { redirect: buildPrivateLoginRedirect(to, router) } };
        }

        return true;
    };

    router.beforeEach(async (to, from) =>
    {
        if (!options.prepareLocaleDomains)
        {
            return await runApplicationRouteGuard(to, from);
        }

        const transaction = await prepareLocaleRoute(options.prepareLocaleDomains, to);
        try
        {
            const result = await runApplicationRouteGuard(to, from, transaction.snapshot);
            if (result !== true && result !== undefined)
            {
                transaction.rollback();
                return result;
            }
            acceptedLocaleTransaction = transaction;
            return result;
        }
        catch (error)
        {
            transaction.rollback();
            throw error;
        }
    });

    if (options.ssr)
    {
        return;
    }

    router.afterEach((to, from, failure) =>
    {
        const localeTransaction = acceptedLocaleTransaction;
        if (localeTransaction)
        {
            acceptedLocaleTransaction = null;
            if (failure)
            {
                localeTransaction.rollback();
            }
            else
            {
                localeTransaction.commit();
            }
        }

        if (isPublicSeoRouteName(to.name))
        {
            if (hasPreparedPublicSeoHead(to.fullPath))
            {
                commitPreparedPublicSeoHead(to.fullPath, from.fullPath);
            }
        }
        else if (isPublicSearchRouteName(to.name))
        {
            commitPublicSearchNoIndexHead(isPublicSeoRouteName(from.name) ? from.fullPath : undefined);
        }
        else if (isPublicSeoRouteName(from.name))
        {
            clearPublicSeoHead(from.fullPath);
        }
        if (!failure && !isPublicSeoRouteName(to.name))
        {
            useSessionBootstrap().syncDocumentTitle(to);
        }
        if (!isPublicSearchRouteName(to.name))
        {
            clearPublicSearchNoIndexHead();
        }
        finishProgressNavigation();
    });

    router.onError(() =>
    {
        acceptedLocaleTransaction?.rollback();
        acceptedLocaleTransaction = null;
        finishProgressNavigation();
    });
}

export function createAppRouter(options: RouterFactoryOptions = {}): Router
{
    const baseUrl = import.meta.env?.BASE_URL ?? '/';
    const history = options.history ?? (
    options.ssr
        ? createMemoryHistory(baseUrl)
        : createWebHistory(baseUrl)
    );

    const router = createRouter({
        history,
        routes: APP_ROUTE_RECORDS,
        scrollBehavior: (to, _from, savedPosition) =>
        {
            if (savedPosition)
            {
                return savedPosition;
            }

            if (to.hash === '#top')
            {
                return { left: 0, top: 0, behavior: 'auto' };
            }

            if (to.hash)
            {
                return {
                    el: to.hash,
                    top: 88,
                    behavior: resolveMotionScrollBehavior()
                };
            }

            return { left: 0, top: 0, behavior: 'auto' };
        }
    });

    applyRouteGuards(router, options);
    return router;
}

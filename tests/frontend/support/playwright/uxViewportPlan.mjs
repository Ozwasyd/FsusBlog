/**
 * @typedef {import('./acceptance-shared.js').UxViewport} UxViewport
 * @typedef {import('./acceptance-shared.js').UxViewportMatrix} UxViewportMatrix
 * @typedef {import('./acceptance-shared.js').UxViewportMode} UxViewportMode
 * @typedef {import('./acceptance-shared.js').UxSafeAreaProfile} UxSafeAreaProfile
 * @typedef {import('./acceptance-shared.js').UxViewportMediaMode} UxViewportMediaMode
 * @typedef {import('./acceptance-shared.js').ThemeMode} ThemeMode
 * @typedef {{ id: string; storage: 'anonymous' | 'user' | 'admin'; }} ViewportRoute
 * @typedef {{ routeIds?: string | readonly string[]; themes?: string | readonly string[]; viewportIds?: string | readonly string[]; media?: string | readonly string[]; riskMatrix?: boolean; skipSafeArea?: boolean; safeAreaSurfaceIds?: string | readonly string[]; safeAreaProfileIds?: string | readonly string[]; safeAreaBrowsers?: string | readonly string[]; }} UxViewportFilters
 * @typedef {{ id: string; routeId: string; theme: ThemeMode; viewportId: string; media: UxViewportMediaMode; screenshot: boolean; safeArea?: boolean; profileId?: string; surfaceId?: string; browser?: string; open?: string; }} UxViewportStep
 * @template {ViewportRoute} [R=ViewportRoute]
 * @typedef {{ id: string; kind: 'route-theme' | 'safe-area'; route: R; theme: ThemeMode; storage: R['storage']; browser?: string; surface?: { id: string; surface: string; open: string; overlayRisk: true; }; profile?: UxSafeAreaProfile; viewports: { id: string; viewport: UxViewport; steps: UxViewportStep[]; }[]; }} UxViewportGroup
 * @template {ViewportRoute} [R=ViewportRoute]
 * @typedef {{ version: string; matrixVersion: string; safeAreaVersion: string | null; mode: UxViewportMode; groups: UxViewportGroup<R>[]; selection: { routeIds: string[]; themes: ThemeMode[]; viewportIds: string[]; media: UxViewportMediaMode[]; safeAreaProfileIds: string[]; safeAreaSurfaceIds: string[]; safeAreaBrowsers: string[]; safeAreaCaseIds: string[]; }; counts: { routes: number; routeThemeGroups: number; safeAreaGroups: number; navigations: number; cases: number; safeAreaCases: number; }; fingerprint: string; }} UxViewportPlan
 * @typedef {UxViewportStep & { groupId: string; navigationId: string; kind: 'route-theme' | 'safe-area'; }} UxViewportCase
 */

import { createHash } from 'node:crypto';

const UX_VIEWPORT_PLAN_VERSION = 'fsusblog-ux-viewport-plan-v1';
const FULL_MEDIA_ROUTE_IDS = new Set([
    'public-article',
    'public-login',
    'user-profile',
    'user-messagebox',
    'manage-write',
    'manage-users'
]);

export const UX_VIEWPORT_MOBILE_LANDSCAPE_CANARY_ROUTE_IDS = Object.freeze([
    'public-home',
    'user-profile',
    'manage-dashboard',
    'manage-audit',
    'manage-settings'
]);

export const UX_VIEWPORT_MODEL_ROUTE_IDS = Object.freeze([
    'public-home', 'public-article', 'public-archive', 'public-about', 'public-privacy',
    'public-guidelines', 'public-copyright', 'public-category', 'public-tag', 'public-search',
    'public-login', 'public-register', 'public-forbidden', 'public-not-found',
    'public-anon-user-redirect', 'public-anon-manage-redirect', 'user-profile', 'user-comments',
    'user-messagebox', 'user-login-redirect', 'manage-dashboard', 'manage-write', 'manage-edit',
    'manage-list', 'manage-trash', 'manage-category', 'manage-tag', 'manage-settings',
    'manage-users', 'manage-message', 'manage-audit', 'manage-user-profile', 'manage-login-redirect'
]);

export const UX_SAFE_AREA_ASSERTION_NAMES = Object.freeze([
    'assertScrimCoversViewport',
    'assertControlsInsideSafeRect',
    'assertOverlayActionsReachable',
    'assertNoBodyOverflowLeak',
    'assertOverlayCloseRestoresFocusAndScroll'
]);

/**
 * @template {ViewportRoute} R
 * @param {{ matrix: UxViewportMatrix; routes: readonly R[]; mode: UxViewportMode; filters?: UxViewportFilters; }} options
 * @returns {UxViewportPlan<R>}
 */
export function buildUxViewportPlan({ matrix, routes, mode, filters = {} })
{
    const config = matrix?.modes?.[mode];
    if (!config)
    {
        throw new Error(`unknown UX viewport mode: ${String(mode)}`);
    }

    const uniqueRoutes = indexUnique(routes, (route) => route.id, 'route');
    const uniqueViewports = indexUnique(matrix.viewports, (viewport) => viewport.name, 'viewport');
    const modeRoutes = config.routes === 'all'
        ? [...uniqueRoutes.values()]
        : config.routes.map((routeId) => requireEntry(uniqueRoutes, routeId, `mode ${mode} route`));
    const modeViewports = config.viewports.map((viewportId) => (
        requireEntry(uniqueViewports, viewportId, `mode ${mode} viewport`)
    ));

    const selectedRoutes = selectKnown(modeRoutes, (route) => route.id, filters.routeIds, 'route', true);
    const selectedThemes = selectKnown(config.themes, (theme) => theme, filters.themes, 'theme');
    const selectedViewports = selectKnown(modeViewports, (viewport) => viewport.name, filters.viewportIds, 'viewport');
    const selectedMedia = selectKnown(config.media, (media) => media, filters.media, 'media');

    let groups = [];
    for (const route of selectedRoutes)
    {
        const routeMedia = mediaForRoute(mode, route.id, selectedMedia);
        if (routeMedia.length === 0)
        {
            continue;
        }

        for (const theme of selectedThemes)
        {
            const groupId = `route-theme:${route.id}:${theme}`;
            groups.push({
                id: groupId,
                kind: 'route-theme',
                route,
                theme,
                storage: route.storage,
                viewports: selectedViewports.map((viewport) => ({
                    id: `navigation:${route.id}:${theme}:${viewport.name}`,
                    viewport,
                    steps: routeMedia.map((media) => ({
                        id: `case:${route.id}:${theme}:${viewport.name}:${media}`,
                        routeId: route.id,
                        theme,
                        viewportId: viewport.name,
                        media,
                        screenshot: config.screenshots === true && media === 'default'
                    }))
                }))
            });
        }
    }

    if (filters.riskMatrix === true)
    {
        if (mode !== 'boundaries')
        {
            throw new Error('UX viewport risk matrix requires boundaries mode');
        }
        groups = buildRiskGroups({ selectedRoutes, selectedThemes, selectedViewports, selectedMedia });
    }

    const safeAreaGroups = filters.skipSafeArea === true
        ? []
        : buildSafeAreaGroups({
        matrix,
        routes: uniqueRoutes,
        mode,
        filters
      });

    groups = [...groups, ...safeAreaGroups];

    if (groups.length === 0)
    {
        throw new Error(`UX viewport plan ${mode} is empty after applying filters`);
    }

    const cases = groups.reduce((total, group) => (
        total + group.viewports.reduce((subtotal, viewport) => subtotal + viewport.steps.length, 0)
    ), 0);
    const safeAreaCases = listUxViewportSafeAreaCases({ groups: safeAreaGroups });
    const plan = {
        version: UX_VIEWPORT_PLAN_VERSION,
        matrixVersion: matrix.version,
        safeAreaVersion: matrix.safeArea?.version ?? null,
        mode,
        groups,
        selection: {
            routeIds: [...new Set(groups.filter((group) => group.kind !== 'safe-area').map((group) => group.route.id))],
            themes: filters.riskMatrix === true
                ? [...selectedThemes]
                : [...new Set(groups.filter((group) => group.kind !== 'safe-area').map((group) => group.theme))],
            viewportIds: filters.riskMatrix === true
                ? selectedViewports.map((viewport) => viewport.name)
                : [...new Set(groups.filter((group) => group.kind !== 'safe-area').flatMap((group) => (
            group.viewports.map((viewport) => viewport.viewport.name)
          )))],
            media: filters.riskMatrix === true
                ? [...selectedMedia]
                : [...new Set(groups.filter((group) => group.kind !== 'safe-area').flatMap((group) => (
            group.viewports.flatMap((viewport) => viewport.steps.map((step) => step.media))
          )))],
            safeAreaProfileIds: [...new Set(safeAreaCases.map((entry) => entry.profileId))],
            safeAreaSurfaceIds: [...new Set(safeAreaCases.map((entry) => entry.surfaceId))],
            safeAreaBrowsers: [...new Set(safeAreaCases.map((entry) => entry.browser))],
            safeAreaCaseIds: safeAreaCases.map((entry) => entry.id)
        },
        counts: {
            routes: new Set(groups.filter((group) => group.kind !== 'safe-area').map((group) => group.route.id)).size,
            routeThemeGroups: groups.filter((group) => group.kind !== 'safe-area').length,
            safeAreaGroups: safeAreaGroups.length,
            navigations: groups.reduce((total, group) => total + group.viewports.length, 0),
            cases,
            safeAreaCases: safeAreaCases.length
        }
    };

    return {
        ...plan,
        fingerprint: createHash('sha256')
            .update(JSON.stringify(fingerprintPayload(plan)))
            .digest('hex')
    };
}

/**
 * @template {ViewportRoute} R
 * @param {{ matrix: UxViewportMatrix; routes: Map<string, R> | Record<string, R>; mode: UxViewportMode; filters?: UxViewportFilters; }} options
 * @returns {UxViewportGroup<R>[]}
 */
export function buildSafeAreaGroups({ matrix, routes, mode, filters = {} })
{
    const safeArea = matrix?.safeArea;
    if (!safeArea)
    {
        return [];
    }

    validateSafeAreaMatrix(safeArea);

    const surfaces = safeArea.overlayRiskSurfaces ?? [];
    const nonOverlay = surfaces.filter((surface) => surface.overlayRisk !== true);
    if (nonOverlay.length > 0)
    {
        throw new Error(
            `safe-area surfaces must set overlayRisk=true: ${nonOverlay.map((item) => item.id).join(', ')}`
        );
    }

    const requestedSurfaces = filters.safeAreaSurfaceIds
        ? new Set(normalizeFilter(filters.safeAreaSurfaceIds))
        : null;
    const requestedProfiles = filters.safeAreaProfileIds
        ? new Set(normalizeFilter(filters.safeAreaProfileIds))
        : null;
    const requestedBrowsers = filters.safeAreaBrowsers
        ? new Set(normalizeFilter(filters.safeAreaBrowsers))
        : null;

    const groups = [];
    for (const surface of surfaces)
    {
        if (requestedSurfaces && !requestedSurfaces.has(surface.id))
        {
            continue;
        }

        const profiles = surface.profilesByMode?.[mode] ?? [];
        const browsers = surface.browsersByMode?.[mode] ?? [];
        const themes = surface.themesByMode?.[mode] ?? ['light'];
        if (profiles.length === 0 || browsers.length === 0 || themes.length === 0)
        {
            continue;
        }

        const route = requireEntry(routes, surface.routeId, `safe-area surface ${surface.id} route`);
        for (const profileId of profiles)
        {
            if (requestedProfiles && !requestedProfiles.has(profileId))
            {
                continue;
            }
            const profile = safeArea.profiles?.[profileId];
            if (!profile)
            {
                throw new Error(`unknown safe-area profile for surface ${surface.id}: ${profileId}`);
            }
            for (const theme of themes)
            {
                for (const browser of browsers)
                {
                    if (requestedBrowsers && !requestedBrowsers.has(browser))
                    {
                        continue;
                    }
                    const groupId = `safe-area:${surface.id}:${profileId}:${theme}:${browser}`;
                    groups.push({
                        id: groupId,
                        kind: 'safe-area',
                        route,
                        theme,
                        storage: route.storage,
                        browser,
                        surface: {
                            id: surface.id,
                            surface: surface.surface,
                            open: surface.open,
                            overlayRisk: true
                        },
                        profile: {
                            id: profile.id,
                            viewport: { ...profile.viewport },
                            insets: { ...profile.insets }
                        },
                        viewports: [{
                            id: `navigation:${groupId}`,
                            viewport: {
                                name: `safe-area:${profile.id}`,
                                width: profile.viewport.width,
                                height: profile.viewport.height,
                                category: 'safe-area-profile',
                                useInAcceptance: false,
                                useInPublicVisual: false,
                                useInConsoleVisual: false,
                                screenshotBaseline: false,
                                prSmoke: mode === 'smoke',
                                visualBoundary: mode === 'visual',
                                boundaryFull: mode === 'boundaries'
                            },
                            steps: [{
                                id: `case:${groupId}`,
                                routeId: route.id,
                                theme,
                                viewportId: `safe-area:${profile.id}`,
                                media: 'default',
                                screenshot: false,
                                safeArea: true,
                                profileId: profile.id,
                                surfaceId: surface.id,
                                browser,
                                open: surface.open
                            }]
                        }]
                    });
                }
            }
        }
    }

    // Fail closed: safe-area must never cartesian-explode with full route×viewport×media.
    const maxByMode = { smoke: 8, visual: 24, boundaries: 40 };
    const limit = maxByMode[mode] ?? 40;
    if (groups.length > limit)
    {
        throw new Error(
            `safe-area plan for ${mode} exploded to ${groups.length} groups (limit ${limit}); keep overlay-risk only`
        );
    }

    return groups;
}

/**
 * @param {{ groups: readonly UxViewportGroup[]; }} plan
 * @returns {UxViewportCase[]}
 */
export function listUxViewportCases(plan)
{
    return plan.groups.flatMap((group) => (
        group.viewports.flatMap((viewport) => viewport.steps.map((step) => ({
            ...step,
            groupId: group.id,
            navigationId: viewport.id,
            kind: group.kind ?? 'route-theme'
        })))
    ));
}

/**
 * @param {{ groups: readonly UxViewportGroup[]; }} plan
 * @returns {UxViewportCase[]}
 */
export function listUxViewportSafeAreaCases(plan)
{
    return listUxViewportCases(plan).filter((entry) => entry.safeArea === true || entry.kind === 'safe-area');
}

/**
 * @param {UxSafeAreaProfile} profile
 * @returns {Record<'--fsus-safe-area-inset-top' | '--fsus-safe-area-inset-right' | '--fsus-safe-area-inset-bottom' | '--fsus-safe-area-inset-left' | '--fsus-viewport-block-size', string>}
 */
export function safeAreaProfileCssOverrides(profile)
{
    return {
        '--fsus-safe-area-inset-top': `${profile.insets.top}px`,
        '--fsus-safe-area-inset-right': `${profile.insets.right}px`,
        '--fsus-safe-area-inset-bottom': `${profile.insets.bottom}px`,
        '--fsus-safe-area-inset-left': `${profile.insets.left}px`,
        '--fsus-viewport-block-size': `${profile.viewport.height}px`
    };
}

/**
 * @param {UxSafeAreaProfile} profile
 * @returns {{ left: number; top: number; right: number; bottom: number; width: number; height: number; }}
 */
export function safeRectFromProfile(profile)
{
    return {
        left: profile.insets.left,
        top: profile.insets.top,
        right: profile.viewport.width - profile.insets.right,
        bottom: profile.viewport.height - profile.insets.bottom,
        width: profile.viewport.width - profile.insets.left - profile.insets.right,
        height: profile.viewport.height - profile.insets.top - profile.insets.bottom
    };
}

/**
 * @param {NonNullable<UxViewportMatrix['safeArea']>} safeArea
 * @returns {void}
 */
export function validateSafeAreaMatrix(safeArea)
{
    if (!safeArea || typeof safeArea !== 'object')
    {
        throw new Error('safe-area matrix section is required for #1789 integration');
    }
    if (safeArea.version !== 'fsusblog-ux-safe-area-v1')
    {
        throw new Error(`unexpected safe-area version: ${String(safeArea.version)}`);
    }

    const requiredProfiles = ['zero-inset', 'portrait-notch', 'landscape-notch', 'short-visual'];
    for (const profileId of requiredProfiles)
    {
        const profile = safeArea.profiles?.[profileId];
        if (!profile?.viewport || !profile?.insets)
        {
            throw new Error(`safe-area profile missing: ${profileId}`);
        }
    }

    const zero = safeArea.profiles['zero-inset'];
    const portrait = safeArea.profiles['portrait-notch'];
    const landscape = safeArea.profiles['landscape-notch'];
    const shortVisual = safeArea.profiles['short-visual'];
    assertProfileShape(zero, 390, 844, 0, 0, 0, 0);
    assertProfileShape(portrait, 390, 844, 47, 0, 34, 0);
    assertProfileShape(landscape, 844, 390, 0, 59, 21, 59);
    assertProfileShape(shortVisual, 390, 430, 47, 0, 34, 0);

    const surfaces = safeArea.overlayRiskSurfaces ?? [];
    if (surfaces.length === 0)
    {
        throw new Error('safe-area overlayRiskSurfaces must not be empty');
    }
    for (const surface of surfaces)
    {
        if (surface.overlayRisk !== true)
        {
            throw new Error(`surface ${surface.id} must mark overlayRisk=true`);
        }
        if (!surface.routeId || !surface.open || !surface.id)
        {
            throw new Error(`surface ${String(surface.id)} is missing routeId/open/id`);
        }
    }

    for (const name of UX_SAFE_AREA_ASSERTION_NAMES)
    {
        if (!(safeArea.assertions ?? []).includes(name))
        {
            throw new Error(`safe-area assertions must include ${name}`);
        }
    }
}

function assertProfileShape(profile, width, height, top, right, bottom, left)
{
    if (
        profile.viewport.width !== width
    || profile.viewport.height !== height
    || profile.insets.top !== top
    || profile.insets.right !== right
    || profile.insets.bottom !== bottom
    || profile.insets.left !== left
    )
    {
        throw new Error(`safe-area profile ${profile.id} does not match the #1789 fixture table`);
    }
}

function buildRiskGroups({ selectedRoutes, selectedThemes, selectedViewports, selectedMedia })
{
    const routesById = new Map(selectedRoutes.map((route) => [route.id, route]));
    const anchors = ['public-article', 'user-profile', 'manage-users'].map((routeId) => (
        requireEntry(routesById, routeId, 'risk matrix route')
    ));
    const groups = new Map();
    for (const [viewportIndex, viewport] of selectedViewports.entries())
    {
        for (const [themeIndex, theme] of selectedThemes.entries())
        {
            const route = anchors[(viewportIndex * selectedThemes.length + themeIndex) % anchors.length];
            const groupId = `route-theme:${route.id}:${theme}`;
            const group = groups.get(groupId) ?? {
                id: groupId,
                kind: 'route-theme',
                route,
                theme,
                storage: route.storage,
                viewports: []
            };
            group.viewports.push({
                id: `navigation:${route.id}:${theme}:${viewport.name}`,
                viewport,
                steps: selectedMedia.map((media) => ({
                    id: `case:${route.id}:${theme}:${viewport.name}:${media}`,
                    routeId: route.id,
                    theme,
                    viewportId: viewport.name,
                    media,
                    screenshot: media === 'default'
                }))
            });
            groups.set(groupId, group);
        }
    }
    return [...groups.values()];
}

function mediaForRoute(mode, routeId, selectedMedia)
{
    if (mode === 'boundaries' || FULL_MEDIA_ROUTE_IDS.has(routeId))
    {
        return selectedMedia;
    }
    return selectedMedia.filter((media) => media === 'default');
}

function selectKnown(entries, identify, requestedValues, label, preserveRequestedOrder = false)
{
    if (requestedValues === undefined || requestedValues === null)
    {
        return [...entries];
    }

    const requested = normalizeFilter(requestedValues);
    const known = new Set(entries.map(identify));
    const unknown = requested.filter((value) => !known.has(value));
    if (unknown.length > 0)
    {
        throw new Error(`unknown UX viewport filter ${label}: ${unknown.join(', ')}`);
    }

    if (preserveRequestedOrder)
    {
        const indexed = new Map(entries.map((entry) => [identify(entry), entry]));
        return requested.map((value) => indexed.get(value));
    }

    const selected = new Set(requested);
    return entries.filter((entry) => selected.has(identify(entry)));
}

function normalizeFilter(values)
{
    const normalized = typeof values === 'string' ? values.split(',') : [...values];
    return [...new Set(normalized.map((value) => String(value).trim()).filter(Boolean))];
}

function indexUnique(entries, identify, label)
{
    const indexed = new Map();
    for (const entry of entries ?? [])
    {
        const id = identify(entry);
        if (!id || indexed.has(id))
        {
            throw new Error(`invalid or duplicate UX viewport ${label}: ${String(id)}`);
        }
        indexed.set(id, entry);
    }
    return indexed;
}

function requireEntry(entries, id, label)
{
    const entry = entries instanceof Map ? entries.get(id) : entries?.[id];
    if (!entry)
    {
    // routes may be a Map from indexUnique, or an object
        if (entries instanceof Map)
        {
            throw new Error(`unknown UX viewport ${label}: ${id}`);
        }
        throw new Error(`unknown UX viewport ${label}: ${id}`);
    }
    return entry;
}

function fingerprintPayload(plan)
{
    return {
        version: plan.version,
        matrixVersion: plan.matrixVersion,
        safeAreaVersion: plan.safeAreaVersion,
        mode: plan.mode,
        groups: plan.groups.map((group) => ({
            id: group.id,
            kind: group.kind ?? 'route-theme',
            storage: group.storage,
            browser: group.browser ?? null,
            surface: group.surface ?? null,
            profile: group.profile ?? null,
            route: {
                id: group.route.id,
                path: group.route.path,
                expectedUrl: group.route.expectedUrl,
                expectedQuery: group.route.expectedQuery,
                allowQuery: group.route.allowQuery,
                injectCorpus: group.route.injectCorpus,
                screenshotSelector: group.route.screenshotSelector
            },
            viewports: group.viewports.map((viewport) => ({
                id: viewport.id,
                width: viewport.viewport.width,
                height: viewport.viewport.height,
                steps: viewport.steps.map((step) => step.id)
            }))
        }))
    };
}

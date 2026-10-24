/**
 * @typedef {Readonly<{ family: string; representativeText: string; weights: readonly number[]; }>} ExpectedFontReadiness
 * @typedef {Readonly<{ family: string; status: 'unloaded' | 'loading' | 'loaded' | 'error'; style: string; weight: string; }>} FontFaceReadinessSnapshot
 * @typedef {Readonly<{
 *   errorFacesAfterProbe: readonly FontFaceReadinessSnapshot[]; errorFacesBeforeProbe: readonly FontFaceReadinessSnapshot[];
 *   families: readonly Readonly<{ family: string; facesBeforeProbe: readonly FontFaceReadinessSnapshot[]; loadedWeightsBeforeProbe: readonly number[]; probes: readonly Readonly<{ check: boolean; loadedCount: number; query: string; weight: number; }>[]; representativeText: string; }>[];
 *   fontSetStatusAfterProbe: 'loading' | 'loaded'; fontSetStatusBeforeProbe: 'loading' | 'loaded';
 * }>} FontLoadingReadinessReport
 */

/* global caches, document, HTMLElement, requestAnimationFrame, window */

const DEFAULT_READINESS_TIMEOUT_MS = 45_000;

function readinessError(description, timeoutMs, error)
{
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(
        `Browser readiness condition "${description}" was not satisfied within ${timeoutMs}ms: ${detail}`,
        { cause: error }
    );
}

/**
 * @template [T=void]
 * @param {import('@playwright/test').Page} page
 * @param {{ description: string; predicate: (argument: T) => unknown | Promise<unknown>; argument?: T; timeoutMs?: number; }} options
 * @returns {Promise<void>}
 */
export async function waitForObservableReadiness(page, {
    description,
    predicate,
    argument,
    timeoutMs = DEFAULT_READINESS_TIMEOUT_MS
})
{
    try
    {
        await page.waitForFunction(predicate, argument, { timeout: timeoutMs });
    }
    catch (error)
    {
        throw readinessError(description, timeoutMs, error);
    }
}

export function applicationReadyPredicate()
{
    const app = document.querySelector('#app');
    if (!(app instanceof HTMLElement) || document.readyState !== 'complete')
    {
        return false;
    }
    const style = window.getComputedStyle(app);
    const rect = app.getBoundingClientRect();
    const loader = document.getElementById('global-loader');
    return style.display !== 'none'
    && style.visibility !== 'hidden'
    && Number(style.opacity || '1') > 0
    && rect.width > 0
    && rect.height > 0
    && (!loader || loader.hidden);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ description?: string; timeoutMs?: number; }} [options]
 * @returns {Promise<void>}
 */
export async function waitForApplicationReady(page, {
    description = 'application root is visible and runtime startup is complete',
    timeoutMs = DEFAULT_READINESS_TIMEOUT_MS
} = {})
{
    await waitForObservableReadiness(page, {
        description,
        timeoutMs,
        predicate: applicationReadyPredicate
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ timeoutMs?: number; }} [options]
 * @returns {Promise<void>}
 */
export async function waitForPublicHydration(page, {
    timeoutMs = DEFAULT_READINESS_TIMEOUT_MS
} = {})
{
    await waitForObservableReadiness(page, {
        description: 'public shell hydration marker is true',
        timeoutMs,
        predicate: () => document.querySelector('#fsus-aot-shell')
            ?.getAttribute('data-public-hydrated') === 'true'
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} expectedPath
 * @param {{ content?: import('@playwright/test').Locator; timeoutMs?: number; }} [options]
 * @returns {Promise<void>}
 */
export async function waitForSpaRoute(page, expectedPath, {
    content,
    timeoutMs = DEFAULT_READINESS_TIMEOUT_MS
} = {})
{
    try
    {
        await page.waitForURL((url) => url.pathname === expectedPath, { timeout: timeoutMs });
        if (content)
        {
            await content.waitFor({ state: 'visible', timeout: timeoutMs });
        }
    }
    catch (error)
    {
        throw readinessError(
            `SPA route ${expectedPath}${content ? ' and its route content are visible' : ' is active'}`,
            timeoutMs,
            error
        );
    }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ cachePrefix?: string; requireShellCache?: boolean; timeoutMs?: number; }} [options]
 * @returns {Promise<void>}
 */
export async function waitForServiceWorkerCacheReady(page, {
    cachePrefix = 'fsus-',
    requireShellCache = false,
    timeoutMs = DEFAULT_READINESS_TIMEOUT_MS
} = {})
{
    await waitForObservableReadiness(page, {
        description: `service worker controls the page and cache names use ${cachePrefix}`,
        timeoutMs,
        argument: { cachePrefix, requireShellCache },
        predicate: async ({ cachePrefix: prefix, requireShellCache: requireShell }) =>
        {
            if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller)
            {
                return false;
            }
            await navigator.serviceWorker.ready;
            const names = await caches.keys();
            return names.length > 0
        && names.every((name) => name.startsWith(prefix))
        && (!requireShell || names.some((name) => name.includes('shell')));
        }
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ timeoutMs?: number; }} [options]
 * @returns {Promise<void>}
 */
export async function waitForNotificationSuppressed(page, {
    timeoutMs = DEFAULT_READINESS_TIMEOUT_MS
} = {})
{
    await waitForObservableReadiness(page, {
        description: 'notification stream suppression marker is true',
        timeoutMs,
        predicate: () => document.documentElement.dataset.fsusDisableNotificationStream === 'true'
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ pathPrefix: string; content: import('@playwright/test').Locator; timeoutMs?: number; }} options
 * @returns {Promise<void>}
 */
export async function waitForAuthPermissionReady(page, {
    pathPrefix,
    content,
    timeoutMs = DEFAULT_READINESS_TIMEOUT_MS
})
{
    try
    {
        await page.waitForURL((url) => url.pathname.startsWith(pathPrefix), { timeout: timeoutMs });
        await content.waitFor({ state: 'visible', timeout: timeoutMs });
    }
    catch (error)
    {
        throw readinessError(
            `authenticated permission route ${pathPrefix} and authorized content are visible`,
            timeoutMs,
            error
        );
    }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ timeoutMs?: number; }} [options]
 * @returns {Promise<void>}
 */
export async function waitForVisualFrameReady(page, {
    timeoutMs = DEFAULT_READINESS_TIMEOUT_MS
} = {})
{
    await page.evaluate(() =>
    {
        delete document.documentElement.dataset.fsusVisualFramePending;
        delete document.documentElement.dataset.fsusVisualFrameReady;
    });
    await waitForObservableReadiness(page, {
        description: 'fonts are loaded and two post-style animation frames completed',
        timeoutMs,
        predicate: () =>
        {
            const root = document.documentElement;
            if (document.fonts?.status !== 'loaded')
            {
                return false;
            }
            if (root.dataset.fsusVisualFrameReady === 'true')
            {
                return true;
            }
            if (root.dataset.fsusVisualFramePending === 'true')
            {
                return false;
            }
            root.dataset.fsusVisualFramePending = 'true';
            requestAnimationFrame(() => requestAnimationFrame(() =>
            {
                root.dataset.fsusVisualFrameReady = 'true';
            }));
            return false;
        }
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {readonly ExpectedFontReadiness[]} expectedFonts
 * @returns {Promise<FontLoadingReadinessReport>}
 */
export async function inspectFontLoadingReadiness(page, expectedFonts)
{
    return await page.evaluate(async (expectations) =>
    {
        const normalizeFamily = (family) => String(family)
            .trim()
            .replace(/^(['"])(.*)\1$/u, '$2');
        const snapshotFaces = () => Array.from(document.fonts, (face) => ({
            family: normalizeFamily(face.family),
            status: face.status,
            style: face.style,
            weight: face.weight
        }));

        await document.fonts.ready;
        const fontSetStatusBeforeProbe = document.fonts.status;
        const facesBeforeProbe = snapshotFaces();
        const families = [];
        for (const expectation of expectations)
        {
            const expectedFamily = normalizeFamily(expectation.family);
            const familyFacesBeforeProbe = facesBeforeProbe
                .filter((face) => face.family === expectedFamily);
            const probes = [];
            for (const weight of expectation.weights)
            {
                const query = `${weight} 1em "${expectedFamily}"`;
                const loaded = await document.fonts.load(query, expectation.representativeText);
                probes.push({
                    check: document.fonts.check(query, expectation.representativeText),
                    loadedCount: loaded.length,
                    query,
                    weight
                });
            }
            families.push({
                family: expectedFamily,
                facesBeforeProbe: familyFacesBeforeProbe,
                loadedWeightsBeforeProbe: Array.from(new Set(
                    familyFacesBeforeProbe
                        .filter((face) => face.status === 'loaded')
                        .map((face) => Number(face.weight))
                        .filter(Number.isFinite)
                )).sort((left, right) => left - right),
                probes,
                representativeText: expectation.representativeText
            });
        }
        const facesAfterProbe = snapshotFaces();

        return {
            errorFacesAfterProbe: facesAfterProbe.filter((face) => face.status === 'error'),
            errorFacesBeforeProbe: facesBeforeProbe.filter((face) => face.status === 'error'),
            families,
            fontSetStatusAfterProbe: document.fonts.status,
            fontSetStatusBeforeProbe
        };
    }, expectedFonts);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ purpose: string; maxWindowMs: number; evidenceClass: 'performance' | 'soak' | 'animation-measurement'; }} options
 * @returns {Promise<void>}
 */
export async function runBrowserMeasurementWindow(page, {
    purpose,
    maxWindowMs,
    evidenceClass
})
{
    if (!purpose || !Number.isFinite(maxWindowMs) || maxWindowMs <= 0 || maxWindowMs > 60_000)
    {
        throw new Error('measurement window requires a purpose and maxWindowMs in (0, 60000]');
    }
    if (!['performance', 'soak', 'animation-measurement'].includes(evidenceClass))
    {
        throw new Error(`measurement window evidenceClass is not approved: ${evidenceClass}`);
    }
    await page.waitForTimeout(maxWindowMs);
}

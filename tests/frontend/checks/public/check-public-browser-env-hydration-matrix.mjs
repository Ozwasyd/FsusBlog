#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BROWSER_ENV_SCHEMA = 'fsusblog.public-hydration-browser-env-matrix.v1';
const BROWSER_ENV_SUMMARY_FILE = process.env.FSUSBLOG_PUBLIC_HYDRATION_BROWSER_ENV_SUMMARY_FILE
  || fileURLToPath(new URL('../../../../.tmp/release-evidence/public-hydration-browser-env-summary.json', import.meta.url));
const PUBLIC_SSR_BUNDLE_FILE = resolve(
    process.env.FSUSBLOG_FRONTEND_DIST_ROOT
    || fileURLToPath(new URL('../../../../src/frontend/dist', import.meta.url)),
    'server/public-ssr.mjs'
);

export const ENVIRONMENT_CELLS = Object.freeze([
    {
        id: 'empty-anonymous-light-desktop',
        themePreference: 'empty',
        savedAppState: 'empty',
        sessionState: 'anonymous',
        storageBehavior: 'normal',
        motionPreference: 'normal',
        colorScheme: 'light',
        viewport: 'desktop'
    },
    {
        id: 'dark-admin-stale-mobile-reduced',
        themePreference: 'dark',
        savedAppState: 'stale-public-shell-state',
        sessionState: 'admin',
        storageBehavior: 'normal',
        motionPreference: 'reduced',
        colorScheme: 'dark',
        viewport: 'mobile'
    },
    {
        id: 'system-user-storage-unavailable-tablet',
        themePreference: 'system',
        savedAppState: 'stale-site-info',
        sessionState: 'user',
        storageBehavior: 'unavailable',
        motionPreference: 'normal',
        colorScheme: 'dark',
        viewport: 'tablet'
    },
    {
        id: 'light-anonymous-cleared-narrow',
        themePreference: 'light',
        savedAppState: 'stale-site-info',
        sessionState: 'anonymous',
        storageBehavior: 'cleared-after-reload',
        motionPreference: 'reduced',
        colorScheme: 'light',
        viewport: 'narrowMobile'
    }
]);

export const ROUTE_CANDIDATES = Object.freeze([
    { id: 'home', route: '/', expectedKind: 'Home' },
    { id: 'article-detail', route: '/article/:id', expectedKind: 'ArticleDetail' },
    { id: 'filter-category', route: '/category/:id', expectedKind: 'Filter' },
    { id: 'static-about', route: '/about', expectedKind: 'About' }
]);

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function writeSummary(summary)
{
    mkdirSync(dirname(BROWSER_ENV_SUMMARY_FILE), { recursive: true });
    writeFileSync(BROWSER_ENV_SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`);
}

async function loadContractBundle()
{
    assert(existsSync(PUBLIC_SSR_BUNDLE_FILE), `missing public SSR bundle: ${PUBLIC_SSR_BUNDLE_FILE}`);
    const bundle = await import(pathToFileURL(PUBLIC_SSR_BUNDLE_FILE).href);
    assert(
        typeof bundle.projectPublicBrowserEnvironment === 'function',
        'public SSR bundle missing projectPublicBrowserEnvironment'
    );
    return bundle;
}

function expectedAuth(sessionState)
{
    if (sessionState === 'admin')
    {
        return { text: '控制板', href: '/user/manage' };
    }
    if (sessionState === 'user')
    {
        return { text: '账户', href: '/user/profile' };
    }
    return { text: '登录', href: '/login' };
}

function expectedThemeMode(cell, storageBehavior)
{
    if (storageBehavior === 'unavailable' || storageBehavior === 'cleared-after-reload')
    {
        return 'system';
    }
    return cell.themePreference === 'empty' ? 'system' : cell.themePreference;
}

function assertProjection(row, projection, cell, route, storageBehavior)
{
    const auth = expectedAuth(cell.sessionState);
    const themeMode = expectedThemeMode(cell, storageBehavior);
    const themeResolved = themeMode === 'system' ? cell.colorScheme : themeMode;
    assert(projection.hydrationKind === route.expectedKind, `${row.id}: hydration kind ${projection.hydrationKind}`);
    assert(projection.authText === auth.text, `${row.id}: auth text ${projection.authText}`);
    assert(projection.authHref === auth.href, `${row.id}: auth href ${projection.authHref}`);
    assert(projection.themeMode === themeMode, `${row.id}: theme mode ${projection.themeMode}`);
    assert(projection.themeResolved === themeResolved, `${row.id}: resolved theme ${projection.themeResolved}`);
    assert(projection.reducedMotion === (cell.motionPreference === 'reduced'), `${row.id}: reduced motion drift`);
    assert(projection.darkColorScheme === (cell.colorScheme === 'dark'), `${row.id}: color scheme drift`);
    assert(projection.storageAvailable === (storageBehavior !== 'unavailable'), `${row.id}: storage availability drift`);
    assert(projection.staleStateAccepted === false, `${row.id}: stale browser state became authoritative`);
}

function runCell(bundle, cell, route)
{
    const id = `${cell.id}/${route.id}`;
    const initialStorageBehavior = cell.storageBehavior === 'cleared-after-reload'
        ? 'normal'
        : cell.storageBehavior;
    const input = {
        hydrationKind: route.expectedKind,
        themePreference: cell.themePreference === 'empty' ? null : cell.themePreference,
        sessionState: cell.sessionState,
        storageBehavior: initialStorageBehavior,
        motionPreference: cell.motionPreference,
        colorScheme: cell.colorScheme,
        stalePublicShellState: cell.savedAppState === 'stale-public-shell-state',
        staleSiteInfo: cell.savedAppState === 'stale-site-info'
    };
    const projection = bundle.projectPublicBrowserEnvironment(input);
    assertProjection({ id }, projection, cell, route, initialStorageBehavior);

    let afterStorageClear = null;
    if (cell.storageBehavior === 'cleared-after-reload')
    {
        afterStorageClear = bundle.projectPublicBrowserEnvironment({
            ...input,
            storageBehavior: 'cleared-after-reload'
        });
        assertProjection({ id: `${id}/after-clear` }, afterStorageClear, cell, route, 'cleared-after-reload');
    }

    return {
        id,
        routeId: route.id,
        route: route.route,
        expectedKind: route.expectedKind,
        environment: cell,
        status: 'success',
        executionLayer: 'browserless-production-view-contract',
        projection,
        afterStorageClear,
        assertions: [
            'production-shell-auth-projection',
            'production-theme-normalization',
            'storage-unavailable-and-cleared-fallback',
            'stale-state-rejected',
            'motion-and-color-scheme-model',
            'route-kind-selection'
        ]
    };
}

async function main()
{
    const summary = {
        schema: BROWSER_ENV_SCHEMA,
        status: 'failure',
        generatedAt: new Date().toISOString(),
        executionLayer: 'browserless-production-view-contract',
        browserLaunchCount: 0,
        playwrightBrowserInstalled: false,
        rows: [],
        browserContractDelegation: {
            issue: 1147,
            scenarioId: 'public-hydration-main',
            retainedRisk: 'real Vue hydration, shell identity, history, reload and Service Worker'
        }
    };

    try
    {
        const bundle = await loadContractBundle();
        for (const cell of ENVIRONMENT_CELLS)
        {
            for (const route of ROUTE_CANDIDATES)
            {
                process.stdout.write(`Testing browserless env ${cell.id} ${route.id}... `);
                summary.rows.push(runCell(bundle, cell, route));
                process.stdout.write('PASS\n');
            }
        }

        summary.coverage = {
            environmentCells: ENVIRONMENT_CELLS.length,
            routesChecked: summary.rows.length,
            routesSkipped: 0,
            sessionStates: [...new Set(ENVIRONMENT_CELLS.map((cell) => cell.sessionState))],
            themePreferences: [...new Set(ENVIRONMENT_CELLS.map((cell) => cell.themePreference))],
            storageBehaviors: [...new Set(ENVIRONMENT_CELLS.map((cell) => cell.storageBehavior))],
            motionPreferences: [...new Set(ENVIRONMENT_CELLS.map((cell) => cell.motionPreference))],
            colorSchemes: [...new Set(ENVIRONMENT_CELLS.map((cell) => cell.colorScheme))],
            viewports: [...new Set(ENVIRONMENT_CELLS.map((cell) => cell.viewport))]
        };
        summary.status = 'success';
        writeSummary(summary);
        console.log(`[public-browser-env-contract] ok (${summary.rows.length} browserless cell(s)); summary=${BROWSER_ENV_SUMMARY_FILE}`);
    }
    catch (error)
    {
        summary.error = error instanceof Error ? error.message : String(error);
        writeSummary(summary);
        console.error(`[public-browser-env-contract] failed: ${summary.error}`);
        process.exitCode = 1;
    }
}

main();

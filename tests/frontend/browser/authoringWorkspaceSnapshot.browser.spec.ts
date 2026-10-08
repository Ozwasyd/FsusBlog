import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { chromium, expect, test } from '@playwright/test';

const origin = process.env.FSUSBLOG_WORKSPACE_BROWSER_ORIGIN ?? 'http://127.0.0.1:4317';
const repository = path.resolve(import.meta.dirname, '../../..');
const fixtureUrl = `${origin}/@fs/${repository}/tests/frontend/fixtures/authoringWorkspaceSnapshotBrowser.html`;
const moduleUrl = `${origin}/@fs/${repository}/tests/frontend/fixtures/authoringWorkspaceSnapshotBrowser.ts`;

test('native IndexedDB survives reload/browser restart as a non-authoritative placeholder', async () =>
{
    const profile = await mkdtemp(path.join(tmpdir(), 'fsusblog-workspace-browser-'));
    let context = await chromium.launchPersistentContext(profile, { headless: true });
    try
    {
        let page = await context.newPage();
        await page.goto(fixtureUrl);
        await expect(page).toHaveTitle('Workspace cache browser controls');
        expect(await page.evaluate(async url => (await import(url)).writeServerFixtureCache(), moduleUrl)).toBe('stored');
        await page.reload();
        expect(await page.evaluate(async url => (await import(url)).inspectCache(), moduleUrl)).toEqual({ status: 'cached-placeholder', revision: 1, tabs: 100, authorityRejected: true });
        await context.close();
        context = await chromium.launchPersistentContext(profile, { headless: true });
        page = await context.newPage();
        await page.goto(fixtureUrl);
        expect(await page.evaluate(async url => (await import(url)).inspectCache(), moduleUrl)).toEqual({ status: 'cached-placeholder', revision: 1, tabs: 100, authorityRejected: true });
    }
    finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

test('native cache retention is bounded and atomic replacement cannot lower a verified revision', async ({ page }) =>
{
    await page.goto(fixtureUrl);
    const count = await page.evaluate(async url =>
    {
        const fixture = await import(url);
        const now = Date.now() - 100;
        for (let userId = 1; userId <= 9; userId++) await fixture.writeServerFixtureCache(userId, 1, now + userId);
        return fixture.nativeCacheCount();
    }, moduleUrl);
    expect(count).toBe(8);
    const cache = await page.evaluate(async url =>
    {
        const fixture = await import(url);
        await fixture.writeServerFixtureCache(9, 3);
        await fixture.writeServerFixtureCache(9, 2);
        return fixture.inspectCache(9);
    }, moduleUrl);
    expect(cache).toEqual({ status: 'cached-placeholder', revision: 3, tabs: 100, authorityRejected: true });
});

test('two native browser tabs exchange scoped revisions and Web Locks grant one flush owner', async ({ context }) =>
{
    const first = await context.newPage(); const second = await context.newPage();
    await first.goto(fixtureUrl); await second.goto(fixtureUrl);
    await first.evaluate(async url => (await import(url)).listenNativeChannel(), moduleUrl);
    await second.evaluate(async url => (await import(url)).listenNativeChannel(), moduleUrl);
    await first.evaluate(async url => (await import(url)).postNativeRevision(), moduleUrl);
    await expect.poll(() => second.evaluate(async url => (await import(url)).nativeMessages(), moduleUrl)).toHaveLength(1);
    const messages = await second.evaluate(async url => (await import(url)).nativeMessages(), moduleUrl);
    expect(JSON.stringify(messages)).not.toMatch(/"snapshot"|"layout"|"body"|"tabs"/u);
    await first.evaluate(async url => (await import(url)).holdNativeLock(), moduleUrl);
    await expect.poll(() => first.evaluate(async url => (await import(url)).nativeLockEntered(), moduleUrl)).toBe(true);
    expect(await second.evaluate(async url => (await import(url)).tryNativeLock(), moduleUrl)).toBe(false);
    await first.evaluate(async url => (await import(url)).releaseNativeLock(), moduleUrl);
    await expect.poll(() => second.evaluate(async url => (await import(url)).tryNativeLock(), moduleUrl)).toBe(true);
});

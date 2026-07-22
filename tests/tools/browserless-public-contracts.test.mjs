import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const browserlessScripts = [
    'tests/frontend/checks/public/check-public-dom-diff-hydration.mjs',
    'tests/frontend/checks/public/check-public-clock-hydration-matrix.mjs',
    'tests/frontend/checks/public/check-public-payload-fixture-matrix.mjs',
    'tests/frontend/checks/public/check-public-browser-env-hydration-matrix.mjs'
];

test('public synthetic matrices are browserless and use production contracts', () =>
{
    for (const file of [
        ...browserlessScripts,
        'tests/frontend/checks/public/public-hydration-smoke.mjs'
    ])
    {
        const source = read(file);
        for (const forbidden of ['@playwright/test', 'chromium.launch', 'resolveSystemChromiumExecutablePath'])
        {
            assert.equal(source.includes(forbidden), false, `${file} contains ${forbidden}`);
        }
    }

    assert.match(read(browserlessScripts[0]), /renderPublicHydrationSnapshot/u);
    assert.match(read(browserlessScripts[1]), /buildEntryWithContext[\s\S]*?renderPublicHydrationSnapshot/u);
    assert.match(read(browserlessScripts[2]), /PUBLIC_PAYLOAD_FIXTURES[\s\S]*?inspectEntryContract/u);
    assert.match(read(browserlessScripts[3]), /projectPublicBrowserEnvironment/u);
});

test('release correctness has no hidden browser command', () =>
{
    const legacy = read('tools/test/lanes/_suite-support.sh');
    const releaseOnly = legacy.slice(legacy.indexOf('RunReleaseOnly()'), legacy.indexOf('\nRunAcceptanceOnly()'));
    for (const forbidden of [
        'PLAYWRIGHT_BASE_URL',
        'check:search-runtime',
        'check:public-hydration\n',
        'check:pwa-offline-smoke',
        'playwright',
        'chromium'
    ])
    {
        assert.equal(releaseOnly.toLowerCase().includes(forbidden.toLowerCase()), false, `release contains ${forbidden}`);
    }
    assert.match(releaseOnly, /browser-only hydration\/search\/PWA risks are delegated to browser-contract/u);
    assert.match(releaseOnly, /public-hydration-smoke\.mjs/u);
});

test('production renderer exposes injectable clock, locale and environment projection', () =>
{
    const clock = read('src/frontend/src/public-renderers/publicRenderClock.ts');
    const environment = read('src/frontend/src/public-renderers/publicBrowserEnvironment.ts');
    assert.match(clock, /export interface Clock[\s\S]*?now\(\): Date/u);
    assert.match(clock, /export interface LocaleContext[\s\S]*?locale: string[\s\S]*?timeZone: string/u);
    assert.match(environment, /createPublicShellViewState/u);
    assert.match(environment, /normalizeThemeMode/u);
});

test('migration handoff maps every removed browser responsibility', () =>
{
    const handoff = read('docs/testing/issue-1145-browserless-public-contracts.md');
    for (const token of [
        'check-public-dom-diff-hydration.mjs',
        'check-public-clock-hydration-matrix.mjs',
        'check-public-payload-fixture-matrix.mjs',
        'check-public-browser-env-hydration-matrix.mjs',
        'public-hydration-main',
        'service-worker-offline-reload'
    ])
    {
        assert.equal(handoff.includes(token), true, `handoff missing ${token}`);
    }
});

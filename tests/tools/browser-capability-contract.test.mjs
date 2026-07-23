import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    assertBrowserCapabilityBehavior,
    browserCapabilityContract,
    validateBrowserCapabilityContract
} = await import(pathToFileURL(path.join(
    root,
    'tests/frontend/support/playwright/browser-capability-contract.mjs'
)).href);

test('every browser declares behavior for every capability', () =>
{
    assert.equal(
        validateBrowserCapabilityContract(browserCapabilityContract),
        browserCapabilityContract
    );

    const source = fs.readFileSync(
        path.join(root, 'tests/frontend/e2e/acceptance/cross-browser-smoke.spec.ts'),
        'utf8'
    );
    assert.doesNotMatch(
        source,
        /typeof hydrationState\.(serviceWorkerSupported|passkeySupported|conditionalMediationProbeAvailable)/
    );
    assert.match(source, /assertBrowserCapabilityBehavior/);
    assert.match(source, /absentCapabilityFixture/);

    const playwrightConfig = fs.readFileSync(
        path.join(root, 'src/frontend/playwright.config.ts'),
        'utf8'
    );
    const configuredBrowserSet = /const supportedBrowsers = new Set\(\[([^\]]+)\]\)/u
        .exec(playwrightConfig)?.[1] ?? '';
    const configuredBrowsers = [...configuredBrowserSet.matchAll(/'([^']+)'/gu)]
        .map((match) => match[1])
        .sort();
    assert.deepEqual(
        Object.keys(browserCapabilityContract).sort(),
        configuredBrowsers,
        'every Playwright browser must have a capability behavior contract'
    );
});

test('a declaration that disagrees with runtime behavior fails closed', () =>
{
    assert.throws(
        () => assertBrowserCapabilityBehavior({
            browserName: 'chromium',
            capability: 'serviceWorker',
            evidence: {
                probe: false,
                supportedBehavior: {},
                fallbackBehavior: {},
                absentCapabilityFixture: {}
            }
        }),
        /browser=chromium capability=serviceWorker classification=required actualProbe=false failedStep=required-capability-probe/
    );
    assert.throws(
        () => assertBrowserCapabilityBehavior({
            browserName: 'firefox',
            capability: 'passkey',
            evidence: {
                probe: true,
                supportedBehavior: {
                    'passkey-action-visible': false,
                    'passkey-action-enabled': true
                },
                fallbackBehavior: {},
                absentCapabilityFixture: {
                    'recovery-link-visible': true,
                    'missing-api-not-called': true
                }
            }
        }),
        /browser=firefox capability=passkey classification=optional-with-fallback actualProbe=true failedStep=passkey-action-visible/
    );
});

test('new engines and capabilities cannot appear without complete semantics', () =>
{
    const incomplete = {
        ...browserCapabilityContract,
        chromium: {
            ...browserCapabilityContract.chromium,
            passkey: undefined
        }
    };

    assert.throws(
        () => validateBrowserCapabilityContract(incomplete),
        /missing capability declaration: chromium\/passkey/
    );
});

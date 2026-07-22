import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- This contract test imports the repository tool under test.
import {
    ASSET_COMPATIBILITY_EVIDENCE_SCHEMA,
    ASSET_COMPATIBILITY_SCENARIO_SCHEMA,
    ASSET_COMPATIBILITY_SIGNAL_SCHEMA,
    captureOldReleaseCheckpoint,
    extractIndexAssetUrls,
    normalizeAssetCompatibilityScenario,
    runReleaseAssetCompatibilityDrill,
    sealAssetBrowserEvidence,
    verifyAssetBrowserEvidenceBinding,
    waitForLifecycleSignal
} from '../../tools/deployment/release-asset-compatibility-probe.mjs';

const OLD_RELEASE = '20260710010101-aaaaaaaaaaaa';
const NEW_RELEASE = '20260711010101-bbbbbbbbbbbb';
const OLD_FRONTEND = 'http://127.0.0.1:4101/';
const PUBLIC = 'http://127.0.0.1:4102/';
const OLD_BACKEND = 'http://127.0.0.1:4103/';
const NEW_BACKEND = 'http://127.0.0.1:4104/';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE_VERIFIER = path.join(ROOT, 'tools/deployment/release-asset-compatibility-evidence-verify.mjs');

function sha256(payload)
{
    return `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
}

function releasePath(relativePath)
{
    return `/release-assets/${OLD_RELEASE}/${relativePath}`;
}

function fixture(overrides = {})
{
    const payloads = new Map([
        ['index.html', Buffer.from([
            '<!doctype html><html><head>',
            `<link rel="stylesheet" href="${releasePath('assets/app.aaaaaa.css')}">`,
            `<link rel="modulepreload" href='${releasePath('assets/chunk.aaaaaa.js')}'>`,
            `<link rel="preload" href=${releasePath('wasm/aeds.aaaaaa.wasm')}>`,
            `<link rel="preload" href="${releasePath('fonts/blog.aaaaaa.woff2')}">`,
            '</head><body>',
            `<script type="module" src="${releasePath('assets/app.aaaaaa.js')}"></script>`,
            '</body></html>'
        ].join(''))],
        ['sw.js', Buffer.from(`const CACHE = 'fsus-static-v4:${OLD_RELEASE}'\n`)],
        ['assets/app.aaaaaa.js', Buffer.from("globalThis.__OLD_APP__ = 'ready'\n")],
        ['assets/chunk.aaaaaa.js', Buffer.from("export const chunk = 'old'\n")],
        ['assets/app.aaaaaa.css', Buffer.from("@font-face{src:url('../fonts/blog.aaaaaa.woff2')}\n")],
        ['wasm/aeds.aaaaaa.wasm', Buffer.from('old-wasm-binary')],
        ['fonts/blog.aaaaaa.woff2', Buffer.from('old-font-binary')]
    ]);
    const files = [...payloads.entries()].map(([relativePath, payload]) => ({
        path: relativePath,
        sha256: sha256(payload),
        bytes: payload.byteLength,
        class: ['index.html', 'sw.js'].includes(relativePath) ? 'mutable-entry' : 'immutable-static',
        releaseUrl: releasePath(relativePath),
        cacheControl: ['index.html', 'sw.js'].includes(relativePath)
            ? 'no-store,max-age=0,must-revalidate'
            : 'public,max-age=31536000,immutable'
    }));
    const manifest = {
        schema: 'fsusblog.release-assets.v1',
        releaseId: OLD_RELEASE,
        slot: 'blue',
        frontendBuildId: OLD_RELEASE,
        files,
        compatibilityFile: 'release-compatibility.json'
    };
    const manifestPayload = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const scenario = {
        schema: ASSET_COMPATIBILITY_SCENARIO_SCHEMA,
        drillId: 'asset-drill-1031',
        oldReleaseId: OLD_RELEASE,
        newReleaseId: NEW_RELEASE,
        oldFrontendBaseUrl: OLD_FRONTEND,
        publicBaseUrl: PUBLIC,
        oldBackendBaseUrl: OLD_BACKEND,
        newBackendBaseUrl: NEW_BACKEND,
        browser: { required: false },
        compatibilityRequests: {
            oldFrontendToNewBackend: [{
                id: 'binary-home',
                method: 'GET',
                path: '/api/binary/article/list/home/1/10.aeds',
                expectedStatuses: [200],
                expectedHeaders: { 'content-type': 'application/octet-stream' },
                expectedSha256: sha256('new-backend-aeds')
            }],
            newFrontendToOldBackend: [{
                id: 'binary-home-rollback',
                method: 'GET',
                path: '/api/binary/article/list/home/1/10.aeds',
                expectedStatuses: [200],
                expectedHeaders: { 'content-type': 'application/octet-stream' },
                expectedSha256: sha256('old-backend-aeds')
            }]
        },
        retention: {
            untilUtc: '2099-07-11T00:00:00.000Z',
            requiredProtectionReason: 'retention-window'
        },
        ...overrides
    };
    return { payloads, manifest, manifestPayload, scenario };
}

function gcEvidence(overrides = {})
{
    return {
        schema: 'fsusblog.release-assets.gc-evidence.v1',
        status: 'ok',
        dryRun: false,
        protectedReleaseIds: [OLD_RELEASE, NEW_RELEASE],
        releaseActions: [{
            releaseId: OLD_RELEASE,
            protected: true,
            reasons: ['previous', 'retention-window'],
            action: 'retain'
        }],
        after: { releases: [OLD_RELEASE, NEW_RELEASE], objects: [], manifests: [] },
        errors: [],
        ...overrides
    };
}

function responseForFixture(data, mutate = () => null)
{
    return async input =>
    {
        const url = new URL(input);
        const mutation = mutate(url);
        if (mutation)
        {
            return mutation;
        }

        if (url.origin === new URL(NEW_BACKEND).origin && url.pathname === '/api/binary/article/list/home/1/10.aeds')
        {
            return new Response('new-backend-aeds', {
                status: 200,
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-fsus-release-id': NEW_RELEASE
                }
            });
        }
        if (url.origin === new URL(OLD_BACKEND).origin && url.pathname === '/api/binary/article/list/home/1/10.aeds')
        {
            return new Response('old-backend-aeds', {
                status: 200,
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-fsus-release-id': OLD_RELEASE
                }
            });
        }
        if (![new URL(OLD_FRONTEND).origin, new URL(PUBLIC).origin].includes(url.origin))
        {
            return new Response('unknown origin', { status: 502 });
        }
        if (url.pathname === releasePath('asset-manifest.json'))
        {
            return new Response(data.manifestPayload, { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const prefix = `${releasePath('')}`;
        const relativePath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
        const payload = relativePath ? data.payloads.get(relativePath) : null;
        if (!payload)
        {
            return new Response('missing fixture', { status: 404 });
        }
        return new Response(payload, {
            status: 200,
            headers: {
                'content-type': contentType(relativePath),
                'x-fsus-frontend-build': OLD_RELEASE
            }
        });
    };
}

function contentType(relativePath)
{
    if (relativePath.endsWith('.html'))
    {
        return 'text/html; charset=utf-8';
    }
    if (relativePath.endsWith('.js'))
    {
        return 'text/javascript; charset=utf-8';
    }
    if (relativePath.endsWith('.css'))
    {
        return 'text/css; charset=utf-8';
    }
    if (relativePath.endsWith('.wasm'))
    {
        return 'application/wasm';
    }
    if (relativePath.endsWith('.woff2'))
    {
        return 'font/woff2';
    }
    return 'application/octet-stream';
}

function monotonicClock()
{
    let milliseconds = Date.parse('2026-07-11T04:00:00.000Z');
    return () => new Date(milliseconds += 1_000);
}

test('extracts quoted and unquoted delayed resources from the N-1 index once', () =>
{
    assert.deepEqual(extractIndexAssetUrls(`
    <link rel="stylesheet" href="/assets/app.1.css">
    <link rel=preload href='/assets/app.1.wasm'>
    <script src=/assets/app.1.js></script>
    <script src="/assets/app.1.js"></script>
  `), ['/assets/app.1.css', '/assets/app.1.wasm', '/assets/app.1.js']);
});

test('normalizes an automatic two-signal N/N-1 asset compatibility scenario', () =>
{
    const normalized = normalizeAssetCompatibilityScenario(fixture().scenario);
    assert.equal(normalized.oldIndexPath, releasePath('index.html'));
    assert.equal(normalized.oldManifestPath, releasePath('asset-manifest.json'));
    assert.equal(normalized.serviceWorker.scriptPath, `${releasePath('sw.js')}?build=${OLD_RELEASE}`);
    assert.equal(normalized.browser.required, false);
    assert.deepEqual(normalized.requiredAssetKinds, ['javascript', 'stylesheet', 'wasm', 'font']);
    assert.equal(normalized.compatibilityRequests.oldFrontendToNewBackend[0].requireReleaseHeader, true);
});

test('captures N-1 index, manifest-bound JS CSS Wasm font and old service worker before switching', async () =>
{
    const data = fixture();
    const checkpoint = await captureOldReleaseCheckpoint(data.scenario, {
        fetchImpl: responseForFixture(data),
        now: monotonicClock()
    });

    assert.equal(checkpoint.status, 'pass');
    assert.equal(checkpoint.index.status, 'pass');
    assert.deepEqual(checkpoint.coverage, {
        javascript: 2,
        stylesheet: 1,
        wasm: 1,
        font: 1
    });
    assert.equal(checkpoint.assets.length, 5);
    assert.equal(checkpoint.assets.every(asset => asset.hashMatches === true), true);
    assert.equal(checkpoint.serviceWorker.script.status, 'pass');
    assert.equal(checkpoint.serviceWorker.cacheEntries.length, 5);
    assert.deepEqual(checkpoint.errors, []);
});

test('drill waits for switch and applied GC, then emits rollout-compatible passing evidence', async () =>
{
    const data = fixture();
    const stages = [];
    let checkpointObserved = false;
    const evidence = await runReleaseAssetCompatibilityDrill(data.scenario, {
        fetchImpl: responseForFixture(data),
        now: monotonicClock(),
        onCheckpoint: async checkpoint =>
        {
            checkpointObserved = checkpoint.status === 'pass';
        },
        waitForStage: async (stage, drillId) =>
        {
            stages.push({ stage, drillId });
        },
        getGcEvidence: async () => gcEvidence()
    });

    assert.equal(evidence.schema, ASSET_COMPATIBILITY_EVIDENCE_SCHEMA);
    assert.equal(evidence.status, 'pass');
    assert.equal(checkpointObserved, true);
    assert.deepEqual(stages, [
        { stage: 'switched', drillId: 'asset-drill-1031' },
        { stage: 'gc-complete', drillId: 'asset-drill-1031' }
    ]);
    assert.equal(evidence.notFoundCount, 0);
    assert.equal(evidence.hashMismatchCount, 0);
    assert.equal(evidence.connectionErrorCount, 0);
    assert.deepEqual(evidence.scenarios, {
        delayedOldAssets: 'pass',
        oldFrontendToNewBackend: 'pass',
        newFrontendToOldBackend: 'pass',
        oldServiceWorkerCache: 'pass',
        retentionWindowAfterGc: 'pass'
    });
    assert.equal(evidence.afterSwitch.resources.length, 5);
    assert.equal(evidence.afterGc.resources.length, 5);
    assert.equal(evidence.retention.requiredProtectionReason, 'retention-window');
    assert.deepEqual(evidence.errors, []);
});

test('drill aggregates 404, hash, backend-release and GC-window failures without an error cap', async () =>
{
    const data = fixture();
    const fetchImpl = responseForFixture(data, url =>
    {
        if (url.origin === new URL(PUBLIC).origin && url.pathname.endsWith('/assets/app.aaaaaa.css'))
        {
            return new Response('deleted', { status: 404 });
        }
        if (url.origin === new URL(PUBLIC).origin && url.pathname.endsWith('/wasm/aeds.aaaaaa.wasm'))
        {
            return new Response('tampered-wasm', { status: 200 });
        }
        if (url.origin === new URL(NEW_BACKEND).origin)
        {
            return new Response('new-backend-aeds', {
                status: 200,
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-fsus-release-id': OLD_RELEASE
                }
            });
        }
        return null;
    });
    const brokenGc = gcEvidence({
        status: 'dry-run',
        dryRun: true,
        releaseActions: [{
            releaseId: OLD_RELEASE,
            protected: false,
            reasons: [],
            action: 'delete'
        }],
        after: { releases: [NEW_RELEASE], objects: [], manifests: [] }
    });

    const evidence = await runReleaseAssetCompatibilityDrill(data.scenario, {
        fetchImpl,
        now: monotonicClock(),
        waitForStage: async () =>
        {},
        getGcEvidence: async () => brokenGc
    });

    assert.equal(evidence.status, 'fail');
    assert.ok(evidence.notFoundCount >= 2);
    assert.ok(evidence.hashMismatchCount >= 4);
    assert.equal(evidence.scenarios.delayedOldAssets, 'fail');
    assert.equal(evidence.scenarios.oldFrontendToNewBackend, 'fail');
    assert.equal(evidence.scenarios.retentionWindowAfterGc, 'fail');
    assert.ok(evidence.errors.length >= 8);
    assert.match(evidence.errors.join('\n'), /HTTP 404/u);
    assert.match(evidence.errors.join('\n'), /hash mismatch/u);
    assert.match(evidence.errors.join('\n'), /expected server release/u);
    assert.match(evidence.errors.join('\n'), /applied GC run/u);
    assert.match(evidence.errors.join('\n'), /did not retain old release/u);
});

test('controlled browser session replaces Node compatibility claims and final evidence is HMAC-bound to browser, scenario, manifest and GC', async t =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-asset-browser-binding-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const key = Buffer.alloc(32, 0x31);
    const keyFile = path.join(directory, 'asset-browser-binding.key');
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    const data = fixture({
        browser: {
            required: true,
            bindingKeyFile: keyFile,
            expectedCacheNamespace: `fsus-static-v4:${OLD_RELEASE}`,
            holdToken: 'browser-hold-1031'
        }
    });
    const scenarioFile = path.join(directory, 'scenario.json');
    const scenarioBytes = Buffer.from(`${JSON.stringify(data.scenario, null, 2)}\n`);
    fs.writeFileSync(scenarioFile, scenarioBytes);
    const scenarioSha256 = sha256(scenarioBytes);
    const compatibility = {
        oldFrontendToNewBackend: {
            status: 'pass', clientReleaseId: OLD_RELEASE, expectedServerReleaseId: NEW_RELEASE, requests: [], errors: []
        },
        newFrontendToOldBackend: {
            status: 'pass', clientReleaseId: NEW_RELEASE, expectedServerReleaseId: OLD_RELEASE, requests: [], errors: []
        }
    };
    const browserEvidence = {
        schema: 'fsusblog.release-asset-browser-evidence.v1',
        status: 'pass',
        browser: {
            name: 'chromium',
            version: 'fixture-browser-1',
            executablePath: '/fixture/chromium',
            executableSha256: `sha256:${'c'.repeat(64)}`
        },
        bindings: {
            drillId: 'asset-drill-1031',
            rolloutId: 'rollout-browser-1031',
            sourceReleaseId: OLD_RELEASE,
            targetReleaseId: NEW_RELEASE,
            scenarioSha256,
            manifestSha256: sha256(data.manifestPayload),
            gcEvidenceSha256: null
        },
        beforeSwitch: { status: 'pass', serviceWorker: { controller: { state: 'activated' } } },
        delayed: { resources: [{ kind: 'javascript', hashMatches: true }, { kind: 'stylesheet', hashMatches: true }, { kind: 'wasm', hashMatches: true }, { kind: 'font', hashMatches: true }] },
        afterSwitch: { status: 'pass' },
        compatibility,
        afterGc: { status: 'pass', cacheReads: [{ cacheHit: true }] },
        console: [],
        pageErrors: [],
        network: { responses: [], failures: [], blockedOldAssetRequests: [] },
        errors: []
    };
    let closed = false;
    const evidence = await runReleaseAssetCompatibilityDrill(data.scenario, {
        fetchImpl: responseForFixture(data),
        now: monotonicClock(),
        rolloutId: 'rollout-browser-1031',
        scenarioSha256: browserEvidence.bindings.scenarioSha256,
        startBrowserSession: async () => ({
            checkpoint: structuredClone(browserEvidence),
            afterSwitch: async () => structuredClone(browserEvidence),
            afterGc: async () => structuredClone(browserEvidence),
            evidence: () => structuredClone(browserEvidence),
            close: async () =>
            {
                closed = true;
            }
        }),
        waitForStage: async () =>
        {},
        getGcEvidence: async () => gcEvidence(),
        getGcEvidenceSha256: () => `sha256:${'e'.repeat(64)}`
    });

    assert.equal(evidence.status, 'pass');
    assert.equal(closed, true);
    assert.equal(evidence.browser.browser.version, 'fixture-browser-1');
    assert.equal(evidence.browser.bindings.gcEvidenceSha256, `sha256:${'e'.repeat(64)}`);
    assert.deepEqual(evidence.compatibility.oldFrontendToNewBackend, evidence.browser.compatibility.oldFrontendToNewBackend);
    const sealed = sealAssetBrowserEvidence(evidence, {
        key,
        scenarioSha256: browserEvidence.bindings.scenarioSha256
    });
    assert.equal(sealed.browserBinding.schema, 'fsusblog.release-asset-browser-binding.v1');
    assert.equal(sealed.browserBinding.browserVersion, 'fixture-browser-1');
    assert.equal(sealed.browserBinding.gcEvidenceSha256, `sha256:${'e'.repeat(64)}`);
    assert.match(sealed.browserBinding.payloadSha256, /^sha256:[0-9a-f]{64}$/u);
    assert.match(sealed.browserBinding.signature, /^hmac-sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(verifyAssetBrowserEvidenceBinding(sealed, key), { status: 'pass', errors: [] });
    const evidenceFile = path.join(directory, 'evidence.json');
    fs.writeFileSync(evidenceFile, `${JSON.stringify(sealed, null, 2)}\n`);
    const cliVerification = spawnSync(process.execPath, [
        EVIDENCE_VERIFIER,
        '--evidence', evidenceFile,
        '--scenario', scenarioFile,
        '--binding-key-file', keyFile,
        '--rollout-id', 'rollout-browser-1031'
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(cliVerification.status, 0, cliVerification.stderr || cliVerification.stdout);
    assert.equal(JSON.parse(cliVerification.stdout).status, 'pass');
    const tampered = structuredClone(sealed);
    tampered.browser.afterGc.cacheReads[0].cacheHit = false;
    const verification = verifyAssetBrowserEvidenceBinding(tampered, key);
    assert.equal(verification.status, 'fail');
    assert.ok(verification.errors.includes('browser binding payload SHA-256 mismatch'));
    fs.writeFileSync(evidenceFile, `${JSON.stringify(tampered, null, 2)}\n`);
    const cliTamper = spawnSync(process.execPath, [
        EVIDENCE_VERIFIER,
        '--evidence', evidenceFile,
        '--scenario', scenarioFile,
        '--binding-key-file', keyFile,
        '--rollout-id', 'rollout-browser-1031'
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(cliTamper.status, 0);
    assert.match(cliTamper.stdout, /payload SHA-256 mismatch/u);
});

test('missing a required font fails before switch and does not consume lifecycle signals', async () =>
{
    const data = fixture();
    data.manifest.files = data.manifest.files.filter(file => !file.path.endsWith('.woff2'));
    data.manifestPayload = Buffer.from(`${JSON.stringify(data.manifest, null, 2)}\n`);
    data.payloads.delete('fonts/blog.aaaaaa.woff2');
    let signalsConsumed = 0;

    const evidence = await runReleaseAssetCompatibilityDrill(data.scenario, {
        fetchImpl: responseForFixture(data),
        now: monotonicClock(),
        waitForStage: async () =>
        {
            signalsConsumed += 1;
        },
        getGcEvidence: async () => gcEvidence()
    });

    assert.equal(evidence.status, 'fail');
    assert.equal(signalsConsumed, 0);
    assert.equal(evidence.switchObservedAtUtc, null);
    assert.match(evidence.errors.join('\n'), /no font resource/u);
});

test('lifecycle signals are drill-bound and ignore stale or wrong-stage files', async (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-asset-signal-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const signalFile = path.join(directory, 'switch.json');
    fs.writeFileSync(signalFile, `${JSON.stringify({
        schema: ASSET_COMPATIBILITY_SIGNAL_SCHEMA,
        drillId: 'stale-drill',
        stage: 'switched'
    })}\n`);

    setTimeout(() =>
    {
        fs.writeFileSync(signalFile, `${JSON.stringify({
            schema: ASSET_COMPATIBILITY_SIGNAL_SCHEMA,
            drillId: 'asset-drill-1031',
            stage: 'switched'
        })}\n`);
    }, 25);

    const signal = await waitForLifecycleSignal(signalFile, 'switched', 'asset-drill-1031', {
        timeoutMs: 1_000,
        pollIntervalMs: 10
    });
    assert.equal(signal.drillId, 'asset-drill-1031');
    assert.equal(signal.stage, 'switched');
});

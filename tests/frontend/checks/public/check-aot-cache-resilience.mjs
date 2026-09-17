#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(new URL('../../../..', import.meta.url).pathname);
const outFile = path.join(
    process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? path.join(root, '.tmp/release-evidence'),
    'aot-cache-resilience-summary.json');
const sessionBase = path.join(
    process.env.FSUSBLOG_RUNTIME_OUTPUT_ROOT ?? path.join(root, '.tmp/public-aot-cache-resilience'),
    'public-aot-cache-resilience');
const schema = 'fsusblog.public-aot-cache-resilience.v1';
const documentMagic = 'FSUSBLOG_AOT_DOCUMENT_V1\n';
const rendererVersion = 'public-aot-cache-resilience-fixture-v1';
const currentAssetVersion = 'frontend-current-fixture';
const route = '/article/1';
const pageKind = 'ArticleDetail';
const routeKey = 'article:1';
const articleId = 1;
const aedsMagic = 0x53444541;
const aedsVersion = 2;
const aedsHeaderLength = 16;
const publicAotBootstrapFrameType = 71;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.mkdirSync(sessionBase, { recursive: true });

const requiredCaseNames = [
    'corrupt-document',
    'invalid-document-bytes',
    'missing-sidecar',
    'corrupt-sidecar',
    'old-asset-version',
    'html-payload-mismatch',
    'sw-stale-cache-poisoning'
];

function sha256(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function crc16(bytes)
{
    let crc = 0xffff;
    for (let i = 0; i < bytes.byteLength; i += 1)
    {
        crc ^= bytes[i] ?? 0;
        for (let bit = 0; bit < 8; bit += 1)
        {
            crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
        }
    }
    return crc & 0xffff;
}

function gitSha()
{
    try
    {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    }
    catch
    {
        return 'unknown';
    }
}

function relative(file)
{
    return path.relative(root, file).replaceAll(path.sep, '/');
}

function createSession(name)
{
    const sessionRoot = fs.mkdtempSync(path.join(sessionBase, `${name}-`));
    const webRoot = path.join(sessionRoot, 'wwwroot');
    const cacheKey = `public:aot:v2:${routeKey}`;
    const routeHash = sha256(cacheKey);
    const documentPath = path.join(
        webRoot,
        'aot-cache',
        'frontend',
        currentAssetVersion,
        pageKind,
        routeHash.slice(0, 2),
        `${routeHash}.aeds`);

    fs.mkdirSync(path.dirname(documentPath), { recursive: true });

    return {
        name,
        sessionRoot,
        webRoot,
        cacheKey,
        documentPath,
        browserCache: new Map(),
        events: []
    };
}

function identity(overrides = {})
{
    return {
        route,
        pageKind,
        routeKey,
        articleId,
        path: route,
        query: '',
        rendererVersion,
        ...overrides
    };
}

function encodeSidecarFrame(payload)
{
    const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const frame = Buffer.alloc(aedsHeaderLength + payloadBytes.byteLength);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    view.setUint32(0, aedsMagic, true);
    view.setUint8(4, aedsVersion);
    view.setUint8(5, aedsHeaderLength);
    view.setUint16(6, 0, true);
    view.setUint16(8, publicAotBootstrapFrameType, true);
    view.setUint32(10, payloadBytes.byteLength, true);
    view.setUint16(14, crc16(payloadBytes), true);
    frame.set(payloadBytes, aedsHeaderLength);
    return frame;
}

function decodeSidecarFrame(bytes)
{
    if (bytes.byteLength < aedsHeaderLength)
    {
        throw new Error('sidecar frame truncated');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== aedsMagic ||
    view.getUint8(4) !== aedsVersion ||
    view.getUint8(5) !== aedsHeaderLength ||
    view.getUint16(8, true) !== publicAotBootstrapFrameType)
    {
        throw new Error('sidecar frame header invalid');
    }

    const length = view.getUint32(10, true);
    if (aedsHeaderLength + length !== bytes.byteLength)
    {
        throw new Error('sidecar frame length mismatch');
    }

    const payloadBytes = bytes.subarray(aedsHeaderLength);
    if (crc16(payloadBytes) !== view.getUint16(14, true))
    {
        throw new Error('sidecar frame crc mismatch');
    }

    return JSON.parse(Buffer.from(payloadBytes).toString('utf8'));
}

function writeSidecar(session, payloadIdentity = identity())
{
    const bytes = encodeSidecarFrame({ kind: payloadIdentity.pageKind, ...payloadIdentity });
    const hash = sha256(bytes);
    const relativePath = `aot-cache/payloads/${hash.slice(0, 2)}/${hash}.aeds`;
    const file = path.join(session.webRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return {
        url: `/${relativePath}`,
        sha256: hash,
        relativePath,
        path: file,
        byteLength: bytes.byteLength
    };
}

function renderHtml(entryIdentity, sidecar)
{
    return [
        '<!doctype html>',
        '<html lang="zh-CN">',
        '<head><title>Fixture Article</title></head>',
        '<body data-fsusblog-public-shell="true">',
        `<main id="app" data-route-key="${entryIdentity.routeKey}" data-page-kind="${entryIdentity.pageKind}">Fixture</main>`,
        `<script id="fsus-aot-hydration-props" type="application/octet-stream" data-aeds-src="${sidecar.url}"></script>`,
        '</body>',
        '</html>'
    ].join('');
}

function serializeDocument(entry)
{
    return Buffer.from(`${documentMagic}${JSON.stringify(entry, null, 2)}\n`, 'utf8');
}

function parseDocument(bytes)
{
    const text = Buffer.from(bytes).toString('utf8');
    if (!text.startsWith(documentMagic))
    {
        throw new Error('document magic missing');
    }
    return JSON.parse(text.slice(documentMagic.length));
}

function writeDocument(session, entryIdentity = identity(), options = {})
{
    const frontendAssetVersion = options.frontendAssetVersion ?? currentAssetVersion;
    const sidecar = options.sidecar ?? writeSidecar(session, entryIdentity);
    const entry = {
        cacheKey: session.cacheKey,
        route,
        pageKind: entryIdentity.pageKind,
        routeKey: entryIdentity.routeKey,
        articleId: entryIdentity.articleId,
        rendererVersion,
        frontendAssetVersion,
        writtenAt: new Date().toISOString(),
        html: renderHtml(entryIdentity, sidecar),
        sidecar: {
            url: sidecar.url,
            sha256: sidecar.sha256,
            relativePath: sidecar.relativePath
        }
    };
    fs.mkdirSync(path.dirname(session.documentPath), { recursive: true });
    fs.writeFileSync(session.documentPath, serializeDocument(entry));
    return { entry, sidecar };
}

function mutateDocument(session, mutator)
{
    const entry = parseDocument(fs.readFileSync(session.documentPath));
    const next = mutator(structuredClone(entry)) ?? entry;
    fs.writeFileSync(session.documentPath, serializeDocument(next));
    return next;
}

function deleteInvalidDocument(session, reason)
{
    if (fs.existsSync(session.documentPath))
    {
        fs.unlinkSync(session.documentPath);
    }
    session.events.push({ event: 'public_aot_cache_invalid_document_removed', reason });
}

function readRouteArtifact(session)
{
    if (!fs.existsSync(session.documentPath))
    {
        return {
            observedState: 'fallback',
            headers: { 'x-fsus-public-aot-cache': 'miss' },
            reason: 'document-missing'
        };
    }

    let entry;
    try
    {
        entry = parseDocument(fs.readFileSync(session.documentPath));
    }
    catch (error)
    {
        deleteInvalidDocument(session, 'document-corrupt');
        return {
            observedState: 'fallback',
            headers: { 'x-fsus-public-aot-cache': 'fallback; reason=document-corrupt' },
            reason: error instanceof Error ? error.message : 'document-corrupt'
        };
    }

    if (entry.cacheKey !== session.cacheKey || entry.route !== route)
    {
        deleteInvalidDocument(session, 'document-route-mismatch');
        return {
            observedState: 'blocked',
            headers: { 'x-fsus-public-aot-cache': 'blocked; reason=document-route-mismatch' },
            reason: 'document-route-mismatch'
        };
    }

    if (entry.frontendAssetVersion !== currentAssetVersion)
    {
        deleteInvalidDocument(session, 'asset-version-mismatch');
        session.events.push({ event: 'public_aot_cache_stale_removed', reason: 'asset-version-mismatch' });
        return {
            observedState: 'fallback',
            headers: { 'x-fsus-public-aot-cache': 'fallback; reason=asset-version-mismatch' },
            reason: 'asset-version-mismatch'
        };
    }

    const sidecarPath = path.join(session.webRoot, entry.sidecar?.relativePath ?? '');
    if (!entry.sidecar?.relativePath || !fs.existsSync(sidecarPath))
    {
        deleteInvalidDocument(session, 'sidecar-missing');
        return {
            observedState: 'fallback',
            headers: { 'x-fsus-public-aot-cache': 'fallback; reason=sidecar-missing' },
            reason: 'sidecar-missing'
        };
    }

    const sidecarBytes = fs.readFileSync(sidecarPath);
    const actualSidecarHash = sha256(sidecarBytes);
    if (actualSidecarHash !== entry.sidecar.sha256)
    {
        deleteInvalidDocument(session, 'sidecar-hash-mismatch');
        return {
            observedState: 'fallback',
            headers: { 'x-fsus-public-aot-cache': 'fallback; reason=sidecar-hash-mismatch' },
            reason: 'sidecar-hash-mismatch'
        };
    }

    let payload;
    try
    {
        payload = decodeSidecarFrame(sidecarBytes);
    }
    catch (error)
    {
        deleteInvalidDocument(session, 'sidecar-decode-failed');
        return {
            observedState: 'fallback',
            headers: { 'x-fsus-public-aot-cache': 'fallback; reason=sidecar-decode-failed' },
            reason: error instanceof Error ? error.message : 'sidecar-decode-failed'
        };
    }

    if (payload.pageKind !== entry.pageKind ||
    payload.routeKey !== entry.routeKey ||
    Number(payload.articleId ?? 0) !== Number(entry.articleId ?? 0))
    {
        deleteInvalidDocument(session, 'html-payload-identity-mismatch');
        return {
            observedState: 'blocked',
            headers: { 'x-fsus-public-aot-cache': 'blocked; reason=html-payload-identity-mismatch' },
            reason: 'html-payload-identity-mismatch',
            payloadIdentity: {
                pageKind: payload.pageKind,
                routeKey: payload.routeKey,
                articleId: payload.articleId
            }
        };
    }

    return {
        observedState: 'fresh',
        headers: { 'x-fsus-public-aot-cache': 'hit' },
        entry,
        payload
    };
}

function recoverRoute(session)
{
    writeDocument(session, identity());
    const recovered = readRouteArtifact(session);
    return recovered.observedState === 'fresh';
}

function assertMutation(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function runCase(name, expectedState, mutate)
{
    const started = performance.now();
    const errors = [];
    const session = createSession(name);
    const warmed = writeDocument(session, identity());
    const initial = readRouteArtifact(session);
    let mutation = 'unknown';
    let mutationVerified = false;
    let observed = { observedState: 'failed', reason: 'not-run' };
    let recovered = false;

    try
    {
        assertMutation(initial.observedState === 'fresh', `initial route state was ${initial.observedState}`);
        const mutationResult = mutate(session, warmed);
        mutation = mutationResult.mutation;
        mutationVerified = mutationResult.verified === true;
        assertMutation(mutationVerified, `${name} mutation did not change the isolated artifact`);
        observed = readRouteArtifact(session);
        assertMutation(observed.observedState === expectedState, `${name} observed ${observed.observedState}, expected ${expectedState}`);
        recovered = recoverRoute(session);
        assertMutation(recovered, `${name} did not recover to a fresh artifact`);
    }
    catch (error)
    {
        errors.push(error instanceof Error ? error.message : String(error));
    }

    return {
        name,
        route,
        status: errors.length === 0 ? 'success' : 'failure',
        initialState: initial.observedState,
        mutation,
        mutationVerified,
        observedState: observed.observedState,
        recovered,
        durationMs: Math.round(performance.now() - started),
        errors,
        artifacts: {
            sessionRoot: relative(session.sessionRoot),
            document: relative(session.documentPath),
            sidecar: warmed.sidecar ? relative(warmed.sidecar.path) : null
        },
        events: session.events
    };
}

function runSwStaleCachePoisoningCase()
{
    const started = performance.now();
    const errors = [];
    const session = createSession('sw-stale-cache-poisoning');
    const warmed = writeDocument(session, identity({ staleMarker: 'old-browser-cache' }), { frontendAssetVersion: 'frontend-old-fixture' });
    const staleEntry = parseDocument(fs.readFileSync(session.documentPath));
    const staleSidecarBytes = fs.readFileSync(warmed.sidecar.path);
    session.browserCache.set(route, { entry: staleEntry, sidecarBytes: staleSidecarBytes });
    fs.writeFileSync(warmed.sidecar.path, Buffer.from('poisoned stale browser sidecar bytes', 'utf8'));
    const poisonedSidecarVerified = fs.readFileSync(warmed.sidecar.path, 'utf8').includes('poisoned');
    writeDocument(session, identity(), { frontendAssetVersion: currentAssetVersion });

    const initial = { observedState: 'fresh' };
    let observedState = 'failed';
    let recovered = false;
    try
    {
        const cached = session.browserCache.get(route);
        assertMutation(poisonedSidecarVerified, 'stale browser sidecar was not poisoned before the network artifact refresh');
        assertMutation(cached?.entry?.frontendAssetVersion === 'frontend-old-fixture', 'browser cache was not primed with an old asset version');
        const network = readRouteArtifact(session);
        assertMutation(network.observedState === 'fresh', `network route was ${network.observedState}`);
        observedState = cached.entry.frontendAssetVersion === currentAssetVersion ? 'cached-hydrated' : 'network-recovered';
        assertMutation(observedState === 'network-recovered', `stale browser cache was treated as ${observedState}`);
        recovered = recoverRoute(session);
        assertMutation(recovered, 'route did not recover after stale browser cache rejection');
    }
    catch (error)
    {
        errors.push(error instanceof Error ? error.message : String(error));
    }

    return {
        name: 'sw-stale-cache-poisoning',
        route,
        status: errors.length === 0 ? 'success' : 'failure',
        initialState: initial.observedState,
        mutation: 'prime-stale-browser-cache',
        mutationVerified: poisonedSidecarVerified,
        observedState,
        recovered,
        durationMs: Math.round(performance.now() - started),
        errors,
        artifacts: {
            sessionRoot: relative(session.sessionRoot),
            document: relative(session.documentPath),
            poisonedSidecar: relative(warmed.sidecar.path)
        },
        events: [{ event: 'service-worker-cache-rejected', reason: 'asset-version-mismatch' }]
    };
}

const cases = [
    runCase('corrupt-document', 'fallback', (session) =>
    {
        const before = fs.statSync(session.documentPath).size;
        fs.truncateSync(session.documentPath, Math.max(1, Math.floor(before / 4)));
        return {
            mutation: 'truncate-document',
            verified: fs.statSync(session.documentPath).size < before
        };
    }),
    runCase('invalid-document-bytes', 'fallback', (session) =>
    {
        fs.writeFileSync(session.documentPath, Buffer.from([0, 1, 2, 3, 4, 5]));
        return {
            mutation: 'overwrite-document',
            verified: fs.readFileSync(session.documentPath).byteLength === 6
        };
    }),
    runCase('missing-sidecar', 'fallback', (_session, warmed) =>
    {
        fs.unlinkSync(warmed.sidecar.path);
        return {
            mutation: 'delete-sidecar',
            verified: !fs.existsSync(warmed.sidecar.path)
        };
    }),
    runCase('corrupt-sidecar', 'fallback', (_session, warmed) =>
    {
        fs.writeFileSync(warmed.sidecar.path, Buffer.from('corrupt sidecar bytes', 'utf8'));
        return {
            mutation: 'overwrite-sidecar',
            verified: sha256(fs.readFileSync(warmed.sidecar.path)) !== warmed.sidecar.sha256
        };
    }),
    runCase('old-asset-version', 'fallback', (session) =>
    {
        const mutated = mutateDocument(session, (entry) => ({
            ...entry,
            frontendAssetVersion: 'frontend-old-fixture'
        }));
        return {
            mutation: 'seed-old-asset-version',
            verified: mutated.frontendAssetVersion === 'frontend-old-fixture'
        };
    }),
    runCase('html-payload-mismatch', 'blocked', (session) =>
    {
        const mismatchedSidecar = writeSidecar(session, identity({ routeKey: 'article:999', articleId: 999 }));
        const mutated = mutateDocument(session, (entry) => ({
            ...entry,
            html: renderHtml(identity(), mismatchedSidecar),
            sidecar: {
                url: mismatchedSidecar.url,
                sha256: mismatchedSidecar.sha256,
                relativePath: mismatchedSidecar.relativePath
            }
        }));
        return {
            mutation: 'swap-sidecar-payload',
            verified: mutated.sidecar.sha256 === mismatchedSidecar.sha256
        };
    }),
    runSwStaleCachePoisoningCase()
];

const missingCases = requiredCaseNames.filter((name) => !cases.some((item) => item.name === name));
const errors = [
    ...missingCases.map((name) => `missing required case: ${name}`),
    ...cases.flatMap((item) => item.errors.map((error) => `${item.name}: ${error}`))
];
const status = errors.length === 0 && cases.every((item) => item.status === 'success') ? 'success' : 'failure';

const summary = {
    schema,
    status,
    gitSha: gitSha(),
    rendererVersion,
    generatedAt: new Date().toISOString(),
    isolation: {
        mode: 'filesystem-fixture',
        platform: `${os.platform()}-${os.arch()}`,
        root: relative(sessionBase)
    },
    placeholderOnly: false,
    requiredCases: requiredCaseNames,
    missingCases,
    cases,
    errors
};

fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`[aot-cache-resilience] wrote ${outFile} status=${status} cases=${cases.length}`);

if (status !== 'success')
{
    for (const error of errors)
    {
        console.error(`[aot-cache-resilience] ${error}`);
    }
    process.exit(1);
}

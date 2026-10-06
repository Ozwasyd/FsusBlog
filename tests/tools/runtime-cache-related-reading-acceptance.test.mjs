import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { digest, loadRuntimeCacheCatalog, sealReceipt, validateRuntimeCacheReceipt } = await import(new URL('../../tools/test/runtime-cache-evidence-contract.mjs', import.meta.url));
const { encodeAedsFrame } = await import(new URL('../frontend/support/aeds-envelope.mjs', import.meta.url));
const { relatedReadingResponseError } = await import(new URL('../../tools/test/runtime-cache-scenarios/related-reading-contract.mjs', import.meta.url));
const { produceRelatedReadingReceipt } = await import(new URL('../../tools/test/runtime-cache-scenarios/related-reading.mjs', import.meta.url));

const frames = JSON.parse(fs.readFileSync(new URL('../fixtures/runtime-cache-related-reading-responses.json', import.meta.url)));
const source = { commit: 'a'.repeat(40), dirty: false, statusDigest: digest('status'), worktreeFingerprint: digest('source') };
const catalog = loadRuntimeCacheCatalog();
const scenario = catalog.scenarios.find((item) => item.id === 'related-reading');

// Synthetic HTTP observation boundary for producer/checker regression tests only.
// These command rows never qualify as PostgreSQL/Redis/Kestrel runtime evidence.
async function collectFixture(t, { frame = 'valid', status = 200, coldCommands = 2, negative = false } = {})
{
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'related-reading-acceptance-'));
    const fixtureFile = path.join(directory, 'fixture.json');
    fs.writeFileSync(fixtureFile, JSON.stringify({ entities: [
        { producerId: 'public-content', kind: 'article', id: '17' },
        { producerId: 'public-content', kind: 'article', id: '18' }
    ] }));
    const observations = new Map();
    const built = new Set();
    const server = http.createServer((request, response) =>
    {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname.startsWith('/_fsus/testing/runtime-cache/observations/'))
        {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(observations.get(url.pathname.split('/').at(-1))));
            return;
        }
        const articleId = /^\/api\/binary\/article\/(\d+)\/related\.aeds$/u.exec(url.pathname)?.[1];
        const first = articleId && !built.has(articleId);
        if (articleId)
        {
            built.add(articleId);
        }
        const body = articleId ? Buffer.from(frames[frame], 'base64') : Buffer.from(encodeAedsFrame(13, Buffer.alloc(12)));
        const actualStatus = articleId ? status : 200;
        const id = request.headers['x-fsus-runtime-evidence-request'];
        const commandCount = first ? coldCommands : 0;
        observations.set(id, {
            requestId: id, method: 'GET', path: url.pathname, status: actualStatus,
            payloadDigest: digest(body), layerSource: first ? 'database' : 'l1-frame',
            latencyMs: first ? 3 : 1, allocatedBytes: 0,
            redisCommands: [], redisFailureEvents: [],
            cacheEvents: articleId ? [{ sequence: 1, elapsedMilliseconds: 1, family: 'related-reading',
        identityDigest: digest(`related-reading:${articleId}`), outcome: negative ? 'negative' : first ? 'built' : 'hit' }] : [],
            databaseFingerprints: Array.from({ length: commandCount }, () => digest('related-reading-sql')),
            databaseCommandCount: commandCount, databaseDroppedCommandCount: 0, databaseLateCommandCount: 0,
            databaseObservationStatus: 'complete', databaseAttributionComplete: true
        });
        response.writeHead(actualStatus, { 'content-type': 'application/octet-stream' });
        response.end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () =>
    {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    let producerError = null;
    const outputFile = path.join(directory, '.tmp/perf/runtime-cache/receipts/related-reading.json');
    try
    {
        await produceRelatedReadingReceipt({
            catalog, scenario, repositoryRoot: directory,
            identity: { source, fixtureFile, fixtureDigest: digest(fs.readFileSync(fixtureFile)),
                runtime: { digest: digest('runtime'), imageDigest: digest('image'), dotnetVersion: '10.0.0', processId: 42, kestrelUrl: baseUrl },
                dependencies: { postgres: { version: '18', topology: 'synthetic-test', digest: digest('postgres') },
                    redis: { version: '8', topology: 'synthetic-test', digest: digest('redis') } },
                machine: { os: 'test', arch: 'arm64', cpuModel: 'test', logicalCpuCount: 1, memoryBytes: 1024, runtime: 'node-test' } },
            baseUrl, secret: 'related-reading-regression-secret', runId: 'related-reading-regression',
            outputFile,
            captureSource: () => source,
            collectMemory: async () => ({ entries: 2, logicalBytes: 48, capacityBytes: 64, logicalBudgetBytes: 128,
                capacityBudgetBytes: 128, allocatedBytes: 0, gen0Collections: 0, gen1Collections: 0, gen2Collections: 0, residentBytes: 128 }),
            collectCleanup: async () => ({ status: 'passed', namespaceRemoved: true, activeKeyedEntries: 0,
                durableRowsBefore: 0, durableRowsAfter: 0, checkedAt: new Date().toISOString() })
        });
    }
    catch (error)
    {
        producerError = error;
    }
    const receipt = JSON.parse(fs.readFileSync(outputFile));
    return { directory, receipt, producerError,
        errors: () => validateRuntimeCacheReceipt(receipt, { catalog, repositoryRoot: directory, expectedSource: source }) };
}

function rewriteEvidence(fixture, mutate)
{
    const file = path.join(fixture.directory, fixture.receipt.rawEvidence.path);
    const raw = JSON.parse(fs.readFileSync(file));
    mutate(raw);
    const bytes = `${JSON.stringify(raw, null, 2)}\n`;
    fs.writeFileSync(file, bytes);
    fixture.receipt.requests = raw.requests;
    fixture.receipt.rawEvidence.digest = digest(bytes);
    fixture.receipt = sealReceipt(fixture.receipt);
    return validateRuntimeCacheReceipt(fixture.receipt, { catalog, repositoryRoot: fixture.directory, expectedSource: source });
}

test('related-reading captures 102 actual response bodies and qualifies expected-type CRC/parity plus command budgets', async (t) =>
{
    const fixture = await collectFixture(t);
    assert.equal(fixture.receipt.status, 'passed');
    assert.equal(fixture.producerError, null);
    assert.equal(fixture.receipt.requests.length, 102);
    assert.ok(fixture.receipt.requests.every((request) => relatedReadingResponseError(request) === null));
    assert.deepEqual(fixture.errors(), []);
    assert.deepEqual(fixture.receipt.assertions.find((item) => item.id === 'rebuild-count').actual, { 'same-key-100': 1 });
});

for (const [name, options, error] of [
    ['102 identical 404s cannot be hot-frame acceptance', { status: 404 }, /HTTP 404/u],
    ['same error-frame type cannot qualify even with HTTP 200', { frame: 'wrongType' }, /wrong AEDS frame type/u],
    ['corrupt CRC cannot qualify despite stable payload parity', { frame: 'badCrc' }, /crc_mismatch/u],
    ['non-AEDS bytes cannot qualify despite stable payload parity', { frame: 'notAeds' }, /aeds_/u],
    ['cold DB command count three cannot qualify', { coldCommands: 3 }, /cold database command budget/u],
    ['negative-cache events cannot qualify as hot frames', { negative: true }, /negative-cache/u]
])
{
    test(name, async (t) =>
    {
        const fixture = await collectFixture(t, options);
        assert.equal(fixture.receipt.status, 'failed');
        assert.notEqual(fixture.producerError, null);
        assert.notEqual(fixture.receipt.firstFailure, null);
        assert.match(fixture.errors().join('\n'), error);
        assert.ok(fs.existsSync(path.join(fixture.directory, '.tmp/perf/runtime-cache/receipts/first-failure.json')));
    });
}

test('independent checker rejects status-only forged pass without response bytes', async (t) =>
{
    const fixture = await collectFixture(t);
    const errors = rewriteEvidence(fixture, (raw) =>
    {
        for (const request of raw.requests)
        {
            delete request.responseBodyBase64;
        }
    });
    assert.match(errors.join('\n'), /required property 'responseBodyBase64'/u);
});

test('independent checker binds retained response bytes to the server-observed digest', async (t) =>
{
    const fixture = await collectFixture(t);
    const errors = rewriteEvidence(fixture, (raw) =>
    {
        raw.requests[0].responseBodyBase64 = frames.wrongType;
    });
    assert.match(errors.join('\n'), /do not match observed payload digest/u);
});

test('independent checker rejects a forged passed assertion for 102 identical negative-cache 404s', async (t) =>
{
    const fixture = await collectFixture(t);
    const errors = rewriteEvidence(fixture, (raw) =>
    {
        for (const request of raw.requests)
        {
            request.status = 404;
        }
        for (const event of raw.cacheEvents)
        {
            event.outcome = 'negative';
        }
    });
    assert.match(errors.join('\n'), /HTTP 404/u);
    assert.match(errors.join('\n'), /negative-cache/u);
});

test('independent checker enforces zero-command hot frame even if a producer assertion still says passed', async (t) =>
{
    const fixture = await collectFixture(t);
    const errors = rewriteEvidence(fixture, (raw) =>
    {
        const hot = raw.requests.find((request) => request.subcaseId === 'hot');
        raw.databaseCommands.push({ requestId: hot.id, subcaseId: 'hot', fingerprint: digest('unexpected-hot-sql'), source: raw.authority.database });
    });
    assert.match(errors.join('\n'), /hot frame must issue zero Redis\/database commands/u);
});

test('independent checker rejects burst/hot parity-group relabeling and detached article routes', async (t) =>
{
    const fixture = await collectFixture(t);
    const errors = rewriteEvidence(fixture, (raw) =>
    {
        const hot = raw.requests.find((request) => request.subcaseId === 'hot');
        hot.path = '/api/binary/article/999/related.aeds';
        hot.parityGroup = 'unrelated-hot-payload';
    });
    assert.match(errors.join('\n'), /related-reading route\/identity binding failed/u);
});

test('prepared published set delegates to the canonical port and live verifier rather than status-only CreateAsync', () =>
{
    const source = fs.readFileSync(new URL('../../src/backend/Services/Fixtures/PublicContentFixtureSeeder.cs', import.meta.url), 'utf8');
    const loop = source.slice(source.indexOf('foreach (SeedArticlePlan plan in publishedPlan)'), source.indexOf('if (requiresDeepPagination)', source.indexOf('foreach (SeedArticlePlan plan in publishedPlan)')));
    assert.match(loop, /publicationPort\.PublishAsync/u);
    assert.match(loop, /CanonicalArticlePublicationVerifier\.VerifyAsync/u);
    assert.match(loop, /ThrowIfInvalid\(\)/u);
    assert.doesNotMatch(loop, /CreateArticleAsync|Insertable<Article>|INSERT INTO article/u);
});

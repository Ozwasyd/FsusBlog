import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { mapCanonicalQueryExpectedModel } = await import(new URL('../../tools/data-scale/query-expected-model.mjs', import.meta.url));
const { computeSha256 } = await import(new URL('../../tools/data-scale/runtime-plan.mjs', import.meta.url));
const { buildQueryCaseRegistry, buildQuerySemanticOwnerInventory, queryCaseIdsForSchema, queryRegistrySchemas, threadReplyCaseId, relatedReadingCaseId } = await import(new URL('../../tools/data-scale/query-case-registry.mjs', import.meta.url));

const root = fileURLToPath(new URL('../..', import.meta.url));
const { extractArticleSearchHitIds, executeProductSearchHttpApi } = await import(new URL('../../tools/data-scale/search-evidence.mjs', import.meta.url));
const { loadQueryPayloadDecoders } = await import(new URL('../../tools/data-scale/query-payload-decoders.mjs', import.meta.url));
const { verifyQueryTraversal } = await import(new URL('../../tools/data-scale/query-matrix.mjs', import.meta.url));
const { encodeAedsFrame } = await import(new URL('../../tools/data-scale/aeds-decoders.mjs', import.meta.url));
const { runQueryMatrixFiles } = await import(new URL('../../tools/data-scale/run-query-matrix.mjs', import.meta.url));

test('real native intake precedes expected mapping and repeated file probes cannot admit verified flags', async () =>
{
    const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const directory = path.join(root, '.tmp/query-matrix-native-intake-controls', randomUUID());
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const collectorPath = process.env.FSUSBLOG_QUERY_INTAKE_COLLECTOR
        ?? path.join(root, 'tools/data-scale/query-plan-collector/bin/Release/net10.0/QueryPlanCollector.dll');
    const binding = { sourceCommit, dataScaleRunId: 'native-intake-refusal-control', fixtureGeneration: 'no-admitted-fixture',
        seedReceiptDigest: computeSha256('no-admitted-seed'), expectedModelDigest: computeSha256('no-admitted-model'),
        businessEpochUtc: '2026-10-08T00:00:00.000Z' };
    fs.writeFileSync(path.join(directory, 'query-binding.json'), JSON.stringify(binding), { mode: 0o600 });
    // Ordinary negative inputs are not producer objects or physical receipts.
    fs.writeFileSync(path.join(directory, 'query-expected-input.json'), JSON.stringify({ registrySchema: queryRegistrySchemas[2],
        normalizedRoles: { verified: true }, production: { verified: true, committed: true }, articles: {} }), { mode: 0o600 });
    const oldFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () =>
    {
        calls += 1;
        throw new Error('must not call HTTP');
    };
    try
    {
        for (let attempt = 0; attempt < 2; attempt += 1)
        {
            const result = await runQueryMatrixFiles({ tier: 'scale-xs', directory, collectorPath });
            assert.equal(result.status, 'failed');
            assert.equal(result.qualification, 'not-performed');
            assert.equal(result.results.length, 18);
            const refusal = JSON.parse(fs.readFileSync(path.join(directory, 'query-producer-intake.json')));
            assert.equal(refusal.sourceCommit, sourceCommit);
            assert.equal(refusal.originalProducerObjectsSupplied, false);
            assert.equal(refusal.releaseEvidenceEligible, false);
            if (process.env.FSUSBLOG_QUERY_INTAKE_COLLECTOR)
            {
                assert.equal(refusal.originalInterfacesLinked, true);
                assert.equal(refusal.roleBlockers.length, 4);
                assert.equal(refusal.postgresBlockers.length, 11);
            }
        }
        assert.equal(calls, 0);
        const wrongOutput = path.join(directory, 'wrong-source.json');
        const wrong = spawnSync('dotnet', [collectorPath, '--producer-intake', wrongOutput, '0'.repeat(40)],
            { cwd: root, encoding: 'utf8', timeout: 30_000 });
        assert.equal(wrong.status, 1);
        assert.equal(fs.existsSync(wrongOutput), false);
    }
    finally
    {
        globalThis.fetch = oldFetch;
    }
});

test('semantic owner metadata resolves original compiled business contracts and refuses nonexistent methods', () =>
{
    const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const directory = path.join(root, '.tmp/query-matrix-semantic-owner-controls', randomUUID());
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const kinds = { article: ['top-list', 'prev-next', 'search-no-hit', 'cache-consistency', 'aot-consistency', 'hot-read-consistency'],
        comment: ['public-thread', 'moderation-queue', 'approved-visibility', 'pending-visibility', 'rejected-visibility', 'hidden-visibility',
            'region-filter', 'actor-filter', 'permission-filter', 'deleted-root', 'deleted-reply'] };
    const inventory = buildQuerySemanticOwnerInventory({ kinds,
        binding: { sourceCommit, dataScaleRunId: 'semantic-owner-control', fixtureGeneration: 'source-only',
            seedReceiptDigest: computeSha256('controlled-no-admission'), expectedModelDigest: computeSha256('controlled-no-model'),
            businessEpochUtc: '2026-10-08T00:00:00.000Z' } });
    assert.equal(inventory.requirements.length, 17);
    assert.ok(inventory.requirements.every((row) => row.existingCaseIds.length === 0 && row.qualification === false));
    const inventoryPath = path.join(directory, 'inventory.json');
    const run = (document) =>
    {
        fs.writeFileSync(inventoryPath, JSON.stringify(document), { mode: 0o600 });
        return spawnSync('dotnet', [path.join(root, 'tools/data-scale/query-plan-collector/bin/Release/net10.0/QueryPlanCollector.dll'),
            '--semantic-owner-controls', inventoryPath, directory, sourceCommit], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    };
    const result = run(inventory);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const control = JSON.parse(fs.readFileSync(path.join(directory, 'semantic-owner-controls.json')));
    assert.equal(control.sourceCommit, sourceCommit);
    assert.equal(control.inventoryDigest, inventory.contentDigest);
    assert.equal(control.scope, 'compiled-business-contract-metadata-only');
    assert.equal(control.qualification, 'not-performed');
    assert.equal(new Set(control.results.map((row) => `${row.domain}:${row.kind}`)).size, 17);
    const invalid = structuredClone(inventory);
    invalid.requirements[0].businessOwners[0].entrypoint += 'Missing';
    assert.equal(run(invalid).status, 1);
    const wrongOverload = structuredClone(inventory);
    const verifier = wrongOverload.requirements.find((row) => row.kind === 'cache-consistency').businessOwners[0];
    assert.equal(verifier.parameterTypes.length, 3);
    verifier.parameterTypes[1] = 'FsusBlog.Server.Services.Fixtures.CanonicalArticlePublicationFixtureBinding';
    assert.equal(run(wrongOverload).status, 1);
    const malformedSignature = structuredClone(inventory);
    malformedSignature.requirements.find((row) => row.kind === 'aot-consistency').businessOwners[0].parameterTypes[1] = '';
    assert.equal(run(malformedSignature).status, 1);
    fs.writeFileSync(inventoryPath, JSON.stringify(inventory), { mode: 0o600 });
});

test('all original registry coordinates select production GET routes and extensionless details remain unmatched', () =>
{
    const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const directory = path.join(root, '.tmp/query-matrix-route-controls', randomUUID());
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const registry = buildQueryCaseRegistry({
        tier: 'scale-s', registrySchema: queryRegistrySchemas[2],
        threadReplies: { articleId: 1, rootId: '1', pageSize: 1, expectedReplies: [] },
        relatedReading: { articleId: 1, related: [], previous: null, next: null },
        binding: { sourceCommit, dataScaleRunId: 'route-control', fixtureGeneration: 'route-control',
            seedReceiptDigest: computeSha256('controlled-route-seed'), expectedModelDigest: computeSha256('controlled-route-model'),
            businessEpochUtc: '2026-10-08T00:00:00.000Z' },
        publicArticles: Array.from({ length: 35 }, (_, index) => ({ id: index + 1, title: `article ${index + 1}`,
            body: `body ${index + 1}`, createTime: '2026-10-08T00:00:00.000Z', categoryId: 1, tagIds: [1] })),
        visibleComments: [
            ...[1, 2, 3].map((id) => ({ id: String(id), articleId: 1, rootId: null, parentId: null,
                content: 'controlled root', createTime: '2026-10-08T00:00:00.000Z' })),
            { id: '4', articleId: 1, rootId: '1', parentId: '1', content: 'controlled child', createTime: '2026-10-08T00:00:00.000Z' }
        ],
        categories: [{ id: 1, name: 'largest' }, { id: 2, name: 'empty' }],
        tags: [{ id: 1, name: 'largest' }, { id: 2, name: 'empty' }],
        canaries: { commentArticleId: 1, nestedRootId: '1', titleSearch: { token: 'title', articleIds: [1] }, bodySearch: { token: 'body', articleIds: [1] } }
    });
    const registryPath = path.join(directory, 'registry.json');
    fs.writeFileSync(registryPath, JSON.stringify(registry), { mode: 0o600 });
    const command = spawnSync('dotnet', [path.join(root, 'tools/data-scale/query-plan-collector/bin/Release/net10.0/QueryPlanCollector.dll'),
        '--route-controls', registryPath, directory, sourceCommit], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assert.equal(command.status, 0, `${command.stdout}\n${command.stderr}`);
    const control = JSON.parse(fs.readFileSync(path.join(directory, 'route-controls.json')));
    assert.equal(control.sourceCommit, sourceCommit);
    assert.equal(control.registryDigest, registry.contentDigest);
    assert.equal(control.qualification, 'not-performed');
    assert.equal(control.scope, 'original-endpoint-registration-and-routing-only');
    assert.deepEqual(control.results.filter((entry) => entry.status === 'matched').map((entry) => entry.id), queryCaseIdsForSchema(registry.schema));
    assert.equal(control.results.find((entry) => entry.id === threadReplyCaseId).runtimeExecutionBlocked, true);
    assert.equal(control.results.filter((entry) => entry.status === 'unmatched').length, 2);
});

test('related/prev-next probe consumes original POD and preserves aliases while refusing malformed projections', async () =>
{
    const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const directory = path.join(root, '.tmp/query-matrix-related-controls', randomUUID());
    const native = spawnSync('dotnet', [path.join(root, 'tools/data-scale/query-plan-collector/bin/Release/net10.0/QueryPlanCollector.dll'),
        '--related-payload-controls', directory, sourceCommit], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assert.equal(native.status, 0, native.stderr);
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'related-payload-controls.json')));
    assert.equal(receipt.sourceCommit, sourceCommit);
    assert.equal(receipt.qualification, 'not-performed');
    const binding = { sourceCommit, dataScaleRunId: 'related-codec-control', fixtureGeneration: 'codec-only',
        seedReceiptDigest: computeSha256('no-admitted-seed'), expectedModelDigest: computeSha256('no-admitted-model'),
        businessEpochUtc: '2026-10-08T00:00:00.000Z' };
    const row = { id: 2, title: 'neighbor', summary: null, createTime: binding.businessEpochUtc, reason: 'related-control' };
    const relatedReading = { articleId: 1, related: [row], previous: { ...row, reason: 'previous-control' },
        next: { ...row, id: 3, title: 'next', summary: 'next-summary', reason: 'next-control' } };
    const registry = buildQueryCaseRegistry({ tier: 'scale-xs', binding, registrySchema: queryRegistrySchemas[2], relatedReading,
        publicArticles: [], visibleComments: [], categories: [], tags: [], canaries: {} });
    const coordinate = registry.cases.at(-1).coordinate;
    const decode = (await loadQueryPayloadDecoders(registry.schema))[relatedReadingCaseId];
    const payload = new Uint8Array(Buffer.from(receipt.payload, 'base64'));
    assert.deepEqual(decode(payload), coordinate.expectedPayloadProjection);
    assert.deepEqual(decode(new Uint8Array(Buffer.from(receipt.emptyPayload, 'base64'))), { related: [], previous: null, next: null });
    const sample = { binding, path: coordinate.path, status: 200, contentType: 'application/octet-stream', inputCursor: null,
        body: encodeAedsFrame(coordinate.frameType, payload) };
    assert.deepEqual(verifyQueryTraversal({ coordinate, binding, samples: [sample], decode }), { itemCount: 3, pageCount: 1 });
    const swapped = structuredClone(coordinate);
    [swapped.expectedPayloadProjection.previous, swapped.expectedPayloadProjection.next]
        = [swapped.expectedPayloadProjection.next, swapped.expectedPayloadProjection.previous];
    assert.throws(() => verifyQueryTraversal({ coordinate: swapped, binding, samples: [sample], decode }));
    assert.throws(() => verifyQueryTraversal({ coordinate, binding, samples: [sample, sample], decode }));
    const set = (offset, value) => (bytes) =>
    {
        new DataView(bytes.buffer).setInt32(offset, value, true);
        return bytes;
    };
    for (const alter of [(bytes) => bytes.slice(0, -1), (bytes) => Uint8Array.from([...bytes, 0]),
        set(0, 7), set(24, -1), set(28, 2147483647), set(128, 2147483647),
        (bytes) =>
        {
            bytes[4] = 2;
            return bytes;
        },
        (bytes) =>
        {
            bytes[20] = 2;
            return bytes;
        },
        (bytes) =>
        {
            bytes[132] = 0xff;
            return bytes;
        }])
    {
        assert.throws(() => decode(alter(payload.slice())));
    }
});

test('original canonical factory/verifier/visibility export mapped read expectations with refusal controls', () =>
{
    const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const directory = path.join(root, '.tmp/query-matrix-expected-controls', randomUUID());
    const command = spawnSync('dotnet', [path.join(root, 'tools/data-scale/query-plan-collector/bin/Release/net10.0/QueryPlanCollector.dll'),
        '--expected-controls', directory, sourceCommit], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assert.equal(command.status, 0, command.stderr);
    const control = JSON.parse(fs.readFileSync(path.join(directory, 'controls.json')));
    assert.equal(control.sourceCommit, sourceCommit);
    assert.equal(control.qualification, 'not-performed');
    assert.equal(control.results.length, 8);
    for (const tier of ['scale-xs', 'scale-s'])
    {
        const articles = JSON.parse(fs.readFileSync(path.join(directory, `${tier}.json`)));
        assert.equal(articles.publicArticles.length > 0, true);
        if (tier === 'scale-xs')
        {
            assert.equal(articles.publicArticles.length, 1);
        }
        const comments = { sourceCommit, businessEpochUtc: articles.businessEpochUtc, dataScaleRunId: 'expected-control',
            fixtureGeneration: 'controlled-map', seedReceiptDigest: articles.seedReceiptDigest, visibleComments: [] };
        const canaries = {};
        const model = { tier, articlePlanDigest: articles.planDigest, articleGraphDigest: articles.graphDigest,
            publicArticles: articles.publicArticles, visibleComments: [], categories: articles.categories, tags: articles.tags, canaries };
        const binding = { sourceCommit, businessEpochUtc: articles.businessEpochUtc, dataScaleRunId: comments.dataScaleRunId,
            fixtureGeneration: comments.fixtureGeneration, seedReceiptDigest: comments.seedReceiptDigest, expectedModelDigest: computeSha256(model) };
        assert.deepEqual(mapCanonicalQueryExpectedModel({ articles, comments, canaries, binding }), model);
        assert.throws(() => mapCanonicalQueryExpectedModel({ articles: { ...articles, sourceCommit: 'a'.repeat(40) }, comments, canaries, binding }));
        assert.throws(() => mapCanonicalQueryExpectedModel({ articles: { ...articles, dataScaleRunId: 'other-run' }, comments, canaries, binding }));
        assert.throws(() => mapCanonicalQueryExpectedModel({ articles: { ...articles, fixtureGeneration: 'other-generation' }, comments, canaries, binding }));
        assert.throws(() => mapCanonicalQueryExpectedModel({ articles: { ...articles, seedReceiptDigest: computeSha256('other-seed') }, comments, canaries, binding }));
        assert.throws(() => mapCanonicalQueryExpectedModel({ articles, comments: { ...comments, fixtureGeneration: 'different' }, canaries, binding }));
        assert.throws(() => mapCanonicalQueryExpectedModel({ articles, comments, canaries: { commentArticleId: 999 }, binding }));
    }
});


test('thread reply case verifies original product POD traversal and rejects bounded invalid formats', async () =>
{
    const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const directory = path.join(root, '.tmp/query-matrix-thread-controls', randomUUID());
    const native = spawnSync('dotnet', [path.join(root, 'tools/data-scale/query-plan-collector/bin/Release/net10.0/QueryPlanCollector.dll'),
        '--thread-payload-controls', directory, sourceCommit], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assert.equal(native.status, 0, native.stderr);
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'thread-payload-controls.json')));
    assert.equal(receipt.sourceCommit, sourceCommit);
    assert.equal(receipt.qualification, 'not-performed');
    assert.equal(receipt.scope, 'original-production-POD-encoder-only');
    const binding = { sourceCommit, dataScaleRunId: 'thread-codec-control', fixtureGeneration: 'codec-only',
        seedReceiptDigest: computeSha256('no-admitted-seed'), expectedModelDigest: computeSha256('no-admitted-model'),
        businessEpochUtc: '2026-10-08T00:00:00.000Z' };
    const threadReplies = { articleId: 1, rootId: '1', pageSize: 1,
        expectedReplies: [
            { id: '2', rootId: '1', parentId: '1', depth: 1, content: 'child', createTime: binding.businessEpochUtc, isDeleted: false, isEdited: false },
            { id: '3', rootId: '1', parentId: '2', depth: 2, content: 'descendant', createTime: binding.businessEpochUtc, isDeleted: false, isEdited: true }
        ] };
    const registry = buildQueryCaseRegistry({ tier: 'scale-xs', binding, registrySchema: queryRegistrySchemas[1], threadReplies,
        publicArticles: [], visibleComments: [], categories: [], tags: [], canaries: {} });
    const coordinate = registry.cases.at(-1).coordinate;
    const decoders = await loadQueryPayloadDecoders(registry.schema);
    assert.equal(Object.keys(await loadQueryPayloadDecoders()).length, 16);
    const decode = decoders[threadReplyCaseId];
    const payloads = receipt.payloads.map((value) => new Uint8Array(Buffer.from(value, 'base64')));
    const samples = payloads.map((payload, index) => ({ binding, path: coordinate.path,
        inputCursor: index === 0 ? null : '2', status: 200, contentType: 'application/octet-stream',
        body: encodeAedsFrame(coordinate.frameType, payload) }));
    assert.deepEqual(verifyQueryTraversal({ coordinate, samples, binding, decode }), { itemCount: 2, pageCount: 2 });
    assert.throws(() => verifyQueryTraversal({ coordinate, samples: samples.slice(0, 1), binding, decode }), /omitted/u);
    const wrongCursor = structuredClone(samples);
    const cursorPayload = payloads[0].slice();
    new DataView(cursorPayload.buffer).setBigInt64(8, 99n, true);
    wrongCursor[0].body = encodeAedsFrame(coordinate.frameType, cursorPayload);
    wrongCursor[1].inputCursor = '99';
    assert.throws(() => verifyQueryTraversal({ coordinate, samples: wrongCursor, binding, decode }), /last returned/u);
    const wrongRoot = { ...coordinate, threadRootId: '99' };
    assert.throws(() => verifyQueryTraversal({ coordinate: wrongRoot, samples, binding, decode }), /root/u);
    const duplicate = structuredClone(samples);
    const duplicatePayload = payloads[0].slice();
    duplicatePayload.fill(0, 8, 16);
    duplicatePayload[16] = 0;
    duplicate[1].body = encodeAedsFrame(coordinate.frameType, duplicatePayload);
    assert.throws(() => verifyQueryTraversal({ coordinate, samples: duplicate, binding, decode }), /membership/u);
    for (const alter of [
        (payload) => payload.slice(0, -1),
        (payload) => Uint8Array.from([...payload, 0]),
        (payload) =>
        {
            payload[16] = 2;
            return payload;
        },
        (payload) =>
        {
            new DataView(payload.buffer).setInt32(17, 101, true);
            return payload;
        },
        (payload) =>
        {
            new DataView(payload.buffer).setInt32(81, -1, true);
            return payload;
        },
        (payload) =>
        {
            new DataView(payload.buffer).setBigInt64(0, 99n, true);
            return payload;
        }
    ])
    {
        assert.throws(() => decode(alter(payloads[0].slice())));
    }
    // Encoder/adapter controls do not admit a fixture or execute a product query case.
    assert.equal(registry.cases.at(-1).status, 'blocked');
});


test('search extractor honors current original FAS4 and explicit fixed-POD contracts with bounded refusal', () =>
{
    const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const directory = path.join(root, '.tmp/query-matrix-search-codec-controls', randomUUID());
    const native = spawnSync('dotnet', [path.join(root, 'tools/data-scale/query-plan-collector/bin/Release/net10.0/QueryPlanCollector.dll'),
        '--search-payload-controls', directory, sourceCommit], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assert.equal(native.status, 0, native.stderr);
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'search-payload-controls.json')));
    assert.equal(receipt.sourceCommit, sourceCommit);
    assert.equal(receipt.qualification, 'not-performed');
    assert.equal(receipt.contract, 'fas4-v4');
    const payload = new Uint8Array(Buffer.from(receipt.payload, 'base64'));
    assert.deepEqual(extractArticleSearchHitIds(payload), [1]);
    const legacy = new Uint8Array(Buffer.from(receipt.legacyEmptyPayload, 'base64'));
    assert.deepEqual(extractArticleSearchHitIds(legacy, { contract: 'fixed-pod' }), []);
    assert.throws(() => extractArticleSearchHitIds(legacy));
    assert.throws(() => extractArticleSearchHitIds(payload, { contract: 'fixed-pod' }));
    assert.throws(() => extractArticleSearchHitIds(payload, { contract: 'guessed-fsr4' }), /unavailable/u);
    for (const alter of [
        (bytes) => bytes.slice(0, -1),
        (bytes) => Uint8Array.from([...bytes, 0]),
        (bytes) =>
        {
            bytes.set(Buffer.from('FSR4'), 0);
            return bytes;
        },
        (bytes) =>
        {
            new DataView(bytes.buffer).setInt32(4, 5, true);
            return bytes;
        },
        (bytes) =>
        {
            new DataView(bytes.buffer).setInt32(8, 10001, true);
            return bytes;
        },
        (bytes) =>
        {
            new DataView(bytes.buffer).setInt32(432, -1, true);
            return bytes;
        },
        (bytes) =>
        {
            new DataView(bytes.buffer).setInt32(436, 2147483647, true);
            return bytes;
        }
    ])
    {
        assert.throws(() => extractArticleSearchHitIds(alter(payload.slice())));
    }
    const empty = payload.slice(0, 12);
    new DataView(empty.buffer).setInt32(8, 0, true);
    assert.deepEqual(extractArticleSearchHitIds(empty), []);
    // This is the current source contract, not a relabeled or accepted FSR4 candidate.
});

test('single extractor decodes original native FSR4 pages only by explicit contract and rejects malformed HTTP payloads', async () =>
{
    const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const directory = path.join(root, '.tmp/query-matrix-search-codec-controls', randomUUID());
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const nativeSource = 'src/frontend/wasm/search/src/search_index.cpp';
    const harness = path.join(directory, 'control.cpp');
    fs.writeFileSync(harness, `#include "${path.join(root, nativeSource)}"
#include <fstream>
int main(int argc, char** argv)
{
    if (argc != 3) return 1;
    static_assert(KSearchResultMagic == 0x34525346u && KSearchResultVersion == 4u);
    SearchDoc first{};
    first.ArticleId = 1; first.CategoryId = 1; first.RevisionId = 11; first.RevisionNo = 1;
    first.PublicationId = 21; first.PublicationNo = 1;
    first.Title = "codec control"; first.Summary = "control only"; first.CategoryName = "category";
    first.Tags = {{1, "tag"}, {2, "中文"}};
    SearchDoc second = first; second.ArticleId = 2; second.Tags.clear();
    t_state.Docs = {first, second};
    BuildBinaryPage({ScoreEntry{0}, ScoreEntry{1}}, 1, 2);
    std::ofstream(argv[1], std::ios::binary).write(t_lastResult.data(), t_lastResult.size());
    BuildBinaryPage({}, 1, 2);
    std::ofstream(argv[2], std::ios::binary).write(t_lastResult.data(), t_lastResult.size());
}
`, { mode: 0o600 });
    const binary = path.join(directory, 'control');
    const compile = spawnSync('g++', ['-std=c++23', '-O0', harness, '-o', binary], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assert.equal(compile.status, 0, compile.stderr);
    const payloadPath = path.join(directory, 'page.bin');
    const emptyPath = path.join(directory, 'empty.bin');
    const native = spawnSync(binary, [payloadPath, emptyPath], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assert.equal(native.status, 0, native.stderr);
    const payload = new Uint8Array(fs.readFileSync(payloadPath));
    const empty = new Uint8Array(fs.readFileSync(emptyPath));
    const decode = (bytes) => extractArticleSearchHitIds(bytes, { contract: 'fsr4-v4' });
    assert.deepEqual(decode(payload), [1, 2]);
    assert.deepEqual(decode(empty), []);
    assert.throws(() => extractArticleSearchHitIds(payload));
    assert.throws(() => extractArticleSearchHitIds(payload, { contract: 'fixed-pod' }));
    const changeI32 = (offset, value) => (bytes) =>
    {
        new DataView(bytes.buffer).setInt32(offset, value, true);
        return bytes;
    };
    const refusals = [
        (bytes) => bytes.slice(0, -1), (bytes) => Uint8Array.from([...bytes, 0]),
        changeI32(0, 0x34534146), changeI32(4, 5), changeI32(8, 1), changeI32(12, -1), changeI32(12, 10001),
        changeI32(16, 25), changeI32(20, payload.length + 1), changeI32(20, 177),
        changeI32(24, 0), changeI32(100, 1), changeI32(68, 1), changeI32(72, -1), changeI32(72, 1001),
        changeI32(76, 0), changeI32(84, 0), changeI32(96, 0),
        changeI32(44, -1), changeI32(48, 2147483647), changeI32(180, -1),
        (bytes) =>
        {
            bytes[new DataView(bytes.buffer).getInt32(20, true)] = 0xff;
            return bytes;
        }
    ];
    for (const alter of refusals)
    {
        assert.throws(() => decode(alter(payload.slice())));
    }
    // Ordinary transport controls exercise the real extractor, with no live product/index receipt.
    const execute = (bytes, payloadContract) => executeProductSearchHttpApi({ baseUrl: 'http://codec-control.invalid',
        query: 'codec-control', payloadContract, fetchImpl: async () => new Response(encodeAedsFrame(4, bytes), { status: 200 }) });
    const accepted = await execute(payload, 'fsr4-v4');
    assert.equal(accepted.status, 'ok');
    assert.deepEqual(accepted.articleIds, [1, 2]);
    assert.equal(accepted.payloadContract, 'fsr4-v4');
    for (const [bytes, contract] of [[payload, undefined], [payload, 'unknown'], [empty.slice(0, -1), 'fsr4-v4']])
    {
        const refused = await execute(bytes, contract);
        assert.equal(refused.status, 'failed');
        assert.ok(refused.errors.some((error) => error.startsWith('search_api_protocol_invalid:')));
    }
    const sourceBlob = spawnSync('git', ['rev-parse', `HEAD:${nativeSource}`], { cwd: root, encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(directory, 'fsr4-controls.json'), JSON.stringify({ sourceCommit, nativeSource, sourceBlob,
        contract: 'fsr4-v4', selectedContractSource: 'aa67f031d453f0040d621992f8123caaf8a19c97',
        scope: 'original-native-search-page-encoder-and-ordinary-transport-controls-only', qualification: 'not-performed',
        payloadDigest: computeSha256(Buffer.from(payload).toString('base64')), compileExit: compile.status, nativeExit: native.status,
        refusedFormats: refusals.length, acceptedIds: accepted.articleIds }, null, 2), { mode: 0o600 });
});

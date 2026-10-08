import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { mapCanonicalQueryExpectedModel } = await import(new URL('../../tools/data-scale/query-expected-model.mjs', import.meta.url));
const { computeSha256 } = await import(new URL('../../tools/data-scale/runtime-plan.mjs', import.meta.url));
const { buildQueryCaseRegistry, buildQuerySemanticOwnerInventory, queryCaseIds, queryRegistrySchemas, threadReplyCaseId } = await import(new URL('../../tools/data-scale/query-case-registry.mjs', import.meta.url));

const root = fileURLToPath(new URL('../..', import.meta.url));
const { extractArticleSearchHitIds } = await import(new URL('../../tools/data-scale/search-evidence.mjs', import.meta.url));
const { loadQueryPayloadDecoders } = await import(new URL('../../tools/data-scale/query-payload-decoders.mjs', import.meta.url));
const { verifyQueryTraversal } = await import(new URL('../../tools/data-scale/query-matrix.mjs', import.meta.url));
const { encodeAedsFrame } = await import(new URL('../../tools/data-scale/aeds-decoders.mjs', import.meta.url));

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
        tier: 'scale-s', registrySchema: queryRegistrySchemas[1],
        threadReplies: { articleId: 1, rootId: '1', pageSize: 1, expectedReplies: [] },
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
    assert.deepEqual(control.results.filter((entry) => entry.status === 'matched').map((entry) => entry.id), [...queryCaseIds, threadReplyCaseId]);
    assert.equal(control.results.find((entry) => entry.id === threadReplyCaseId).runtimeExecutionBlocked, true);
    assert.equal(control.results.filter((entry) => entry.status === 'unmatched').length, 2);
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
        (payload) => { payload[16] = 2; return payload; },
        (payload) => { new DataView(payload.buffer).setInt32(17, 101, true); return payload; },
        (payload) => { new DataView(payload.buffer).setInt32(81, -1, true); return payload; },
        (payload) => { new DataView(payload.buffer).setBigInt64(0, 99n, true); return payload; }
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
        (bytes) => { bytes.set(Buffer.from('FSR4'), 0); return bytes; },
        (bytes) => { new DataView(bytes.buffer).setInt32(4, 5, true); return bytes; },
        (bytes) => { new DataView(bytes.buffer).setInt32(8, 10001, true); return bytes; },
        (bytes) => { new DataView(bytes.buffer).setInt32(432, -1, true); return bytes; },
        (bytes) => { new DataView(bytes.buffer).setInt32(436, 2147483647, true); return bytes; }
    ])
    {
        assert.throws(() => extractArticleSearchHitIds(alter(payload.slice())));
    }
    const empty = payload.slice(0, 12);
    new DataView(empty.buffer).setInt32(8, 0, true);
    assert.deepEqual(extractArticleSearchHitIds(empty), []);
    // This is the current source contract, not a relabeled or accepted FSR4 candidate.
});

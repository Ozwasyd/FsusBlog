import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { mapCanonicalQueryExpectedModel } = await import(new URL('../../tools/data-scale/query-expected-model.mjs', import.meta.url));
const { computeSha256 } = await import(new URL('../../tools/data-scale/runtime-plan.mjs', import.meta.url));
const { buildQueryCaseRegistry, buildQuerySemanticOwnerInventory, queryCaseIds } = await import(new URL('../../tools/data-scale/query-case-registry.mjs', import.meta.url));

const root = fileURLToPath(new URL('../..', import.meta.url));

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
    fs.writeFileSync(inventoryPath, JSON.stringify(inventory), { mode: 0o600 });
});

test('all original registry coordinates select production GET routes and extensionless details remain unmatched', () =>
{
    const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const directory = path.join(root, '.tmp/query-matrix-route-controls', randomUUID());
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const registry = buildQueryCaseRegistry({
        tier: 'scale-s',
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
    assert.deepEqual(control.results.filter((entry) => entry.status === 'matched').map((entry) => entry.id), queryCaseIds);
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

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { computeSha256 } = await import(new URL('../../tools/data-scale/runtime-plan.mjs', import.meta.url));
const { buildQueryCaseInventory, buildQueryCaseRegistry, buildQuerySemanticOwnerInventory, queryCaseIds, queryCaseIdsForSchema, queryRegistrySchemas, queryMatrixTiers, threadReplyCaseId, relatedReadingCaseId } = await import(new URL('../../tools/data-scale/query-case-registry.mjs', import.meta.url));
const { compareQueryTrends, evaluateQueryCase, evaluateQueryMatrix, sqlFingerprint, summarizeActualPlan, validateQueryPolicy, verifyQueryTraversal } = await import(new URL('../../tools/data-scale/query-matrix.mjs', import.meta.url));
const { decodeAedsFrame, decodeTaxonomyList, encodeAedsFrame, encodeTaxonomyList } = await import(new URL('../../tools/data-scale/aeds-decoders.mjs', import.meta.url));
const { runQueryMatrix, runQueryMatrixFiles } = await import(new URL('../../tools/data-scale/run-query-matrix.mjs', import.meta.url));
const { buildSemanticProofReceipt, verifySemanticProofReceipt } = await import(new URL('../../tools/data-scale/semantic-proof.mjs', import.meta.url));
const { buildProductBackendEnvironment, writeProductBackendEnvironmentFile } = await import(new URL('../../tools/data-scale/product-backend.mjs', import.meta.url));

// Controlled decoder and plan fixtures test the evaluator, not runtime admission.
const decodeControlled = (body) => JSON.parse(Buffer.from(body).toString('utf8'));
const controlledBody = (frameType, payload) => encodeAedsFrame(frameType, Buffer.from(JSON.stringify(payload)));
const binding = {
    sourceCommit: 'a'.repeat(40),
    dataScaleRunId: 'query-matrix-unit',
    fixtureGeneration: 'fixture-unit',
    seedReceiptDigest: computeSha256('seed-unit'),
    expectedModelDigest: computeSha256('canonical-model-unit'),
    businessEpochUtc: '2024-02-29T23:59:59.000Z'
};

function fixture(tier = 'scale-s')
{
    return {
        tier,
        binding,
        publicArticles: Array.from({ length: 35 }, (_, index) => ({
            id: index + 1,
            title: `article ${index + 1}`,
            body: `body ${index + 1}`,
            createTime: '2024-02-29T10:00:00.000Z',
            categoryId: 1,
            tagIds: [1]
        })),
        visibleComments: [
            ...Array.from({ length: 35 }, (_, index) => ({
                id: String(index + 1), articleId: 1, parentId: null, rootId: null,
                content: `root ${index + 1}`, createTime: '2024-02-29T10:00:00.000Z'
            })),
            { id: '36', articleId: 1, parentId: '1', rootId: '1', content: 'nested child', createTime: '2024-02-29T10:00:00.000Z' }
        ],
        categories: [{ id: 1, name: 'largest category' }, { id: 2, name: 'empty category' }],
        tags: [{ id: 1, name: 'largest tag' }, { id: 2, name: 'empty tag' }],
        canaries: { commentArticleId: 1, nestedRootId: '1', titleSearch: { token: 'title-only', articleIds: [1] }, bodySearch: { token: 'body-only', articleIds: [1] } }
    };
}

test('source inventory preserves all cases and exposes semantic and scenario gaps without claiming coverage', () =>
{
    const inventory = buildQueryCaseInventory(binding);
    assert.deepEqual(inventory.cases.map((entry) => entry.id), queryCaseIds);
    assert.deepEqual(buildQueryCaseRegistry(fixture()).inventory, inventory);
    assert.equal(inventory.qualification, 'not-performed');
    assert.equal(inventory.releaseEvidenceEligible, false);
    const kinds = [...new Set(inventory.cases.map((entry) => entry.kind).filter(Boolean))].sort();
    assert.deepEqual(kinds, ['category-filter', 'detail', 'latest-list', 'pagination-order', 'public-list', 'search-hit', 'tag-filter']);
    const child = inventory.cases.find((entry) => entry.id === 'comment-nested-root-expansion');
    assert.equal(child.kind, 'pagination-order');
    assert.ok(child.blockers.includes('child_expansion_is_not_full_public_thread'));
    for (const entry of inventory.cases)
    {
        assert.deepEqual(entry.applicableTiers, queryMatrixTiers);
        assert.equal(entry.actorClass, 'anonymous');
        assert.equal(entry.canonicalRoleBindings, null);
        assert.equal(entry.scenarioApplicability, null);
        assert.ok(entry.blockers.includes('query_owner_scenario_receipt_intake_missing'));
        assert.equal(entry.queryOwner.contentDigest, computeSha256(fs.readFileSync(new URL(`../../${entry.queryOwner.path}`, import.meta.url))));
        assert.equal(entry.queryOwner.version, `source-${entry.queryOwner.contentDigest.slice('sha256:'.length)}`);
    }
    const { contentDigest, ...body } = inventory;
    assert.equal(contentDigest, computeSha256(body));
    assert.throws(() => buildQueryCaseInventory({ ...binding, sourceCommit: '' }));
});

test('semantic owner declarations bind real source contracts without adding cases or approving missing semantics', () =>
{
    const kinds = { article: ['latest-list', 'top-list', 'prev-next'], comment: ['public-list', 'moderation-queue', 'deleted-root'] };
    const result = buildQuerySemanticOwnerInventory({ binding, kinds });
    assert.equal(result.requirements.length, 6);
    assert.equal(result.qualification, false);
    assert.equal(result.releaseEvidenceEligible, false);
    assert.equal(result.vocabularyDigest, computeSha256(kinds));
    assert.deepEqual(result.requirements.find((row) => row.kind === 'latest-list').existingCaseIds, queryCaseIds.filter((id) => id.startsWith('article-list')));
    const top = result.requirements.find((row) => row.kind === 'top-list');
    assert.deepEqual(top.existingCaseIds, []);
    assert.equal(top.status, 'owner-declaration-only');
    assert.ok(top.blockers.includes('canonical_top_semantics_missing_hot_and_featured_are_distinct'));
    assert.equal(result.requirements.find((row) => row.kind === 'moderation-queue').actorConstraint, 'AdminPermissions.CommentModerate');
    for (const row of result.requirements)
    {
        assert.equal(row.qualification, false);
        assert.equal(row.inputs, null);
        assert.equal(row.scenarioApplicability, null);
        assert.equal(row.canonicalRoleBindings, null);
        assert.ok(row.blockers.includes('query_owner_scenario_receipt_intake_missing'));
        for (const owner of row.businessOwners)
        {
            assert.equal(owner.contentDigest, computeSha256(fs.readFileSync(new URL(`../../${owner.path}`, import.meta.url))));
        }
    }
    const consistency = buildQuerySemanticOwnerInventory({ binding,
        kinds: { article: ['cache-consistency', 'aot-consistency', 'hot-read-consistency'], comment: ['public-list'] } });
    for (const row of consistency.requirements.filter((requirement) => requirement.domain === 'article'))
    {
        assert.deepEqual(row.businessOwners[0].parameterTypes,
            ['FsusBlog.Server.Services.Fixtures.CanonicalArticlePublicationReceipt',
                'FsusBlog.Server.Services.Fixtures.CanonicalArticlePublicationRequest', 'System.Threading.CancellationToken']);
        assert.ok(row.blockers.includes('original_same_run_publication_receipt_and_current_invocation_missing'));
    }
    const aot = consistency.requirements.find((row) => row.kind === 'aot-consistency');
    assert.deepEqual(aot.routePatterns, ['/article/{articleId}']);
    assert.ok(aot.businessOwners.some((owner) => owner.entrypoint.endsWith('PublicRouteIdentity.BuildCanonicalPath')));
    const comments = buildQuerySemanticOwnerInventory({ binding, kinds: { article: ['detail'],
        comment: ['public-thread', 'deleted-root', 'deleted-reply', 'actor-filter', 'permission-filter', 'pending-visibility'] } });
    const thread = comments.requirements.find((row) => row.kind === 'public-thread');
    assert.equal(thread.businessOwners.length, 4);
    assert.equal(thread.routePatterns.length, 4);
    assert.ok(thread.businessOwners.some((owner) => owner.entrypoint.endsWith('.GetPermalinkContextAsync')));
    assert.ok(comments.requirements.find((row) => row.kind === 'deleted-reply').businessOwners
        .some((owner) => owner.entrypoint.endsWith('.GetChildrenAsync')));
    const actor = comments.requirements.find((row) => row.kind === 'actor-filter');
    assert.ok(actor.businessOwners.some((owner) => owner.entrypoint.endsWith('.GetAttributableAsync')));
    assert.ok(actor.businessOwners.some((owner) => owner.entrypoint.endsWith('.GetUserCommentsForArticleAsync')));
    const permission = comments.requirements.find((row) => row.kind === 'permission-filter');
    assert.deepEqual(permission.routePatterns, ['/api/binary/author/comments/moderation']);
    assert.equal(permission.actorConstraint, 'AdminPermissions.CommentModerate');
    const pending = comments.requirements.find((row) => row.kind === 'pending-visibility');
    assert.ok(pending.routePatterns.includes('/api/binary/comment/me'));
    assert.ok(pending.routePatterns.includes('/api/binary/comment/{articleId:int}'));
    assert.ok(pending.routePatterns.includes('/api/binary/author/comments/moderation'));
    assert.throws(() => buildQuerySemanticOwnerInventory({ binding, kinds: { ...kinds, article: ['invented-kind'] } }), /undeclared/u);
    assert.throws(() => buildQuerySemanticOwnerInventory({ binding, kinds: { ...kinds, comment: ['public-list', 'public-list'] } }), /unique/u);
    assert.throws(() => buildQuerySemanticOwnerInventory({ binding, kinds: { article: ['detail'] } }), /vocabulary/u);
    const { contentDigest, ...body } = result;
    assert.equal(contentDigest, computeSha256(body));
});

function policy()
{
    return {
        maxLatencyMs: 100, maxRowsRead: 100, maxSharedBlocksRead: 20, maxTempBlocks: 0,
        allowedScanTypes: ['Index Scan'], requiredIndexNames: ['fixture_read_index'], forbidOffset: true
    };
}

function actualPlan(overrides = {})
{
    return [{
        Plan: {
            'Node Type': 'Index Scan', 'Index Name': 'fixture_read_index',
            'Actual Rows': 10, 'Actual Loops': 1, 'Shared Read Blocks': 1, 'Shared Hit Blocks': 2,
            'Temp Read Blocks': 0, 'Temp Written Blocks': 0, ...overrides
        },
        'Planning Time': 0.1, 'Execution Time': 1
    }];
}

function sample(entry)
{
    const { coordinate } = entry;
    const rows = coordinate.traversalItems ?? coordinate.expectedItems;
    const size = coordinate.pageSize ?? Math.max(1, rows.length);
    const http = [];
    let cursor = null;
    for (let offset = 0; offset < Math.max(1, rows.length); offset += size)
    {
        const hasMore = offset + size < rows.length;
        const nextCursor = hasMore ? `protected-cursor-${offset + size}` : null;
        http.push({
            binding, path: coordinate.path, inputCursor: cursor, status: 200,
            contentType: 'application/octet-stream', latencyMs: 1,
            body: controlledBody(coordinate.frameType, { items: rows.slice(offset, offset + size), total: rows.length, hasMore, nextCursor })
        });
        cursor = nextCursor;
    }
    const sql = 'SELECT id FROM fixture_read WHERE id < @cursor ORDER BY id DESC LIMIT @limit';
    const parameters = { cursor: 50, limit: 11 };
    return {
        id: entry.id, status: 'collected', binding, http,
        queries: [{ binding, status: 'collected', httpSampleIndex: coordinate.offset === undefined ? 0 : coordinate.offset / size, sql, sqlFingerprint: sqlFingerprint(sql), parameters, parametersDigest: computeSha256(parameters), explain: actualPlan() }]
    };
}

function matrixInput(tier = 'scale-s')
{
    const registry = buildQueryCaseRegistry(fixture(tier));
    return {
        registry,
        samples: registry.cases.map(sample),
        policies: Object.fromEntries(queryCaseIds.map((id) => [id, policy()])),
        decoders: Object.fromEntries(queryCaseIds.map((id) => [id, decodeControlled]))
    };
}

test('product runner follows returned cursors, measures exact target windows and refuses collector failure', async () =>
{
    const input = matrixInput();
    let observations = 0;
    const targets = [];
    const options = {
        registry: input.registry, policies: input.policies, baseUrl: 'http://127.0.0.1:18888', secret: 'control-secret',
        decoders: input.decoders, captureDirectory: '/tmp/query-control', verifyRuntime: async () =>
        {
            observations += 1;
        },
        fetchImpl: async (url) =>
        {
            const path = url.slice('http://127.0.0.1:18888'.length).replace(/([?&])cursor=.*$/u, '');
            const entry = input.registry.cases.find((item) => item.coordinate.path === path);
            const cursor = new URL(url).searchParams.get('cursor');
            const page = sample(entry).http.find((http) => http.inputCursor === cursor);
            assert.ok(page, 'runner must use an actual returned cursor');
            return new Response(page.body, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
        },
        collect: async ({ httpSampleIndex, binding: actualBinding }) =>
        {
            targets.push(httpSampleIndex);
            const sql = 'SELECT id FROM fixture_read ORDER BY id LIMIT @limit';
            const parameters = { limit: 10 };
            return [{ binding: actualBinding, status: 'collected', httpSampleIndex, sql, sqlFingerprint: sqlFingerprint(sql),
                parameters, parametersDigest: computeSha256(parameters), explain: actualPlan() }];
        }
    };
    const result = await runQueryMatrix(options);
    assert.equal(result.status, 'ok', JSON.stringify(result.results));
    assert.equal(result.qualification, 'not-performed');
    assert.deepEqual(targets.slice(0, 4), [0, 1, 3, 3]);
    assert.ok(observations > 16);
    const failed = await runQueryMatrix({ ...options, collect: async () =>
    {
        throw new Error('collector control');
    } });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.results.length, 16);
    const unavailable = await runQueryMatrix({ ...options, verifyRuntime: undefined });
    assert.equal(unavailable.results.every((row) => row.status === 'failed'), true);
});

test('missing canonical runner files retain all required failed cases', async () =>
{
    const matrix = await runQueryMatrixFiles({ tier: 'scale-xs', directory: '/tmp/nonexistent-query-matrix-control' });
    assert.equal(matrix.status, 'failed');
    assert.deepEqual(matrix.results.map((row) => row.id), queryCaseIds);
});

test('product backend private capture configuration requires its owned binding and secret', (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'query-backend-control-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const options = { repositoryRoot: directory, runRoot: directory, postgresHostPort: '15432', redisHostPort: '16379' };
    const disabled = buildProductBackendEnvironment(options);
    assert.equal(disabled.fsus__queryPlanCaptureDirectory, undefined);
    fs.writeFileSync(path.join(directory, 'query-capture-binding.json'), JSON.stringify(binding));
    assert.throws(() => buildProductBackendEnvironment(options));
    fs.writeFileSync(path.join(directory, 'query-observation.secret'), 'controlled-observation-secret', { mode: 0o600 });
    const enabled = buildProductBackendEnvironment(options);
    assert.equal(enabled.fsus__queryPlanCaptureDirectory, path.join(directory, 'query-captures'));
    assert.equal(enabled.fsus__queryPlanCaptureBindingPath, path.join(directory, 'query-capture-binding.json'));
    assert.equal(enabled.fsus__allowLocalAuthFixture, 'false');
    const environmentFile = path.join(directory, 'backend.env');
    fs.writeFileSync(environmentFile, '', { mode: 0o644 });
    writeProductBackendEnvironmentFile(environmentFile, enabled);
    assert.equal(fs.statSync(environmentFile).mode & 0o777, 0o600);
});

test('probe CLI attaches every failure through the original receipt producer and retains scheduler binding', (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'query-probe-control-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const summaryFile = path.join(directory, 'summary.json');
    const receipt = buildSemanticProofReceipt({ tier: 'scale-xs', dataScaleRunId: 'probe-control',
        results: Object.fromEntries(['database', 'httpPayload', 'search', 'aot', 'hotRead'].map((kind) => [kind, { status: 'ok' }])) });
    fs.writeFileSync(summaryFile, JSON.stringify({ ...receipt, releaseReliability: { control: 'original-binding' } }));
    const result = spawnSync(process.execPath, [new URL('../../tools/data-scale/run-query-matrix.mjs', import.meta.url).pathname,
        '--tier', 'scale-xs', '--summary', summaryFile], {
        encoding: 'utf8', env: { ...process.env, FSUSBLOG_DATA_SCALE_OUT_DIR: directory }, timeout: 10_000
    });
    assert.equal(result.status, 1, result.stderr);
    const updated = JSON.parse(fs.readFileSync(summaryFile));
    assert.equal(updated.status, 'failed');
    assert.equal(updated.queryMatrix.results.length, 16);
    assert.deepEqual(updated.releaseReliability, { control: 'original-binding' });
    assert.equal(verifySemanticProofReceipt(updated).failureReasons.some((reason) => reason.includes('contentDigest')), false);
    const matrix = JSON.parse(fs.readFileSync(path.join(directory, 'query-matrix.json')));
    assert.deepEqual(matrix, updated.queryMatrix);
});

test('comment coordinates exercise existing distributed roots with limit one and validate preview membership', () =>
{
    const input = fixture();
    input.visibleComments = input.visibleComments.filter((row) => BigInt(row.id) <= 7n || row.parentId !== null);
    const registry = buildQueryCaseRegistry(input);
    const middle = registry.cases.find((row) => row.id === 'comment-root-middle-cursor');
    assert.equal(middle.status, 'ready');
    assert.equal(middle.coordinate.pageSize, 1);
    assert.equal(middle.coordinate.offset, 3);
    const first = registry.cases.find((row) => row.id === 'comment-root-first');
    const observed = sample(first);
    const last = observed.http.at(-1);
    const decoded = decodeControlled(decodeAedsFrame(last.body).payload);
    assert.equal(decoded.items[0].childrenPreview.length, 1);
    decoded.items[0].childrenPreview = [];
    last.body = controlledBody(first.coordinate.frameType, decoded);
    assert.equal(evaluateQueryCase({ entry: first, sample: observed, policy: policy(), binding, decode: decodeControlled }).status, 'failed');
});

function evaluatedCase(mutate)
{
    const entry = buildQueryCaseRegistry(fixture()).cases[3];
    const observed = sample(entry);
    mutate(observed);
    return evaluateQueryCase({ entry, sample: observed, policy: policy(), binding, decode: decodeControlled });
}

test('fixed registry binds deterministic first/middle/last windows and exact taxonomy/search coordinates', () =>
{
    const registry = buildQueryCaseRegistry(fixture());
    assert.deepEqual(registry.cases.map((row) => row.id), queryCaseIds);
    assert.equal(registry.cases.every((row) => row.status === 'ready'), true);
    assert.deepEqual(registry.cases.slice(0, 4).map((row) => row.coordinate.offset), [0, 10, 30, 30]);
    assert.deepEqual(registry.cases[3].coordinate.expectedItems.map((row) => row.id), [5, 4, 3, 2, 1]);
    assert.equal(registry.cases[9].coordinate.taxonomyId, '2');
    assert.equal(registry.cases[15].coordinate.token, 'body-only');
    const reordered = fixture();
    reordered.publicArticles.reverse();
    reordered.visibleComments.reverse();
    assert.deepEqual(buildQueryCaseRegistry(reordered), registry);
});

test('unmodified one-article zero-comment xs retains every case and exposes unconstructible cursor windows', () =>
{
    const input = fixture('scale-xs');
    input.publicArticles = input.publicArticles.slice(0, 1);
    input.visibleComments = [];
    const registry = buildQueryCaseRegistry(input);
    assert.deepEqual(registry.cases.map((row) => row.id), queryCaseIds);
    assert.equal(registry.cases.find((row) => row.id === 'comment-root-first').status, 'ready');
    assert.deepEqual(registry.cases.find((row) => row.id === 'comment-root-first').coordinate.expectedItems, []);
    for (const id of ['article-list-middle-page', 'article-list-deep-cursor', 'comment-root-middle-cursor', 'comment-root-last-cursor', 'comment-nested-root-expansion'])
    {
        assert.equal(registry.cases.find((row) => row.id === id).status, 'blocked');
    }
});

test('missing empty taxonomy fails its own case without selecting an arbitrary replacement', () =>
{
    const input = fixture();
    input.categories.pop();
    input.tags.pop();
    const registry = buildQueryCaseRegistry(input);
    assert.equal(registry.cases.find((row) => row.id === 'category-empty').status, 'blocked');
    assert.equal(registry.cases.find((row) => row.id === 'tag-empty').status, 'blocked');
});

test('duplicate inventory, missing canonical model fields and invalid binding are rejected', () =>
{
    const input = fixture();
    input.publicArticles.push(input.publicArticles[0]);
    assert.throws(() => buildQueryCaseRegistry(input), /duplicate/);
    const incomplete = fixture();
    delete incomplete.publicArticles[0].body;
    assert.throws(() => buildQueryCaseRegistry(incomplete), /fields missing/);
    assert.throws(() => buildQueryCaseRegistry({ ...fixture(), binding: {} }), /binding missing/);
});

test('all exact samples pass evaluator independently of aggregate latency', () =>
{
    const result = evaluateQueryMatrix(matrixInput());
    assert.equal(result.status, 'ok');
    assert.equal(result.results.length, 16);
});

test('page1 passes but last page exceeds latency policy: matrix fails', () =>
{
    const input = matrixInput();
    input.samples[2].http.at(-1).latencyMs = 101;
    input.aggregateP99Ms = 1;
    const result = evaluateQueryMatrix(input);
    assert.equal(result.results[0].status, 'ok');
    assert.equal(result.results[2].status, 'failed');
    assert.equal(result.status, 'failed');
});

for (const family of ['article-list-deep-cursor', 'comment-root-last-cursor'])
{
    for (const fault of ['duplicate', 'omission', 'sort', 'wrong-cursor', 'early-terminal', 'repeated-cursor', 'missing-terminal'])
    {
        test(`${family} rejects ${fault}`, () =>
        {
            const input = matrixInput();
            const observed = input.samples.find((row) => row.id === family);
            const decoded = decodeControlled(decodeAedsFrame(observed.http[1].body).payload);
            if (fault === 'duplicate')
            {
                decoded.items[1] = decoded.items[0];
            }
            if (fault === 'omission')
            {
                decoded.items.pop();
            }
            if (fault === 'sort')
            {
                if (decoded.items.length === 1)
                {
                    // Limit-one pages still have an exact cross-page order.
                    decoded.items[0] = decodeControlled(decodeAedsFrame(observed.http[0].body).payload).items[0];
                }
                else
                {
                    decoded.items.reverse();
                }
            }
            if (fault === 'wrong-cursor')
            {
                observed.http[1].inputCursor = 'unrelated-cursor';
            }
            if (fault === 'early-terminal')
            {
                decoded.hasMore = false;
            }
            if (fault === 'repeated-cursor')
            {
                decoded.nextCursor = decodeControlled(decodeAedsFrame(observed.http[0].body).payload).nextCursor;
            }
            if (fault === 'missing-terminal')
            {
                observed.http.pop();
            }
            observed.http[1].body = controlledBody(input.registry.cases.find((row) => row.id === family).coordinate.frameType, decoded);
            assert.equal(evaluateQueryMatrix(input).status, 'failed');
        });
    }
}

for (const [name, mutate] of [
    ['deep cursor OFFSET regression', (observed) =>
    {
        observed.queries[0].sql += ' OFFSET 10000';
        observed.queries[0].sqlFingerprint = sqlFingerprint(observed.queries[0].sql);
    }],
    ['missing required index', (observed) =>
    {
        observed.queries[0].explain[0].Plan['Index Name'] = 'other_index';
    }],
    ['unexpected Seq Scan', (observed) =>
    {
        observed.queries[0].explain[0].Plan['Node Type'] = 'Seq Scan';
    }],
    ['temp block spill', (observed) =>
    {
        observed.queries[0].explain[0].Plan['Temp Written Blocks'] = 1;
    }],
    ['plan fixture drift', (observed) =>
    {
        observed.queries[0].binding = { ...binding, fixtureGeneration: 'old' };
    }],
    ['HTTP business epoch drift', (observed) =>
    {
        observed.http[0].binding = { ...binding, businessEpochUtc: '2024-03-01T00:00:00.000Z' };
    }],
    ['SQL text without plan', (observed) =>
    {
        delete observed.queries[0].explain;
    }],
    ['unexecuted estimated plan', (observed) =>
    {
        delete observed.queries[0].explain[0].Plan['Actual Loops'];
    }],
    ['missing buffers', (observed) =>
    {
        delete observed.queries[0].explain[0].Plan['Shared Read Blocks'];
    }],
    ['collector failure', (observed) =>
    {
        observed.status = 'collector-failed';
    }],
    ['supporting statement collector failure', (observed) =>
    {
        observed.queries[0].status = 'failed';
    }],
    ['SQL fingerprint drift', (observed) =>
    {
        observed.queries[0].sql += ' AND false';
    }],
    ['parameter drift', (observed) =>
    {
        observed.queries[0].parameters.cursor = 5;
    }]
])
{
    test(`query evaluator rejects ${name}`, () =>
    {
        const result = evaluatedCase(mutate);
        assert.equal(result.status, 'failed', result.failureReasons.join('; '));
    });
}

test('HTTP 200 with undecodable payload cannot pass even with valid plans', () =>
{
    const result = evaluatedCase((observed) =>
    {
        observed.http[0].body = Buffer.from('not decoded content');
    });
    assert.equal(result.status, 'failed');
});

test('canonical AEDS taxonomy decoder proves payload contents and rejects header-only samples', () =>
{
    const entry = {
        id: 'taxonomy-decoder-control',
        coordinate: { path: '/api/binary/category', frameType: 9, expectedItems: [{ id: 1, name: 'largest category', articleCount: 35 }] }
    };
    const decode = (payload) => ({ items: decodeTaxonomyList(payload) });
    const observed = sample(entry);
    observed.http[0].body = encodeAedsFrame(entry.coordinate.frameType, encodeTaxonomyList(entry.coordinate.expectedItems));
    assert.doesNotThrow(() => verifyQueryTraversal({ coordinate: entry.coordinate, samples: observed.http, binding, decode }));
    observed.http[0].body = encodeAedsFrame(entry.coordinate.frameType, Buffer.alloc(0));
    assert.throws(() => verifyQueryTraversal({ coordinate: entry.coordinate, samples: observed.http, binding, decode }));
});

for (const fault of ['missing', 'skip', 'duplicate', 'unknown', 'page1-only'])
{
    test(`matrix rejects ${fault} samples`, () =>
    {
        const input = matrixInput();
        if (fault === 'missing')
        {
            input.samples.pop();
        }
        if (fault === 'skip')
        {
            input.samples[0].status = 'skipped';
        }
        if (fault === 'duplicate')
        {
            input.samples.push(input.samples[0]);
        }
        if (fault === 'unknown')
        {
            input.samples.push({ id: 'unregistered' });
        }
        if (fault === 'page1-only')
        {
            input.samples = [input.samples[0]];
        }
        assert.equal(evaluateQueryMatrix(input).status, 'failed');
    });
}

test('plan metrics count scanned/filtered rows times loops and do not double-count inclusive buffers', () =>
{
    const explain = actualPlan();
    explain[0].Plan = { ...explain[0].Plan, 'Node Type': 'Limit', Plans: [{ ...actualPlan()[0].Plan, 'Actual Loops': 3, 'Rows Removed by Filter': 7 }] };
    const metrics = summarizeActualPlan(explain);
    assert.equal(metrics.rowsRead, 51);
    assert.equal(metrics.sharedBlocksRead, 1);
    assert.equal(metrics.sharedBlocksHit, 2);
});

test('case policy cannot omit a metric or permit Seq Scan without a reason', () =>
{
    const input = policy();
    delete input.maxTempBlocks;
    assert.throws(() => validateQueryPolicy(input), /missing/);
    assert.throws(() => validateQueryPolicy({ ...policy(), allowedScanTypes: ['Seq Scan'] }), /reason/);
    assert.doesNotThrow(() => validateQueryPolicy({ ...policy(), allowedScanTypes: ['Seq Scan'], seqScanReason: 'Exact one-row relation under this case-specific fixture.' }));
});

test('SQL fingerprint preserves meaningful literal whitespace', () =>
{
    assert.notEqual(sqlFingerprint("SELECT 'a b'"), sqlFingerprint("SELECT 'a  b'"));
});

test('plans from a different HTTP window and tampered registries fail closed', () =>
{
    assert.equal(evaluatedCase((observed) =>
    {
        observed.queries[0].httpSampleIndex = 0;
    }).status, 'failed');
    const input = matrixInput();
    input.registry.cases[0].coordinate.expectedItems.pop();
    assert.throws(() => evaluateQueryMatrix(input), /digest mismatch/);
});

test('supporting query costs accumulate instead of hiding behind a per-statement maximum', () =>
{
    const result = evaluatedCase((observed) =>
    {
        observed.queries = Array.from({ length: 11 }, () => observed.queries[0]);
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.metrics.rowsRead, 110);
});

test('an unbound decoder, wrong AEDS type and corrupt content cannot produce a semantic pass', () =>
{
    const input = matrixInput();
    delete input.decoders['comment-root-first'];
    assert.equal(evaluateQueryMatrix(input).status, 'failed');
    assert.equal(evaluatedCase((observed) =>
    {
        observed.http[0].body = controlledBody(9, decodeControlled(decodeAedsFrame(observed.http[0].body).payload));
    }).status, 'failed');
    assert.equal(evaluatedCase((observed) =>
    {
        const bytes = new Uint8Array(observed.http[0].body);
        bytes[bytes.length - 1] ^= 1;
    }).status, 'failed');
});

test('xs/s/m trends require exact case sets and compare all rows, block and latency measurements', () =>
{
    const matrices = queryMatrixTiers.map((tier) => evaluateQueryMatrix(matrixInput(tier)));
    const trends = compareQueryTrends(matrices);
    assert.equal(trends.status, 'ok');
    assert.equal(trends.results.length, 16);
    assert.deepEqual(trends.results[0].values.map((row) => row.tier), queryMatrixTiers);
    matrices[2].results.pop();
    assert.equal(compareQueryTrends(matrices).status, 'failed');
});

test('trends reject a missing tier or cross-source/cross-epoch evaluations', () =>
{
    const matrices = queryMatrixTiers.map((tier) => evaluateQueryMatrix(matrixInput(tier)));
    assert.equal(compareQueryTrends(matrices.slice(1)).status, 'failed');
    matrices[2].binding = { ...binding, sourceCommit: 'b'.repeat(40) };
    assert.throws(() => compareQueryTrends(matrices), /cross-tier/);
});

test('trend comparisons expose adjacent-tier deltas and ratios without hiding zero baselines', () =>
{
    const matrices = queryMatrixTiers.map((tier) => evaluateQueryMatrix(matrixInput(tier)));
    matrices[1].results[0].metrics.rowsRead = 20;
    matrices[0].results[0].metrics.sharedBlocksRead = 0;
    const comparison = compareQueryTrends(matrices).results[0].comparisons[0];
    assert.equal(comparison.fromTier, 'scale-xs');
    assert.equal(comparison.toTier, 'scale-s');
    assert.deepEqual(comparison.changes.rowsRead, { delta: 10, ratio: 2 });
    assert.deepEqual(comparison.changes.sharedBlocksRead, { delta: 1, ratio: null });
    assert.deepEqual(comparison.changes.tempBlocks, { delta: 0, ratio: 1 });
});

function threadInput()
{
    return { articleId: 1, rootId: '1', pageSize: 1,
        expectedReplies: [
            { id: '2', rootId: '1', parentId: '1', depth: 1, content: 'child', createTime: '2026-10-08T00:00:00.000Z', isDeleted: false, isEdited: false },
            { id: '3', rootId: '1', parentId: '2', depth: 2, content: 'descendant', createTime: '2026-10-08T00:00:00.000Z', isDeleted: false, isEdited: true }
        ] };
}

test('versioned thread reply case consumes typed inputs without inferring roles or admitting scalar IDs', () =>
{
    const input = { ...fixture(), registrySchema: queryRegistrySchemas[1], threadReplies: threadInput() };
    const registry = buildQueryCaseRegistry(input);
    assert.deepEqual(registry.cases.slice(0, 16).map((row) => row.id), queryCaseIds);
    assert.deepEqual(registry.cases.map((row) => row.id), queryCaseIdsForSchema(queryRegistrySchemas[1]));
    const thread = registry.cases.at(-1);
    assert.equal(thread.id, threadReplyCaseId);
    assert.equal(thread.status, 'blocked');
    assert.equal(thread.coordinate.path, '/api/binary/comment/1/thread/1?limit=1');
    assert.equal(thread.coordinate.threadRootId, '1');
    assert.equal(thread.coordinate.traversalItems.length, 2);
    assert.deepEqual(thread.failureReasons, ['canonical_comment_normalized_role_reader_unavailable', 'canonical_comment_exact_revision_reader_unavailable']);
    const inventory = registry.inventory.cases.at(-1);
    assert.equal(inventory.kind, 'public-thread');
    assert.equal(inventory.coverageScope, 'rooted-reply-cursor');
    assert.equal(inventory.canonicalRoleBindings, null);
    assert.ok(inventory.requiredInputTypes.rootId.includes('Int64'));
    assert.throws(() => buildQueryCaseRegistry({ ...fixture(), threadReplies: threadInput() }), /explicit v2/u);
    assert.throws(() => queryCaseIdsForSchema('invented-schema'), /unsupported/u);
    for (const alter of [
        (value) =>
        {
            value.rootId = 1;
        },
        (value) =>
        {
            value.articleId = 2147483648;
        },
        (value) =>
        {
            value.pageSize = 101;
        },
        (value) =>
        {
            value.rootId = '9223372036854775808';
        },
        (value) =>
        {
            value.expectedReplies.reverse();
        },
        (value) =>
        {
            value.expectedReplies[1].id = '2';
        },
        (value) =>
        {
            value.expectedReplies[1].rootId = '99';
        }
    ])
    {
        const value = threadInput();
        alter(value);
        assert.equal(buildQueryCaseRegistry({ ...input, threadReplies: value }).cases.at(-1).coordinate, undefined);
    }
    assert.equal(buildQueryCaseRegistry({ ...input, threadReplies: undefined }).cases.at(-1).coordinate, undefined);
});

test('versioned thread runner refuses resealed verified flags before its HTTP request and retains all cases', async () =>
{
    const registry = buildQueryCaseRegistry({ ...fixture(), registrySchema: queryRegistrySchemas[1], threadReplies: threadInput() });
    registry.cases.forEach((row) =>
    {
        row.status = 'blocked';
    });
    const thread = registry.cases.at(-1);
    thread.status = 'ready';
    thread.normalizedRoles = { verified: true };
    thread.exactRevisions = { verified: true };
    const { contentDigest, ...body } = registry;
    assert.notEqual(contentDigest, computeSha256(body));
    registry.contentDigest = computeSha256(body);
    let calls = 0;
    const matrix = await runQueryMatrix({ registry, policies: Object.fromEntries(queryCaseIdsForSchema(registry.schema).map((id) => [id, policy()])),
        baseUrl: 'http://127.0.0.1:18888', secret: 'ordinary-control', verifyRuntime: async () =>
        {},
        decoders: Object.fromEntries(queryCaseIdsForSchema(registry.schema).map((id) => [id, decodeControlled])),
        fetchImpl: async () =>
        {
            calls += 1;
            throw new Error('must not execute');
        } });
    assert.equal(calls, 0);
    assert.equal(matrix.status, 'failed');
    assert.equal(matrix.qualification, 'not-performed');
    assert.equal(matrix.results.length, 17);
    assert.ok(matrix.results.at(-1).failureReasons.some((reason) => reason.includes('normalized_role_reader_unavailable')));
});

test('v3 related/prev-next case preserves frozen registries and legitimate cross-role article aliases', () =>
{
    const row = { id: 2, title: 'neighbor', summary: null, createTime: binding.businessEpochUtc, reason: 'related-control' };
    const relatedReading = { articleId: 1, related: [row], previous: { ...row, reason: 'previous-control' },
        next: { ...row, id: 3, reason: 'next-control' } };
    const input = { ...fixture(), registrySchema: queryRegistrySchemas[2], threadReplies: threadInput(), relatedReading };
    const registry = buildQueryCaseRegistry(input);
    assert.deepEqual(registry.cases.slice(0, 17).map((item) => item.id), queryCaseIdsForSchema(queryRegistrySchemas[1]));
    assert.deepEqual(registry.cases.map((item) => item.id), queryCaseIdsForSchema(queryRegistrySchemas[2]));
    const entry = registry.cases.at(-1);
    assert.equal(entry.id, relatedReadingCaseId);
    assert.equal(entry.status, 'blocked');
    assert.equal(entry.coordinate.frameType, 27);
    assert.equal(entry.coordinate.path, '/api/binary/article/1/related.aeds');
    assert.equal(entry.coordinate.expectedPayloadProjection.related[0].id, entry.coordinate.expectedPayloadProjection.previous.id);
    assert.equal(registry.inventory.cases.at(-1).kind, 'prev-next');
    assert.equal(registry.inventory.schema, 'fsusblog.data-scale-query-inventory.v3');
    assert.throws(() => buildQueryCaseRegistry({ ...input, registrySchema: queryRegistrySchemas[1] }), /v3/u);
    for (const alter of [
        (value) =>
        {
            value.articleId = 0;
        },
        (value) =>
        {
            delete value.previous;
        },
        (value) =>
        {
            value.related.push(value.related[0]);
        },
        (value) =>
        {
            value.related[0].id = 1;
        },
        (value) =>
        {
            value.related[0].summary = {};
        },
        (value) =>
        {
            value.next.id = value.previous.id;
        },
        (value) =>
        {
            value.related = Array.from({ length: 7 }, (_, index) => ({ ...row, id: index + 2 }));
        }
    ])
    {
        const value = structuredClone(relatedReading);
        alter(value);
        assert.equal(buildQueryCaseRegistry({ ...input, relatedReading: value }).cases.at(-1).coordinate, undefined);
    }
    const forged = { ...entry, status: 'ready', publicationReceipt: { verified: true }, normalizedRoles: { verified: true } };
    const evaluated = evaluateQueryCase({ entry: forged, sample: { status: 'collected' }, policy: policy(), binding, decode: decodeControlled });
    assert.equal(evaluated.status, 'failed');
    assert.ok(evaluated.failureReasons.some((reason) => reason.includes('semantic_coordinates_missing')));
});

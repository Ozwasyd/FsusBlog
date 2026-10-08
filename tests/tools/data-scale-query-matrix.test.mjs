import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { computeSha256 } = await import(new URL('../../tools/data-scale/runtime-plan.mjs', import.meta.url));
const { buildQueryCaseRegistry, queryCaseIds, queryMatrixTiers } = await import(new URL('../../tools/data-scale/query-case-registry.mjs', import.meta.url));
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

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { distributionCatalog, distributionScenarioIds } = await import(new URL('../../tools/data-scale/distribution-catalog.mjs', import.meta.url));
const { canonicalDigest } = await import(new URL('../../tools/data-scale/distribution-contract.mjs', import.meta.url));
const {
    createDistributionArticleWriterRequest,
    prepareDistributionArticleWriterBatches,
    readArticleBulkWriterSourceReference,
    serializeDistributionArticleWriterRequest,
    validateDistributionArticleWriterRequest
} = await import(new URL('../../tools/data-scale/distribution-writer-adapter.mjs', import.meta.url));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceCommit = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceReference = readArticleBulkWriterSourceReference({ repositoryRoot, sourceCommit });
const opaqueOwnerDigest = canonicalDigest({ purpose: 'unit-only-opaque-plan-reference-not-owner-validation' });

function options(scenarioId = 'zipf-hot-content')
{
    return {
        scenarioId,
        namespace: 'unit-reference-only',
        articlePlanReference: null,
        batchSize: sourceReference.physicalBatchGraphLimit === null ? null : 1,
        sourceReference
    };
}

function planReference(namespace = 'unit-reference-only')
{
    // This is deliberately an opaque structural control, never an admitted C# plan.
    return {
        schema: 'fsusblog.article-scale-plan.v1',
        ownerSourceCommit: sourceCommit,
        contentDigest: opaqueOwnerDigest,
        scaleTier: 'scale-l-nightly',
        articleCount: 100_000,
        namespace
    };
}

function reseal(request)
{
    const body = { ...request };
    delete body.contentDigest;
    return { ...body, contentDigest: canonicalDigest(body) };
}

test('provenance reads actual current Git blobs and keeps absent pipeline files missing', () =>
{
    assert.equal(sourceReference.sourceCommit, sourceCommit);
    assert.equal(sourceReference.executionCapability, false);
    assert.equal(sourceReference.files.length, 8);
    for (const file of sourceReference.files)
    {
        const actual = execFileSync('git', ['-C', repositoryRoot, 'ls-tree', sourceCommit, '--', file.path],
            { encoding: 'utf8' }).trim();
        if (file.status === 'missing')
        {
            assert.equal(actual, '');
            assert.equal(file.gitBlob, null);
            assert.equal(file.sourceDigest, null);
        }
        else
        {
            assert.ok(actual.includes(file.gitBlob));
            const source = execFileSync('git', ['-C', repositoryRoot, 'cat-file', 'blob', file.gitBlob],
                { encoding: 'utf8' });
            assert.equal(file.sourceDigest, canonicalDigest({ source }));
        }
    }
    assert.ok(Object.isFrozen(sourceReference.files));
});

test('all eight real scenarios serialize every exact metric and shape as bounded blocked requests', () =>
{
    for (const scenarioId of distributionScenarioIds)
    {
        const request = createDistributionArticleWriterRequest(options(scenarioId));
        const scenario = distributionCatalog.scenarios.find((row) => row.id === scenarioId);
        const serialized = serializeDistributionArticleWriterRequest(request, sourceReference, request.contentDigest);
        assert.deepEqual(JSON.parse(serialized), request);
        assert.deepEqual(request.metricContracts, scenario.expectedStatistics);
        assert.deepEqual(request.shapeReferences, scenario.shapes);
        assert.equal(request.identity.catalogDigest, distributionCatalog.contentDigest);
        assert.equal(request.identity.scenarioDigest, scenario.contentDigest);
        assert.equal(request.identity.metricContractsDigest, canonicalDigest(scenario.expectedStatistics));
        assert.equal(request.status, 'blocked');
        assert.equal(request.executionEligible, false);
        assert.equal(request.releaseEvidenceEligible, false);
        assert.ok(request.blockers.includes('article_writer_semantic_assignment_input_missing'));
        assert.ok(request.blockers.includes('article_writer_complete_plan_admission_host_missing'));
        assert.ok(Buffer.byteLength(serialized) < 256 * 1024);
        assert.ok(Object.isFrozen(request.metricContracts));
        if (scenarioId === 'uniform-baseline')
        {
            assert.ok(request.blockers.includes('uniform_baseline_release_evidence_forbidden'));
        }
    }
});

test('published real writer source exposes its observed 1000-graph bound without admitting distribution writes', () =>
{
    // Explicit source dependency from #2542 / PR3820; absence is a failed source
    // prerequisite, never a skipped positive or invented physical writer fixture.
    const published = readArticleBulkWriterSourceReference({
        repositoryRoot,
        sourceCommit: '1440291b065a8e30b6d5f64ed864c090d5a9d79e'
    });
    assert.equal(published.physicalBatchGraphLimit, 1000);
    assert.equal(published.files.filter((file) => file.status === 'missing').length, 0);
    for (const batchSize of [1, 1000])
    {
        const request = createDistributionArticleWriterRequest({ ...options(), sourceReference: published, batchSize });
        assert.equal(JSON.parse(serializeDistributionArticleWriterRequest(request, published, request.contentDigest)).batchSize, batchSize);
        assert.equal(request.executionEligible, false);
        let reads = 0;
        const assignments = Object.defineProperty({}, Symbol.iterator, {
            get: () =>
            {
                reads += 1;
                throw new Error('must-not-read');
            }
        });
        assert.throws(() => prepareDistributionArticleWriterBatches(request, published, request.contentDigest, assignments),
            /article_writer_semantic_assignment_input_missing/u);
        assert.equal(reads, 0);
    }
    for (const batchSize of [0, 1001, 1.5])
    {
        assert.throws(() => createDistributionArticleWriterRequest({ ...options(), sourceReference: published, batchSize }),
            /batch_bound_invalid/u);
    }
    assert.throws(() => createDistributionArticleWriterRequest({ ...options(), sourceReference: published, batchSize: -0 }),
        /distribution_noncanonical_json/u);
});

test('same inputs are byte stable while changed scenario, namespace and owner digest invalidate identity', () =>
{
    const input = { ...options(), articlePlanReference: planReference() };
    const first = createDistributionArticleWriterRequest(input);
    const second = createDistributionArticleWriterRequest(input);
    assert.equal(serializeDistributionArticleWriterRequest(first, sourceReference, first.contentDigest),
        serializeDistributionArticleWriterRequest(second, sourceReference, second.contentDigest));
    for (const changed of [
        { ...input, scenarioId: 'media-mixed' },
        { ...input, namespace: 'another-reference', articlePlanReference: planReference('another-reference') },
        { ...input, articlePlanReference: { ...planReference(), contentDigest: canonicalDigest({ otherOpaqueReference: true }) } }
    ])
    {
        const next = createDistributionArticleWriterRequest(changed);
        assert.notEqual(first.contentDigest, next.contentDigest);
        assert.throws(() => validateDistributionArticleWriterRequest(next, sourceReference, first.contentDigest),
            /identity_mismatch/u);
    }
    assert.equal(first.articlePlanReference.contentDigest, opaqueOwnerDigest);
    assert.equal(first.articlePlanValidation, 'not-owner-validated');
    assert.notEqual(first.contentDigest, opaqueOwnerDigest);
});

test('exact observed source revision changes request identity even when article plan blobs are unchanged', () =>
{
    const previousCommit = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
    const previous = readArticleBulkWriterSourceReference({ repositoryRoot, sourceCommit: previousCommit });
    const first = createDistributionArticleWriterRequest(options());
    const other = createDistributionArticleWriterRequest({ ...options(), sourceReference: previous,
        batchSize: previous.physicalBatchGraphLimit === null ? null : 1 });
    assert.notEqual(first.contentDigest, other.contentDigest);
    assert.throws(() => validateDistributionArticleWriterRequest(first, previous, first.contentDigest), /identity_mismatch/u);
});

test('unknown scenario, private options and fabricated or copied source capabilities are rejected', () =>
{
    for (const changed of [
        { ...options(), scenarioId: 'private-scenario' },
        { ...options(), weights: [1] },
        { ...options(), executionEligible: true },
        { ...options(), sourceReference: structuredClone(sourceReference) },
        { ...options(), sourceReference: { valid: true } },
        { ...options(), namespace: '' },
        { ...options(), namespace: 'x'.repeat(129) }
    ])
    {
        assert.throws(() => createDistributionArticleWriterRequest(changed));
    }
    for (const commit of ['HEAD', 'latest', '0'.repeat(40)])
    {
        assert.throws(() => readArticleBulkWriterSourceReference({ repositoryRoot, sourceCommit: commit }));
    }
});

test('plan references retain owner digests but reject unknown schemas, scope drift and million-article substitution', () =>
{
    for (const reference of [
        { ...planReference(), schema: 'private-plan' },
        { ...planReference(), contentDigest: 'not-a-digest' },
        { ...planReference(), ownerSourceCommit: 'latest' },
        { ...planReference(), articleCount: 1_000_000 },
        { ...planReference(), scaleTier: 'private-million-tier' },
        { ...planReference(), namespace: 'cross-scenario' },
        { ...planReference(), valid: true },
        { ...planReference(), rows: [] }
    ])
    {
        assert.throws(() => createDistributionArticleWriterRequest({ ...options(), articlePlanReference: reference }));
    }
});

test('physical batch bounds cannot be invented when source is absent or exceed an observed owner bound', () =>
{
    const limit = sourceReference.physicalBatchGraphLimit;
    const values = limit === null ? [1, 1000, 1_000_000] : [null, 0, limit + 1, Number.MAX_SAFE_INTEGER];
    for (const batchSize of [...values, -0, -1, 1.5, NaN])
    {
        assert.throws(() => createDistributionArticleWriterRequest({ ...options(), batchSize }));
    }
});

test('resealed metric omissions, duplicates, algorithms, sample sets and intervals cannot become writer requests', () =>
{
    const original = createDistributionArticleWriterRequest(options());
    const mutations = [
        (request) => request.metricContracts.pop(),
        (request) => request.metricContracts.push(request.metricContracts[0]),
        (request) =>
        {
            request.metricContracts[0].algorithmVersion = 'private-algorithm';
        },
        (request) =>
        {
            request.metricContracts[0].sampleSet = 'fake-db-graph';
        },
        (request) =>
        {
            request.metricContracts[0].interval.max = 1;
        },
        (request) =>
        {
            request.metricContracts.find((metric) => metric.status === 'blocked').interval = { min: 0, max: 0 };
        },
        (request) =>
        {
            request.shapeReferences.hotness.exponent = 0;
        },
        (request) =>
        {
            request.identity.catalogDigest = canonicalDigest({ privateCatalog: true });
        },
        (request) =>
        {
            request.identity.scenarioDigest = canonicalDigest({ staleScenario: true });
        },
        (request) =>
        {
            request.executionEligible = true;
        },
        (request) =>
        {
            request.ownerRequest.proposedContractStatus = 'admitted';
        },
        (request) =>
        {
            request.blockers = [];
        }
    ];
    for (const mutate of mutations)
    {
        const changed = structuredClone(original);
        mutate(changed);
        const sealed = reseal(changed);
        assert.throws(() => serializeDistributionArticleWriterRequest(sealed, sourceReference, sealed.contentDigest),
            /identity_mismatch/u);
    }
});

test('all scenarios atomically refuse before obtaining any assignment iterator or producing a writer batch', () =>
{
    for (const scenarioId of distributionScenarioIds)
    {
        const request = createDistributionArticleWriterRequest(options(scenarioId));
        let consumed = 0;
        let submitted = 0;
        const assignments = Object.defineProperty({}, Symbol.iterator, { get: () =>
        {
            consumed += 1;
            throw new Error('must-not-obtain-iterator');
        } });
        assert.throws(() =>
        {
            const batches = prepareDistributionArticleWriterBatches(request, sourceReference, request.contentDigest, assignments);
            for (const batch of batches)
            {
                assert.ok(batch);
                submitted += 1;
            }
        }, /article_writer_semantic_assignment_input_missing/u);
        assert.equal(consumed, 0);
        assert.equal(submitted, 0);
    }
});

test('tampered plans fail before assignment access and malformed JSON has no serialization sink output', () =>
{
    const original = createDistributionArticleWriterRequest(options());
    const changed = structuredClone(original);
    changed.identity.articleCount += 1;
    let reads = 0;
    const assignments = Object.defineProperty({}, Symbol.iterator, { get: () =>
    {
        reads += 1;
        throw new Error('must-not-read');
    } });
    assert.throws(() => prepareDistributionArticleWriterBatches(changed, sourceReference, original.contentDigest, assignments).next(),
        /identity_mismatch/u);
    assert.equal(reads, 0);
    const badOptions = Object.defineProperty(options(), 'namespace', { get: () =>
    {
        reads += 1;
        return 'invalid';
    }, enumerable: true });
    assert.throws(() => createDistributionArticleWriterRequest(badOptions), /unsupported_property/u);
    assert.equal(reads, 0);
    let output = 0;
    assert.throws(() =>
    {
        serializeDistributionArticleWriterRequest({ ...original, extra: undefined }, sourceReference, original.contentDigest);
        output += 1;
    });
    assert.equal(output, 0);
});

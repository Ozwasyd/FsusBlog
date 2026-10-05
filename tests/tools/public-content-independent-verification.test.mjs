import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { plan, prepare, verify } = await import(new URL('../../tools/test-fixtures/orchestrator.mjs', import.meta.url));
const { createPublicContentPort } = await import(new URL('../../tools/test-fixtures/producers/catalog-ports.mjs', import.meta.url));
const { publicContentVerificationIdentity, verifyPublicContent } = await import(new URL('../../tools/test-fixtures/producers/public-content-producer.mjs', import.meta.url));
const { runPostcondition } = await import(new URL('../../tools/test-fixtures/receipt/postconditions.mjs', import.meta.url));
const { projectFixtureIds, writeFixtureReceipt, writePrivateJson, buildProducerReceipt, buildFixtureReceipt } = await import(new URL('../../tools/test-fixtures/receipt/index.mjs', import.meta.url));

function fixture()
{
    const cursors = [10, 100, 1000].map((page, index) => ({
        logicalPage: page,
        cursor: `opaque-production-cursor-${page}`,
        boundaryIdentity: { articleId: String(901 + index), createTimeUtc: '2026-09-14T08:00:00Z', sortValue: 0, precedingItemCount: (page - 1) * 10 }
    }));
    const pagination = { route: 'article/list/home', sort: 'latest', pageSize: 10, generation: 47, articleCount: 10023, ownedArticleCount: 10023, cursors };
    const articles = [101, 102, 103].map((id, index) => ({
        kind: 'article', id: String(id), capabilityHint: 'article-published',
        fields: { status: 'published', currentPublicationId: 501 + index, currentRevisionId: 601 + index, publicDetailReadable: true, hasCover: index < 2, coverImageUrl: index < 2 ? '/fixtures/cover.svg' : null }
    }));
    const boundaries = cursors.map((cursor, index) => ({ kind: 'article', id: cursor.boundaryIdentity.articleId, capabilityHint: 'article-pagination-deep', fields: { status: 'published', currentPublicationId: 800, publicDetailReadable: true, hasCover: index < 2, coverImageUrl: index < 2 ? '/fixtures/cover.svg' : null } }));
    const entities = [...articles, ...boundaries, { kind: 'pagination-keyset', id: 'article/list/home:latest:size=10', capabilityHint: 'article-pagination-deep', postconditionId: 'article-pagination-deep', fields: pagination }];
    return {
        entityIdentities: entities.map((entity) => ({ kind: entity.kind, id: entity.id, capabilityHint: entity.capabilityHint })),
        observations: { source: 'service', database: { namespace: 'ns', entities }, redis: { namespace: 'ns', keys: [] }, cache: { namespace: 'ns', generation: 47, entries: [] } },
        projection: { pagination }
    };
}

test('featured/hot postcondition recognizes the actual canonical Redis rank key and still refuses absence', () =>
{
    const context = {
        observations: {
            database: { entities: [{ kind: 'article', id: '101', fields: { hot: true } }] },
            redis: { keys: [{ domain: 'redis.cache.public', key: 'blog:top_articles', present: true, memberIds: ['101'] }] },
            cache: { entries: [{ endpoint: 'article/hot', matchesDb: true, requireOwnedVisible: true, visibleEntityIds: ['101'] }] }
        }
    };
    assert.equal(runPostcondition('home-featured-hot', context).ok, true);
    context.observations.redis.keys[0].present = false;
    assert.equal(runPostcondition('home-featured-hot', context).ok, false);
    context.observations.redis.keys[0].present = true;
    context.observations.redis.keys[0].key = 'unrelated-key';
    assert.equal(runPostcondition('home-featured-hot', context).ok, false);
    context.observations.redis.keys[0].key = 'blog:top_articles';
    context.observations.cache.entries[0].visibleEntityIds = ['foreign'];
    assert.equal(runPostcondition('home-featured-hot', context).ok, false);
});

async function preparedFixture()
{
    const planned = plan({ profileId: 'runtime-cache-pagination', profileSource: 'dev-cli', executionClass: 'runtime' }, {
        runId: 'issue-1851-verification', namespace: 'ns',
        sourceIdentity: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
        handles: { serviceGeneration: 'generation-1' }
    });
    const port = createPublicContentPort();
    const prepared = await prepare(planned, [port], undefined, {
        handles: { publicContentAdapter: { async prepare()
        {
            return { strategy: 'transaction-fixture', ...fixture() };
        } } }
    });
    return { prepared, port };
}

function live(context, result)
{
    return { ok: true, identity: publicContentVerificationIdentity(context), proofDigest: null,
        entityIdentities: structuredClone(result.entityIdentities),
        observations: { ...structuredClone(result.observations), source: 'independent-service-read' } };
}

async function verifiedFixture()
{
    const { prepared, port } = await preparedFixture();
    return verify(prepared, [port], { handles: { publicContentAdapter: { async verify(context, result)
    {
        return live(context, result);
    } } } });
}

test('public verifier cannot qualify prepare observations or missing live adapter', async () =>
{
    const { prepared } = await preparedFixture();
    const result = prepared.producerOutputs['public-content'];
    const rejected = await verifyPublicContent({}, result);
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /independent live verifier/u);
    const { port } = await preparedFixture();
    await assert.rejects(verify(prepared, [port], { handles: { publicContentAdapter: { async verify()
    {
        return { ok: true };
    } } } }), /binding\/observations mismatch/u);
});

for (const field of ['runId', 'namespace', 'profileId', 'sourceCommit', 'sourceFingerprint', 'variantPlanDigest'])
{
    test(`live public verification rejects wrong ${field}`, async () =>
    {
        const { prepared, port } = await preparedFixture();
        await assert.rejects(verify(prepared, [port], { handles: { publicContentAdapter: { async verify(context, result)
        {
            const current = live(context, result);
            current.identity[field] = 'foreign';
            return current;
        } } } }), /binding\/observations mismatch/u);
    });
}

for (const field of ['currentPublicationId', 'publicDetailReadable'])
{
    test(`prepare success cannot hide later ${field} drift`, async () =>
    {
        const { prepared, port } = await preparedFixture();
        await assert.rejects(verify(prepared, [port], { handles: { publicContentAdapter: { async verify(context, result)
        {
            const current = live(context, result);
            current.observations.database.entities[0].fields[field] = null;
            return current;
        } } } }), /verify failed/u);
        assert.notEqual(prepared.producerOutputs['public-content'].observations.database.entities[0].fields[field], null);
    });
}

test('verified pagination projection preserves sealed cursors and remains non-authoritative', async () =>
{
    const receipt = await verifiedFixture();
    const projection = projectFixtureIds(receipt);
    assert.equal(projection.notAuthoritative, true);
    assert.equal(projection.sourceReceiptDigest, receipt.receiptDigest);
    assert.deepEqual(projection.pagination.cursors, fixture().projection.pagination.cursors);
    assert.deepEqual(projection.pagination.cursors.map((item) => item.logicalPage), [10, 100, 1000]);
    assert.throws(() => projectFixtureIds({ ...receipt, terminalStatus: 'prepared' }), /digest|terminal|verified/u);
    const changed = structuredClone(receipt);
    changed.producerReceipts[0].observations.database.entities.find((item) => item.kind === 'pagination-keyset').fields.cursors[0].boundaryIdentity.articleId = 'foreign';
    assert.throws(() => projectFixtureIds(changed), /digest|pagination/u);
});

test('canonical CLI writes verified projection privately and refuses prepared input', async () =>
{
    const directory = mkdtempSync(path.join(tmpdir(), 'issue-1851-verified-projection-'));
    try
    {
        const receipt = await verifiedFixture();
        const input = path.join(directory, 'receipt.json');
        const output = path.join(directory, 'projection.json');
        writeFixtureReceipt(input, receipt);
        const execution = spawnSync(process.execPath, ['tools/test-fixtures/cli.mjs', 'project-verified', '--receipt', input, '--out', output], { encoding: 'utf8' });
        assert.equal(execution.status, 0, execution.stderr);
        assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), projectFixtureIds(receipt));
        assert.equal(statSync(output).mode & 0o777, 0o600);
        const rejected = spawnSync(process.execPath, ['tools/test-fixtures/cli.mjs', 'project-verified', '--receipt', output, '--out', path.join(directory, 'bad.json')], { encoding: 'utf8' });
        assert.notEqual(rejected.status, 0);
        const { prepared } = await preparedFixture();
        const preparedPath = path.join(directory, 'prepared.json');
        writePrivateJson(preparedPath, prepared);
        const unverified = spawnSync(process.execPath, ['tools/test-fixtures/cli.mjs', 'project-verified', '--receipt', preparedPath, '--out', path.join(directory, 'unverified.json')], { encoding: 'utf8' });
        assert.notEqual(unverified.status, 0);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('projection reruns pagination postcondition even when altered observations are resealed', async () =>
{
    const receipt = await verifiedFixture();
    const previous = receipt.producerReceipts[0];
    const database = structuredClone(previous.observations.database);
    database.entities.find((item) => item.kind === 'pagination-keyset').fields.cursors[0].boundaryIdentity.articleId = 'foreign';
    const producer = buildProducerReceipt({ ...previous,
        databaseObservation: database, redisObservation: previous.observations.redis, cacheObservation: previous.observations.cache });
    const forged = buildFixtureReceipt({ ...receipt,
        orderedProducerReceiptDigests: [producer.producerReceiptDigest], producerReceipts: [producer],
        databaseObservation: database });
    assert.throws(() => projectFixtureIds(forged), /verified pagination projection rejected/u);
});

for (const kind of ['cache', 'generation'])
{
    test(`independent public verification refuses ${kind} drift`, async () =>
    {
        const { prepared, port } = await preparedFixture();
        await assert.rejects(verify(prepared, [port], { handles: { publicContentAdapter: { async verify(context, result)
        {
            const current = live(context, result);
            if (kind === 'generation')
            {
                current.observations.cache.generation += 1;
            }
            else
            {
                current.observations.cache.entries.push({ endpoint: 'article/hot', matchesDb: false });
            }
            return current;
        } } } }), /cache\/generation drift/u);
    });
}

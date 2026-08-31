import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { checkFixtureMutationRecoveryGovernance } from '../../tools/governance/check-fixture-mutation-recovery-governance.mjs';
import {
    loadCanonicalMutationEnvelopeCatalog
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test-fixtures/mutation-envelope-catalog.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { digest, seal } from '../../tools/test-fixtures/mutation-recovery/canonical.mjs';
import {
    applyFixtureMutation,
    buildMutationRecoveryPlan,
    buildMutationRequest,
    buildSnapshotRequest,
    compareSemanticSnapshots,
    createSemanticSnapshot,
    runMutationRecovery,
    readMutationJournal,
    verifyMutationJournal,
    verifyMutationRecoveryReceipt,
    verifySemanticDiff,
    verifyExternalSemanticSnapshot,
    verifySemanticSnapshot,
    writeMutationJournal
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test-fixtures/mutation-recovery/index.mjs';
import {
    buildFixtureReceipt,
    buildProducerReceipt,
    digestCanonical
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test-fixtures/receipt/index.mjs';
import {
    buildFixtureVariantPlan,
    buildProducerFixtureVariantPlan,
    fixtureCatalogDigest,
    readFixtureCatalogs
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/testing/fixture-catalog.mjs';

const catalogs = readFixtureCatalogs();
const fixtureCatalog = fixtureCatalogDigest(catalogs);
const mutationCatalog = loadCanonicalMutationEnvelopeCatalog();
const source = { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` };
const runtimeIdentity = {
    digest: `sha256:${'c'.repeat(64)}`,
    backendPid: 8123,
    backendStartedAt: '2026-08-26T00:00:00.000Z',
    databaseInstance: 'db-1',
    redisInstance: 'redis-1'
};
const serviceIdentity = {
    databaseSchema: 'public',
    databaseInstance: 'db-1',
    redisInstance: 'redis-1',
    redisNamespace: 'FsusBlog_run-a_',
    schemaIdentity: 'public'
};
const producerPlanDigest = `sha256:${'d'.repeat(64)}`;
const temporalContextDigest = `sha256:${'e'.repeat(64)}`;

test('semantic snapshot policy is closed and schema-valid', () =>
{
    const policy = JSON.parse(readFileSync('config/testing/fixture-semantic-snapshot-policy.json', 'utf8'));
    const schema = JSON.parse(readFileSync('config/schemas/fixture-semantic-snapshot-policy.schema.json', 'utf8'));
    assert.equal(schema.$id, policy.schema);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(policy).sort());
    assert.deepEqual([...schema.properties.fieldDispositions.items.enum].sort(), [...policy.fieldDispositions].sort());
    assert.deepEqual([...schema.properties.recordKinds.items.enum].sort(), [...policy.recordKinds].sort());
    assert.ok(policy.nonownedSentinelDomains.every((domain) => domain.startsWith('sentinel.')));
});

function verifiedReceipt()
{
    const variantIds = ['canonical.public.article.published'];
    const variantPlan = buildFixtureVariantPlan(variantIds, catalogs);
    const producerPlan = buildProducerFixtureVariantPlan({
        producerId: 'public-content',
        variantIds,
        fixtureVariantIds: variantIds,
        fixtureVariantPlanDigest: variantPlan.variantPlanDigest,
        catalogs
    });
    const identity = {
        namespace: 'run-a',
        catalogDigest: fixtureCatalog,
        serviceGeneration: 'generation-1'
    };
    const producer = buildProducerReceipt({
        producerId: 'public-content',
        strategy: 'transaction-fixture',
        runId: 'run-a',
        namespace: 'run-a',
        source,
        fixtureCatalogDigest: fixtureCatalog,
        profileId: 'public-minimal',
        expandedCapabilityDigest: digestCanonical(['public.article.published']),
        fixtureVariantIds: variantIds,
        variantPlanDigest: variantPlan.variantPlanDigest,
        producerVariantPlanDigest: producerPlan.producerVariantPlanDigest,
        producedVariantIds: variantIds,
        serviceGeneration: 'generation-1',
        providedCapabilities: ['public.article.published'],
        ownedStateDomains: ['fixture.public-content', 'postgres.article', 'postgres.outbox', 'redis.cache.public'],
        entityIdentities: [{ kind: 'article', id: 'article-1', variantId: variantIds[0] }],
        postconditionObservations: [{
            capabilityId: 'public.article.published',
            postconditionId: 'article-published',
            ok: true,
            detail: { articleIds: ['article-1'] }
        }],
        databaseObservation: {
            ...identity,
            schemaIdentity: 'public',
            entities: [{
                kind: 'article', id: 'article-1', variantId: variantIds[0], owned: true,
                fields: { status: 'published', deleted: false, currentPublicationId: 'pub-1', publicDetailReadable: true }
            }]
        },
        redisObservation: { ...identity, keys: [{ domain: 'redis.cache.public', key: 'hot:article-1', present: true }] },
        cacheObservation: {
            ...identity,
            entries: [{ domain: 'public.home.featured-hot', generation: 'generation-1', matchesDb: true, visibleEntityIds: ['article-1'] }]
        },
        catalogs
    });
    return buildFixtureReceipt({
        terminalStatus: 'verified',
        executionIdentity: { runId: 'run-a', namespace: 'run-a', source, serviceGeneration: 'generation-1' },
        profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli', executionClass: 'runtime' },
        catalogDigest: fixtureCatalog,
        expandedCapabilityDigest: digestCanonical(['public.article.published']),
        orderedProducerReceiptDigests: [producer.producerReceiptDigest],
        producerReceipts: [producer],
        capabilityMap: [{ capabilityId: 'public.article.published', producerId: 'public-content', postconditionIds: ['article-published'] }],
        serviceIdentity,
        catalogs
    });
}

function field(name, value, disposition = 'semantic', semanticRole = null)
{
    return { name, value, disposition, semanticRole };
}

function semanticRecords(state = {})
{
    return [
        {
            kind: 'entity', domain: 'article.metadata', role: 'article', stableId: 'article-1', owned: true,
            fields: [
                field('published-at', state.publishedAt ?? '2026-01-01T00:00:00.123Z', 'semantic', 'article-published-instant'),
                field('updated-at', '2026-01-02T00:00:00.456Z', 'semantic', 'article-updated-instant'),
                field('nullable', null), field('empty', ''), field('false-value', false), field('zero-value', 0),
                field('generated-at', 'volatile', 'diagnostic-volatile'),
                field('token', { redacted: true, present: true, type: 'string', digest: `sha256:${'f'.repeat(64)}` }, 'secret-redacted')
            ]
        },
        {
            kind: 'relation', domain: 'article.tags', role: 'article-tag', stableId: 'article-1/tag-1', owned: true,
            fields: [field('version', 2), field('target', 'tag-1')]
        },
        {
            kind: 'redis-key', domain: 'public.projection', role: 'deleted-article-projection-generation', stableId: 'key-1', owned: true,
            ttlMilliseconds: state.ttl ?? 1234, generation: 'generation-1', fields: [field('value-digest', `sha256:${'1'.repeat(64)}`)]
        },
        {
            kind: 'file', domain: 'media', role: 'thumbnail', stableId: 'media-1', owned: true,
            relativePath: 'media/article-1/thumb.webp', byteDigest: state.byteDigest ?? `sha256:${'2'.repeat(64)}`,
            byteLength: state.byteLength ?? 32, fields: [field('media-type', 'image/webp')]
        },
        {
            kind: 'api-projection', domain: 'public.projection', role: 'article-detail', stableId: 'article-1', owned: true,
            fields: [field('status', 'published'), field('version', 2)]
        },
        {
            kind: 'outbox', domain: 'article.metadata', role: 'publication-event', stableId: 'event-1', owned: true,
            fields: [field('version', 1), field('published', true)]
        },
        {
            kind: 'entity', domain: 'sentinel.dev-data', role: 'article', stableId: 'dev-article', owned: false,
            fields: [field('value', state.sentinel ?? 'untouched')]
        }
    ];
}

function request(receipt, purpose, provider = 'postgresql')
{
    return buildSnapshotRequest({
        receipt,
        producerPlanDigest,
        mutationCatalog,
        provider,
        runtimeIdentity,
        temporalContextDigest,
        purpose
    });
}

function observer(records)
{
    return async () =>
    {
        const value = typeof records === 'function' ? records() : records;
        const ordered = Array.isArray(value)
            ? [...value].sort((left, right) => `${left.owned ? 'owned' : 'sentinel'}:${left.kind}:${left.domain}:${left.role}:${left.stableId}`
                .localeCompare(`${right.owned ? 'owned' : 'sentinel'}:${right.kind}:${right.domain}:${right.role}:${right.stableId}`))
            : value;
        return {
            runtimeIdentity,
            serviceGeneration: 'generation-1',
            serviceIdentity,
            records: ordered
        };
    };
}

test('semantic snapshots are current-runtime-bound, closed, redacted and content-sharded', async () =>
{
    const receipt = verifiedReceipt();
    const baselineRequest = request(receipt, 'baseline');
    const snapshot = await createSemanticSnapshot({
        request: baselineRequest,
        receipt,
        observe: observer(semanticRecords()),
        shardSize: 2
    });
    verifySemanticSnapshot(snapshot, baselineRequest);
    assert.equal(snapshot.manifest.recordCount, 7);
    assert.equal(snapshot.shards.length, 4);
    const article = snapshot.shards.flatMap((item) => item.records)
        .find((item) => item.record.domain === 'article.metadata' && item.record.kind === 'entity').record;
    assert.equal(article.fields.some((item) => item.name === 'generated-at'), false);
    assert.equal(article.fields.find((item) => item.name === 'token').value.redacted, true);
    assert.equal(JSON.stringify(snapshot).includes('volatile'), false);

    const externalShards = new Map();
    const external = await createSemanticSnapshot({
        request: baselineRequest,
        receipt,
        observe: observer(semanticRecords()),
        shardSize: 2,
        shardWriter: async (shard) => externalShards.set(shard.contentDigest, shard),
        retainShards: false
    });
    await verifyExternalSemanticSnapshot(
        external,
        baselineRequest,
        async (descriptor) => externalShards.get(descriptor.digest)
    );
    const firstExternalDigest = external.manifest.shards[0].digest;
    externalShards.get(firstExternalDigest).records[0].record.fields[0].value = 'tampered';
    await assert.rejects(
        verifyExternalSemanticSnapshot(external, baselineRequest,
            async (descriptor) => externalShards.get(descriptor.digest)),
        /digest mismatch/
    );

    const unknown = semanticRecords();
    unknown[0].fields.push({ name: 'unknown', value: 1, disposition: 'guess' });
    await assert.rejects(
        createSemanticSnapshot({ request: baselineRequest, receipt, observe: observer(unknown) }),
        /unknown field disposition/
    );
    const plaintext = semanticRecords();
    plaintext[0].fields.find((item) => item.name === 'token').disposition = 'semantic';
    plaintext[0].fields.find((item) => item.name === 'token').value = 'plaintext-secret';
    await assert.rejects(
        createSemanticSnapshot({ request: baselineRequest, receipt, observe: observer(plaintext) }),
        /protected field must be secret-redacted/
    );
    await assert.rejects(
        createSemanticSnapshot({
            request: baselineRequest,
            receipt,
            observe: async () => ({
                runtimeIdentity: { ...runtimeIdentity, backendPid: 9 },
                serviceGeneration: 'generation-1', serviceIdentity, records: []
            })
        }),
        /not from the request current runtime/
    );
    await assert.rejects(
        createSemanticSnapshot({
            request: baselineRequest,
            receipt,
            observe: async () => ({
                runtimeIdentity, serviceGeneration: 'generation-1', serviceIdentity,
                records: [...semanticRecords()].reverse()
            })
        }),
        /non-canonical semantic record/
    );
});

test('snapshot authority accepts every catalog semantic domain and every provider through one contract', async () =>
{
    const receipt = verifiedReceipt();
    const records = mutationCatalog.semanticDomains.map((domain, index) => ({
        kind: 'entity', domain, role: 'other', stableId: `record-${String(index).padStart(3, '0')}`,
        owned: true, fields: [field('value', index)]
    }));
    for (const provider of mutationCatalog.providers)
    {
        const baselineRequest = request(receipt, 'baseline', provider);
        const snapshot = await createSemanticSnapshot({ request: baselineRequest, receipt, observe: observer(records) });
        verifySemanticSnapshot(snapshot, baselineRequest);
        assert.equal(snapshot.manifest.recordCount, mutationCatalog.semanticDomains.length);
    }
});

test('every catalog envelope and closed mutation kind produces only its declared provider drift', async () =>
{
    const receipt = verifiedReceipt();
    const coveredKinds = new Set();
    for (const envelope of mutationCatalog.envelopes)
    {
        const provider = Object.entries(envelope.providerSupport).find(([, supported]) => supported)[0];
        const baselineRequest = request(receipt, 'baseline', provider);
        const mutatedRequest = request(receipt, 'mutated', provider);
        const records = [];
        for (const target of envelope.allowedChanges.entities)
        {
            records.push({
                kind: 'entity', domain: target.domain, role: target.kind,
                stableId: `${envelope.envelopeId.replaceAll('/', '-')}-entity`, owned: true,
                fields: target.fields.map((name) => field(name, 0, 'semantic',
                    /(?:^|[-_.])(?:timestamp|time|at)(?:$|[-_.])/u.test(name) ? `${name}-role` : null))
            });
        }
        for (const target of [...envelope.allowedChanges.redisKeys.map((item) => ({ ...item, role: item.keyRole })),
            ...envelope.allowedChanges.cacheEntries.map((item) => ({ ...item, role: item.generationRole }))])
        {
            records.push({
                kind: 'redis-key', domain: target.domain, role: target.role,
                stableId: `${envelope.envelopeId.replaceAll('/', '-')}-key`, owned: true,
                ttlMilliseconds: 1000, generation: 'generation-1', fields: [field('value-digest', `sha256:${'6'.repeat(64)}`)]
            });
        }
        for (const target of envelope.allowedChanges.ownedFiles)
        {
            records.push({
                kind: 'file', domain: target.domain, role: target.role,
                stableId: `${envelope.envelopeId.replaceAll('/', '-')}-file`, owned: true,
                relativePath: `media/${envelope.envelopeId.replaceAll('/', '-')}.bin`,
                byteDigest: `sha256:${'7'.repeat(64)}`, byteLength: 10, fields: []
            });
        }
        let changed = structuredClone(records);
        if (['remove-required-row/relation', 'delete-owned-file', 'delete-owned-cache-key'].includes(envelope.mutationKind))
        {
            changed = [];
        }
        else if (envelope.mutationKind === 'add-extra-owned-relation')
        {
            const added = structuredClone(changed[0]);
            added.stableId = `${added.stableId}-extra`;
            changed.push(added);
        }
        else if (changed[0]?.kind === 'entity')
        {
            changed[0].fields[0].value = 1;
        }
        else if (changed[0]?.kind === 'redis-key')
        {
            changed[0].ttlMilliseconds = 1;
        }
        else if (changed[0]?.kind === 'file')
        {
            changed[0].byteDigest = `sha256:${'8'.repeat(64)}`;
            changed[0].byteLength = envelope.mutationKind === 'truncate-owned-file' ? 0 : 11;
        }
        const baseline = await createSemanticSnapshot({ request: baselineRequest, receipt, observe: observer(records) });
        const candidate = await createSemanticSnapshot({ request: mutatedRequest, receipt, observe: observer(changed) });
        const diff = compareSemanticSnapshots({ baseline, candidate, baselineRequest, candidateRequest: mutatedRequest, envelope });
        verifySemanticDiff(diff, { requireExpectedDrift: true });
        coveredKinds.add(envelope.mutationKind);
    }
    assert.deepEqual([...coveredKinds].sort(), [...mutationCatalog.mutationKinds].sort());
});

test('semantic diff preserves exact values, TTL, relations, files, projections and nonowned sentinels', async () =>
{
    const receipt = verifiedReceipt();
    const baselineRequest = request(receipt, 'baseline');
    const mutatedRequest = request(receipt, 'mutated');
    const baseline = await createSemanticSnapshot({ request: baselineRequest, receipt, observe: observer(semanticRecords()) });
    const envelope = mutationCatalog.envelopes.find((item) => item.envelopeId === 'mutation/article-metadata-timestamp');
    const candidate = await createSemanticSnapshot({
        request: mutatedRequest,
        receipt,
        observe: observer(semanticRecords({ publishedAt: '2026-03-01T00:00:00.123Z' }))
    });
    const diff = compareSemanticSnapshots({ baseline, candidate, baselineRequest, candidateRequest: mutatedRequest, envelope });
    verifySemanticDiff(diff, { requireExpectedDrift: true });
    assert.equal(diff.expectedDrift.length, 1);
    assert.deepEqual(diff.expectedDrift[0].details.fieldChanges, ['published-at']);

    const precisionRequest = request(receipt, 'reprepared');
    const precisionEquivalent = await createSemanticSnapshot({
        request: precisionRequest,
        receipt,
        observe: observer(semanticRecords({ publishedAt: '2026-01-01T00:00:00.123000Z' }))
    });
    const precisionDiff = compareSemanticSnapshots({
        baseline, candidate: precisionEquivalent, baselineRequest, candidateRequest: precisionRequest
    });
    verifySemanticDiff(precisionDiff, { requireExactRecovery: true });

    const bad = await createSemanticSnapshot({
        request: mutatedRequest,
        receipt,
        observe: observer(semanticRecords({ publishedAt: '2026-03-01T00:00:00.123Z', sentinel: 'damaged', ttl: 1, byteDigest: `sha256:${'3'.repeat(64)}` }))
    });
    const badDiff = compareSemanticSnapshots({ baseline, candidate: bad, baselineRequest, candidateRequest: mutatedRequest, envelope });
    assert.throws(() => verifySemanticDiff(badDiff, { requireExpectedDrift: true }), /unexpected or nonowned drift/);

    const tampered = structuredClone(candidate);
    tampered.shards[0].records[0].record.fields[0].value = 'tampered';
    assert.throws(() => verifySemanticSnapshot(tampered, mutatedRequest), /digest mismatch/);
});

function fakePort(provider, state, apply)
{
    const attempts = new Set();
    return {
        ...(provider === 'filesystem' ? {
            fixtureRootRealPath: '/fixture-root',
            realPath: (relative) => `/fixture-root/${relative}`
        } : {}),
        async verifyIdentity(identity)
        {
            assert.deepEqual(identity.runtimeIdentity, runtimeIdentity);
        },
        async applyMutation(input)
        {
            if (attempts.has(input.attemptId))
            {
                return { requestDigest: input.requestDigest, duplicateApplied: true };
            }
            attempts.add(input.attemptId);
            state.before = structuredClone(state.current);
            apply(state.current, input.targets);
            return {
                requestDigest: input.requestDigest,
                duplicateApplied: false,
                transactionRef: databaseProviders.has(provider) ? `transaction:${input.attemptId}` : null,
                recoveryRef: `recovery:${input.attemptId}`
            };
        },
        async restoreMutation()
        {
            state.current = structuredClone(state.before);
            return { restored: true };
        },
        async recoverInterruptedAttempt()
        {
            if (state.before)
            {
                state.current = structuredClone(state.before);
            }
            return { restored: true };
        }
    };
}

const databaseProviders = new Set(['postgresql', 'mysql', 'sqlite']);

test('PostgreSQL, MySQL and SQLite adapters apply one parameter-bound semantic mutation with identical drift', async () =>
{
    for (const provider of databaseProviders)
    {
        const receipt = verifiedReceipt();
        const baselineRequest = request(receipt, 'baseline', provider);
        const baseline = await createSemanticSnapshot({ request: baselineRequest, receipt, observe: observer(semanticRecords()) });
        const envelope = mutationCatalog.envelopes.find((item) => item.envelopeId === 'mutation/article-metadata-timestamp');
        const mutationRequest = buildMutationRequest({
            receipt, baseline, baselineRequest, envelopeId: envelope.envelopeId,
            provider, attemptId: `${provider}-attempt`, catalog: mutationCatalog
        });
        const state = { current: { publishedAt: '2026-01-01T00:00:00.123Z' } };
        const port = fakePort(provider, state, (current) =>
        {
            current.publishedAt = '2026-04-01T00:00:00.123Z';
        });
        let mutated;
        const journal = await applyFixtureMutation({
            request: mutationRequest, baseline, baselineRequest, envelope, port,
            observeMutated: async () =>
            {
                const mutatedRequest = request(receipt, 'mutated', provider);
                const snapshot = await createSemanticSnapshot({ request: mutatedRequest, receipt, observe: observer(semanticRecords(state.current)) });
                mutated = { request: mutatedRequest, snapshot };
                return mutated;
            }
        });
        await verifyMutationJournal({
            journal, request: mutationRequest, port, mutated: mutated.snapshot,
            mutatedRequest: mutated.request, baseline, baselineRequest, envelope
        });
        assert.equal(journal.status, 'expected-drift-verified');
        assert.equal(JSON.stringify(journal).includes('2026-01-01'), false);
        const directory = mkdtempSync(path.join(tmpdir(), `fsusblog-${provider}-journal-`));
        try
        {
            const file = path.join(directory, 'journal.json');
            writeMutationJournal(file, journal);
            assert.equal(readMutationJournal(file).contentDigest, journal.contentDigest);
            assert.throws(() => writeMutationJournal(file, journal), /exist/u);
            writeFileSync(file, `${JSON.stringify({ ...journal, status: 'forged' })}\n`, { mode: 0o600 });
            assert.throws(() => readMutationJournal(file), /digest mismatch/);
        }
        finally
        {
            rmSync(directory, { recursive: true, force: true });
        }
    }
});

test('missing target drift restores before-state and duplicate attempts fail without second damage', async () =>
{
    const receipt = verifiedReceipt();
    const baselineRequest = request(receipt, 'baseline');
    const baseline = await createSemanticSnapshot({ request: baselineRequest, receipt, observe: observer(semanticRecords()) });
    const envelope = mutationCatalog.envelopes.find((item) => item.envelopeId === 'mutation/article-metadata-timestamp');
    const mutationRequest = buildMutationRequest({
        receipt, baseline, baselineRequest, envelopeId: envelope.envelopeId,
        provider: 'postgresql', attemptId: 'no-drift-attempt', catalog: mutationCatalog
    });
    const state = { current: { publishedAt: '2026-01-01T00:00:00.123Z' }, restoreCount: 0 };
    const port = fakePort('postgresql', state, () =>
    {});
    const restore = port.restoreMutation;
    port.restoreMutation = async (input) =>
    {
        state.restoreCount += 1;
        return restore(input);
    };
    await assert.rejects(applyFixtureMutation({
        request: mutationRequest, baseline, baselineRequest, envelope, port,
        observeMutated: async () =>
        {
            const mutatedRequest = request(receipt, 'mutated');
            return {
                request: mutatedRequest,
                snapshot: await createSemanticSnapshot({ request: mutatedRequest, receipt, observe: observer(semanticRecords(state.current)) })
            };
        }
    }), /declared mutation target did not change/);
    assert.equal(state.restoreCount, 1);
    await assert.rejects(applyFixtureMutation({
        request: mutationRequest, baseline, baselineRequest, envelope, port,
        observeMutated: async () =>
        {
            throw new Error('must not observe duplicate');
        }
    }), /single-attempt result/);
    assert.equal(state.restoreCount, 1);
});

test('Redis and filesystem adapters reject wildcard and root escape and verify exact TTL/bytes drift', async () =>
{
    const receipt = verifiedReceipt();
    for (const provider of ['redis', 'filesystem'])
    {
        const baselineRequest = request(receipt, 'baseline', provider);
        const baseline = await createSemanticSnapshot({ request: baselineRequest, receipt, observe: observer(semanticRecords()) });
        const envelope = provider === 'redis'
            ? mutationCatalog.envelopes.find((item) => item.envelopeId === 'mutation/public-deleted-projection-cache-stale')
            : mutationCatalog.envelopes.find((item) => item.envelopeId === 'mutation/owned-media-truncated');
        const state = { current: {} };
        const port = fakePort(provider, state, (current) =>
        {
            if (provider === 'redis')
            {
                current.ttl = 5;
            }
            else
            {
                current.byteDigest = `sha256:${'4'.repeat(64)}`;
                current.byteLength = 0;
            }
        });
        const targets = provider === 'redis'
            ? [{ domain: 'public.projection', role: 'deleted-article-projection-generation', stableId: 'key-1', ttlMilliseconds: 1234, generation: 'generation-1', beforeDigest: digest(semanticRecords()[2]) }]
            : [{ domain: 'media', role: 'thumbnail', stableId: 'media-1', relativePath: 'media/article-1/thumb.webp', beforeDigest: digest(semanticRecords()[3]) }];
        const mutationRequest = seal({
            schema: 'fsusblog.fixture-mutation-request.v1', attemptId: `${provider}-attempt`, runId: 'run-a', namespace: 'run-a',
            profileId: 'public-minimal', source, serviceGeneration: 'generation-1', serviceIdentity, runtimeIdentity,
            receiptDigest: receipt.receiptDigest, snapshotDigest: baseline.manifest.contentDigest,
            catalogDigest: mutationCatalog.contentDigest, envelopeId: envelope.envelopeId, envelopeDigest: envelope.contentDigest,
            mutationKind: envelope.mutationKind, provider, targets
        });
        let mutated;
        const journal = await applyFixtureMutation({
            request: mutationRequest, baseline, baselineRequest, envelope, port,
            observeMutated: async () =>
            {
                const mutatedRequest = request(receipt, 'mutated', provider);
                const snapshot = await createSemanticSnapshot({ request: mutatedRequest, receipt, observe: observer(semanticRecords(state.current)) });
                mutated = { request: mutatedRequest, snapshot };
                return mutated;
            }
        });
        await verifyMutationJournal({ journal, request: mutationRequest, port, mutated: mutated.snapshot, mutatedRequest: mutated.request, baseline, baselineRequest, envelope });
        assert.equal(journal.status, 'expected-drift-verified');

        if (provider === 'redis')
        {
            const wildcard = structuredClone(mutationRequest);
            wildcard.targets[0].stableId = 'key-*';
            wildcard.contentDigest = seal(wildcard).contentDigest;
            await assert.rejects(applyFixtureMutation({ request: wildcard, baseline, baselineRequest, envelope, port, observeMutated: async () => mutated }), /single-attempt result|wildcard/u);
        }
        else
        {
            const escapingPort = { ...port, realPath: () => '/outside/thumb.webp' };
            const newRequest = seal({ ...mutationRequest, attemptId: 'filesystem-escape-attempt' });
            await assert.rejects(applyFixtureMutation({ request: newRequest, baseline, baselineRequest, envelope, port: escapingPort, observeMutated: async () => mutated }), /symlink, junction or reparse escape/);
        }
    }
});

test('same-runtime runner proves drift then canonical same-profile exact recovery without retry or cleanup', async () =>
{
    const receipt = verifiedReceipt();
    const envelopeId = 'mutation/article-metadata-timestamp';
    const state = { current: { publishedAt: '2026-01-01T00:00:00.123Z' } };
    const port = fakePort('postgresql', state, (current) =>
    {
        current.publishedAt = '2026-05-01T00:00:00.123Z';
    });
    let prepareCount = 0;
    const plan = buildMutationRecoveryPlan({
        runId: 'run-a', attemptId: 'attempt-0001', profileId: 'public-minimal', provider: 'postgresql',
        envelopeIds: [envelopeId], producerPlanDigest, source, temporalContextDigest, runtimeIdentity, serviceIdentity
    });
    const recovery = await runMutationRecovery({
        plan,
        prepareAndVerify: async ({ previousReceipt, sameSealedPlan }) =>
        {
            prepareCount += 1;
            if (previousReceipt)
            {
                assert.equal(sameSealedPlan, true);
                state.current = { publishedAt: '2026-01-01T00:00:00.123Z' };
            }
            return receipt;
        },
        observe: observer(() => semanticRecords(state.current)),
        adapterPort: port,
        probeRuntime: async () => runtimeIdentity
    });
    verifyMutationRecoveryReceipt(recovery, plan);
    assert.equal(prepareCount, 2);
    assert.equal(recovery.retryCount, 0);
    assert.equal(recovery.forbiddenOperationCount, 0);
});

test('runner rejects runtime restart and restores the active mutation before propagating first failure', async () =>
{
    const receipt = verifiedReceipt();
    const state = { current: { publishedAt: '2026-01-01T00:00:00.123Z' }, restoreCount: 0 };
    const port = fakePort('postgresql', state, (current) =>
    {
        current.publishedAt = '2026-06-01T00:00:00.123Z';
    });
    const restore = port.restoreMutation;
    port.restoreMutation = async (input) =>
    {
        state.restoreCount += 1;
        return restore(input);
    };
    const plan = buildMutationRecoveryPlan({
        runId: 'run-a', attemptId: 'attempt-failure', profileId: 'public-minimal', provider: 'postgresql',
        envelopeIds: ['mutation/article-metadata-timestamp'], producerPlanDigest, source,
        temporalContextDigest, runtimeIdentity, serviceIdentity
    });
    let probes = 0;
    await assert.rejects(runMutationRecovery({
        plan,
        prepareAndVerify: async () => receipt,
        observe: observer(() => semanticRecords(state.current)),
        adapterPort: port,
        probeRuntime: async () => (++probes === 1
            ? runtimeIdentity
            : { ...runtimeIdentity, backendPid: runtimeIdentity.backendPid + 1 })
    }), /identity changed during mutation recovery/);
    assert.equal(state.restoreCount, 1);
    assert.equal(state.current.publishedAt, '2026-01-01T00:00:00.123Z');
});

test('snapshot sharding scales without row-count-only equality and tamper remains independently visible', async () =>
{
    const receipt = verifiedReceipt();
    const baselineRequest = request(receipt, 'baseline');
    async function *records()
    {
        for (let index = 0; index < 100_000; index += 1)
        {
            yield {
                kind: 'entity', domain: 'article.views', role: 'article', stableId: `article-${String(index).padStart(6, '0')}`,
                owned: true, fields: [field('view-count', index), field('version', index % 7)]
            };
        }
    }
    const snapshot = await createSemanticSnapshot({
        request: baselineRequest,
        receipt,
        observe: async () => ({ runtimeIdentity, serviceGeneration: 'generation-1', serviceIdentity, records: records() }),
        shardSize: 4096
    });
    verifySemanticSnapshot(snapshot, baselineRequest);
    assert.equal(snapshot.manifest.recordCount, 100_000);
    assert.equal(snapshot.shards.length, 25);
    assert.ok(snapshot.shards.every((shard) => shard.records.length <= 4096));

    let writtenShards = 0;
    async function *millionRecords()
    {
        for (let index = 0; index < 1_000_000; index += 1)
        {
            yield {
                kind: 'entity', domain: 'article.views', role: 'article',
                stableId: `article-${String(index).padStart(7, '0')}`,
                owned: true, fields: [field('view-count', index)]
            };
        }
    }
    const external = await createSemanticSnapshot({
        request: baselineRequest,
        receipt,
        observe: async () => ({ runtimeIdentity, serviceGeneration: 'generation-1', serviceIdentity, records: millionRecords() }),
        shardSize: 10_000,
        shardWriter: async () =>
        {
            writtenShards += 1;
        },
        retainShards: false
    });
    assert.equal(external.manifest.recordCount, 1_000_000);
    assert.equal(external.manifest.shards.length, 100);
    assert.equal(external.shards.length, 0);
    assert.equal(writtenShards, 100);
    assert.throws(() => verifySemanticSnapshot(external, baselineRequest), /independently re-read external shards/);
});

test('static governance rejects raw mutation authority and a second recovery runner', () =>
{
    assert.deepEqual(checkFixtureMutationRecoveryGovernance(), []);
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fsusblog-mutation-recovery-governance-'));
    try
    {
        const relativeFiles = [
            'tools/test-fixtures/mutation-recovery/mutation-adapters.mjs',
            'tools/test-fixtures/mutation-recovery/runner.mjs',
            'tools/test-fixtures/mutation-recovery/semantic-snapshot.mjs'
        ];
        for (const relative of relativeFiles)
        {
            const target = path.join(fixtureRoot, relative);
            mkdirSync(path.dirname(target), { recursive: true });
            cpSync(relative, target);
        }
        const adapterFile = path.join(fixtureRoot, relativeFiles[0]);
        writeFileSync(adapterFile, `${readFileSync(adapterFile, 'utf8')}\nport.query(userText);\n`);
        const runnerFile = path.join(fixtureRoot, relativeFiles[1]);
        writeFileSync(runnerFile, `${readFileSync(runnerFile, 'utf8')}\nexport async function runMutationRecovery() {}\n`);
        const errors = checkFixtureMutationRecoveryGovernance(fixtureRoot);
        assert.ok(errors.some((error) => error.includes('raw database query')));
        assert.ok(errors.some((error) => error.includes('exactly one canonical implementation')));
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

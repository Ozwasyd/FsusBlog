import assert from 'node:assert/strict';
import test from 'node:test';

const {buildAuditPlan, computeAuditNegativeContentDigest, computeAuditReceiptContentDigest, prepareAuditRecords, validateAuditReceipt, verifyAuditRecords} = await import(new URL('../../tools/test-fixtures/producers/audit-producer.mjs', import.meta.url));
const {createAuditRecordsPort, createDefaultProducerPorts} = await import(new URL('../../tools/test-fixtures/producers/catalog-ports.mjs', import.meta.url));
const {defaultTimeoutPolicyDigest, qualificationTemporalContext, verifyTemporalReplay} = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const {bindCorrectnessProducerTemporalArtifacts} = await import(new URL('../../tools/test/temporal-producer-bindings.mjs', import.meta.url));
const {cleanup, plan, prepare, verify} = await import(new URL('../../tools/test-fixtures/orchestrator.mjs', import.meta.url));
const {validateFixtureVariantEvidence} = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));
function context(capabilities)
{
    return {
        namespace: 'audit-ns',
        runIdentity: 'audit-run',
        plan: { capabilities },
        temporalContext: qualificationTemporalContext({
            sourceCommit: 'a'.repeat(40),
            sourceFingerprint: `sha256:${'b'.repeat(64)}`,
            producerId: 'audit-records',
            schedulerRunId: 'audit-run',
            businessEpochUtc: '2026-08-20T12:00:00.000Z',
            locale: 'en-US',
            uiLocale: 'en-US',
            timeoutPolicyDigest: defaultTimeoutPolicyDigest()
        }),
        handles: {}
    };
}

function receiptFor(plan, overrides = {})
{
    const receipt = {
        schema: 'fsusblog.audit-fixture-receipt.v1',
        producerId: 'audit-records',
        strategy: 'transaction-fixture',
        owner: 'audit-fixture:0123456789abcdef01234567',
        capabilities: [...plan.capabilities],
        records: [],
        negativeCases: [],
        retention: [],
        query: null,
        authorities: {
            actionCatalog: 'AuditRetentionCatalog',
            store: 'AuditLogStore',
            protector: 'AuditRetentionPayloadProtector',
            signer: 'AuditTamperEvidence',
            query: 'AuditQueryService',
            temporalAuthority: 'TestTemporalRuntimeContext.BusinessEpochUtc',
            commandDigest: '5'.repeat(64)
        },
        privacy: {
            protectedRecordCount: 0,
            plaintextDetected: false,
            projectionDigest: '6'.repeat(64)
        },
        performance: {
            recordCount: 0,
            batchCount: 0,
            maximumBatchSize: 100,
            elapsedMilliseconds: 0
        },
        policyDigest: '0'.repeat(64),
        semanticRecordSetDigest: '1'.repeat(64),
        status: 'verified',
        warnings: [],
        ...overrides
    };
    receipt.contentDigest = computeAuditReceiptContentDigest(receipt);
    return receipt;
}

test('audit records port is exported once through the default producer registry', () =>
{
    const port = createAuditRecordsPort();
    const defaultAuditPorts = createDefaultProducerPorts()
        .filter((candidate) => candidate.id === 'audit-records');

    assert.equal(port.id, 'audit-records');
    assert.equal(port.strategy, 'transaction-fixture');
    assert.deepEqual(defaultAuditPorts.map((candidate) => candidate.id), ['audit-records']);
    assert.equal(typeof port.prepare, 'function');
    assert.equal(typeof port.verify, 'function');
    assert.equal(typeof port.cleanup, 'function');
});

test('audit plan is exact, UTC-bound and rejects empty mixing', () =>
{
    const plan = buildAuditPlan(context([
        'audit.single-valid',
        'audit.chain-multi-record',
        'audit.single-valid'
    ]));

    assert.deepEqual(plan.capabilities, [
        'audit.chain-multi-record',
        'audit.single-valid'
    ]);
    assert.equal(plan.businessEpochUtc, '2026-08-20T12:00:00.000Z');
    assert.throws(
        () => buildAuditPlan(context(['audit.empty', 'audit.single-valid'])),
        /cannot mix/u
    );
    assert.throws(
        () => buildAuditPlan({ ...context(['audit.single-valid']), temporalContext: null }),
        /UTC business epoch/u
    );
});

test('audit empty receipt is content-addressed and proves zero mutation', () =>
{
    const plan = buildAuditPlan(context(['audit.empty']));
    const receipt = receiptFor(plan);

    assert.equal(validateAuditReceipt(receipt, plan), receipt);
    assert.throws(
        () => validateAuditReceipt(receiptFor(plan, {
            records: [{ identity: '1' }]
        }), plan),
        /zero records/u
    );
});

test('audit negative receipt requires isolation and one exact stable reason', () =>
{
    const plan = buildAuditPlan(context(['audit.unknown-action-negative']));
    const negative = {
        mutationId: 'unknown-action',
        mutatedField: 'action',
        expectedReason: 'audit_retention_policy_missing',
        actualReason: 'audit_retention_policy_missing',
        isolated: true,
        sourceRecordDigest: '2'.repeat(64),
        mutatedRecordDigest: '3'.repeat(64),
        isolation: 'prewrite-production-catalog'
    };
    const valid = receiptFor(plan, {
        negativeCases: [{
            ...negative,
            contentDigest: computeAuditNegativeContentDigest(negative)
        }]
    });

    assert.equal(validateAuditReceipt(valid, plan), valid);
    assert.throws(
        () => validateAuditReceipt(receiptFor(plan, {
            negativeCases: [{
                ...valid.negativeCases[0],
                actualReason: 'warning-only'
            }]
        }), plan),
        /one exact reason/u
    );
});

test('audit retention and investigation receipt binds production boundary and paging evidence', () =>
{
    const plan = buildAuditPlan(context([
        'audit.investigation-page',
        'audit.legal-hold-eligible'
    ]));
    const receipt = receiptFor(plan, {
        retention: [{
            action: 'security.policy.activated',
            maximumFullRecordAgeSeconds: 7776000,
            maximumPseudonymAgeSeconds: 7776000,
            aggregateAfterSeconds: 7776000,
            legalHoldAllowed: true,
            beforeBoundaryUtc: '2026-11-18T11:59:59.9999999+00:00',
            atBoundaryUtc: '2026-11-18T12:00:00.0000000+00:00',
            afterBoundaryUtc: '2026-11-18T12:00:00.0000001+00:00',
            eligibleHoldActiveBeforeExpiry: true,
            eligibleHoldInactiveAtExpiry: true,
            ineligibleHoldReason: 'audit_legal_hold_not_allowed'
        }],
        query: {
            total: 3,
            firstPageCount: 2,
            secondPageCount: 1,
            cursorBound: true,
            orderedDescending: true,
            piiRedacted: true,
            chainVerified: true,
            projectionDigest: '4'.repeat(64)
        }
    });

    assert.equal(validateAuditReceipt(receipt, plan), receipt);
    assert.throws(() => validateAuditReceipt(receiptFor(plan, {
        retention: receipt.retention,
        query: { ...receipt.query, cursorBound: false }
    }), plan), /paged production projection/u);
});

test('audit receipt rejects plaintext security fields', () =>
{
    const plan = buildAuditPlan(context(['audit.empty']));
    const receipt = receiptFor(plan, {
        leaked: {
            token: 'synthetic-secret'
        }
    });

    assert.throws(() => validateAuditReceipt(receipt, plan), /forbidden field/u);
});

function actualTemporalObservation()
{
    return {
        businessEpochUtc: '2026-08-20T12:00:00.000Z',
        backendCulture: 'Invariant',
        postgresTimezone: 'UTC'
    };
}

test('audit adapter actual observation qualifies through canonical temporal ingress and replay', async () =>
{
    const input = context(['audit.empty']);
    const plan = buildAuditPlan(input);
    const receipt = receiptFor(plan, { temporalObservation: actualTemporalObservation() });
    input.handles.auditFixtureAdapter = { prepare: async () => receipt };
    const result = await prepareAuditRecords(input);
    assert.deepEqual(result.temporalObservation, actualTemporalObservation());
    assert.equal(result.auditReceipt, receipt);
    const { temporalObservation, ...outcome } = result;
    const artifacts = bindCorrectnessProducerTemporalArtifacts({
        producerId: 'audit-records',
        contextInput: input.temporalContext,
        observations: temporalObservation,
        outcome,
        generatedAt: '2026-09-23T00:00:00.000Z'
    });
    assert.equal(verifyTemporalReplay(artifacts).qualificationEligible, true);
    assert.equal((await verifyAuditRecords(input, result)).ok, true);
    await assert.rejects(() => verifyAuditRecords(input, {
        ...result,
        temporalObservation: { ...temporalObservation, postgresTimezone: 'Asia/Shanghai' }
    }), /timezone|temporal/iu);
});

test('audit adapters reject absent and drifting actual epoch culture or database timezone', async () =>
{
    for (const [field, value] of [
        ['businessEpochUtc', undefined],
        ['backendCulture', undefined],
        ['postgresTimezone', undefined],
        ['businessEpochUtc', '2026-08-20T12:00:01.000Z'],
        ['backendCulture', 'zh-CN'],
        ['postgresTimezone', 'Asia/Shanghai']
    ])
    {
        const input = context(['audit.empty']);
        const observed = { ...actualTemporalObservation(), [field]: value };
        input.handles.auditFixtureAdapter = {
            prepare: async (plan) => receiptFor(plan, { temporalObservation: observed })
        };
        await assert.rejects(() => prepareAuditRecords(input), /actual|epoch|culture|timezone|temporal/iu);
    }
    const input = context(['audit.empty']);
    input.handles.auditFixtureAdapter = { prepare: async (plan) => receiptFor(plan) };
    await assert.rejects(() => prepareAuditRecords(input), /requires actual businessEpochUtc/u);
});

test('audit context must be canonical and producer/run-bound before the adapter can write', async () =>
{
    for (const temporalContext of [
        { businessEpochUtc: '2026-08-20T12:00:00.000Z' },
        { ...context(['audit.empty']).temporalContext, producerId: 'public-content' },
        { ...context(['audit.empty']).temporalContext, schedulerRunId: 'different-run' }
    ])
    {
        let writes = 0;
        const input = context(['audit.empty']);
        input.temporalContext = temporalContext;
        input.handles.auditFixtureAdapter = {
            prepare: async () =>
            {
                writes += 1;
            }
        };
        await assert.rejects(() => prepareAuditRecords(input), /schema|temporal context/iu);
        assert.equal(writes, 0);
    }
});

test('audit HTTP prepare observes the same protected backend session without altering the audit receipt', async (t) =>
{
    const input = context(['audit.empty']);
    input.handles = { baseUrl: 'http://127.0.0.1:9876/', localPublicContentFixtureSecret: 'audit-test-secret' };
    const receipt = receiptFor(buildAuditPlan(input));
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options = {}) =>
    {
        requests.push([url, options.method ?? 'GET']);
        if (options.method === 'POST')
        {
            assert.equal(url, 'http://127.0.0.1:9876/__local/audit-fixture/prepare');
            assert.deepEqual(JSON.parse(options.body).temporalContext, input.temporalContext);
            return new Response(JSON.stringify(receipt));
        }
        assert.equal(url, 'http://127.0.0.1:9876/__local/temporal-observation');
        assert.equal(options.headers['X-Fsus-Local-Temporal-Fixture-Secret'], 'audit-test-secret');
        return new Response(JSON.stringify(actualTemporalObservation()));
    });
    const result = await prepareAuditRecords(input);
    assert.deepEqual(requests.map(([, method]) => method), ['POST', 'GET']);
    assert.deepEqual(result.auditReceipt, receipt);
    assert.deepEqual(result.temporalObservation, actualTemporalObservation());
});

test('audit HTTP temporal observation failure cannot become a successful producer result', async (t) =>
{
    const input = context(['audit.empty']);
    input.handles = { baseUrl: 'http://127.0.0.1:9876', localPublicContentFixtureSecret: 'audit-test-secret' };
    t.mock.method(globalThis, 'fetch', async (_url, options = {}) => options.method === 'POST'
        ? new Response(JSON.stringify(receiptFor(buildAuditPlan(input))))
        : new Response('', { status: 401 }));
    await assert.rejects(() => prepareAuditRecords(input), /temporal observation failed HTTP 401/u);
});

test('real audit port seals its observed temporal binding through orchestrator verification', async (t) =>
{
    const input = context(['audit.empty']);
    const prior = Object.fromEntries(['FSUSBLOG_TEMPORAL_CONTEXT_JSON', 'FSUSBLOG_TEMPORAL_CONTEXT_FILE']
        .map((key) => [key, process.env[key]]));
    t.after(() =>
    {
        for (const [key, value] of Object.entries(prior))
        {
            if (value === undefined)
            {
                delete process.env[key];
            }
            else
            {
                process.env[key] = value;
            }
        }
    });
    process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON = JSON.stringify(input.temporalContext);
    delete process.env.FSUSBLOG_TEMPORAL_CONTEXT_FILE;
    let cleanupCount = 0;
    const planned = plan({ profileId: 'audit-empty', profileSource: 'dev-cli' }, {
        runId: input.runIdentity,
        namespace: input.namespace,
        sourceIdentity: {
            commit: input.temporalContext.sourceCommit,
            worktreeFingerprint: input.temporalContext.sourceFingerprint
        },
        handles: {
            auditFixtureAdapter: {
                prepare: async (auditPlan) => receiptFor(auditPlan, {
                    temporalObservation: actualTemporalObservation()
                }),
                cleanup: async () =>
                {
                    cleanupCount += 1;
                }
            }
        }
    });
    const ports = [createAuditRecordsPort()];
    const prepared = await prepare(planned, ports);
    const artifacts = prepared.producerOutputs['audit-records'].temporalArtifacts;
    assert.equal(verifyTemporalReplay(artifacts).qualificationEligible, true);
    const verified = await verify(prepared, ports);
    assert.equal(verified.terminalStatus, 'verified');
    assert.equal(verified.producerReceipts[0].temporalBinding.actualDigest, artifacts.actual.digest);
    await cleanup(prepared, ports);
    assert.equal(cleanupCount, 1);
});

test('empty audit variant requires live explicit zero-record evidence and cannot excuse a populated variant', () =>
{
    const variantId = 'canonical.audit.empty';
    const result = {
        enforceVariantEvidence: true,
        entityIdentities: [],
        observations: { database: { recordCount: 0, entities: [] } },
        variantEvidence: { variants: [{ variantId, source: 'live-service', entityIds: [], emptyVerified: true }] }
    };
    const validate = (candidate, id = variantId) => validateFixtureVariantEvidence({
        result: candidate,
        variantIds: [id]
    });
    assert.deepEqual(validate(result), []);
    for (const candidate of [
        { ...result, observations: { database: { entities: [] } } },
        { ...result, observations: { database: { recordCount: 1, entities: [] } } },
        { ...result, observations: { database: { recordCount: '0', entities: [] } } },
        { ...result, entityIdentities: [{ id: 'unexpected', variantId }] },
        { ...result, variantEvidence: { variants: [{ variantId, source: 'local-fallback', entityIds: [], emptyVerified: true }] } },
        { ...result, variantEvidence: { variants: [{ variantId, source: 'live-service', entityIds: [], emptyVerified: false }] } }
    ])
    {
        assert.match(validate(candidate).join('\n'), /no exact entity binding or live evidence/u);
    }
    const populatedVariant = 'canonical.audit.single-valid';
    assert.match(validate({
        ...result,
        variantEvidence: { variants: [{ ...result.variantEvidence.variants[0], variantId: populatedVariant }] }
    }, populatedVariant).join('\n'), /no exact entity binding or live evidence/u);
});

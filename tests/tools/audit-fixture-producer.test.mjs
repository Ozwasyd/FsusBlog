import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildAuditPlan,
    computeAuditNegativeContentDigest,
    computeAuditReceiptContentDigest,
    validateAuditReceipt
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test-fixtures/producers/audit-producer.mjs';
import {
    createAuditRecordsPort,
    createDefaultProducerPorts
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test-fixtures/producers/catalog-ports.mjs';

function context(capabilities)
{
    return {
        namespace: 'audit-ns',
        runIdentity: 'audit-run',
        plan: { capabilities },
        temporalContext: {
            businessEpochUtc: '2026-08-20T12:00:00.000Z'
        },
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

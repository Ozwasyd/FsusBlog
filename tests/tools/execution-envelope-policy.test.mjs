import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    createExecutionEnvelopePolicyIdentity,
    executionEnvelopeDigest,
    loadExecutionEnvelopeApplicability,
    loadExecutionEnvelopePolicy,
    projectExecutionEnvelopeApplicability,
    validateExecutionEnvelopeContracts
} from '../../tools/test-matrix/execution-envelope-policy.mjs';
import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs';

const matrix = parseMatrix(
    fs.readFileSync(new URL('../../tests/matrix.yml', import.meta.url), 'utf8')
);
const policy = loadExecutionEnvelopePolicy();
const catalog = loadExecutionEnvelopeApplicability();
const valid = () => ({
    matrix: structuredClone(matrix),
    policy: structuredClone(policy),
    catalog: structuredClone(catalog)
});

test('canonical execution envelope covers every correctness producer exactly once', () =>
{
    assert.deepEqual(validateExecutionEnvelopeContracts({ matrix, policy, catalog }), []);
    const projection = projectExecutionEnvelopeApplicability(matrix, policy, catalog);
    const expected = matrix.tiers.filter((tier) =>
        ['correctness', 'browser-contract'].includes(tier.evidenceClass ?? 'correctness'));
    assert.equal(projection.length, expected.length);
    assert.equal(new Set(projection.map((entry) => entry.producerId)).size, expected.length);
    assert.ok(projection.every((entry) => entry.policyId === policy.policyId));
    assert.ok(projection.every((entry) =>
        Object.keys(entry.fieldApplicability).length === 10));
    assert.ok(projection.every((entry) =>
        entry.allowedEnvironment.includes('PATH')));
    assert.equal(catalog.producers.filter((entry) =>
        entry.producerId === 'frontend-openapi-sync').length, 1);
    assert.equal(catalog.producers.some((entry) =>
        entry.producerId === 'cross-stack-openapi-sync'), false);
});

test('policy identity binds policy, catalog, and schema content independently', () =>
{
    const identity = createExecutionEnvelopePolicyIdentity({ policy, catalog });
    assert.match(identity.policyDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.match(identity.catalogDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.match(identity.schemaIdentity, /^sha256:[a-f0-9]{64}$/u);
    const changedPolicy = structuredClone(policy);
    changedPolicy.contract.environment.controlledVariables.push('FSUSBLOG_TEST_ONLY');
    assert.notEqual(executionEnvelopeDigest(changedPolicy), identity.policyDigest);
    const changedCatalog = structuredClone(catalog);
    changedCatalog.producers.reverse();
    assert.notEqual(executionEnvelopeDigest(changedCatalog), identity.catalogDigest);
});

test('missing, unknown, duplicate, ambiguous, and defaulted policy state fails closed', () =>
{
    const cases = [
        ({ policy: candidate }) =>
        {
            delete candidate.contract.network.sandboxUnavailable;
        },
        ({ policy: candidate }) =>
        {
            candidate.contract.unknown = true;
        },
        ({ catalog: candidate }) =>
        {
            candidate.producers.push(structuredClone(candidate.producers[0]));
        },
        ({ catalog: candidate }) =>
        {
            candidate.producers[1].producerId = candidate.producers[0].producerId;
        },
        ({ catalog: candidate }) =>
        {
            candidate.producers[0].policyId = 'unknown-policy';
        },
        ({ matrix: candidate }) =>
        {
            candidate.tiers[0].executionClass = 'acceptance';
        },
        ({ catalog: candidate }) =>
        {
            candidate.producers[0].fieldApplicability.network.observerId = null;
        },
        ({ catalog: candidate }) =>
        {
            candidate.producers[0].fieldApplicability.network = {
                status: 'not-applicable',
                observerId: null,
                notApplicableReason: 'fixture attempts to suppress a required observer'
            };
        },
        ({ catalog: candidate }) =>
        {
            candidate.producers[0].allowedEnvironment.push('UNDECLARED_INPUT');
        },
        ({ catalog: candidate }) =>
        {
            candidate.producers = candidate.producers.filter((entry) =>
                entry.producerId !== 'matrix-governance');
        },
        ({ catalog: candidate }) =>
        {
            candidate.producers[0].fieldApplicability.services = {
                status: 'not-applicable',
                observerId: null,
                notApplicableReason: null
            };
        }
    ];
    for (const mutate of cases)
    {
        const candidate = valid();
        mutate(candidate);
        assert.notDeepEqual(validateExecutionEnvelopeContracts(candidate), []);
    }
});

test('diagnostic producers remain explicitly excluded from correctness admission', () =>
{
    const candidate = valid();
    candidate.catalog.excludedEvidenceClasses = [];
    assert.match(
        validateExecutionEnvelopeContracts(candidate).join('\n'),
        /lacks an explicit exclusion/u
    );
});

test('missing and malformed canonical sources fail without fallback values', () =>
{
    assert.match(
        validateExecutionEnvelopeContracts({
            matrix,
            policy: { missing: true, identity: 'execution envelope policy' },
            catalog
        }).join('\n'),
        /source is missing/u
    );
    assert.match(
        validateExecutionEnvelopeContracts({
            matrix,
            policy,
            catalog: {
                invalid: true,
                identity: 'execution envelope applicability catalog',
                error: 'fixture'
            }
        }).join('\n'),
        /source is invalid/u
    );
});

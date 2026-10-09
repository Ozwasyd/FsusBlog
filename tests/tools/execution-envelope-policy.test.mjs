import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {createExecutionEnvelopePolicyIdentity, executionEnvelopeDigest, executionEnvelopePolicySchemaFile, loadExecutionEnvelopeApplicability, loadExecutionEnvelopePolicy, projectExecutionEnvelopeApplicability, validateExecutionEnvelopeContracts} = await import(new URL('../../tools/test-matrix/execution-envelope-policy.mjs', import.meta.url));
const {parseMatrix} = await import(new URL('../../tools/test-matrix/parse-matrix.mjs', import.meta.url));
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

test('canonical mysql applicability binds the registered service and rejects unknown providers', () =>
{
    const tier = matrix.tiers.find((entry) => entry.id === 'backend-unit');
    const producer = catalog.producers.find((entry) => entry.producerId === tier.id);
    const serviceCatalog = JSON.parse(fs.readFileSync(new URL(
        '../../config/testing/test-execution-service-catalog.json', import.meta.url
    ), 'utf8'));
    assert.deepEqual(tier.services, ['mysql']);
    assert.deepEqual(producer.requiredServices, tier.services);
    assert.equal(producer.fieldApplicability.services.status, 'required');
    assert.equal(serviceCatalog.services.mysql.kind, 'container');
    assert.equal(serviceCatalog.services.mysql.hostNativeAllowed, false);
    assert.match(serviceCatalog.services.mysql.imageReference, /^mysql@sha256:[a-f0-9]{64}$/u);
    assert.ok(serviceCatalog.services.mysql.requiredIdentityFields.includes('ownership'));
    assert.deepEqual(validateExecutionEnvelopeContracts({ matrix, policy, catalog }), []);

    const unknown = valid();
    unknown.matrix.tiers.find((entry) => entry.id === tier.id).services.push('unknown-service');
    unknown.catalog.producers.find((entry) => entry.producerId === tier.id).requiredServices.push('unknown-service');
    assert.match(validateExecutionEnvelopeContracts(unknown).join('\n'),
        /applicability schema .*requiredServices.*is not an allowed value/u);
});

test('only matrix governance and validation admit the pinned content-field host input', () =>
{
    const admitted = catalog.producers.filter((entry) =>
        entry.allowedEnvironment.includes('FSUSBLOG_CONTENT_FIELD_DOTNET'));
    assert.deepEqual(admitted.map((entry) => entry.producerId), [
        'matrix-governance',
        'validate-matrix'
    ]);
    for (const producerId of ['matrix-governance', 'validate-matrix'])
    {
        const removed = valid();
        const entry = removed.catalog.producers.find((producer) =>
            producer.producerId === producerId);
        entry.allowedEnvironment = entry.allowedEnvironment.filter((name) =>
            name !== 'FSUSBLOG_CONTENT_FIELD_DOTNET');
        assert.match(
            validateExecutionEnvelopeContracts(removed).join('\n'),
            /allowed environment drift|canonical runner applicability drift/u
        );
    }
    const widened = valid();
    widened.catalog.producers.find((entry) =>
        entry.producerId === 'frontend-openapi-sync')
        .allowedEnvironment.push('FSUSBLOG_CONTENT_FIELD_DOTNET');
    assert.match(
        validateExecutionEnvelopeContracts(widened).join('\n'),
        /allowed environment drift|canonical runner applicability drift/u
    );
});

test('matrix governance runner passes the host input only for the two admitted producers', (context) =>
{
    if (process.platform !== 'linux')
    {
        context.skip('canonical shell runner uses Linux bash and /bin/echo');
        return;
    }
    const runner = fileURLToPath(new URL(
        '../../tools/test/run-matrix-governance-once.sh',
        import.meta.url
    ));
    for (const [producerId, admitted] of [
        ['matrix-governance', true],
        ['validate-matrix', true],
        ['static-matrix-contract', false],
        ['release-evidence-plan', false]
    ])
    {
        const result = spawnSync('bash', [runner, producerId], {
            encoding: 'utf8',
            env: { ...process.env, FSUSBLOG_NODE: '/bin/echo' }
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`--producer-id ${producerId}`, 'u'));
        assert.equal(result.stdout.includes('--env FSUSBLOG_CONTENT_FIELD_DOTNET'), admitted);
    }
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
    assert.notEqual(createExecutionEnvelopePolicyIdentity({
        policy,
        catalog,
        receiptSchemaFile: executionEnvelopePolicySchemaFile
    }).schemaIdentity, identity.schemaIdentity);
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

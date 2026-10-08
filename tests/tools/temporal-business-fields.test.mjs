import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const { defaultTimeoutPolicyDigest, digestCanonical, qualificationTemporalContext } = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const { readTemporalDomainProducerInventory, resolveTemporalRoles } = await import(new URL('../../tools/test/temporal-role-resolver.mjs', import.meta.url));
const { bindTemporalBusinessFields, verifyObservedTemporalBusinessFields } = await import(new URL('../../tools/test-fixtures/temporal-business-fields.mjs', import.meta.url));

function input()
{
    const temporalContext = qualificationTemporalContext({
        sourceCommit: 'a'.repeat(40),
        sourceFingerprint: `sha256:${'b'.repeat(64)}`,
        producerId: 'account-profile-preferences',
        schedulerRunId: 'business-field-test',
        businessEpochUtc: '2024-02-29T23:59:59.000Z',
        locale: 'en-US',
        uiLocale: 'en-US',
        timeoutPolicyDigest: defaultTimeoutPolicyDigest()
    });
    const fixtureIdentity = {
        producerId: temporalContext.producerId,
        runId: temporalContext.schedulerRunId,
        namespace: 'business-field-test',
        fixtureId: 'profile-fields',
        planDigest: `sha256:${'c'.repeat(64)}`
    };
    const fieldMappings = readTemporalDomainProducerInventory().producerBindings
        .find((binding) => binding.producerId === temporalContext.producerId).fieldMappings;
    const artifact = resolveTemporalRoles({
        temporalContext,
        fixtureIdentity,
        shapeId: 'auth-security-messaging-account-lifecycle',
        roleIds: [...new Set(fieldMappings.map((mapping) => mapping.roleId))]
    });
    return {
        temporalContext,
        artifact: structuredClone(artifact),
        expected: { ...fixtureIdentity, artifactDigest: artifact.contentDigest, shapeId: artifact.shape.id },
        fieldMappings
    };
}

test('business fields preserve exact canonical Node/Postgres/.NET/browser instants', () =>
{
    const source = input();
    const binding = bindTemporalBusinessFields(source);
    for (const mapping of source.fieldMappings)
    {
        const field = binding.requireField(mapping.field);
        const role = source.artifact.roles.find((candidate) => candidate.roleId === mapping.roleId);
        assert.equal(field.instantUtc, role.instantUtc);
        assert.equal(field.epochMilliseconds, role.epochMilliseconds);
        assert.equal(field.postgresLiteral, `timestamptz '${role.instantUtc}'`);
        assert.equal(field.dotnetUtc, role.instantUtc);
        assert.equal(field.browserUtc, role.instantUtc);
        assert.equal(field.roleDigest, role.digest);
    }
    assert.equal('qualificationEligible' in binding, false);
});

test('held source/run/namespace/fixture/plan/shape and artifact identities cannot drift', () =>
{
    for (const field of ['producerId', 'runId', 'namespace', 'fixtureId', 'planDigest', 'shapeId', 'artifactDigest'])
    {
        const source = input();
        source.expected[field] = field.endsWith('Digest') ? `sha256:${'d'.repeat(64)}` : 'other';
        assert.throws(() => bindTemporalBusinessFields(source), /does not match held|does not match the held/u);
    }
    const source = input();
    delete source.expected.artifactDigest;
    assert.throws(() => bindTemporalBusinessFields(source), /independently held/u);
    source.artifact.roles[0].instantUtc = '2026-06-01T00:00:00.000Z';
    assert.throws(() => bindTemporalBusinessFields({ ...source, expected: input().expected }), /digest mismatch/u);
});

test('resealed role owner/state and timezone projection cannot replace canonical resolver output', () =>
{
    for (const mutate of [
        (artifact) =>
        {
            artifact.roles[0].owner = 'other-owner';
        },
        (artifact) =>
        {
            artifact.roles[0].expectedBusinessState = 'forged';
        },
        (artifact) =>
        {
            artifact.projection.timezone = 'Asia/Shanghai';
        }
    ])
    {
        const source = input();
        mutate(source.artifact);
        const { digest: ignored, ...role } = source.artifact.roles[0];
        assert.ok(ignored);
        source.artifact.roles[0].digest = digestCanonical(role);
        const { contentDigest: oldContentDigest, semanticDigest: oldSemanticDigest, ...unsigned } = source.artifact;
        assert.ok(oldContentDigest && oldSemanticDigest);
        source.artifact.semanticDigest = digestCanonical(unsigned);
        source.artifact.contentDigest = digestCanonical({ ...unsigned, semanticDigest: source.artifact.semanticDigest });
        source.expected.artifactDigest = source.artifact.contentDigest;
        assert.throws(() => bindTemporalBusinessFields(source), /canonical resolver output/u);
    }
});

test('business observations require all timestamps and reject drift, omission and metadata', () =>
{
    const binding = bindTemporalBusinessFields(input());
    const observed = Object.fromEntries(binding.fields.map((field) => [field.field, field.instantUtc]));
    const verified = verifyObservedTemporalBusinessFields(binding, observed);
    assert.equal(verified.observedDigest, digestCanonical(observed));
    const changed = { ...observed, [binding.fields[0].field]: '2026-06-01T00:00:00.000Z' };
    assert.throws(() => verifyObservedTemporalBusinessFields(binding, changed), /timestamp differs/u);
    delete changed[binding.fields[0].field];
    assert.throws(() => verifyObservedTemporalBusinessFields(binding, changed), /exact-match/u);
    assert.throws(() => verifyObservedTemporalBusinessFields(binding, { ...observed, generatedAt: 'metadata' }), /exact-match/u);
    assert.throws(() => verifyObservedTemporalBusinessFields({ ...binding }, observed), /binding created by this consumer/u);
});

test('caller mutation cannot alter an already validated binding', () =>
{
    const source = input();
    const binding = bindTemporalBusinessFields(source);
    const original = binding.requireField(source.fieldMappings[0].field).instantUtc;
    source.artifact.roles[0].instantUtc = 'changed';
    source.expected.namespace = 'changed';
    assert.equal(binding.requireField(source.fieldMappings[0].field).instantUtc, original);
    assert.throws(() =>
    {
        binding.fields[0].instantUtc = 'changed';
    }, TypeError);
    assert.throws(() => binding.requireField('metadata.generated-at'), /unbound business field/u);
});

test('duplicate fields, missing roles and empty mappings are refused', () =>
{
    const source = input();
    assert.throws(() => bindTemporalBusinessFields({ ...source, fieldMappings: [] }), /nonempty/u);
    assert.throws(() => bindTemporalBusinessFields({ ...source, fieldMappings: [source.fieldMappings[0], source.fieldMappings[0]] }), /unique/u);
    assert.throws(() => bindTemporalBusinessFields({ ...source, fieldMappings: [{ field: 'article.created-at', roleId: 'article.created' }] }), /unresolved canonical role article.created/u);
});

test('same sealed input repeats across host time/TZ with metadata excluded', () =>
{
    const program = `
        import { qualificationTemporalContext, defaultTimeoutPolicyDigest } from './tools/test/temporal-context.mjs';
        import { resolveTemporalRoles, readTemporalDomainProducerInventory } from './tools/test/temporal-role-resolver.mjs';
        import { bindTemporalBusinessFields } from './tools/test-fixtures/temporal-business-fields.mjs';
        Date.now = () => Number(process.env.TEST_HOST_TIME);
        const temporalContext = qualificationTemporalContext({ ...${JSON.stringify({ sourceCommit: 'a'.repeat(40), sourceFingerprint: `sha256:${'b'.repeat(64)}`, producerId: 'account-profile-preferences', schedulerRunId: 'business-field-test', businessEpochUtc: '2024-02-29T23:59:59.000Z', locale: 'en-US', uiLocale: 'en-US' })}, timeoutPolicyDigest: defaultTimeoutPolicyDigest() });
        const fixtureIdentity = ${JSON.stringify(input().artifact.fixtureIdentity)};
        const fieldMappings = readTemporalDomainProducerInventory().producerBindings.find(x => x.producerId === temporalContext.producerId).fieldMappings;
        const artifact = resolveTemporalRoles({ temporalContext, fixtureIdentity, shapeId: 'auth-security-messaging-account-lifecycle', roleIds: [...new Set(fieldMappings.map(x => x.roleId))] });
        const binding = bindTemporalBusinessFields({ temporalContext, artifact, fieldMappings, expected: { ...fixtureIdentity, artifactDigest: artifact.contentDigest, shapeId: artifact.shape.id } });
        process.stdout.write(JSON.stringify({ fields: binding.fields, semanticDigest: binding.semanticDigest }));
    `;
    const results = ['UTC', 'Asia/Shanghai', 'America/New_York'].map((timezone, index) =>
    {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
            cwd: new URL('../..', import.meta.url),
            env: { ...process.env, TZ: timezone, TEST_HOST_TIME: String(index * 9_000_000_000_000) },
            encoding: 'utf8'
        });
        assert.equal(child.status, 0, child.stderr);
        return child.stdout;
    });
    assert.equal(new Set(results).size, 1);
});

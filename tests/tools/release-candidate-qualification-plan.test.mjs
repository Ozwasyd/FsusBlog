import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import test from 'node:test';

const { prepareQualificationPlanMaterial, verifyQualificationPlanMaterial } = await import(new URL(
    '../../tools/release-candidate/qualification-plan.mjs', import.meta.url
));
const { qualificationIdentityBinding, deriveRepeatabilityCatalog } = await import(new URL(
    '../../tools/release-candidate/qualification-policy.mjs', import.meta.url
));
const { sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));

function inputs()
{
    const reference = (name) => ({ path: `objects/${name}.json`, digest: `sha256:${'a'.repeat(64)}` });
    return {
        cohortId: 'candidate-fixture',
        cohortReference: reference('cohort'),
        candidateIdentityReference: reference('identity'),
        identityBinding: qualificationIdentityBinding(),
        immutableInputs: Object.fromEntries(['build', 'replay', 'temporal', 'envelope', 'fixture'].map((name) => [name, reference(name)])),
        resourceRoot: 'qualification-runtime',
        portBase: 21000
    };
}

test('planning material derives three sequential disjoint resource sets and exact per-run catalog authorities', () =>
{
    const source = inputs();
    const material = prepareQualificationPlanMaterial(source);
    assert.equal(verifyQualificationPlanMaterial(material, source), material);
    assert.equal(material.admissionStatus, 'requires-verified-cohort-and-sealed-producer-dag');
    assert.deepEqual(material.ordinals.map((slot) => slot.ordinal), [1, 2, 3]);
    assert.deepEqual(material.ordinals.map((slot) => slot.requiresPreviousPostflight), [null, 1, 2]);
    assert.equal(new Set(material.ordinals.map((slot) => slot.namespace)).size, 3);
    assert.equal(new Set(material.ordinals.flatMap((slot) => Object.values(slot.ports))).size, 12);
    assert.equal(new Set(material.ordinals.flatMap((slot) => Object.values(slot.roots))).size, 12);
    const requiredIds = deriveRepeatabilityCatalog().entries.filter((entry) => entry.required).map((entry) => entry.authorityId);
    for (const slot of material.ordinals)
    {
        assert.deepEqual(slot.immutableInputs, source.immutableInputs);
        assert.deepEqual(slot.authorityRequirements.map((entry) => entry.authorityId), requiredIds);
        assert.ok(slot.authorityRequirements.every((entry) => entry.repeatability === 'per-run'
            && entry.command && entry.verifier && entry.receiptSchema && entry.outputBindingKey && entry.locatorBindingKey));
        assert.equal(slot.freshPreflightRequired, true);
        assert.equal(slot.freshPostflightRequired, true);
        assert.equal(slot.independentDatabaseRequired, true);
        assert.equal(slot.independentRedisRequired, true);
    }
    assert.deepEqual(material.candidateOnce, [{ operation: 'reference-immutable-build', reference: source.immutableInputs.build }]);
});

test('planning requires explicit refs, digest bindings and bounded namespaces/roots/ports', () =>
{
    const original = inputs();
    const variants = [
        { cohortReference: null }, { candidateIdentityReference: { path: 'objects/identity.json' } },
        { resourceRoot: '../escape' }, { resourceRoot: '/absolute' }, { resourceRoot: 'root//alias' },
        { cohortId: 'bad/namespace' }, { portBase: 1023 }, { portBase: 65525 }, { portBase: 21000.5 },
        { identityBinding: { ...original.identityBinding, qualificationPolicyDigest: `sha256:${'0'.repeat(64)}` } },
        { immutableInputs: { ...original.immutableInputs, replay: { path: 'objects/replay.json', digest: 'unsealed' } } },
        { latest: true }, { authorityRequirements: [] }
    ];
    for (const variant of variants)
    {
        assert.throws(() => prepareQualificationPlanMaterial({ ...original, ...variant }));
    }
});

test('independent material verification rejects resealed collisions, omitted keys and per-ordinal replans', () =>
{
    const source = inputs();
    const original = prepareQualificationPlanMaterial(source);
    const mutations = [
        (value) =>
        {
            value.ordinals.pop();
        },
        (value) =>
        {
            value.sequential = false;
        },
        (value) =>
        {
            value.ordinals[1].ports.database = value.ordinals[0].ports.database;
        },
        (value) =>
        {
            value.ordinals[1].namespace = value.ordinals[0].namespace;
        },
        (value) =>
        {
            value.ordinals[1].roots.home = value.ordinals[0].roots.home;
        },
        (value) =>
        {
            value.ordinals[1].immutableInputs.replay.digest = `sha256:${'b'.repeat(64)}`;
        },
        (value) =>
        {
            value.ordinals[2].immutableInputs.temporal.digest = `sha256:${'b'.repeat(64)}`;
        },
        (value) =>
        {
            value.ordinals[2].immutableInputs.envelope.digest = `sha256:${'b'.repeat(64)}`;
        },
        (value) =>
        {
            value.ordinals[0].authorityRequirements.pop();
        },
        (value) =>
        {
            delete value.ordinals[0].authorityRequirements[0].outputBindingKey;
        },
        (value) =>
        {
            value.ordinals[0].authorityRequirements[0].repeatability = 'candidate-once';
        }
    ];
    for (const mutate of mutations)
    {
        const value = structuredClone(original);
        mutate(value);
        assert.throws(() => verifyQualificationPlanMaterial(sealContentDigest(value), source), /drift, collision or authority omission/);
    }
});

test('plan material creation has zero process/network/runtime-write side effects and does not resolve mutable environment', (context) =>
{
    const source = inputs();
    const expected = prepareQualificationPlanMaterial(source);
    const forbidden = () =>
    {
        throw new Error('plan-only attempted mutation');
    };
    for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
    {
        context.mock.method(childProcess, method, forbidden);
    }
    for (const method of ['writeFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'createWriteStream'])
    {
        context.mock.method(fs, method, forbidden);
    }
    const previous = process.env.HOME;
    try
    {
        process.env.HOME = '/different-mutable-home';
        assert.deepEqual(prepareQualificationPlanMaterial(source), expected);
    }
    finally
    {
        if (previous === undefined)
        {
            delete process.env.HOME;
        }
        else
        {
            process.env.HOME = previous;
        }
    }
});

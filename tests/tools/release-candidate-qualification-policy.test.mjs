import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { default: Ajv } = await import(new URL(
    '../../tools/test-matrix/schema-validator/node_modules/ajv/dist/2020.js', import.meta.url
));
const { digestCanonical, sealContentDigest } = await import(new URL(
    '../../tools/test/attempt-provenance.mjs', import.meta.url
));
const {
    qualificationPolicy, verifyQualificationPolicy, deriveRepeatabilityCatalog,
    verifyRepeatabilityCatalog, verifyCandidateOnceOperation, qualificationIdentityBinding,
    qualificationReceiptSchemaPath
} = await import(new URL('../../tools/release-candidate/qualification-policy.mjs', import.meta.url));
const {
    loadCanonicalRequiredEvidenceCatalog, entryContentDigest, producerContractDigest, ledgerContentDigest
} = await import(new URL('../../tools/test-matrix/required-evidence-catalog.mjs', import.meta.url));

function reseal(value)
{
    return sealContentDigest(structuredClone(value));
}

test('canonical qualification policy binds exactly three sequential rounds and terminal states', () =>
{
    const policy = qualificationPolicy();
    assert.equal(verifyQualificationPolicy(policy), policy);
    assert.equal(policy.requiredRunCount, 3);
    assert.deepEqual(policy.ordinals, [1, 2, 3]);
    assert.equal(policy.sequential, true);
    assert.equal(policy.states.length, 11);
    assert.deepEqual(policy.transitions.collecting, policy.states.slice(1));
    assert.ok(Object.values(policy.requirements).every((value) => value === true));
    assert.ok(Object.isFrozen(policy.requirements));
});

test('resealed two-of-three, parallel, warning, manual and TTL policies are refused', () =>
{
    const mutations = [
        { requiredRunCount: 2 }, { requiredRunCount: 4 }, { ordinals: [1, 3, 2] },
        { sequential: false }, { parallel: true }, { manualOverride: true }, { ttl: 60 },
        { states: ['collecting', 'mostly-passed'] }, { states: ['qualified-with-warning'] }
    ];
    for (const mutation of mutations)
    {
        assert.throws(() => verifyQualificationPolicy(reseal({ ...qualificationPolicy(), ...mutation })), /canonical/);
    }
});

test('clean-first-attempt and no-recovery requirements cannot be omitted or resealed away', () =>
{
    for (const field of ['cleanFirstAttempt', 'qualificationEligible', 'noRecoveredRetry', 'currentRunEvidence'])
    {
        const policy = structuredClone(qualificationPolicy());
        delete policy.requirements[field];
        assert.throws(() => verifyQualificationPolicy(reseal(policy)), /canonical/);
    }
});

test('repeatability derives the exact canonical authority roster and defaults every producer to per-run', () =>
{
    const ledger = loadCanonicalRequiredEvidenceCatalog();
    const catalog = deriveRepeatabilityCatalog(ledger);
    assert.deepEqual(catalog.entries.map((entry) => entry.authorityId), ledger.entries.map((entry) => entry.authorityId));
    assert.ok(catalog.entries.every((entry) => entry.repeatability === 'per-run'));
    assert.equal(verifyRepeatabilityCatalog(catalog, ledger), catalog);
    assert.equal(catalog.requiredEvidenceCatalogDigest, ledger.contentDigest);
});

test('missing, duplicate, unknown or candidate-once classifications and policy drift fail closed', () =>
{
    const original = deriveRepeatabilityCatalog();
    const variants = [
        { ...original, entries: original.entries.slice(1) },
        { ...original, entries: [...original.entries, original.entries[0]] },
        { ...original, qualificationPolicyDigest: `sha256:${'0'.repeat(64)}` }
    ];
    for (const repeatability of ['candidate-once', 'unknown', undefined])
    {
        const changed = structuredClone(original);
        changed.entries[0].repeatability = repeatability;
        variants.push(changed);
    }
    for (const variant of variants)
    {
        assert.throws(() => verifyRepeatabilityCatalog(reseal(variant)), /exactly classify/);
    }
});

test('new validated authority defaults per-run rather than becoming an unclassified exception', () =>
{
    const ledger = loadCanonicalRequiredEvidenceCatalog();
    const entry = structuredClone(ledger.entries[0]);
    entry.authorityId = 'additional-runtime-authority';
    entry.locatorBindingKey = 'additional-runtime';
    entry.outputBindingKey = 'additional-runtime';
    entry.contentDigest = entryContentDigest(entry);
    entry.producerDigest = producerContractDigest(entry);
    ledger.entries.push(entry);
    ledger.entries.sort((left, right) => left.authorityId.localeCompare(right.authorityId));
    ledger.contentDigest = ledgerContentDigest(ledger);
    assert.equal(deriveRepeatabilityCatalog(ledger).entries.find((item) => item.authorityId === entry.authorityId).repeatability, 'per-run');
});

test('candidate-once admits only closed content references and refuses executable or mutable operations', () =>
{
    const staticReference = { operation: 'reference-static-content', reference: { path: 'objects/policy.json', digest: `sha256:${'a'.repeat(64)}` } };
    assert.equal(verifyCandidateOnceOperation(staticReference), staticReference);
    assert.doesNotThrow(() => verifyCandidateOnceOperation({ ...staticReference, operation: 'reference-immutable-build' }));
    for (const command of ['node --test', 'curl example.com', 'docker run image', 'env', 'npm run build'])
    {
        assert.throws(() => verifyCandidateOnceOperation({ ...staticReference, command }), /pure content-addressed/);
    }
    for (const operation of ['test', 'runtime', 'measurement', 'read-environment', 'create-immutable-build'])
    {
        assert.throws(() => verifyCandidateOnceOperation({ ...staticReference, operation }), /pure content-addressed/);
    }
    for (const path of ['../escape', '/absolute', 'objects//alias', 'objects/./alias'])
    {
        assert.throws(() => verifyCandidateOnceOperation({ ...staticReference, reference: { ...staticReference.reference, path } }), /pure content-addressed/);
    }
});

test('identity binding covers policy, repeatability, required catalog and receipt schema digests', () =>
{
    const binding = qualificationIdentityBinding();
    assert.equal(binding.qualificationPolicyDigest, qualificationPolicy().contentDigest);
    assert.equal(binding.repeatabilityCatalogDigest, deriveRepeatabilityCatalog().contentDigest);
    assert.equal(binding.qualificationReceiptSchemaDigest, digestCanonical(JSON.parse(fs.readFileSync(qualificationReceiptSchemaPath, 'utf8'))));
});

test('qualification receipt schema requires all parent fields and rejects status-only, missing blocker IDs and unknown states', () =>
{
    const schema = JSON.parse(fs.readFileSync(qualificationReceiptSchemaPath, 'utf8'));
    const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
    assert.equal(validate({ finalStatus: 'sealed-qualified' }), false);
    for (const field of ['candidateIdentity', 'cohortLedgerDigest', 'runReceiptRefs', 'runAttemptEligibility', 'failureTopologyComparison', 'perRunAuthorityVerification', 'localReproduction', 'contentDigest'])
    {
        assert.ok(schema.required.includes(field));
    }
    const validateBlocker = new Ajv({ strict: false }).compile(schema.properties.blockers.items);
    const blocker = { reasonCode: 'incomplete', field: 'runReceiptRefs', ordinals: [2], producerIds: [], testIds: [] };
    assert.equal(validateBlocker(blocker), true);
    assert.equal(validateBlocker({ ...blocker, reasonCode: 'ignored' }), false);
    delete blocker.producerIds;
    assert.equal(validateBlocker(blocker), false);
    assert.equal(schema.properties.finalStatus.enum.includes('qualified-with-warning'), false);
    assert.equal(schema.properties.requiredRunCount.const, 3);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    loadCanonicalRequiredEvidenceCatalog,
    validateRequiredEvidenceCatalog,
    entryContentDigest,
    producerContractDigest,
    ledgerContentDigest,
    createRequiredEvidenceCatalogBinding,
    validateRequiredEvidenceCatalogBinding,
    requiredEvidenceAuthorityLedgerSchema,
    requiredEvidenceCatalogSchema
} from '../../tools/test-matrix/required-evidence-catalog.mjs';

function reseal(ledger)
{
    for (const entry of ledger.entries)
    {
        entry.contentDigest = entryContentDigest(entry);
        entry.producerDigest = producerContractDigest(entry);
    }
    ledger.contentDigest = ledgerContentDigest(ledger);
    return ledger;
}

function cloneLedger(ledger = loadCanonicalRequiredEvidenceCatalog())
{
    return reseal(JSON.parse(JSON.stringify(ledger)));
}

function errorsFor(ledger, options = {})
{
    return validateRequiredEvidenceCatalog(ledger, options);
}

function findEntry(ledger, authorityId)
{
    return ledger.entries.find((entry) => entry.authorityId === authorityId);
}

test('canonical required evidence catalog is valid with 21 exact-one authorities', () =>
{
    const ledger = loadCanonicalRequiredEvidenceCatalog();
    const errors = errorsFor(ledger);
    assert.deepEqual(errors, []);
    assert.equal(ledger.schema, requiredEvidenceAuthorityLedgerSchema);
    assert.equal(ledger.catalogSchema, requiredEvidenceCatalogSchema);
    assert.equal(ledger.entries.length, 21);
    const authorityIds = ledger.entries.map((entry) => entry.authorityId);
    assert.deepEqual(authorityIds, [...authorityIds].sort());
    assert.equal(new Set(authorityIds).size, authorityIds.length);
});

test('matrix authority without a ledger source fixture fails closed', () =>
{
    const ledger = cloneLedger();
    const removed = ledger.entries.pop();
    const errors = errorsFor(ledger);
    assert.ok(errors.some((error) => error.includes(`missing: ${removed.authorityId}`)));
    assert.ok(errors.some((error) => error.includes('reduces the required evidence set')));
});

test('duplicate authority IDs fail closed', () =>
{
    const ledger = cloneLedger();
    const duplicate = JSON.parse(JSON.stringify(ledger.entries[0]));
    duplicate.outputBindingKey = 'duplicate.output-binding-key';
    duplicate.locatorBindingKey = 'duplicate.locator-binding-key';
    ledger.entries.splice(1, 0, duplicate);
    const errors = errorsFor(ledger);
    assert.ok(errors.some((error) => error.includes('duplicate authority IDs')));
});

test('orphan authority referencing an unknown producer tier fails closed', () =>
{
    const ledger = cloneLedger();
    findEntry(ledger, 'browser-contract').producerTierIds = ['browser-contract', 'unknown-tier'];
    reseal(ledger);
    const errors = errorsFor(ledger);
    assert.ok(errors.some((error) => error.includes('references unknown tier unknown-tier')));
});

test('missing schema, identity fields, required IDs and digests fail closed', () =>
{
    const ledger = cloneLedger();
    delete ledger.schema;
    assert.ok(errorsFor(ledger).some((error) => error.includes('must use')));

    const missingIdentity = cloneLedger();
    delete findEntry(missingIdentity, 'browser-contract').requiredIdentityFields;
    reseal(missingIdentity);
    assert.ok(errorsFor(missingIdentity)
        .some((error) => error.includes('requiredIdentityFields must be a non-empty string array')));

    const missingIds = cloneLedger();
    delete findEntry(missingIds, 'release-admin-console').requiredTestIds;
    reseal(missingIds);
    assert.ok(errorsFor(missingIds)
        .some((error) => error.includes('requiredTestIds must be a string array')));

    const missingDigest = cloneLedger();
    delete findEntry(missingDigest, 'test-quality-lint').contentDigest;
    assert.ok(errorsFor(missingDigest)
        .some((error) => error.includes('contentDigest must be a SHA-256 digest')));
});

test('mtime, latest and search locator binding keys fail closed', () =>
{
    for (const term of ['mtime', 'latest', 'search'])
    {
        const ledger = cloneLedger();
        findEntry(ledger, 'browser-contract').locatorBindingKey = `current-run.${term}-selection`;
        reseal(ledger);
        const errors = errorsFor(ledger);
        assert.ok(
            errors.some((error) => error.includes(`must not use ${term} selection semantics`)),
            `${term} locator must fail closed`
        );
    }
    const glob = cloneLedger();
    findEntry(glob, 'browser-contract').locatorBindingKey = 'current-run/*/receipt';
    reseal(glob);
    assert.ok(errorsFor(glob)
        .some((error) => error.includes('must be a binding key without path rules')));
});

test('job-name-only canonical owner fails closed', () =>
{
    for (const owner of ['ci:release-job', 'github-actions:build', 'jobs.release'])
    {
        const ledger = cloneLedger();
        findEntry(ledger, 'browser-contract').canonicalOwner = owner;
        reseal(ledger);
        const errors = errorsFor(ledger);
        assert.ok(
            errors.some((error) => error.includes('must not be a job-name-only owner')),
            `owner ${owner} must fail closed`
        );
    }
});

test('diagnostic authority cannot substitute a correctness pass', () =>
{
    const ledger = cloneLedger();
    const entry = findEntry(ledger, 'browser-contract');
    entry.allowDiagnostic = true;
    entry.exactness = 'test-id-exact';
    reseal(ledger);
    assert.ok(errorsFor(ledger)
        .some((error) => error.includes('must declare exactness diagnostic-only')));

    const diagnosticOnly = cloneLedger();
    const diagnosticEntry = findEntry(diagnosticOnly, 'browser-contract');
    diagnosticEntry.allowDiagnostic = true;
    diagnosticEntry.exactness = 'diagnostic-only';
    reseal(diagnosticOnly);
    const errors = errorsFor(diagnosticOnly);
    assert.ok(errors.some((error) =>
        error.includes('diagnostic authority browser-contract cannot satisfy')));
    assert.ok(errors.some((error) =>
        error.includes('missing: browser-contract')));
});

test('unknown correctness IDs fail closed against the disposition ledger', () =>
{
    const ledger = cloneLedger();
    findEntry(ledger, 'release-admin-console').requiredTestIds.push(
        'release-admin-console/unknown-extra-test'
    );
    reseal(ledger);
    assert.ok(errorsFor(ledger)
        .some((error) => error.includes('must exactly match the disposition ledger')));
});

test('catalog that reduces the required evidence set fails closed', () =>
{
    const ledger = cloneLedger();
    ledger.entries = ledger.entries.filter((entry) => entry.authorityId !== 'release-closeout');
    const errors = errorsFor(ledger);
    assert.ok(errors.some((error) => error.includes('missing: release-closeout')));
    assert.ok(errors.some((error) => error.includes('reduces the required evidence set')));
});

test('missing producer verifier fails closed', () =>
{
    const ledger = cloneLedger();
    delete findEntry(ledger, 'test-quality-lint').producerVerifier;
    reseal(ledger);
    assert.ok(errorsFor(ledger)
        .some((error) => error.includes('producerVerifier must be a tools-relative verifier')));

    const missingFile = cloneLedger();
    findEntry(missingFile, 'test-quality-lint').producerVerifier =
        'tools/release/does-not-exist.mjs';
    reseal(missingFile);
    assert.ok(errorsFor(missingFile)
        .some((error) => error.includes('producerVerifier file does not exist')));
});

test('version and digest tamper fail closed', () =>
{
    const version = cloneLedger();
    version.version = 2;
    reseal(version);
    assert.ok(errorsFor(version).some((error) => error.includes('version must be 1')));

    const digest = cloneLedger();
    digest.contentDigest = `sha256:${'0'.repeat(64)}`;
    assert.ok(errorsFor(digest)
        .some((error) => error.includes('contentDigest is stale or tampered')));

    const entryDigest = cloneLedger();
    findEntry(entryDigest, 'browser-contract').contentDigest = `sha256:${'1'.repeat(64)}`;
    assert.ok(errorsFor(entryDigest)
        .some((error) => error.includes('contentDigest does not match its canonical entry content')));
});

test('output binding key conflicts fail closed', () =>
{
    const ledger = cloneLedger();
    findEntry(ledger, 'release-closeout').outputBindingKey = 'release-final.browser-contract';
    reseal(ledger);
    assert.ok(errorsFor(ledger)
        .some((error) => error.includes('duplicate outputBindingKey values')));
});

test('unsupported receipt schema and non-exact cardinality fail closed', () =>
{
    const ledger = cloneLedger();
    findEntry(ledger, 'browser-contract').receiptSchema = 'fsusblog.unknown-schema.v99';
    reseal(ledger);
    assert.ok(errorsFor(ledger)
        .some((error) => error.includes('receiptSchema is unsupported')));

    const emptyTiers = cloneLedger();
    findEntry(emptyTiers, 'browser-contract').producerTierIds = [];
    reseal(emptyTiers);
    assert.ok(errorsFor(emptyTiers)
        .some((error) => error.includes('producerTierIds must be a non-empty string array')));
});

test('stable canonical ordering and digest are deterministic', () =>
{
    const first = cloneLedger();
    const second = cloneLedger();
    assert.equal(first.contentDigest, second.contentDigest);
    assert.equal(JSON.stringify(first.entries), JSON.stringify(second.entries));

    const unsorted = cloneLedger();
    const [head, ...rest] = unsorted.entries;
    unsorted.entries = [...rest, head];
    reseal(unsorted);
    assert.ok(errorsFor(unsorted)
        .some((error) => error.includes('must be sorted by authorityId')));
});

test('production release-final catalog binding seals the exact canonical authority set', () =>
{
    const binding = createRequiredEvidenceCatalogBinding();
    assert.deepEqual(validateRequiredEvidenceCatalogBinding(binding), []);
    assert.equal(binding.schema,
        'fsusblog.release-final-required-evidence-catalog-binding.v1');
    assert.equal(binding.path,
        'config/testing/required-evidence-authority-ledger.json');
    assert.equal(binding.authorityIds.length, 21);
    assert.equal(binding.locatorBindingKeys.length, 21);
    assert.equal(binding.outputBindingKeys.length, 21);
});

test('production release-final consumer uses the canonical catalog binding', () =>
{
    const source = readFileSync(new URL(
        '../../tools/release/release-final-domain-evidence.mjs',
        import.meta.url
    ), 'utf8');
    assert.match(source,
        /createRequiredEvidenceCatalogBinding\(requiredEvidenceCatalog\)/u);
    assert.match(source,
        /requiredEvidenceCatalogBinding,/u);
});

test('release-final catalog binding rejects deletion replacement and digest tamper', async (context) =>
{
    const mutations = [
        ['authority deletion', (binding) => binding.authorityIds.pop()],
        ['authority replacement', (binding) =>
        {
            binding.authorityIds[0] = 'forged-authority';
        }],
        ['catalog digest', (binding) =>
        {
            binding.contentDigest = `sha256:${'0'.repeat(64)}`;
        }],
        ['file digest', (binding) =>
        {
            binding.fileDigest = `sha256:${'1'.repeat(64)}`;
        }]
    ];
    for (const [name, mutate] of mutations)
    {
        await context.test(name, () =>
        {
            const binding = createRequiredEvidenceCatalogBinding();
            mutate(binding);
            assert.notDeepEqual(validateRequiredEvidenceCatalogBinding(binding), []);
        });
    }
});

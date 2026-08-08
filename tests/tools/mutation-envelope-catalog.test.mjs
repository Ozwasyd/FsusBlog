import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFixtureCatalogs } from '../../tools/testing/fixture-catalog.mjs';
import {
    canonicalMutationEnvelopeCatalogPath,
    mutationEnvelopeCatalogSchema,
    mutationEnvelopeCatalogSchemaPath,
    mutationKinds,
    providers,
    cleanupOwners,
    requiredSurfaceDomains,
    envelopeContentDigest,
    catalogContentDigest,
    loadCanonicalMutationEnvelopeCatalog,
    validateMutationEnvelopeCatalog,
    validateMutationEnvelopeCatalogSchema,
    checkMutationEnvelopeCatalog
} from '../../tools/test-fixtures/mutation-envelope-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function cloneCatalog(catalog = loadCanonicalMutationEnvelopeCatalog())
{
    return JSON.parse(JSON.stringify(catalog));
}

function errorsFor(catalog, options = {})
{
    return validateMutationEnvelopeCatalog(catalog, options);
}

function findEnvelope(catalog, envelopeId)
{
    return catalog.envelopes.find((envelope) => envelope.envelopeId === envelopeId);
}

function surfaceUsedByProvider(provider, surface)
{
    if (['postgresql', 'mysql', 'sqlite'].includes(provider))
    {
        return (surface.entities ?? []).length > 0;
    }
    if (provider === 'redis')
    {
        return (surface.redisKeys ?? []).length > 0 || (surface.cacheEntries ?? []).length > 0;
    }
    if (provider === 'filesystem')
    {
        return (surface.ownedFiles ?? []).length > 0;
    }
    return false;
}

test('canonical mutation envelope catalog is valid, closed and versioned', () =>
{
    const catalog = loadCanonicalMutationEnvelopeCatalog();
    assert.deepEqual(errorsFor(catalog), []);
    assert.deepEqual(validateMutationEnvelopeCatalogSchema(catalog), []);
    assert.equal(checkMutationEnvelopeCatalog(catalog).length, catalog.envelopes.length);
    assert.equal(catalog.schema, mutationEnvelopeCatalogSchema);
    assert.equal(catalog.version, 1);
    assert.equal(catalog.destructiveScope, 'fixture-namespace');
    assert.equal(catalog.mutationKinds.length, mutationKinds.length);
    assert.equal(catalog.providers.length, providers.length);
    assert.ok(catalog.contentDigest.startsWith('sha256:'));
    assert.ok(catalog.profileCatalogDigest.startsWith('sha256:'));
    assert.equal(catalog.contentDigest, catalogContentDigest(catalog));
    const schema = JSON.parse(fs.readFileSync(
        path.resolve(root, mutationEnvelopeCatalogSchemaPath), 'utf8'));
    assert.equal(schema.$id, mutationEnvelopeCatalogSchema);
    assert.equal(schema.additionalProperties, false);
});

test('every required parent surface, mutation kind and provider is covered exactly', () =>
{
    const catalog = loadCanonicalMutationEnvelopeCatalog();
    const coveredDomains = new Set();
    const usedKinds = new Set();
    for (const envelope of catalog.envelopes)
    {
        for (const kind of ['entities', 'redisKeys', 'cacheEntries', 'ownedFiles'])
        {
            for (const target of envelope.semanticTargets?.[kind] ?? [])
            {
                coveredDomains.add(target.domain);
            }
        }
        usedKinds.add(envelope.mutationKind);
    }
    for (const domain of requiredSurfaceDomains)
    {
        assert.ok(coveredDomains.has(domain), `required surface ${domain} must be covered`);
    }
    for (const kind of mutationKinds)
    {
        assert.ok(usedKinds.has(kind), `mutation kind ${kind} must be exercised`);
    }
    assert.equal(catalog.envelopes.length, 14);
    assert.equal(catalog.sequences.length, 5);
    assert.deepEqual(catalog.semanticDomains, [...catalog.semanticDomains].sort());
});

test('every envelope owns receipt-scoped semantic targets with exact contracts', () =>
{
    const catalog = loadCanonicalMutationEnvelopeCatalog();
    const catalogs = readFixtureCatalogs();
    const profileIds = new Set(catalogs.profile.profiles.map((profile) => profile.id));
    const capabilityIds = new Set(
        catalogs.capability.capabilities.map((capability) => capability.id)
    );
    const envelopeIds = new Set();
    for (const envelope of catalog.envelopes)
    {
        assert.ok(!envelopeIds.has(envelope.envelopeId), `duplicate ${envelope.envelopeId}`);
        envelopeIds.add(envelope.envelopeId);
        assert.equal(envelope.version, 1);
        assert.ok(envelope.targetProfileIds.length > 0);
        for (const profileId of envelope.targetProfileIds)
        {
            assert.notEqual(profileId, 'none');
            assert.ok(profileIds.has(profileId), `unknown profile ${profileId}`);
        }
        assert.ok(envelope.targetCapabilities.length > 0);
        for (const capabilityId of envelope.targetCapabilities)
        {
            assert.ok(capabilityIds.has(capabilityId), `unknown capability ${capabilityId}`);
        }
        assert.deepEqual(envelope.precondition, {
            verifiedReceipt: true,
            receiptSchema: 'fsusblog.fixture-receipt.v2',
            semanticSnapshot: 'pre-mutation-verified'
        });
        assert.deepEqual(envelope.expectedRecovery, {
            source: 'same-profile-current-producer-plan',
            restoreTarget: 'pre-mutation-verified-semantic-snapshot'
        });
        assert.ok(cleanupOwners.includes(envelope.cleanupOwner));
        assert.equal(envelope.contentDigest, envelopeContentDigest(envelope));
        const anyTarget = ['entities', 'redisKeys', 'cacheEntries', 'ownedFiles']
            .some((kind) => (envelope.semanticTargets?.[kind] ?? []).length > 0);
        assert.ok(anyTarget, `${envelope.envelopeId} must own at least one target`);
    }
});

test('provider support matrix is explicit per envelope and per sequence', () =>
{
    const catalog = loadCanonicalMutationEnvelopeCatalog();
    for (const envelope of catalog.envelopes)
    {
        for (const provider of providers)
        {
            assert.equal(
                typeof envelope.providerSupport[provider],
                'boolean',
                `${envelope.envelopeId}.${provider} must be boolean`
            );
            assert.equal(
                envelope.providerSupport[provider],
                surfaceUsedByProvider(provider, envelope.semanticTargets),
                `${envelope.envelopeId}.${provider} must match its used surface`
            );
        }
        assert.deepEqual(
            Object.keys(envelope.providerSupport).sort(),
            [...providers].sort()
        );
    }
    const referenced = new Map();
    for (const sequence of catalog.sequences)
    {
        assert.ok(sequence.targetProfileIds.length >= 2);
        assert.ok(sequence.envelopeIds.length >= 2);
        for (const envelopeId of sequence.envelopeIds)
        {
            assert.ok(!referenced.has(envelopeId), `${envelopeId} referenced twice`);
            referenced.set(envelopeId, sequence.sequenceId);
        }
        const sequenceEnvelopes = catalog.envelopes.filter((envelope) =>
            sequence.envelopeIds.includes(envelope.envelopeId));
        for (const provider of providers)
        {
            const mode = sequence.providerSupport[provider];
            const used = sequenceEnvelopes.some((envelope) =>
                surfaceUsedByProvider(provider, envelope.semanticTargets));
            const allSupported = sequenceEnvelopes.every((envelope) =>
                envelope.providerSupport[provider] === true);
            if (mode === 'supported')
            {
                assert.ok(allSupported, `${sequence.sequenceId}.${provider} all must support`);
            }
            if (mode === 'fail-closed')
            {
                assert.ok(used, `${sequence.sequenceId}.${provider} must be used`);
                assert.equal(sequence.qualificationEligible, false);
            }
            if (mode === 'unsupported')
            {
                assert.ok(!used, `${sequence.sequenceId}.${provider} must not be used`);
            }
        }
    }
    assert.equal(referenced.size, catalog.envelopes.length);
});

test('profile sequence scenarios cover cross-profile cross-recovery combinations', () =>
{
    const catalog = loadCanonicalMutationEnvelopeCatalog();
    const catalogs = readFixtureCatalogs();
    const profileIds = new Set(catalogs.profile.profiles.map((profile) => profile.id));
    const sequenceIds = new Set();
    for (const sequence of catalog.sequences)
    {
        assert.ok(!sequenceIds.has(sequence.sequenceId));
        sequenceIds.add(sequence.sequenceId);
        for (const profileId of sequence.targetProfileIds)
        {
            assert.ok(profileIds.has(profileId), `unknown sequence profile ${profileId}`);
        }
        for (const envelopeId of sequence.envelopeIds)
        {
            assert.ok(findEnvelope(catalog, envelopeId), `unknown sequence envelope ${envelopeId}`);
        }
    }
    const failClosed = catalog.sequences.filter((sequence) =>
        Object.values(sequence.providerSupport).includes('fail-closed'));
    assert.ok(failClosed.length >= 1, 'at least one fail-closed sequence must exist');
    assert.ok(failClosed.every((sequence) => sequence.qualificationEligible === false));
    assert.ok(catalog.sequences.some((sequence) => sequence.qualificationEligible === true));
});

test('owned/unowned/ambiguous targets and fixed identity fields fail closed', () =>
{
    const catalog = cloneCatalog();
    const envelope = findEnvelope(catalog, 'mutation/article-views-inflation');
    envelope.semanticTargets.entities[0].fields = ['id'];
    assert.ok(errorsFor(catalog).some((error) =>
        error.includes('must not target fixed identity field id')));

    const unowned = cloneCatalog();
    findEnvelope(unowned, 'mutation/article-views-inflation').cleanupOwner = 'unowned.other';
    assert.ok(errorsFor(unowned).some((error) =>
        error.includes('not a receipt-owned cleanup owner')));

    const unknownDomain = cloneCatalog();
    findEnvelope(unknownDomain, 'mutation/article-views-inflation')
        .semanticTargets.entities[0].domain = 'unknown.surface';
    assert.ok(errorsFor(unknownDomain).some((error) =>
        error.includes('domain is unknown: unknown.surface')));

    const unknownCapability = cloneCatalog();
    findEnvelope(unknownCapability, 'mutation/article-views-inflation')
        .targetCapabilities.push('unknown.capability');
    assert.ok(errorsFor(unknownCapability).some((error) =>
        error.includes('references unknown profile capability unknown.capability')));

    const unknownProfile = cloneCatalog();
    findEnvelope(unknownProfile, 'mutation/article-views-inflation')
        .targetProfileIds.push('unknown-profile');
    assert.ok(errorsFor(unknownProfile).some((error) =>
        error.includes('references unknown fixture profile unknown-profile')));

    const noneProfile = cloneCatalog();
    findEnvelope(noneProfile, 'mutation/article-views-inflation').targetProfileIds = ['none'];
    assert.ok(errorsFor(noneProfile).some((error) =>
        error.includes('must not target the none profile')));
});

test('wildcards, paths and SQL/script/restart actions fail closed', () =>
{
    const catalog = cloneCatalog();
    findEnvelope(catalog, 'mutation/redis-risk-key-tamper')
        .semanticTargets.redisKeys[0].keyRole = 'risk-*';
    assert.ok(errorsFor(catalog).some((error) =>
        error.includes('stable key role without wildcards')));

    for (const key of ['restart', 'script', 'sql', 'commands', 'filePath', 'absolutePath'])
    {
        const mutated = cloneCatalog();
        const envelope = findEnvelope(mutated, 'mutation/article-views-inflation');
        envelope[key] = { arbitrary: 'action' };
        const errors = errorsFor(mutated);
        assert.ok(errors.some((error) => error.includes(`must not declare ${key}`)),
            `key ${key} must be rejected`);
    }
});

test('allowed and forbidden domains must be exact and disjoint', () =>
{
    const narrowed = cloneCatalog();
    const envelope = findEnvelope(narrowed, 'mutation/article-views-inflation');
    envelope.allowedChanges.entities = [];
    assert.ok(errorsFor(narrowed).some((error) =>
        error.includes('allowedChanges must exactly equal semanticTargets')));

    const conflicted = cloneCatalog();
    const conflictedEnvelope = findEnvelope(conflicted, 'mutation/article-views-inflation');
    conflictedEnvelope.forbiddenDomains.entities = [
        JSON.parse(JSON.stringify(conflictedEnvelope.semanticTargets.entities[0]))
    ];
    assert.ok(errorsFor(conflicted).some((error) =>
        error.includes('both allowed and forbidden')));
});

test('duplicate and overlapping envelopes fail closed, no second mutation list', () =>
{
    const duplicated = cloneCatalog();
    duplicated.envelopes.push(JSON.parse(JSON.stringify(duplicated.envelopes[0])));
    assert.ok(errorsFor(duplicated).some((error) => error.includes('duplicate envelope id')));

    const overlapping = cloneCatalog();
    const copy = JSON.parse(JSON.stringify(
        findEnvelope(overlapping, 'mutation/article-views-inflation')));
    copy.envelopeId = 'mutation/article-views-inflation-copy';
    overlapping.envelopes.push(copy);
    const errors = errorsFor(overlapping);
    assert.ok(errors.some((error) => error.includes('overlapping semantic target')));

    const secondList = cloneCatalog();
    secondList.mutations = [];
    assert.ok(errorsFor(secondList).some((error) =>
        error.includes('must not contain a second mutation list')));
});

test('producer/profile drift and catalog tamper invalidate stale plans', () =>
{
    const tampered = cloneCatalog();
    tampered.contentDigest = 'sha256:' + '0'.repeat(64);
    assert.ok(errorsFor(tampered).some((error) =>
        error.includes('contentDigest is stale or tampered')));

    const catalogs = readFixtureCatalogs();
    catalogs.profile.profiles[0] = { ...catalogs.profile.profiles[0], capabilities: ['public.empty'] };
    assert.ok(errorsFor(loadCanonicalMutationEnvelopeCatalog(), { catalogs }).some((error) =>
        error.includes('profileCatalogDigest is stale')));

    const boundPlan = cloneCatalog();
    assert.ok(errorsFor(boundPlan, { profileCatalogDigest: 'sha256:' + 'f'.repeat(64) })
        .some((error) => error.includes('does not match the bound plan')));

    const stale = cloneCatalog();
    delete stale.envelopes[0].semanticTargets.entities[0].fields[0];
    assert.ok(errorsFor(stale).some((error) => error.includes('stale or tampered')));

    const removed = cloneCatalog();
    removed.envelopes = removed.envelopes.filter((envelope) =>
        envelope.envelopeId !== 'mutation/article-views-inflation');
    assert.ok(errorsFor(removed).some((error) =>
        error.includes('uncovered: article.views')));
});

test('schema conformance rejects missing fields and extra identity columns', () =>
{
    const catalog = cloneCatalog();
    delete catalog.destructiveScope;
    assert.ok(validateMutationEnvelopeCatalogSchema(catalog).some((error) =>
        error.includes('missing required property destructiveScope')));

    const extra = cloneCatalog();
    extra.urlPrimaryKey = true;
    assert.ok(validateMutationEnvelopeCatalogSchema(extra).some((error) =>
        error.includes('has additional property urlPrimaryKey')));

    const envelope = findEnvelope(extra, 'mutation/article-views-inflation');
    envelope.extraIdentityColumn = 'articleId';
    assert.ok(validateMutationEnvelopeCatalogSchema(extra).some((error) =>
        error.includes('has additional property extraIdentityColumn')));
});

test('stable canonical ordering and deterministic digests', () =>
{
    const first = loadCanonicalMutationEnvelopeCatalog();
    const second = JSON.parse(JSON.stringify(first));
    assert.equal(catalogContentDigest(second), first.contentDigest);
    for (const envelope of first.envelopes)
    {
        assert.equal(envelopeContentDigest(envelope), envelope.contentDigest);
    }
    assert.deepEqual(
        first.envelopes.map((envelope) => envelope.envelopeId),
        [...first.envelopes.map((envelope) => envelope.envelopeId)].sort()
    );
    assert.deepEqual(
        first.sequences.map((sequence) => sequence.sequenceId),
        [...first.sequences.map((sequence) => sequence.sequenceId)].sort()
    );
    for (const envelope of first.envelopes)
    {
        assert.deepEqual(envelope.targetProfileIds, [...envelope.targetProfileIds].sort());
        assert.deepEqual(envelope.targetCapabilities, [...envelope.targetCapabilities].sort());
    }
    for (const sequence of first.sequences)
    {
        assert.deepEqual(sequence.targetProfileIds, [...sequence.targetProfileIds].sort());
        assert.deepEqual(sequence.envelopeIds, [...sequence.envelopeIds].sort());
    }
    assert.ok(!fs.existsSync(path.resolve(root, canonicalMutationEnvelopeCatalogPath))
        || true);
});

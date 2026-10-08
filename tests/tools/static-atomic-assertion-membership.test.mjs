import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import { staticAtomicCanonicalFixture } from './support/static-atomic-canonical-fixture.mjs';

const { sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { validateStaticAssertionMembership } = await import(new URL('../../tools/test/static-atomic/assertion-membership.mjs', import.meta.url));

test('canonical membership retains every original assertion, coverage, artifact and legacy test identity', t =>
{
    const fixture = staticAtomicCanonicalFixture(t);
    for (const producer of fixture.declarations.producers)
    {
        const replay = fixture.options.authorities.replayPlans.find(entry => entry.plan.producer.id === producer.id);
        const result = validateStaticAssertionMembership(producer, fixture.memberships[producer.id], replay.plan);
        assert.deepEqual(result.originalAssertionBindings, producer.assertionBindings);
        assert.deepEqual(result.legacyPhysicalTestIds, producer.legacyPhysicalTestIds);
        assert.deepEqual(result.replayTestIds, replay.plan.testEnumerationOrder);
        assert.equal(result.qualificationEligible, false);
    }
});

test('resealing cannot remove an original assertion, alter coverage, or substitute legacy IDs for canonical membership', t =>
{
    const fixture = staticAtomicCanonicalFixture(t);
    const producer = fixture.declarations.producers.find(entry => entry.assertionBindings.length > 0);
    const replay = fixture.options.authorities.replayPlans.find(entry => entry.plan.producer.id === producer.id).plan;
    const original = fixture.memberships[producer.id];
    const altered = mutate =>
    {
        const body = structuredClone(original);
        delete body.contentDigest;
        mutate(body);
        return sealContentDigest(body);
    };
    assert.throws(() => validateStaticAssertionMembership(producer, altered(body => body.assertionBindings.pop()), replay), /original assertion roster/u);
    assert.throws(() => validateStaticAssertionMembership(producer, altered(body => body.assertionBindings[0].coverageIds = []), replay), /original assertion\/test/u);
    assert.throws(() => validateStaticAssertionMembership(producer, altered(body => body.assertionBindings[0].replayTestIds = []), replay), /every original assertion/u);
    assert.throws(() => validateStaticAssertionMembership(producer, altered(body => body.legacyPhysicalTestIds = []), replay), /original logical test IDs/u);
    assert.throws(() => validateStaticAssertionMembership(producer, altered(body => body.additionalTestIds = body.assertionBindings[0].replayTestIds), replay), /multiple assertions/u);
});

test('security checks without registered assertions require an explicit nonempty canonical test enumeration', t =>
{
    const fixture = staticAtomicCanonicalFixture(t);
    const producer = fixture.declarations.producers.find(entry => entry.assertionBindings.length === 0);
    const replay = fixture.options.authorities.replayPlans.find(entry => entry.plan.producer.id === producer.id).plan;
    const body = { ...fixture.memberships[producer.id] };
    delete body.contentDigest;
    assert.throws(() => validateStaticAssertionMembership(producer, sealContentDigest({ ...body, additionalTestIds: [] }), replay), /complete replay enumeration/u);
});

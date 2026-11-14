import assert from 'node:assert/strict';
import test from 'node:test';

const { seal } = await import(new URL('../../tools/test-fixtures/mutation-recovery/canonical.mjs', import.meta.url));
const { bindFixtureSwitchPlan, buildFixtureSwitchEvidence, inspectFixtureSwitchCapability, verifyFixtureSwitchEvidence } = await import(new URL('../../tools/test-matrix/fixture-switch-evidence.mjs', import.meta.url));

import { replaceEventMaterial, switchMaterials } from './support/fixture-matrix-evidence-fixture.mjs';

test('fixed switch materials recompute for three providers without claiming runtime qualification', () =>
{
    for (const provider of ['postgresql', 'mysql', 'sqlite'])
    {
        const inputs = switchMaterials(provider);
        const evidence = buildFixtureSwitchEvidence(inputs);
        assert.equal(evidence.outcome, 'passed');
        assert.equal(evidence.qualificationEligible, false);
        assert.equal(evidence.terminalVector.length, 5);
        assert.equal(verifyFixtureSwitchEvidence(evidence, inputs), evidence);
    }
});

test('actual catalog explicitly reports missing messaging, timeline and mixed-provider media capability', () =>
{
    const actual = inspectFixtureSwitchCapability();
    assert.equal(actual.status, 'unqualified');
    assert.ok(actual.gaps.some((gap) => gap.includes('messaging-preferences')));
    assert.ok(actual.gaps.some((gap) => gap.includes('public-minimal: media')));
    assert.ok(actual.gaps.some((gap) => gap.includes('timeline')));
});

test('runtime PID, start identity, DB, Redis, build and service generations cannot drift', () =>
{
    for (const field of ['backendPid', 'backendStartedAt', 'databaseInstance', 'redisInstance', 'backendBuildDigest', 'serviceGeneration'])
    {
        const inputs = switchMaterials();
        inputs.events[5].runtimeIdentity = { ...inputs.events[5].runtimeIdentity, [field]: 'changed' };
        assert.throws(() => buildFixtureSwitchEvidence(inputs), /identity/);
    }
    const inputs = switchMaterials();
    inputs.events[8].serviceIdentity = { ...inputs.events[8].serviceIdentity, serviceGeneration: 'changed' };
    assert.throws(() => buildFixtureSwitchEvidence(inputs), /service identity/);
});

test('previous-profile cleanup residue, unobserved sentinels and public-empty resident state fail closed', () =>
{
    for (const update of [
        (document) =>
        {
            document.ownedRemaining = 1;
        },
        (document) =>
        {
            document.sentinels = [];
        },
        (document) =>
        {
            document.sentinels[0].afterDigest = `sha256:${'f'.repeat(64)}`;
        },
        (document) =>
        {
            document.settled = false;
        },
        (document) =>
        {
            document.namespace = 'old-namespace';
        }
    ])
    {
        const inputs = switchMaterials();
        replaceEventMaterial(inputs, inputs.events.find((event) => event.phase === 'cleanup'), update);
        assert.throws(() => buildFixtureSwitchEvidence(inputs), /cleanup|sentinel|namespace/);
    }
    for (const domain of ['auth', 'comment', 'message', 'preference', 'public'])
    {
        for (const kind of ['records', 'keys', 'files', 'sessions'])
        {
            const inputs = switchMaterials();
            replaceEventMaterial(inputs, inputs.events.find((event) => event.phase === 'empty'), (document) =>
            {
                document.resident[domain][kind] = 1;
            });
            assert.throws(() => buildFixtureSwitchEvidence(inputs), /not zero/);
        }
    }
});

test('missing, overlapping, reordered and extra mutation events are rejected', () =>
{
    const missing = switchMaterials();
    missing.events.splice(3, 1);
    assert.throws(() => buildFixtureSwitchEvidence(missing), /missing or out-of-order/);
    const overlapping = switchMaterials();
    overlapping.events[8].startedAt = 0;
    assert.throws(() => buildFixtureSwitchEvidence(overlapping), /overlapping/);
    const reordered = switchMaterials();
    [reordered.events[3], reordered.events[4]] = [reordered.events[4], reordered.events[3]];
    assert.throws(() => buildFixtureSwitchEvidence(reordered), /out-of-order/);
    const extra = switchMaterials();
    extra.events.push(extra.events[0]);
    assert.throws(() => buildFixtureSwitchEvidence(extra), /extra event/);
});

test('failed, cancelled and timeout runs retain primary outcome, settled cleanup and all blocked successors', () =>
{
    for (const outcome of ['failed', 'cancelled', 'timed-out'])
    {
        const inputs = switchMaterials();
        inputs.outcome = outcome;
        inputs.events[3].status = outcome;
        inputs.events = [...inputs.events.slice(0, 4), inputs.events[6]];
        const evidence = buildFixtureSwitchEvidence(inputs);
        assert.equal(evidence.outcome, outcome);
        assert.equal(evidence.terminalVector.length, 5);
        assert.ok(evidence.terminalVector.slice(1).every((profile) => profile.entries.every((entry) => entry.status === 'blocked')));
        const continued = switchMaterials();
        continued.outcome = outcome;
        continued.events[3].status = outcome;
        assert.throws(() => buildFixtureSwitchEvidence(continued), /continued after failure/);
        inputs.events.pop();
        assert.throws(() => buildFixtureSwitchEvidence(inputs), /settled cleanup/);
    }
});

test('partial recovery, stale plans, retries and forbidden operations cannot pass', () =>
{
    for (const update of [
        (document) =>
        {
            document.receipt = seal({ ...document.receipt, retryCount: 1 });
        },
        (document) =>
        {
            document.receipt = seal({ ...document.receipt, cases: [] });
        },
        (document) =>
        {
            document.plan = seal({ ...document.plan, source: { ...document.plan.source, commit: 'f'.repeat(40) } });
            document.receipt = seal({ ...document.receipt, planDigest: document.plan.contentDigest });
        },
        (document) =>
        {
            document.operations.push('backend-restart');
        }
    ])
    {
        const inputs = switchMaterials();
        replaceEventMaterial(inputs, inputs.events.find((event) => event.phase === 'recovery'), update);
        assert.throws(() => buildFixtureSwitchEvidence(inputs), /recovery|operations/);
    }
});

test('projection requires exact profiles, node dependencies, envelopes and precise resource contracts', () =>
{
    for (const update of [
        (projection) =>
        {
            projection.profiles.reverse();
        },
        (projection) =>
        {
            projection.edges.pop();
        },
        (projection) =>
        {
            projection.profiles[0].envelopeIds.pop();
        },
        (projection) =>
        {
            projection.profiles[0].nodes.admit = projection.profiles[0].nodes.prepare;
        },
        (projection) =>
        {
            projection.exclusivity.stateDomains = ['*'];
        },
        (projection) =>
        {
            projection.exclusivity.resources.pop();
        },
        (projection) =>
        {
            projection.context.provider = 'filesystem';
        }
    ])
    {
        const inputs = switchMaterials();
        const projection = structuredClone(inputs.projection);
        update(projection);
        assert.throws(() => bindFixtureSwitchPlan({ context: inputs.plan.context, projection: seal(projection), catalog: inputs.catalog }));
    }
});

test('plan, event material and terminal evidence tamper or accepted-status promotion is rejected', () =>
{
    const inputs = switchMaterials();
    const evidence = buildFixtureSwitchEvidence(inputs);
    assert.throws(() => verifyFixtureSwitchEvidence(seal({ ...evidence, qualificationEligible: true }), inputs), /recomputed/);
    assert.throws(() => verifyFixtureSwitchEvidence({ ...evidence, outcome: 'failed' }, inputs), /digest mismatch/);
    const document = inputs.materials[inputs.events[0].evidenceDigest];
    document.phase = 'mutation';
    assert.throws(() => buildFixtureSwitchEvidence(inputs), /tampered/);
});

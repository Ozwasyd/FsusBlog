import assert from 'node:assert/strict';
import test from 'node:test';

const { admitSecurityPrerequisites, projectSecurityBarriers } = await import(new URL('../../tools/test/security-atomic/barriers.mjs', import.meta.url));
const { verifyProjection } = await import(new URL('../../tools/test/security-atomic/contract.mjs', import.meta.url));

import { createSecurityAtomicFixture } from './support/security-atomic-fixtures.mjs';

test('security barrier projection reuses the canonical fixture plan and has no empty legacy attack node', () =>
{
    const fixture = createSecurityAtomicFixture();
    const resident = projectSecurityBarriers({ profileId: fixture.context.profileId, mode: 'resident' });
    assert.ok(resident.fixturePlan.producers.length > 0);
    assert.deepEqual(resident.nodes.map((node) => node.producerId), [
        'security-runtime-ready', 'security-fixture-prepare', 'security-reset-pre-scenarios', 'security-reset-post-gate'
    ]);
    assert.equal(resident.nodes.at(-1).alwaysRun, true);
    assert.equal(resident.nodes.at(-1).unlocksCorrectness, false);
    assert.equal(resident.nodes.at(-1).settledScenarioIds.length,
        fixture.catalog.scenarios.filter((scenario) => scenario.phase === 'security').length);
    const legacy = projectSecurityBarriers({ profileId: fixture.context.profileId, mode: 'legacy' });
    assert.deepEqual(legacy.nodes.find((node) => node.producerId === 'security-reset-pre-attack').consumers,
        ['security.attack-matrix']);
});

test('runtime rejection prevents fixture and reset owner consumption', async () =>
{
    const fixture = createSecurityAtomicFixture();
    fixture.records.get(fixture.references.runtime.path).document.ready = false;
    await assert.rejects(admitSecurityPrerequisites({ ...fixture, needsFixture: true }), /runtime owner rejected/u);
    assert.deepEqual(fixture.calls, ['runtime']);
});

test('fixture failure prevents reset admission and successful exit cannot replace reset postconditions', async () =>
{
    const fixture = createSecurityAtomicFixture();
    fixture.records.get(fixture.references.fixture.path).document.ready = false;
    await assert.rejects(admitSecurityPrerequisites({ ...fixture, needsFixture: true }), /fixture owner rejected/u);
    assert.deepEqual(fixture.calls, ['runtime', 'fixture']);
    fixture.calls.length = 0;
    fixture.references.reset = fixture.reference('reset', 'exit-zero-bad-postcondition', { ready: false, commandExit: 0 });
    await assert.rejects(admitSecurityPrerequisites({ ...fixture, needsFixture: false }), /reset owner rejected/u);
    assert.deepEqual(fixture.calls, ['runtime', 'reset']);
});

test('cross-run namespace runtime and state catalog bindings fail closed', async () =>
{
    const fixture = createSecurityAtomicFixture();
    await assert.rejects(admitSecurityPrerequisites({ ...fixture, context: { ...fixture.context, runId: 'another-run' } }), /rejected evidence/u);
    await assert.rejects(admitSecurityPrerequisites({ ...fixture, context: { ...fixture.context, namespace: 'another-namespace' } }), /rejected evidence/u);
    await assert.rejects(admitSecurityPrerequisites({ ...fixture, context: { ...fixture.context, stateCatalogDigest: `sha256:${'c'.repeat(64)}` } }), /rejected evidence/u);
});

test('missing canonical capability and tampered barrier projection are refused', async () =>
{
    const fixture = createSecurityAtomicFixture();
    await assert.rejects(admitSecurityPrerequisites({ ...fixture, ownerVerifiers: {} }), /missing canonical runtime/u);
    const projection = structuredClone(projectSecurityBarriers({ profileId: fixture.context.profileId, mode: 'resident' }));
    projection.nodes[0].dependsOn.push('ambient-port');
    assert.throws(() => verifyProjection(projection), /digest mismatch/u);
    assert.throws(() => projectSecurityBarriers({ profileId: 'none', mode: 'resident' }), /non-empty canonical profile/u);
});

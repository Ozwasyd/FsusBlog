import assert from 'node:assert/strict';
import test from 'node:test';

const { collectSecurityTerminals } = await import(new URL('../../tools/test/security-atomic/contract.mjs', import.meta.url));
const { admitSecurityScenario, projectSecurityScenarios } = await import(new URL('../../tools/test/security-atomic/scenarios.mjs', import.meta.url));

import { createSecurityAtomicFixture } from './support/security-atomic-fixtures.mjs';

test('each catalog application scenario projects exactly once with mode-independent producer and test identities', () =>
{
    const fixture = createSecurityAtomicFixture();
    const resident = projectSecurityScenarios({ ...fixture, mode: 'resident' });
    const legacy = projectSecurityScenarios({ ...fixture, mode: 'legacy' });
    assert.deepEqual(resident.producers.map(({ producerId, testId }) => ({ producerId, testId })),
        legacy.producers.map(({ producerId, testId }) => ({ producerId, testId })));
    assert.equal(resident.producers.length, fixture.bindings.length);
    assert.equal(resident.aggregate.executesCommands, false);
    assert.deepEqual(resident.aggregate.settledDependsOn, resident.producers.map((producer) => producer.producerId));
    for (const producer of resident.producers)
    {
        assert.equal(producer.allowedRetries, 0);
        assert.equal(producer.attemptNumber, 1);
        assert.deepEqual(producer.scenario, fixture.catalog.scenarios.find((scenario) => scenario.id === producer.testId));
    }
});

test('catalog additions missing bindings and unknown retained application commands fail instead of disappearing', () =>
{
    const fixture = createSecurityAtomicFixture();
    const catalog = structuredClone(fixture.catalog);
    const scenario = { ...catalog.scenarios.find((item) => item.id === 'security.auth-session'), id: 'security.new-scenario' };
    catalog.scenarios.push(scenario);
    catalog.migrationBaseline.catalogScenarioCount += 1;
    assert.throws(() => projectSecurityScenarios({ ...fixture, catalog, mode: 'resident' }), /cover the catalog exactly once/u);
    scenario.executor = 'retained-cli';
    scenario.command = 'node new-command.mjs';
    assert.throws(() => projectSecurityScenarios({ ...fixture, catalog, mode: 'legacy' }), /unprojected security catalog scenario/u);
});

test('isolation reference reuse and retry mutation are rejected before admission', async () =>
{
    const fixture = createSecurityAtomicFixture();
    const duplicate = structuredClone(fixture.bindings);
    duplicate[1].isolation = duplicate[0].isolation;
    assert.throws(() => projectSecurityScenarios({ ...fixture, bindings: duplicate, mode: 'resident' }), /isolation reference reuse/u);
    const plan = fixture.register(projectSecurityScenarios({ ...fixture, mode: 'resident' }));
    const producer = { ...plan.producers[0], attemptNumber: 2 };
    await assert.rejects(admitSecurityScenario({ ...fixture, producer }), /exact-one zero-retry/u);
    assert.deepEqual(fixture.calls, []);
});

test('healthy isolated siblings remain admissible after a product failure only with exact host revalidation', async () =>
{
    const fixture = createSecurityAtomicFixture();
    const plan = fixture.register(projectSecurityScenarios({ ...fixture, mode: 'resident' }));
    const failures = ['controlled-first-attempt-failure'];
    fixture.references.hostRevalidation = fixture.reference('hostRevalidation', 'healthy-after-failure', { failures });
    const admitted = await admitSecurityScenario({ ...fixture, producer: plan.producers[1], hostFailureRefs: failures });
    assert.equal(admitted.producerId, plan.producers[1].producerId);
    await assert.rejects(admitSecurityScenario({ ...fixture, producer: plan.producers[1], hostFailureRefs: ['uncovered-failure'] }), /cover all failed attempts/u);
    fixture.records.get(fixture.references.host.path).document.ready = false;
    await assert.rejects(admitSecurityScenario({ ...fixture, producer: plan.producers[2] }), /host owner rejected/u);
});

test('missing host health capability and catalog declaration tamper fail closed', async () =>
{
    const fixture = createSecurityAtomicFixture();
    const plan = fixture.register(projectSecurityScenarios({ ...fixture, mode: 'resident' }));
    await assert.rejects(admitSecurityScenario({ ...fixture, producer: plan.producers[0], hostFailureRefs: ['failed'] }), /owner reference/u);
    const producer = structuredClone(plan.producers[0]);
    producer.scenario.expectedAssertions = ['weakened'];
    await assert.rejects(admitSecurityScenario({ ...fixture, producer }), /canonical catalog/u);
});

test('settled aggregate retains all failed siblings and cleanup cannot erase the original failure', async () =>
{
    const fixture = createSecurityAtomicFixture();
    const ids = ['first', 'second', 'security-reset-post-gate'];
    const references = [fixture.terminal('first', 'failed', ['original-failure']),
        fixture.terminal('second', 'timed-out', ['second-timeout']),
        fixture.terminal('security-reset-post-gate', 'failed', ['cleanup-failure'])];
    const summary = await collectSecurityTerminals({ ...fixture, producerIds: ids, references });
    assert.equal(summary.status, 'failed');
    assert.deepEqual(summary.primaryFailureRefs, ['original-failure', 'second-timeout', 'cleanup-failure']);
    assert.equal(summary.terminals.length, 3);
    await assert.rejects(collectSecurityTerminals({ ...fixture, producerIds: ids, references: references.slice(1) }), /exact-one terminal/u);
    const tampered = structuredClone(references);
    tampered[0].terminalState = 'success';
    await assert.rejects(collectSecurityTerminals({ ...fixture, producerIds: ids, references: tampered }), /fields must match/u);
});

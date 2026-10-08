import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { executeWeightedStepDag, buildSettledPhaseJoinEvidence } = await import(new URL('../../tools/test/bundles/bundle-steps.mjs', import.meta.url));
const { digestCanonical, sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { projectStaticAtomicSummary, verifyStaticAtomicSummary } = await import(new URL('../../tools/test/static-atomic/summary.mjs', import.meta.url));
const { staticAtomicFixture } = await import(new URL('./support/static-atomic-fixture.mjs', import.meta.url));

async function executeFixture(fixture, lane, runtimeProbe = false)
{
    const producers = fixture.declarations.producers.filter(entry => entry.lane === lane);
    const children = [];
    const options = { repositoryRoot: fixture.root, evidenceRoot: fixture.evidenceRoot,
        lane, identity: fixture.identity, children, verifyAuthority: fixture.verifyAuthority };
    let summary;
    let runtimeExecuted = false;
    const steps = producers.map(producer => ({
        id: producer.id, command: producer.command, dependsOn: [], resources: producer.resources
    }));
    steps.push({ id: `${lane}-summary`, command: null, settledDependsOn: producers.map(entry => entry.id),
        runAfterSettled: true, resources: { coordinationOnly: true } });
    if (runtimeProbe)
    {
        steps.push({ id: 'independent-runtime-control', command: null, dependsOn: [],
            resources: { coordinationOnly: true } });
    }
    // Isolated owner fixture over the existing scheduler, not the missing shared compiler.
    try
    {
        await executeWeightedStepDag(steps, { maxParallel: 4, cpuUnits: 4, memoryGiB: 4 }, async step =>
        {
            if (step.id === 'independent-runtime-control')
            {
                runtimeExecuted = true;
                return;
            }
            if (step.id === `${lane}-summary`)
            {
                assert.equal(children.length, producers.length);
                summary = projectStaticAtomicSummary(options);
                const result = buildSettledPhaseJoinEvidence({ stepId: step.id,
                    dependencyIds: producers.map(entry => entry.id),
                    dependencyOutcomes: step.dependencyOutcomes,
                    dependencyResults: Object.fromEntries(Object.entries(step.dependencyOutcomes)
                        .map(([id, terminalState]) => [id, { terminalState }])),
                    evidenceRef: 'synthetic-summary' });
                return { terminalState: result.evidence.terminalState, evidence: result.evidence };
            }
            const producer = producers.find(entry => entry.id === step.id);
            const child = await fixture.run(producer);
            children.push(child);
            const receipt = JSON.parse(fs.readFileSync(path.join(fixture.evidenceRoot, child.attemptPath), 'utf8'));
            if (receipt.status !== 'clean-success')
            {
                throw new Error(`synthetic checker failed: ${producer.id}`);
            }
        });
    }
    catch (error)
    {
        assert.equal(summary?.status, 'failure', error.message);
    }
    assert.ok(summary);
    return { summary, options, runtimeExecuted };
}

test('distribution failure settles all six children and leaves independent runtime runnable', async t =>
{
    const fixture = staticAtomicFixture(t, ['cross-stack-distribution-coherence']);
    const { summary, runtimeExecuted } = await executeFixture(fixture, 'cross-stack-static', true);
    assert.equal(runtimeExecuted, true);
    assert.equal(summary.status, 'failure');
    assert.equal(summary.children.length, 6);
    assert.equal(summary.children.filter(child => child.terminalState === 'clean-success').length, 5);
    assert.equal(summary.qualificationEligible, false);
    for (const child of summary.children)
    {
        assert.equal(child.evidenceRefs.length, 3);
        assert.ok(child.replayRef.artifactDigest);
        assert.ok(child.inputClosureDigest);
    }
});

test('auth and service worker failures both survive the cross-stack settled projection', async t =>
{
    const fixture = staticAtomicFixture(t, ['cross-stack-auth-state-coherence', 'cross-stack-service-worker-cache']);
    const { summary } = await executeFixture(fixture, 'cross-stack-static');
    assert.deepEqual(summary.children.filter(child => child.terminalState !== 'clean-success')
        .map(child => child.producerId), ['cross-stack-auth-state-coherence', 'cross-stack-service-worker-cache']);
});

test('network failure does not cancel the other six security checks', async t =>
{
    const fixture = staticAtomicFixture(t, ['security-network-baseline']);
    const { summary } = await executeFixture(fixture, 'security-static');
    assert.equal(summary.children.length, 7);
    assert.equal(summary.children.filter(child => child.terminalState === 'clean-success').length, 6);
    assert.equal(summary.status, 'failure');
});

test('matrices and PoW simultaneous failures are retained; warning-policy failure cannot pass', async t =>
{
    const fixture = staticAtomicFixture(t, ['security-matrices', 'security-pow-parity', 'security-zap-warning-policy']);
    const { summary } = await executeFixture(fixture, 'security-static');
    assert.deepEqual(summary.children.filter(child => child.terminalState !== 'clean-success').map(child => child.producerId),
        ['security-matrices', 'security-pow-parity', 'security-zap-warning-policy']);
    assert.equal(summary.status, 'failure');
});

test('projection requires all attempts; duplicate, absent, runtime and blocked placeholders are rejected', async t =>
{
    const fixture = staticAtomicFixture(t);
    const { summary, options } = await executeFixture(fixture, 'cross-stack-static');
    assert.equal(summary.status, 'success');
    assert.equal(summary.qualificationEligible, false);
    assert.throws(() => projectStaticAtomicSummary({ ...options, children: options.children.slice(1) }), /complete child set/);
    assert.throws(() => projectStaticAtomicSummary({ ...options, children: Array(6).fill(options.children[0]) }), /complete child set/);
    assert.throws(() => projectStaticAtomicSummary({ ...options, lane: 'cross-stack-runtime' }), /complete child set/);
    const mixed = structuredClone(options.children);
    mixed[0].producerId = 'cross-stack-runtime';
    assert.throws(() => projectStaticAtomicSummary({ ...options, children: mixed }), /complete child set/);
    const blocked = structuredClone(options.children);
    blocked[0] = { producerId: blocked[0].producerId, terminalState: 'blocked', blockedBy: ['frontend-install'] };
    assert.throws(() => projectStaticAtomicSummary({ ...options, children: blocked }), /confined relative path/);
    const before = options.children.map(child => fs.readFileSync(path.join(fixture.evidenceRoot, child.attemptPath), 'utf8'));
    verifyStaticAtomicSummary(summary, options);
    assert.deepEqual(options.children.map(child => fs.readFileSync(path.join(fixture.evidenceRoot, child.attemptPath), 'utf8')), before);
});

test('summary and resealed status tamper, foreign run, input, child and log tamper fail closed', async t =>
{
    const fixture = staticAtomicFixture(t, ['cross-stack-distribution-coherence']);
    const { summary, options } = await executeFixture(fixture, 'cross-stack-static');
    const forgedSummary = sealContentDigest({ ...summary, status: 'success' });
    assert.throws(() => verifyStaticAtomicSummary(forgedSummary, options), /does not match/);
    assert.throws(() => projectStaticAtomicSummary({ ...options, identity: { ...fixture.identity,
        schedulerRunId: 'foreign-run' } }), /identity\/command\/membership/);
    const child = options.children.find(entry => entry.producerId === 'cross-stack-distribution-coherence');
    const forgedBindings = structuredClone(options.children);
    forgedBindings[0].binding.inputClosureDigest = digestCanonical('different-input');
    assert.throws(() => projectStaticAtomicSummary({ ...options, children: forgedBindings }), /execution envelope/);
    const file = path.join(fixture.evidenceRoot, child.attemptPath);
    const originalBytes = fs.readFileSync(file);
    const original = JSON.parse(originalBytes);
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, JSON.stringify(sealContentDigest({ ...original, status: 'clean-success', exitCode: 0,
        failureClass: null, failureKind: null, firstFailure: false, retryDecision: 'not-applicable' })));
    assert.throws(() => projectStaticAtomicSummary(options), /identity\/command\/membership/);
    fs.writeFileSync(file, originalBytes);
    const log = path.join(path.dirname(file), 'stdout.log');
    fs.chmodSync(log, 0o600);
    fs.appendFileSync(log, 'tampered log');
    assert.throws(() => projectStaticAtomicSummary(options), /artifact-tamper/);
});

test('attempt references cannot escape evidence root or follow symlink aliases', async t =>
{
    const fixture = staticAtomicFixture(t);
    const { options } = await executeFixture(fixture, 'security-static');
    const children = structuredClone(options.children);
    children[0].attemptPath = '../receipt.json';
    assert.throws(() => projectStaticAtomicSummary({ ...options, children }), /confined relative path/);
    const original = options.children[0];
    const target = path.join(fixture.evidenceRoot, original.attemptPath);
    const alias = path.join(fixture.evidenceRoot, 'alias.json');
    fs.symlinkSync(target, alias);
    children[0].attemptPath = 'alias.json';
    assert.throws(() => projectStaticAtomicSummary({ ...options, children }), /symlink/);
});

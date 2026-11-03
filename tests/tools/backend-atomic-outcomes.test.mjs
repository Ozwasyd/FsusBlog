import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { digestCanonical, sealContentDigest, sha256 } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { backendGovernanceInput, backendReadinessInput, projectBackendGovernanceOutcomes, projectBackendPerfOutcomes, verifyBackendAtomicSummary } = await import(new URL('../../tools/test/backend-atomic-outcomes.mjs', import.meta.url));
const { createBackendAtomicPlan } = await import(new URL('../../tools/test/backend-atomic-producers.mjs', import.meta.url));
const { executeWeightedStepDag } = await import(new URL('../../tools/test/bundles/bundle-steps.mjs', import.meta.url));

import { fixtureArtifactCommand, fixtureAttempt, fixtureCommandFor, fixtureInput, fixtureVerifyAuthority } from './support/backend-atomic-fixture.mjs';

const sourceRoot = path.resolve(import.meta.dirname, '../..');

async function withEvidence(run)
{
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-atomic-outcomes-'));
    try
    {
        await run(evidenceRoot);
    }
    finally
    {
        fs.rmSync(evidenceRoot, { recursive: true, force: true });
    }
}

async function governanceFixture(evidenceRoot, failures = [])
{
    const input = fixtureInput();
    const producers = input.declarations.filter((entry) => entry.kind === 'atomic-producer');
    for (const entry of producers)
    {
        entry.commandDigest = digestCanonical(fixtureCommandFor(failures.includes(entry.producerId) ? 'product-failure' : 'success'));
    }
    const plan = createBackendAtomicPlan(input);
    const observations = [];
    const steps = producers.map((entry) => ({ id: entry.producerId, command: 'DATA_ONLY physical fixture', resources: { cpuWeight: 1, memoryWeight: 1 } }));
    let schedulerFailure;
    try
    {
        await executeWeightedStepDag(steps, { cpuUnits: 3, memoryGiB: 3, maxParallel: 3 }, async (step) =>
        {
            const entry = producers.find((producer) => producer.producerId === step.id);
            const observation = await fixtureAttempt(evidenceRoot, entry, { scenario: failures.includes(step.id) ? 'product-failure' : 'success' });
            observations.push(observation);
            if (failures.includes(step.id))
            {
                throw new Error('fixture checker failed');
            }
        });
    }
    catch (error)
    {
        schedulerFailure = error;
    }
    assert.equal(observations.length, 3, 'every independent physical fixture completed');
    assert.equal(Boolean(schedulerFailure), failures.length > 0);
    return { plan, expectedPlanDigest: plan.contentDigest, observations, evidenceRoot, sourceRoot, verifyAuthority: fixtureVerifyAuthority };
}

for (const failures of [[], ['backend-source-file-size'], ['backend-test-governance'], ['backend-source-file-size', 'backend-test-governance']])
{
    test(`physical first-attempt fixtures settle every sibling with failures ${JSON.stringify(failures)}`, async () => withEvidence(async (root) =>
    {
        const input = await governanceFixture(root, failures);
        const result = projectBackendGovernanceOutcomes(input);
        assert.equal(result.exitCode, failures.length ? 1 : 0);
        assert.equal(result.statusVector.length, 3);
        assert.deepEqual(result.statusVector.filter((entry) => entry.terminalState !== 'clean-success').map((entry) => entry.producerId).sort(), [...failures].sort());
        assert.equal(result.authority, 'DATA_ONLY');
        assert.equal(verifyBackendAtomicSummary(result, result.contentDigest, input).contentDigest, result.contentDigest);
    }));
}

function rewriteAttempt(root, observation, mutate)
{
    const file = path.join(root, observation.attemptRef.path);
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(document);
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, JSON.stringify(sealContentDigest(document)));
    observation.attemptRef.digest = sha256(fs.readFileSync(file));
}

for (const [name, mutate, pattern] of [
    ['old source identity', (receipt) =>
    {
        receipt.sourceCommit = '9'.repeat(40);
    }, /crosses sourceCommit|attempt sourceCommit/u],
    ['foreign replay identity', (receipt) =>
    {
        receipt.replayPlanDigest = `sha256:${'9'.repeat(64)}`;
    }, /replayPlanDigest/u],
    ['wrong command', (receipt) =>
    {
        receipt.command = ['node', 'second-checker'];
        receipt.commandDigest = digestCanonical(receipt.command);
    }, /commandDigest/u],
    ['second attempt', (receipt) =>
    {
        receipt.attemptNumber = 2;
    }, /policy-limit-exceeded/u],
    ['first failure erased', (receipt) =>
    {
        receipt.status = 'clean-success';
    }, /clean-status-invalid/u],
    ['missing log refs', (receipt) =>
    {
        receipt.stdoutPath = 'absent.log';
    }, /log-reference-missing/u]
])
{
    test(`reject resealed ${name}`, async () => withEvidence(async (root) =>
    {
        const input = await governanceFixture(root, ['backend-source-file-size']);
        rewriteAttempt(root, input.observations.find((entry) => entry.producerId === 'backend-source-file-size'), mutate);
        assert.throws(() => projectBackendGovernanceOutcomes(input), pattern);
    }));
}

test('missing/duplicate observations, extra physical attempt, log tamper and summary tamper reject', async () => withEvidence(async (root) =>
{
    const input = await governanceFixture(root);
    assert.throws(() => projectBackendGovernanceOutcomes({ ...input, observations: input.observations.slice(1) }), /complete exact-one/u);
    assert.throws(() => projectBackendGovernanceOutcomes({ ...input, observations: [...input.observations, input.observations[0]] }), /complete exact-one/u);
    assert.throws(() => projectBackendGovernanceOutcomes({ ...input, verifyAuthority: null }), /independent/u);
    const result = projectBackendGovernanceOutcomes(input);
    const changed = sealContentDigest({ ...result, statusVector: result.statusVector.slice(0, 1) });
    assert.throws(() => verifyBackendAtomicSummary(changed, changed.contentDigest, input), /complete summary/u);
    const extra = path.join(root, path.dirname(path.dirname(input.observations[0].attemptRef.path)), 'attempt-2');
    fs.mkdirSync(extra);
    assert.throws(() => projectBackendGovernanceOutcomes(input), /exact-one attempt/u);
    fs.rmSync(extra, { recursive: true });
    const log = path.join(root, path.dirname(input.observations[0].attemptRef.path), 'stdout.log');
    fs.chmodSync(log, 0o600);
    fs.appendFileSync(log, 'tamper');
    assert.throws(() => projectBackendGovernanceOutcomes(input), /artifact-tamper/u);
}));

async function perfFixture(root, { governanceFailures = [], nativeFails = false, readinessFails = false, releaseFails = false, consumerFails = governanceFailures.length > 0, missingInput = false } = {})
{
    const governance = await governanceFixture(root, governanceFailures);
    const governanceSummary = projectBackendGovernanceOutcomes(governance);
    const input = fixtureInput('backend-perf', 'build');
    const govEntry = input.declarations.find((entry) => entry.producerId === 'backend-perf-governance');
    const readinessEntry = input.declarations.find((entry) => entry.producerId === 'backend-perf-readiness');
    const nativeEntry = input.declarations.find((entry) => entry.producerId === 'backend-perf-native-p99');
    const govCommand = fixtureArtifactCommand(missingInput ? {} : { 'governance-input.json': backendGovernanceInput(governanceSummary, governance.observations) }, consumerFails ? 1 : 0);
    govEntry.commandDigest = digestCanonical(govCommand);
    // readiness-input binds the plan, so the physical command reads that data
    // through an owned fixture environment file, avoiding a command/plan cycle.
    const readinessCommand = [process.execPath, '-e', "const fs=require('node:fs'); const input=JSON.parse(fs.readFileSync(process.argv[1])); fs.writeFileSync(process.env.FSUSBLOG_ATTEMPT_ARTIFACT_ROOT+'/readiness-input.json',JSON.stringify(input)); fs.writeFileSync(process.env.FSUSBLOG_ATTEMPT_RESULT_PATH,JSON.stringify({schema:'fsusblog.test-attempt-result.v1',failureClass:null,failureKind:null,failedTestIds:[],executedTestIds:[],artifactPaths:['readiness-input.json']})); process.exitCode=Number(process.argv[2]);", path.join(root, 'readiness-input.json'), String(readinessFails ? 1 : 0)];
    readinessEntry.commandDigest = digestCanonical(readinessCommand);
    nativeEntry.commandDigest = digestCanonical(fixtureCommandFor(nativeFails ? 'product-failure' : 'success'));
    input.releasePrerequisite.commandDigest = digestCanonical(fixtureCommandFor(releaseFails ? 'product-failure' : 'success'));
    const plan = createBackendAtomicPlan(input);
    fs.writeFileSync(path.join(root, 'readiness-input.json'), JSON.stringify(backendReadinessInput(plan)));
    const release = await fixtureAttempt(root, input.releasePrerequisite, { scenario: releaseFails ? 'product-failure' : 'success' });
    const observations = [await fixtureAttempt(root, govEntry, { command: govCommand }), await fixtureAttempt(root, readinessEntry, { command: readinessCommand })];
    observations.push(releaseFails ? { producerId: nativeEntry.producerId, blockedBy: [input.releasePrerequisite.producerId] }
        : await fixtureAttempt(root, nativeEntry, { scenario: nativeFails ? 'product-failure' : 'success' }));
    return { plan, expectedPlanDigest: plan.contentDigest, observations, releaseAttemptRef: release.attemptRef,
        governance: { plan: governance.plan, expectedPlanDigest: governance.expectedPlanDigest, observations: governance.observations },
        evidenceRoot: root, sourceRoot, verifyAuthority: fixtureVerifyAuthority };
}

for (const [name, options, expected] of [
    ['complete success', {}, []],
    ['governance failure still collects readiness and native', { governanceFailures: ['backend-test-governance'] }, ['governance']],
    ['native failure retains independent readiness', { nativeFails: true }, ['product-performance']],
    ['benchmark readiness failure permits independent Release native consumer', { readinessFails: true }, ['build-readiness']],
    ['two independent failures', { nativeFails: true, readinessFails: true }, ['build-readiness', 'product-performance']],
    ['real Release test build failure blocks only native', { releaseFails: true }, ['blocked']]
])
{
    test(`perf projection: ${name}`, async () => withEvidence(async (root) =>
    {
        const input = await perfFixture(root, options);
        const result = projectBackendPerfOutcomes(input);
        assert.equal(result.exitCode, expected.length ? 1 : 0);
        assert.deepEqual(result.statusVector.filter((entry) => entry.failureDomain).map((entry) => entry.failureDomain).sort(), [...expected].sort());
    }));
}

test('governance success cannot overwrite first failure and input evidence is mandatory', async () => withEvidence(async (root) =>
{
    const input = await perfFixture(root, { governanceFailures: ['backend-test-governance'], consumerFails: false });
    assert.throws(() => projectBackendPerfOutcomes(input), /overwrite/u);
}));

test('governance receipt consumer requires exact attempt input bindings', async () => withEvidence(async (root) =>
{
    const input = await perfFixture(root, { missingInput: true });
    assert.throws(() => projectBackendPerfOutcomes(input), /consumed input artifact/u);
}));

test('native measurement cannot overlap readiness or governance CPU work', async () => withEvidence(async (root) =>
{
    const input = await perfFixture(root);
    const observation = input.observations.find((entry) => entry.producerId === 'backend-perf-native-p99');
    rewriteAttempt(root, observation, (receipt) =>
    {
        receipt.startedAt = '2000-01-01T00:00:00.000Z';
    });
    assert.throws(() => projectBackendPerfOutcomes(input), /overlaps/u);
}));

test('blocked native producer cannot also have executed an attempt', async () => withEvidence(async (root) =>
{
    const input = await perfFixture(root, { releaseFails: true });
    fs.mkdirSync(path.join(root, input.plan.identity.schedulerRunId, 'backend-perf-native-p99'));
    assert.throws(() => projectBackendPerfOutcomes(input), /spawn\/attempt=0/u);
}));

test('profile drift rejects governance receipt reuse before performance projection', async () => withEvidence(async (root) =>
{
    const input = await perfFixture(root);
    const changed = JSON.parse(JSON.stringify(input.governance.plan));
    changed.identity.profile = 'old-profile';
    input.governance.plan = sealContentDigest(changed);
    input.governance.expectedPlanDigest = input.governance.plan.contentDigest;
    assert.throws(() => projectBackendPerfOutcomes(input), /identity\/profile/u);
}));

test('performance summary cannot relabel build readiness as a product regression', async () => withEvidence(async (root) =>
{
    const input = await perfFixture(root, { readinessFails: true });
    const result = projectBackendPerfOutcomes(input);
    const changed = JSON.parse(JSON.stringify(result));
    changed.statusVector.find((entry) => entry.producerId === 'backend-perf-readiness').failureDomain = 'product-performance';
    const resealed = sealContentDigest(changed);
    assert.throws(() => verifyBackendAtomicSummary(resealed, resealed.contentDigest, input), /complete summary/u);
}));

test('resealing a correctness receipt cannot authorize a retry', async () => withEvidence(async (root) =>
{
    const input = await governanceFixture(root, ['backend-source-file-size']);
    rewriteAttempt(root, input.observations.find((entry) => entry.producerId === 'backend-source-file-size'), (receipt) =>
    {
        receipt.retryDecision = 'policy-authorized';
    });
    assert.throws(() => projectBackendGovernanceOutcomes(input), /zero-retry terminal decision/u);
}));

test('receipt-file tampering and aliased attempt evidence reject before projection', async () => withEvidence(async (root) =>
{
    const input = await governanceFixture(root);
    const observation = input.observations[0];
    const file = path.join(root, observation.attemptRef.path);
    const original = fs.readFileSync(file);
    fs.chmodSync(file, 0o600);
    fs.appendFileSync(file, ' ');
    assert.throws(() => projectBackendGovernanceOutcomes(input), /reference digest mismatch/u);
    fs.writeFileSync(file, original);
    const backup = path.join(root, 'original-receipt.json');
    fs.renameSync(file, backup);
    fs.symlinkSync(backup, file);
    assert.throws(() => projectBackendGovernanceOutcomes(input), /without aliases/u);
}));

test('native cannot overlap a settled sibling after the separate Release build completed', async () => withEvidence(async (root) =>
{
    const input = await perfFixture(root);
    const release = JSON.parse(fs.readFileSync(path.join(root, input.releaseAttemptRef.path)));
    rewriteAttempt(root, input.observations.find((entry) => entry.producerId === 'backend-perf-native-p99'), (receipt) =>
    {
        receipt.startedAt = release.finishedAt;
    });
    assert.throws(() => projectBackendPerfOutcomes(input), /native measurement overlaps/u);
}));

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { runHeldReleaseReliabilitySemanticOutcome } = await import(new URL(
    '../../tools/test-matrix/outcomes/release-reliability-held-input-bridge.mjs', import.meta.url
));
const { digestCanonical } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { sealDocument } = await import(new URL('../../tools/test/release-reliability-receipt.mjs', import.meta.url));
const catalog = JSON.parse(fs.readFileSync(new URL(
    '../../config/testing/release-reliability-scenario-catalog.json', import.meta.url
), 'utf8'));
const registry = JSON.parse(fs.readFileSync(new URL(
    '../../config/testing/release-reliability-lifecycle-action-registry.json', import.meta.url
), 'utf8'));
const terminalSourceCommit = 'e737d2812b5d380a70b6fe05f67b9868ead508f7';
const terminalPath = 'tools/test/release-reliability-terminal.mjs';
const terminalBytes = execFileSync('git', ['show', `${terminalSourceCommit}:${terminalPath}`], {
    cwd: path.resolve(import.meta.dirname, '../..')
});
const verifierPath = 'tools/test/verify-release-reliability-receipt.mjs';
const verifierBytes = execFileSync('git', ['show', `${terminalSourceCommit}:${verifierPath}`], {
    cwd: path.resolve(import.meta.dirname, '../..')
});
const terminalApi = await import(`data:text/javascript;base64,${terminalBytes.toString('base64')}`);
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const limits = { maxArtifactBytes: 1024 * 1024, maxArtifacts: 128 };

// Actual retained files/descriptors and the original exact upstream terminal API
// exercise source coupling. Controlled attestations/projections are DATA_ONLY
// fixtures, never evidence that the physical producers or owner verifier ran.
async function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-held-'));
    const files = [];
    const expected = { heldFileDigests: {}, heldFileIdentities: {}, receiptDigests: {},
        isolationDigests: {}, lifecycleByScenario: {}, resultDigests: {}, memberDigests: {} };
    const add = (relative, value) =>
    {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value)}\n`);
        const absolute = path.join(root, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, bytes);
        const fd = fs.openSync(absolute, 'r');
        const stat = fs.fstatSync(fd, { bigint: true });
        files.push({ path: relative, fd });
        expected.heldFileDigests[relative] = digest(bytes);
        expected.heldFileIdentities[relative] = { device: String(stat.dev), inode: String(stat.ino),
            size: String(stat.size), mode: String(stat.mode), modifiedNs: String(stat.mtimeNs), changedNs: String(stat.ctimeNs) };
        return digest(bytes);
    };
    const identity = { producerId: 'release-reliability-semantic-outcome', sourceCommit: 'a'.repeat(40),
        schedulerRunId: 'held-run', worktreeFingerprint: digestCanonical('tree'),
        buildIdentity: digestCanonical('build'), executionEnvelopeDigest: digestCanonical('envelope'),
        replayPlanDigest: digestCanonical('replay'), temporalContextDigest: digestCanonical('temporal'),
        toolchainDigest: digestCanonical('tools') };
    const binding = { identity, invocationId: 'held-invocation', attemptDigest: digestCanonical('attempt'),
        fixtureDigest: digestCanonical('fixture'), machineDigest: digestCanonical('machine'),
        policyDigest: digestCanonical('policy'), runtimeDigest: digestCanonical('runtime'),
        currentRunDigest: digestCanonical('current') };
    const runIdentity = sealDocument({ schema: 'fsusblog.release-reliability-run-identity.v1', status: 'complete',
        runId: identity.schedulerRunId, invocationId: binding.invocationId,
        sourceState: { commit: identity.sourceCommit, worktreeFingerprint: identity.worktreeFingerprint },
        build: { contentDigest: identity.buildIdentity } });
    const identityReference = { path: 'identity.json', contentDigest: runIdentity.contentDigest };
    add(identityReference.path, runIdentity);
    const results = [];
    const members = [];
    const memberPaths = [];
    for (const scenario of catalog.scenarios)
    {
        const scenarioId = scenario.id;
        const actions = registry.actions.filter(action => action.scenarioId === scenarioId).map(plan =>
        {
            const receiptPath = `${scenarioId}/${plan.actionId}.json`;
            const treePath = `${scenarioId}/${plan.actionId}-tree.json`;
            const receiptDigest = add(receiptPath, { scenarioId, actionId: plan.actionId, phase: plan.phase,
                stateDomains: plan.stateDomains, status: 'passed', observedState: 'controlled' });
            const treeDigest = add(treePath, { status: 'passed', postObservation: 'zero-members', logComplete: true });
            expected.receiptDigests[receiptPath] = receiptDigest;
            expected.receiptDigests[treePath] = treeDigest;
            expected.isolationDigests[plan.actionId] = digestCanonical(`${plan.actionId}:state`);
            return { actionId: plan.actionId, phase: plan.phase, status: 'passed',
                receipt: { path: receiptPath, bytesDigest: receiptDigest, actionId: plan.actionId,
                    phase: plan.phase, stateDomains: plan.stateDomains },
                processTreeReceipt: { path: treePath, bytesDigest: treeDigest,
                    postObservation: 'zero-members', logComplete: true },
                terminalFence: { status: 'closed', lateEvidenceAccepted: false } };
        });
        const producerDigest = add(scenario.authoritativeEvidence.path, { schema: 'controlled-measurement',
            scenarioId, binding, metrics: { budget: 3 }, state: { count: 0 } });
        expected.receiptDigests[scenario.authoritativeEvidence.path] = producerDigest;
        const result = sealDocument({ schema: 'fsusblog.release-reliability-scenario-result.v3',
            scenarioId, runId: identity.schedulerRunId, invocationId: binding.invocationId,
            identity: identityReference, status: 'passed', producerSpawned: true,
            qualificationEligible: true, evidenceClass: 'correctness', firstFailure: null, cleanupFailures: [],
            producer: { exitCode: 0, signal: null, timedOut: false },
            authoritativeEvidence: { path: scenario.authoritativeEvidence.path, digest: producerDigest },
            startedAt: '2026-10-08T00:00:00.000Z', finishedAt: '2026-10-08T00:00:01.000Z',
            lifecycle: { actions, resetPostObservation: { status: 'passed' }, finalPostObservation: { status: 'passed' } } });
        result.resultPath = `results/${scenarioId}.json`;
        const sealed = sealDocument(result);
        add(sealed.resultPath, sealed);
        results.push(sealed);
        expected.resultDigests[scenarioId] = sealed.contentDigest;
        expected.lifecycleByScenario[scenarioId] = actions.map(action => ({ actionId: action.actionId,
            phase: action.phase, status: action.status, stateDomains: action.receipt.stateDomains,
            isolationEvidenceDigest: expected.isolationDigests[action.actionId] }));
        const member = { scenarioId, binding, failures: [],
            isolationEvidenceDigests: Object.fromEntries(actions.map(action =>
                [action.actionId, expected.isolationDigests[action.actionId]])),
            semanticEvidence: { producerEvidenceDigest: producerDigest, metrics: { budget: 3 }, state: { count: 0 },
                assertions: [{ assertionId: `${scenarioId}:budget`, status: 'passed' }] } };
        const memberPath = `projections/${scenarioId}.json`;
        add(memberPath, member);
        memberPaths.push(memberPath);
        members.push(member);
        expected.memberDigests[scenarioId] = digestCanonical(member);
    }
    const events = terminalApi.createTerminalEvents(results);
    const references = results.map(result => ({ scenarioId: result.scenarioId,
        resultPath: result.resultPath, resultContentDigest: result.contentDigest }));
    const timeline = sealDocument({ schema: 'fsusblog.release-reliability-timeline.v3', status: 'complete',
        runId: identity.schedulerRunId, invocationId: binding.invocationId, identity: identityReference,
        terminalEvents: events, scenarioResults: references });
    add('timeline.json', timeline);
    const receipt = sealDocument({ schema: 'fsusblog.release-reliability-candidate-receipt.v1',
        status: 'candidate', failure: null, runId: identity.schedulerRunId, invocationId: binding.invocationId,
        identity: identityReference, timeline: { path: 'timeline.json', contentDigest: timeline.contentDigest },
        scenarios: references });
    const receiptDigest = add('candidate.json', receipt);
    const verifierDigest = add(verifierPath, verifierBytes);
    const verification = sealDocument({ schema: 'fsusblog.release-reliability-verified-attestation.v1',
        status: 'verified', runId: identity.schedulerRunId, invocationId: binding.invocationId,
        candidate: { path: 'candidate.json', contentDigest: receipt.contentDigest, fileDigest: receiptDigest },
        verifier: { path: verifierPath, fileDigest: verifierDigest },
        files: [...files].filter(file => !file.path.startsWith('projections/') && file.path !== 'candidate.json')
            .map(file => ({ path: file.path, fileDigest: expected.heldFileDigests[file.path] })) });
    add('verification.json', verification);
    add(terminalPath, terminalBytes);
    const inputAuthorityRefs = [{ kind: 'reliability-terminal-verification', path: 'verification.json',
        digest: verification.contentDigest }, { kind: 'reliability-terminal-module', path: terminalPath,
        digest: digest(terminalBytes) }];
    Object.assign(expected, structuredClone({ identity, binding, inputAuthorityRefs,
        verificationReceiptDigest: verification.contentDigest, runIdentityReference: identityReference,
        timelineDigest: timeline.contentDigest, terminalEvents: events }));
    const options = { identity, inputAuthorityRefs, expected,
        attemptEligibility: { aggregateDigest: digestCanonical('aggregate'), attemptDigest: binding.attemptDigest,
            attemptNumber: 1, cleanFirstAttempt: true, firstFailure: false, qualificationEligible: true },
        heldInputs: { files, verificationReceiptPath: 'verification.json', memberPaths } };
    const ownedDescriptors = files.map(file => file.fd);
    const cleanup = () =>
    {
        for (const fd of ownedDescriptors)
        {
            fs.closeSync(fd);
        }
        fs.rmSync(root, { recursive: true, force: true });
    };
    const admitControlledReplacement = (relative, value) =>
    {
        const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
        fs.writeFileSync(path.join(root, relative), bytes);
        const file = files.find(entry => entry.path === relative);
        const stat = fs.fstatSync(file.fd, { bigint: true });
        expected.heldFileDigests[relative] = digest(bytes);
        expected.heldFileIdentities[relative] = { device: String(stat.dev), inode: String(stat.ino),
            size: String(stat.size), mode: String(stat.mode), modifiedNs: String(stat.mtimeNs), changedNs: String(stat.ctimeNs) };
    };
    return { options, root, cleanup, admitControlledReplacement };
}

test('retained descriptors couple exact upstream terminal verification to the original adapter', async t =>
{
    const input = await fixture();
    t.after(input.cleanup);
    const fd = input.options.heldInputs.files[0].fd;
    fs.readSync(fd, Buffer.alloc(1), 0, 1, null);
    const result = await runHeldReleaseReliabilitySemanticOutcome(input.options, limits);
    assert.equal(result.outcome.status, 'success');
    assert.equal(result.outcome.membership.memberOutcomes.length, 7);
    assert.ok(result.outcome.membership.memberOutcomes.every(member => member.terminalClassification === 'qualified-success'));
    assert.equal(fs.fstatSync(input.options.heldInputs.files[0].fd).isFile(), true);
    const next = Buffer.alloc(1);
    fs.readSync(fd, next, 0, 1, null);
    assert.equal(next.toString(), '"');
});

test('path replacement cannot switch a retained artifact or reopen a pathname', async t =>
{
    const input = await fixture();
    t.after(input.cleanup);
    const absolute = path.join(input.root, 'timeline.json');
    fs.renameSync(absolute, `${absolute}.held`);
    fs.writeFileSync(absolute, '{"status":"forged"}');
    await assert.rejects(runHeldReleaseReliabilitySemanticOutcome(input.options, limits), /identity/u);
});

test('changed held contents truncated files and foreign descriptor identities fail closed', async t =>
{
    const contents = await fixture();
    t.after(contents.cleanup);
    fs.writeFileSync(path.join(contents.root, 'timeline.json'), '{}');
    await assert.rejects(runHeldReleaseReliabilitySemanticOutcome(contents.options, limits), /identity/u);
    const foreign = await fixture();
    t.after(foreign.cleanup);
    foreign.options.heldInputs.files[0].fd = foreign.options.heldInputs.files[1].fd;
    await assert.rejects(runHeldReleaseReliabilitySemanticOutcome(foreign.options, limits), /identity/u);
});

test('missing held authority or canonical module and orphan duplicate files fail closed', async t =>
{
    for (const mutation of ['missing', 'module', 'duplicate', 'orphan'])
    {
        const input = await fixture();
        t.after(input.cleanup);
        if (mutation === 'missing')
        {
            input.options.heldInputs.verificationReceiptPath = 'absent.json';
        }
        if (mutation === 'module')
        {
            input.options.inputAuthorityRefs.pop();
        }
        if (mutation === 'duplicate')
        {
            input.options.heldInputs.files.push(input.options.heldInputs.files[0]);
        }
        if (mutation === 'orphan')
        {
            input.options.expected.heldFileDigests['orphan.json'] = digestCanonical('orphan');
        }
        await assert.rejects(runHeldReleaseReliabilitySemanticOutcome(input.options, limits));
    }
});

test('held semantic projection cannot cross source runtime attempt or original producer bytes', async t =>
{
    const input = await fixture();
    t.after(input.cleanup);
    input.options.expected.binding.runtimeDigest = digestCanonical('foreign');
    await assert.rejects(runHeldReleaseReliabilitySemanticOutcome(input.options, limits), /binding/u);
    const attempt = await fixture();
    t.after(attempt.cleanup);
    attempt.options.attemptEligibility.attemptDigest = digestCanonical('foreign');
    await assert.rejects(runHeldReleaseReliabilitySemanticOutcome(attempt.options, limits), /attempt/u);
    const source = await fixture();
    t.after(source.cleanup);
    source.options.identity.sourceCommit = 'b'.repeat(40);
    await assert.rejects(runHeldReleaseReliabilitySemanticOutcome(source.options, limits), /run source/u);
    const producer = await fixture();
    t.after(producer.cleanup);
    fs.writeFileSync(path.join(producer.root, catalog.scenarios[0].authoritativeEvidence.path), '{"forged":true}');
    await assert.rejects(runHeldReleaseReliabilitySemanticOutcome(producer.options, limits), /identity/u);
});

test('host count and byte budgets are explicit and cannot be omitted or silently defaulted', async t =>
{
    const input = await fixture();
    t.after(input.cleanup);
    await assert.rejects(runHeldReleaseReliabilitySemanticOutcome(input.options, undefined), /host limits/u);
    await assert.rejects(runHeldReleaseReliabilitySemanticOutcome(input.options,
        { maxArtifacts: 1, maxArtifactBytes: 1 }), /budget/u);
    await assert.rejects(runHeldReleaseReliabilitySemanticOutcome(input.options,
        { maxArtifacts: 128, maxArtifactBytes: 10 }), /budget/u);
});

test('completion fence rejects retained-file mutation after terminal module loading begins', async t =>
{
    const input = await fixture();
    t.after(input.cleanup);
    const pending = runHeldReleaseReliabilitySemanticOutcome(input.options, limits);
    fs.writeFileSync(path.join(input.root, 'timeline.json'), '{}');
    await assert.rejects(pending, /identity/u);
});

test('unqualified terminal input cannot impersonate the existing qualified attestation API', async t =>
{
    const input = await fixture();
    t.after(input.cleanup);
    const verification = JSON.parse(fs.readFileSync(path.join(input.root, 'verification.json'), 'utf8'));
    const unqualified = sealDocument({ ...verification, status: 'unqualified' });
    input.admitControlledReplacement('verification.json', unqualified);
    input.options.expected.verificationReceiptDigest = unqualified.contentDigest;
    await assert.rejects(runHeldReleaseReliabilitySemanticOutcome(input.options, limits), /unqualified held-snapshot/u);
});

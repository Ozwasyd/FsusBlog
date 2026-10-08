import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { digestCanonical, sealContentDigest, verifyFileDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { prepareFrontendVitestOutcomeRun, captureFrontendVitestNativeMaterial,
    harvestFrontendVitestNativeMaterial, runFrontendVitestOutcomeAttempts,
    bindFrontendVitestHeldOutcome } = await import(new URL('../../tools/test/frontend-vitest-outcome-bridge.mjs', import.meta.url));

const repository = path.resolve(import.meta.dirname, '../..');
const d = (value) => `sha256:${value.repeat(64)}`;
const limits = { maxDepth: 64, maxNodes: 100000, maxStringBytes: 1000000 };

// Real native processes execute task-owned Git sources. External authorities below
// are controlled test data, never evidence of production runtime qualification.
function fixture(source)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-vitest-held-'));
    fs.mkdirSync(path.join(root, 'src/frontend'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests/native'), { recursive: true });
    fs.symlinkSync(path.join(repository, 'src/frontend/node_modules'), path.join(root, 'src/frontend/node_modules'), 'dir');
    fs.writeFileSync(path.join(root, 'src/frontend/vitest.config.mjs'), `export default { test: { include: ['../../tests/native/*.test.ts'], environment: 'node', pool: 'forks', maxWorkers: 1, fileParallelism: false, retry: 0, coverage: { enabled: false } } };\n`);
    fs.writeFileSync(path.join(root, 'tests/native/source.test.ts'), `import { it, expect } from 'vitest';\n${source}\n`);
    const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git(['init', '--quiet']);
    git(['add', 'src/frontend/vitest.config.mjs', 'tests/native/source.test.ts']);
    git(['-c', 'user.name=Outcome fixture', '-c', 'user.email=outcome-fixture@example.invalid', 'commit', '--quiet', '-m', 'controlled native source']);
    const identity = { sourceCommit: git(['rev-parse', 'HEAD']), producerId: 'frontend-vitest', schedulerRunId: 'controlled-native-2651',
        worktreeFingerprint: d('1'), executionEnvelopeDigest: d('2'), replayPlanDigest: d('3'), temporalContextDigest: d('4'),
        buildIdentity: d('5'), toolchainDigest: d('6') };
    return { root, identity, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function prepare(f)
{
    return prepareFrontendVitestOutcomeRun({ root: f.root, configFile: 'src/frontend/vitest.config.mjs',
        files: ['tests/native/source.test.ts'], outputRoot: path.join(f.root, 'held'), identity: f.identity,
        policyDigests: { 'policy:outcome': d('7') }, rootSeed: `seed256:${'ab'.repeat(32)}` });
}

function attemptInput(f, prepared, extra = {})
{
    const references = ['execution-envelope', 'replay-plan', 'temporal-context'].map((kind, index) => ({ kind,
        artifactPath: `controlled/${kind}.json`, artifactDigest: [d('2'), prepared.replayPlan.planDigest, d('4')][index],
        verificationReceiptPath: `controlled/${kind}.verified.json`, verificationReceiptDigest: d('8') }));
    const verifyAuthority = (reference) => ({ verified: true, authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest, identity: { sourceCommit: f.identity.sourceCommit,
            worktreeFingerprint: f.identity.worktreeFingerprint, schedulerRunId: f.identity.schedulerRunId, producerId: 'frontend-vitest' } });
    return { ...f.identity, evidenceRoot: path.join(f.root, 'attempts'), env: { PATH: process.env.PATH },
        retryPolicyId: 'correctness-first-attempt', authorityReferences: references, verifyAuthority, ...extra };
}

function heldInputs(f, prepared, run, material)
{
    const artifactRoot = path.join(run.producerRoot, 'attempt-1');
    return { prepared, material, aggregate: run.aggregate, artifactRoot,
        loadAttempt: (reference) => JSON.parse(fs.readFileSync(path.join(run.producerRoot, reference.path), 'utf8')),
        verifyAuthority: attemptInput(f, prepared).verifyAuthority,
        verifyArtifact: (relative, digest) => verifyFileDigest(artifactRoot, relative, digest),
        expectedPreparedDigest: prepared.contentDigest, expectedMaterialDigest: material.contentDigest, hostExpectedLimits: limits };
}

test('original native collect/run and original attempt owner bind an exact passing candidate', async (t) =>
{
    const f = fixture(`it('same title', () => { expect(1).toBe(1); expect('a').toBe('a'); });\nit('same title', () => { expect(2).toBe(2); });`);
    t.after(f.dispose);
    const prepared = await prepare(f);
    assert.equal(prepared.qualificationEligible, false);
    assert.equal(prepared.manifest.suites.flatMap((suite) => suite.tests).length, 2);
    const run = await runFrontendVitestOutcomeAttempts(prepared, attemptInput(f, prepared));
    assert.equal(run.aggregate.cleanFirstAttempt, true);
    const material = JSON.parse(fs.readFileSync(path.join(run.producerRoot, 'attempt-1/native-material.json'), 'utf8'));
    assert.equal(material.qualificationEligible, false);
    assert.deepEqual(material.tests.map((item) => item.assertionCalls), [2, 1]);
    const inputs = heldInputs(f, prepared, run, material);
    const candidate = bindFrontendVitestHeldOutcome(inputs);
    assert.equal(candidate.verificationStatus, 'verified');
    assert.deepEqual(candidate.outcome.membership.executedTestIds, prepared.replayPlan.testEnumerationOrder);
    assert.throws(() => bindFrontendVitestHeldOutcome({ ...inputs, verifyArtifact: undefined }), /artifact verifier/);
    assert.throws(() => bindFrontendVitestHeldOutcome({ ...inputs, expectedPreparedDigest: d('f') }), /independent prepared/);
    const tampered = sealContentDigest({ ...material, tests: material.tests.map((item) => ({ ...item, executed: false })) });
    assert.throws(() => bindFrontendVitestHeldOutcome({ ...inputs, material: tampered, expectedMaterialDigest: tampered.contentDigest }), /actual held material/);
    fs.chmodSync(path.join(inputs.artifactRoot, 'native-report.json'), 0o600);
    fs.appendFileSync(path.join(inputs.artifactRoot, 'native-report.json'), ' ');
    assert.throws(() => bindFrontendVitestHeldOutcome(inputs), /artifact.*changed|artifact bytes/);
});

test('real skip and assertion failure retain distinct terminal and assertion evidence without qualification', async (t) =>
{
    // Vitest intentionally marks the host process failed for this expected
    // negative run. Restore only the harness's previous exit status.
    const hostExitCode = process.exitCode;
    t.after(() =>
    {
        process.exitCode = hostExitCode;
    });
    const f = fixture(`it.skip('skipped', () => { expect(1).toBe(1); });\nit('failure', () => { expect(2).toBe(2); expect(3).toBe(4); expect(5).toBe(5); });`);
    t.after(f.dispose);
    const prepared = await prepare(f);
    const material = await captureFrontendVitestNativeMaterial(prepared, path.join(f.root, 'run'));
    assert.equal(material.completion, 'complete');
    assert.deepEqual(material.tests.map((item) => item.status), ['skipped', 'failed']);
    assert.deepEqual(material.tests.map((item) => item.executed), [false, true]);
    assert.equal(material.tests[1].assertionCalls, 2);
    assert.equal(material.tests[1].assertionIds.length, 3);
    assert.equal(material.tests[1].native.result.errors.length, 1);
    assert.match(material.tests[1].bindingIssues[0], /blocked-tail-contract/);
    assert.equal(material.qualificationEligible, false);
});

test('literal parameter rows have semantic identities independent of displayed registration title', async (t) =>
{
    const f = fixture(`it.each([[2, 4], [3, 6]])('case %i', (value, expected) => { expect(value * 2).toBe(expected); });`);
    t.after(f.dispose);
    const prepared = await prepare(f);
    const tests = prepared.manifest.suites.flatMap((suite) => suite.tests);
    assert.equal(tests.length, 2);
    assert.equal(tests[0].declarationId, tests[1].declarationId);
    assert.notEqual(tests[0].caseId, tests[1].caseId);
    const material = await captureFrontendVitestNativeMaterial(prepared, path.join(f.root, 'run'));
    assert.deepEqual(material.tests.map((item) => item.status), ['passed', 'passed']);
});

test('semantic declaration identities survive line, title and declaration-order changes', async (t) =>
{
    const first = fixture(`it('display one', () => { expect(1).toBe(1); });\nit('display two', () => { expect(2).toBe(2); });`);
    const second = fixture(`// locator lines moved\n\nit('renamed two', () => { expect(2).toBe(2); });\nit('renamed one', () => { expect(1).toBe(1); });`);
    t.after(first.dispose);
    t.after(second.dispose);
    const left = await prepare(first);
    const right = await prepare(second);
    assert.deepEqual(left.replayPlan.testEnumerationOrder, right.replayPlan.testEnumerationOrder);
    assert.notDeepEqual(left.blueprint.bindings.map((item) => item.location), right.blueprint.bindings.map((item) => item.location));
});

test('source drift and conditional assertion proof fail before native qualification', async (t) =>
{
    const f = fixture(`it('condition', () => { if (true) { expect(1).toBe(1); } });`);
    t.after(f.dispose);
    await assert.rejects(prepare(f), /conditional\/nested assertion/);
    fs.rmSync(path.join(f.root, 'held'), { recursive: true });
    fs.appendFileSync(path.join(f.root, 'tests/native/source.test.ts'), '\n// dirty source\n');
    await assert.rejects(prepare(f), /differs from Git HEAD/);
});

test('real process timeout preserves completed, started-blocked and never-started topology', async (t) =>
{
    const f = fixture(`it('completed', () => { expect(1).toBe(1); });\nit('started', async () => { expect(2).toBe(2); await new Promise(() => {}); });\nit('never started', () => { expect(3).toBe(3); });`);
    t.after(f.dispose);
    const prepared = await prepare(f);
    const run = await runFrontendVitestOutcomeAttempts(prepared, attemptInput(f, prepared, { timeoutMs: 4000 }));
    assert.equal(run.aggregate.qualificationEligible, false);
    const attempt = run.attempts[0];
    const material = harvestFrontendVitestNativeMaterial(prepared, path.join(run.producerRoot, 'attempt-1'),
        { signal: attempt.signal, failureKind: attempt.failureKind, exitCode: attempt.exitCode });
    assert.equal(material.completion, 'aborted');
    assert.deepEqual(material.tests.map((item) => item.status), ['passed', 'blocked', 'blocked']);
    assert.deepEqual(material.tests.map((item) => item.executed), [true, true, false]);
    assert.equal(material.qualificationEligible, false);
    // Original attempt fallback planned IDs cannot be promoted as observed execution.
    assert.notDeepEqual(attempt.executedTestIds, material.tests.filter((item) => item.executed).map((item) => item.testId).sort());
});

test('real event journal refuses tamper, duplicates and cross-source before consuming material', async (t) =>
{
    const f = fixture(`it('actual', () => { expect(1).toBe(1); });`);
    t.after(f.dispose);
    const prepared = await prepare(f);
    const outputRoot = path.join(f.root, 'run');
    await captureFrontendVitestNativeMaterial(prepared, outputRoot);
    const journal = path.join(outputRoot, 'native-events.jsonl');
    const original = fs.readFileSync(journal, 'utf8');
    const events = original.trimEnd().split('\n').map(JSON.parse);
    events[1].value.source = '/wrong/source.test.ts';
    fs.writeFileSync(journal, `${events.map(JSON.stringify).join('\n')}\n`);
    assert.throws(() => harvestFrontendVitestNativeMaterial(prepared, outputRoot), /journal tamper/);
    let previousDigest = null;
    const resealed = events.map((entry, sequence) =>
    {
        const updated = sealContentDigest({ ...entry, sequence, previousDigest });
        previousDigest = updated.contentDigest;
        return updated;
    });
    fs.writeFileSync(journal, `${resealed.map(JSON.stringify).join('\n')}\n`);
    assert.throws(() => harvestFrontendVitestNativeMaterial(prepared, outputRoot), /native event locator/);
    fs.writeFileSync(journal, `${original}${original.split('\n')[1]}\n`);
    assert.throws(() => harvestFrontendVitestNativeMaterial(prepared, outputRoot), /journal tamper/);
    assert.equal(digestCanonical(prepared.blueprint.suites), digestCanonical(prepared.manifest.suites));
});

test('real timeout before journal creation retains sealed planned blocked cases without inventing execution', async (t) =>
{
    const f = fixture(`it('planned', () => { expect(1).toBe(1); });`);
    t.after(f.dispose);
    const prepared = await prepare(f);
    const run = await runFrontendVitestOutcomeAttempts(prepared, attemptInput(f, prepared, { timeoutMs: 1 }));
    const attempt = run.attempts[0];
    const artifactRoot = path.join(run.producerRoot, 'attempt-1');
    assert.equal(fs.existsSync(path.join(artifactRoot, 'native-events.jsonl')), false);
    assert.throws(() => harvestFrontendVitestNativeMaterial(prepared, artifactRoot), /actual process outcome/);
    const material = harvestFrontendVitestNativeMaterial(prepared, artifactRoot,
        { signal: attempt.signal, failureKind: attempt.failureKind, exitCode: attempt.exitCode });
    assert.equal(material.qualificationEligible, false);
    assert.equal(material.report, null);
    assert.deepEqual(material.tests.map((item) => [item.status, item.executed]), [['blocked', false]]);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { assertBackendAtomicPlanParity, createBackendAtomicPlan, validateBackendAtomicPlan, verifyBackendAtomicSourceRefs } = await import(new URL('../../tools/test/backend-atomic-producers.mjs', import.meta.url));

import { fixtureInput } from './support/backend-atomic-fixture.mjs';

const root = path.resolve(import.meta.dirname, '../..');

test('governance requires the exact three original command owners and a command-free complete join', () =>
{
    const plan = createBackendAtomicPlan(fixtureInput());
    assert.equal(plan.authority, 'DATA_ONLY');
    assert.equal(verifyBackendAtomicSourceRefs(plan, plan.contentDigest, root), true);
    assert.equal(plan.declarations.filter((entry) => entry.kind === 'atomic-producer').length, 3);
    for (const entry of plan.declarations)
    {
        assert.deepEqual(entry.dependsOn, []);
    }
});

test('declaration ordering does not change local/CI plan identity', () =>
{
    const input = fixtureInput();
    const local = createBackendAtomicPlan(input);
    input.declarations.reverse();
    const ci = createBackendAtomicPlan(input);
    assertBackendAtomicPlanParity(local, ci, local.contentDigest);
});

for (const [name, mutate, pattern] of [
    ['duplicate checker', (input) => input.declarations.push(input.declarations[0]), /exact producer roster/u],
    ['hidden summary command', (input) =>
    {
        input.declarations[3].command = ['node', 'checker'];
    }, /exactly/u],
    ['only first-result summary', (input) =>
    {
        input.declarations[3].settledDependsOn.pop();
    }, /complete settled/u],
    ['sequential correctness edge', (input) =>
    {
        input.declarations[1].dependsOn = ['backend-source-file-size'];
    }, /hard dependencies/u],
    ['retry policy change', (input) =>
    {
        input.declarations[1].attemptPolicyId = 'diagnostic';
    }, /attemptPolicyId/u],
    ['second checker owner', (input) =>
    {
        input.declarations[1].commandSourceRef.symbol = 'RunBackendGovernanceChecks';
    }, /command symbol/u],
    ['undeclared field', (input) =>
    {
        input.declarations[0].approved = true;
    }, /exactly/u],
    ['missing resource authority', (input) =>
    {
        input.declarations[0].resourceContractRef = null;
    }, /resourceContractRef/u]
])
{
    test(`reject ${name}`, () =>
    {
        const input = fixtureInput();
        mutate(input);
        assert.throws(() => createBackendAtomicPlan(input), pattern);
    });
}

for (const readinessMode of ['build', 'verify-fresh'])
{
    test(`perf ${readinessMode} binds original readiness authority and separate Release assembly prerequisite`, () =>
    {
        const plan = createBackendAtomicPlan(fixtureInput('backend-perf', readinessMode));
        const native = plan.declarations.find((entry) => entry.producerId === 'backend-perf-native-p99');
        assert.deepEqual(native.dependsOn, ['backend-release-test-build']);
        assert.deepEqual(native.settledDependsOn, ['backend-perf-governance', 'backend-perf-readiness']);
    });
}

for (const readinessMode of [null, '', 'other'])
{
    test(`reject missing/unknown readiness mode ${JSON.stringify(readinessMode)}`, () =>
    {
        assert.throws(() => createBackendAtomicPlan(fixtureInput('backend-perf', readinessMode)), /readinessMode/u);
    });
}

test('readiness cannot be a hard prerequisite for the unrelated native assembly', () =>
{
    const input = fixtureInput('backend-perf', 'build');
    input.declarations[1].dependsOn = ['backend-perf-readiness'];
    input.declarations[1].settledDependsOn = ['backend-perf-governance'];
    assert.throws(() => createBackendAtomicPlan(input), /hard dependencies/u);
});

test('performance governance can only consume the governance summary', () =>
{
    const input = fixtureInput('backend-perf', 'build');
    input.declarations[0].commandSourceRef = { ...input.declarations[0].commandSourceRef, path: 'tools/test/lanes/_suite-support.sh', symbol: 'RunBackendPerfGovernanceOnly' };
    assert.throws(() => createBackendAtomicPlan(input), /existing command owner/u);
});

test('profile/source/mode and resealed local/CI drift cannot reuse an old selected plan', () =>
{
    const plan = createBackendAtomicPlan(fixtureInput('backend-perf', 'build'));
    for (const field of ['profile', 'sourceCommit', 'worktreeFingerprint', 'schedulerRunId'])
    {
        const input = fixtureInput('backend-perf', 'build');
        input.identity[field] = field === 'sourceCommit' ? '3'.repeat(40)
            : field === 'worktreeFingerprint' ? `sha256:${'4'.repeat(64)}` : 'other';
        assert.throws(() => assertBackendAtomicPlanParity(plan, createBackendAtomicPlan(input), plan.contentDigest), /selected plan digest/u);
    }
    const otherMode = createBackendAtomicPlan(fixtureInput('backend-perf', 'verify-fresh'));
    assert.throws(() => assertBackendAtomicPlanParity(plan, otherMode, plan.contentDigest), /selected plan digest/u);
    assert.throws(() => validateBackendAtomicPlan(sealContentDigest({ ...plan, authority: 'QUALIFIED' }), plan.contentDigest), /authority/u);
});

test('changed bytes, leaf aliases and parent aliases reject source ref verification', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-atomic-source-'));
    try
    {
        const plan = createBackendAtomicPlan(fixtureInput());
        for (const relative of ['tests/matrix.yml', 'tools/test/lanes/_suite-support.sh'])
        {
            const file = path.join(directory, relative);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.copyFileSync(path.join(root, relative), file);
        }
        assert.equal(verifyBackendAtomicSourceRefs(plan, plan.contentDigest, directory), true);
        fs.appendFileSync(path.join(directory, 'tests/matrix.yml'), '\n# drift\n');
        assert.throws(() => verifyBackendAtomicSourceRefs(plan, plan.contentDigest, directory), /drift/u);
        fs.rmSync(path.join(directory, 'tests/matrix.yml'));
        fs.symlinkSync(path.join(root, 'tests/matrix.yml'), path.join(directory, 'tests/matrix.yml'));
        assert.throws(() => verifyBackendAtomicSourceRefs(plan, plan.contentDigest, directory), /drift/u);
        fs.rmSync(path.join(directory, 'tests'), { recursive: true });
        fs.symlinkSync(path.join(root, 'tests'), path.join(directory, 'tests'));
        assert.throws(() => verifyBackendAtomicSourceRefs(plan, plan.contentDigest, directory), /drift/u);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('performance plan cannot select a Debug build identity', () =>
{
    const input = fixtureInput('backend-perf', 'build');
    input.buildConfiguration = 'Debug';
    assert.throws(() => createBackendAtomicPlan(input), /buildConfiguration/u);
});

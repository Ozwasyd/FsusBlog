import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { prepareFrontendVitestOutcomeRun, captureFrontendVitestNativeMaterial }
    = await import(new URL('../../tools/test/frontend-vitest-outcome-bridge.mjs', import.meta.url));
const repository = path.resolve(import.meta.dirname, '../..');
const digest = (value) => `sha256:${value.repeat(64)}`;

// These ordinary native reporter cases collect unqualified observations only.
// They use no attempt receipts, external verification callbacks or adapter admission.
test('native callbacks retain a failed assertion tail, dynamic skip and first retried execution', async (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-vitest-reporter-cases-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'src/frontend'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests/native'), { recursive: true });
    fs.symlinkSync(path.join(repository, 'src/frontend/node_modules'), path.join(root, 'src/frontend/node_modules'), 'dir');
    fs.writeFileSync(path.join(root, 'src/frontend/vitest.config.mjs'), `export default { test: {
        include: ['../../tests/native/*.test.ts'], environment: 'node', pool: 'forks',
        maxWorkers: 1, fileParallelism: false, retry: 0, coverage: { enabled: false }
    } };\n`);
    fs.writeFileSync(path.join(root, 'tests/native/source.test.ts'), `import { it, expect } from 'vitest';
let executionNumber = 0;
it('ordinary failed tail', () => {
    expect(1).toBe(1);
    expect(2).toBe(3);
    expect(4).toBe(4);
});
it('ordinary dynamic skip', (context) => {
    expect(5).toBe(5);
    context.skip('ordinary skip after one assertion');
    expect(6).toBe(6);
});
it('ordinary retry', { retry: 1 }, () => {
    expect(++executionNumber).toBe(2);
});\n`);
    const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git(['init', '--quiet']);
    git(['add', 'src/frontend/vitest.config.mjs', 'tests/native/source.test.ts']);
    git(['-c', 'user.name=Reporter cases', '-c', 'user.email=reporter-cases@example.invalid',
        'commit', '--quiet', '-m', 'ordinary native reporter cases']);
    const identity = { sourceCommit: git(['rev-parse', 'HEAD']), producerId: 'frontend-vitest', schedulerRunId: 'ordinary-native-reporter',
        worktreeFingerprint: digest('1'), executionEnvelopeDigest: digest('2'), replayPlanDigest: digest('3'), temporalContextDigest: digest('4'),
        buildIdentity: digest('5'), toolchainDigest: digest('6') };
    const prepared = await prepareFrontendVitestOutcomeRun({ root, configFile: 'src/frontend/vitest.config.mjs',
        files: ['tests/native/source.test.ts'], outputRoot: path.join(root, 'held'), identity,
        policyDigests: { 'policy:outcome': digest('7') }, rootSeed: `seed256:${'ab'.repeat(32)}` });
    // Vitest sets a failed exit for the ordinary failing native case. Restore the
    // harness status after retaining that native result, before harness assertions.
    const hostExitCode = process.exitCode;
    let material;
    try
    {
        material = await captureFrontendVitestNativeMaterial(prepared, path.join(root, 'run'));
    }
    finally
    {
        process.exitCode = hostExitCode;
    }
    assert.equal(material.qualificationEligible, false);
    assert.equal(prepared.qualificationEligible, false);
    assert.deepEqual(material.tests.map((item) => item.status), ['failed', 'skipped', 'passed']);
    const [failed, skipped, retried] = material.tests;
    assert.equal(failed.assertionCalls, 2);
    assert.deepEqual(failed.firstExecution.assertions.map((item) => item.status), ['passed', 'failed', 'blocked']);
    assert.equal(failed.firstExecution.failureLocations.length, 1);
    assert.equal(failed.firstExecution.failureLocations[0].assertionId, failed.assertionIds[1]);
    assert.equal(failed.firstExecution.callback.result.errors.length, 1);
    assert.equal(failed.native.nativeCounters.retryCount, 0);
    assert.equal(failed.native.nativeCounters.repeatCount, 0);
    assert.equal(skipped.executed, true);
    assert.equal(skipped.assertionCalls, 1);
    assert.deepEqual(skipped.firstExecution.assertions.map((item) => item.status), ['passed', 'skipped']);
    assert.equal(skipped.firstExecution.callback.result.pending, true);
    assert.equal(skipped.firstExecution.terminal.result.state, 'skip');
    assert.equal(skipped.firstExecution.callback.nativeCounters.retryCount, 0);
    assert.equal(skipped.firstExecution.callback.nativeCounters.repeatCount, 0);
    assert.equal(retried.executions.length, 2);
    assert.equal(retried.firstExecution.callback.result.state, 'fail');
    assert.equal(retried.firstExecution.callback.result.errors.length, 1);
    assert.deepEqual(retried.executions.map((item) => item.assertions.map((assertion) => assertion.status)), [['failed'], ['passed']]);
    assert.deepEqual(retried.executions.map((item) => item.errorCountBeforeTry), [0, 1]);
    assert.equal(retried.executions[1].callback.result.errors.length, 1);
    assert.deepEqual(retried.executions.map((item) => item.callback.assertionCalls), [1, 1]);
    assert.deepEqual(retried.executions.map((item) => item.retry), [0, 1]);
    assert.equal(retried.native.nativeCounters.retryCount, 1);
    assert.equal(retried.native.nativeCounters.repeatCount, 0);
    assert.equal(retried.native.observation.tries, 2);
    assert.match(retried.bindingIssues.join(' '), /original-execution-failure-retained/);
});

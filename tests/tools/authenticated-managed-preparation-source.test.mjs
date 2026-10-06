import assert from 'node:assert/strict';
import test from 'node:test';
import { observeExecutableIdentity, observeExecutableIdentityAsync } from '../../tools/test/execution-envelope-environment.mjs';

// COMPONENT_SIMULATION: these complete output fixtures exercise the original consumer only.
// No boundary, grant, native execution or qualification is issued by an injected test callback.
function completeOutput(stdout)
{
    return { schema: 'fsusblog.physical-execution-process-tree.v1', platform: 'linux',
        authority: { kind: 'linux-cgroup-process-group', established: true },
        postObservation: 'zero-members', logComplete: true, logTruncationReason: null, forcedPipeClose: false,
        lifecycle: ['post-observe-zero-members', 'bounded-pipe-close', 'seal-completed-receipt'], termination: [],
        processInventory: [{ role: 'direct-child', pid: 17, startIdentity: 'simulated', exitCode: 0, signal: null }],
        policy: { maximumCapturedOutputBytesPerStream: 1024 }, stdout, stderr: '',
        outputCapture: { maximumBytesPerStream: 1024, stdoutTruncated: false, stderrTruncated: false,
            stdoutBytes: Buffer.byteLength(stdout), stdoutCapturedBytes: Buffer.byteLength(stdout),
            stderrBytes: 0, stderrCapturedBytes: 0 } };
}
const inputs = { pathValue: '/component-fixture', cwd: '/component-fixture', environment: { PATH: '/component-fixture' },
    resolve: () => '/component-fixture/compiler', realpath: (file) => file, readFile: () => Buffer.from('simulated executable bytes') };

test('default synchronous version identity refuses before native or file observation', () =>
{
    let reads = 0;
    assert.throws(() => observeExecutableIdentity('compiler', { ...inputs, readFile: () => { reads++; } }),
        /held-managed owner/u);
    assert.equal(reads, 0);
});

test('restored async executable identity uses the exact held consumer tuple and observation phases', async () =>
{
    const calls = [];
    const output = completeOutput('compiler version 1\n');
    const identity = await observeExecutableIdentityAsync('compiler', { ...inputs,
        assertPreparationExecution({ request, phase, physicalExecution })
        {
            calls.push(phase);
            assert.equal(request.purpose, 'executable-version');
            assert.deepEqual(request.command, ['/component-fixture/compiler', '--version']);
            assert.equal(request.cwd, inputs.cwd);
            assert.ok(Object.isFrozen(request) && Object.isFrozen(request.command) && Object.isFrozen(request.environment));
            assert.equal(physicalExecution, phase === 'before' ? null : output);
        }, executePreparation(request)
        {
            calls.push('execute');
            assert.equal(request.environment.PATH, '/component-fixture');
            return output;
        } });
    assert.deepEqual(calls, ['before', 'execute', 'after']);
    assert.equal(identity.version, 'compiler version 1');
    assert.match(identity.sha256, /^sha256:[a-f0-9]{64}$/u);
});

for (const reason of [Object.freeze(new Error('frozen original')), 0, false, '', null, undefined])
{
    test(`restored async observation preserves exact ${String(reason)} ahead of owner postflight refusal`, async () =>
    {
        let caught = false;
        try
        {
            await observeExecutableIdentityAsync('compiler', { ...inputs,
                assertPreparationExecution({ phase }) { if (phase === 'after') throw new Error('secondary owner refusal'); },
                executePreparation() { throw reason; } });
        }
        catch (error) { caught = true; assert.equal(error, reason); }
        assert.ok(caught);
    });
}

test('restored async version arguments reject a foreign special selector before any owner call', async () =>
{
    let calls = 0;
    await assert.rejects(observeExecutableIdentityAsync('compiler', { ...inputs, versionArgs: ['-Version'],
        assertPreparationExecution() { calls++; }, executePreparation() { calls++; } }), /original tool observation rule/u);
    assert.equal(calls, 0);
});

test('version await refuses selector and byte drift before publishing identity', async () =>
{
    let bytes = Buffer.from('before');
    await assert.rejects(observeExecutableIdentityAsync('compiler', { ...inputs, readFile: () => bytes,
        assertPreparationExecution() {}, executePreparation() { bytes = Buffer.from('after'); return completeOutput('v1'); } }), /bytes drifted/u);
});


for (const reason of [Object.freeze(new Error('frozen nested cancellation')), 0, false, '', null])
{
    test(`actual existing nested cancellation preserves explicit signal reason ${String(reason)}`, async () =>
    {
        const { assertNestedPreparationCancellation } = await import('../../tools/test/physical-execution-nested-channel.mjs');
        const controller = new AbortController();
        controller.abort(reason);
        const attempt = {};
        let caught = false;
        try { assertNestedPreparationCancellation(controller.signal, undefined, attempt); }
        catch (actual) { caught = true; assert.equal(actual,reason); }
        assert.equal(caught,true);
        assert.equal(attempt.preparationCancellationReason,reason);
        assert.ok(attempt.recoveryObligation);
    });
}

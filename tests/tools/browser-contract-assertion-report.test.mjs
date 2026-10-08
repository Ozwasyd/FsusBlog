import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { productAssert } = await import(new URL('../../tests/browser-contract/contract.mjs', import.meta.url));
const { sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { createBrowserContractAssertionReport } = await import(new URL('../../tools/test-matrix/outcomes/browser-contract-assertion-report.mjs', import.meta.url));
const { adaptBrowserContractSemanticOutcome } = await import(new URL('../../tools/test-matrix/outcomes/browser-contract-adapter.mjs', import.meta.url));
const digest = (digit) => `sha256:${digit.repeat(64)}`;

// Controlled ordinary producer callbacks exercise emission, not a physical browser run.
function fixture(t, { failedAttempt = false, optionalSecond = false } = {})
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-assertion-report-'));
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    const authority = {
        identity: { producerId: 'browser-contract-semantic-outcome', sourceCommit: '1'.repeat(40),
            worktreeFingerprint: digest('2'), buildIdentity: digest('3'), executionEnvelopeDigest: digest('4'),
            replayPlanDigest: digest('5'), temporalContextDigest: digest('6'), toolchainDigest: digest('7'), schedulerRunId: 'report-fixture' },
        attemptEligibility: { aggregateDigest: digest('8'), attemptDigest: digest('9'), attemptNumber: 1,
            cleanFirstAttempt: !failedAttempt, firstFailure: failedAttempt, qualificationEligible: !failedAttempt },
        policyDigest: digest('a'),
        runtimeIdentities: [{ projectId: 'public', browserId: 'chromium', runtimeDigest: digest('b') }]
    };
    function write(file, value)
    {
        const bytes = Buffer.from(JSON.stringify(value));
        fs.writeFileSync(path.join(repositoryRoot, file), bytes);
        return { path: file, digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` };
    }
    const members = [0, 1].map((index) => ({ id: `member-${index}`, projectId: 'public', browserId: 'chromium',
        testId: 'browser-contract:public-hydration-history-reload', assertionId: `assertion-${index}`,
        required: index === 0 || !optionalSecond, artifacts: [{ id: `dom-${index}`, kind: 'dom' }] }));
    const catalog = sealContentDigest({ schema: 'fsusblog.browser-contract-outcome-catalog.v1', ...authority, members });
    const plan = sealContentDigest({ schema: 'fsusblog.browser-contract-outcome-plan.v1', ...authority,
        members, catalogDigest: catalog.contentDigest });
    const catalogReference = write('catalog.json', catalog);
    const planReference = write('plan.json', plan);
    const recorder = createBrowserContractAssertionReport({ repositoryRoot, authority, catalogReference, planReference });
    let runnerReference;
    function finalize(diagnostics = {})
    {
        runnerReference ??= write('runner.json', { fixture: 'byte-held finalized source; native validation belongs to runner binding' });
        return recorder.finalize({ runnerReference, diagnostics });
    }
    const capture = (index) => async () => [{ id: `dom-${index}`, ...write(`dom-${index}.json`, { actualObservedDom: index }) }];
    function adapt(report)
    {
        const reportReference = write('report.json', report);
        return adaptBrowserContractSemanticOutcome({ repositoryRoot, authority: { ...authority, inputAuthorityRefs: [
            { kind: 'browser-contract-catalog', ...catalogReference }, { kind: 'browser-contract-plan', ...planReference },
            { kind: 'browser-contract-report', ...reportReference }
        ] } });
    }
    return { recorder, capture, adapt, finalize,
        get runnerReference()
        {
            return runnerReference;
        } };
}

test('actual assertion callbacks and declared byte captures emit a complete sealed report', async (t) =>
{
    const f = fixture(t);
    const calls = [];
    assert.equal(f.runnerReference, undefined);
    for (const index of [0, 1])
    {
        const value = await f.recorder.runAssertion(`member-${index}`, {
            assertion: () =>
            {
                calls.push(index);
                productAssert(index >= 0, 'original assertion');
                return index;
            },
            capture: f.capture(index)
        });
        assert.equal(value, index);
    }
    const report = f.finalize({ producer: 'controlled original callbacks' });
    assert.deepEqual(calls, [0, 1]);
    assert.deepEqual(report.diagnostics.runnerReceipt, f.runnerReference);
    assert.equal(report.groupStatus, 'success');
    assert.equal(f.adapt(report).outcome.status, 'success');
    assert.deepEqual(f.finalize(), report);
});

test('original product assertion error is rethrown and emitted with its planned assertion identity', async (t) =>
{
    const f = fixture(t, { failedAttempt: true });
    let original;
    await assert.rejects(f.recorder.runAssertion('member-0', {
        assertion: () =>
        {
            try
            {
                productAssert(false, 'actual product rejection');
            }
            catch (error)
            {
                original = error;
                throw error;
            }
        },
        capture: f.capture(0)
    }), (error) => error === original);
    await f.recorder.runAssertion('member-1', { assertion: () => productAssert(true, 'second actual assertion'), capture: f.capture(1) });
    const report = f.finalize();
    assert.equal(report.members[0].failures[0].kind, 'product.assertion');
    assert.equal(report.members[0].failures[0].identity.assertionId, 'assertion-0');
    assert.equal(report.groupStatus, 'failed');
    assert.equal(f.adapt(report).outcome.status, 'failed');
});

test('structured infrastructure event preserves the executed assertion and blocks only unstarted assertions', async (t) =>
{
    const f = fixture(t, { failedAttempt: true });
    const original = new Error('producer structured browser-disconnect event');
    await assert.rejects(f.recorder.runAssertion('member-0', {
        assertion: () =>
        {
            throw original;
        }, classifyFailure: (error) =>
        {
            assert.equal(error, original);
            return 'infra.browser-crash';
        }
    }), (error) => error === original);
    f.recorder.interrupt('infra.browser-crash');
    const report = f.finalize();
    assert.deepEqual(report.members.map((member) => [member.executed, member.status]), [[true, 'failed'], [false, 'blocked']]);
    assert.equal(report.interruption.identity.attemptNumber, 1);
    assert.deepEqual(f.adapt(report).outcome.membership.blockedMemberIds, ['member-1']);
});

test('explicit optional assertion skip emits the actual unexecuted terminal', async (t) =>
{
    const f = fixture(t, { optionalSecond: true });
    await f.recorder.runAssertion('member-0', { assertion: () => true, capture: f.capture(0) });
    f.recorder.skipAssertion('member-1');
    const report = f.finalize();
    assert.equal(report.members[1].executed, false);
    assert.equal(report.members[1].status, 'skipped');
    assert.equal(f.adapt(report).outcome.status, 'success');
});

test('in-flight assertion and incomplete producer coverage cannot produce a terminal report', async (t) =>
{
    const f = fixture(t);
    let finish;
    const running = f.recorder.runAssertion('member-0', { assertion: () => new Promise((resolve) =>
    {
        finish = resolve;
    }), capture: f.capture(0) });
    assert.throws(() => f.finalize(), /started assertion lacks/u);
    finish('observed');
    await running;
    assert.throws(() => f.finalize(), /terminals are incomplete/u);
    await f.recorder.runAssertion('member-1', { assertion: () => true, capture: f.capture(1) });
    assert.equal(f.finalize().groupStatus, 'success');
});

test('unclassified original producer rejection stays unresolved and cannot become an unstarted blocked member', async (t) =>
{
    const f = fixture(t, { failedAttempt: true });
    const original = new Error('unknown original producer event');
    await assert.rejects(f.recorder.runAssertion('member-0', { assertion: () =>
    {
        throw original;
    } }), (error) => error === original);
    f.recorder.interrupt('infra.process-signal');
    assert.throws(() => f.finalize(), /started assertion lacks/u);
});

test('capture failure preserves the original product rejection and leaves report sealing incomplete', async (t) =>
{
    const f = fixture(t, { failedAttempt: true });
    let original;
    await assert.rejects(f.recorder.runAssertion('member-0', {
        assertion: () =>
        {
            try
            {
                productAssert(false, 'primary product failure');
            }
            catch (error)
            {
                original = error;
                throw error;
            }
        },
        capture: () =>
        {
            throw new Error('capture failed');
        }
    }), (error) => error === original);
    assert.throws(() => f.finalize(), /started assertion lacks/u);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import * as failures from '../../tools/test/execution-failure-diagnostic.mjs';

const root = new URL('../../', import.meta.url);
const physicalSource = fs.readFileSync(new URL('tools/test/physical-execution-process-tree.mjs', root), 'utf8');
const actualWrapper = physicalSource.slice(physicalSource.lastIndexOf('export async function runPhysicalExecution(options)')).replace('export ', '');
const actualReader = physicalSource.slice(physicalSource.indexOf('export function observePhysicalExecutionFailure'),
    physicalSource.indexOf('export const physicalExecutionProcessTreeSchema')).replace('export ', '');

function physicalAdapter(operation)
{
    const context = vm.createContext({ ...failures, physicalInvocationObservations: new WeakMap(),
        executePhysicalExecution: operation });
    return { run: vm.runInContext(`(${actualWrapper})`, context),
        observePhysicalExecutionFailure: vm.runInContext(`(${actualReader})`, context) };
}
const runner = fs.readFileSync(new URL('tools/test/run-deterministic-command.mjs', root), 'utf8');
const commandEnd = runner.indexOf('\nexport async function runDeterministicCommand');
const commandCatch = runner.lastIndexOf('\n    catch (error)', commandEnd);
// Exact production catch/finally bodies, not a second implementation of cleanup.
const commandSuffix = runner.slice(commandCatch, commandEnd).trimEnd().slice(0, -1);
const managedEnd = runner.indexOf('\nif (process.argv[1]', commandEnd);
const managedCatch = runner.lastIndexOf('\n    catch (error)', managedEnd);
const managedSuffix = runner.slice(managedCatch, managedEnd).trimEnd().slice(0, -1);

const reasons = [['frozen', Object.freeze(new Error('original'))], ['zero', 0], ['false', false],
    ['empty', ''], ['null', null], ['undefined', undefined], ['hostile', Object.defineProperties({}, {
        physicalStarted: { get() { assert.fail('failure metadata accessor must not run'); } },
        physicalExecution: { get() { assert.fail('failure terminal accessor must not run'); } },
        message: { get() { assert.fail('diagnostic accessor must not run'); } }
    })]];

for (const [label, first] of reasons)
{
    test(`actual runner catch/finally preserves ${label} and independent cleanup refusal`, async () =>
    {
        const failureOwner = failures.createExecutionFailureOwner();
        const secondary = new Error('owned directory cleanup refused');
        const run = vm.runInNewContext(`(async () => {
            try { throw first; } ${commandSuffix}
        })`, { ...failures, first, failureOwner, physicalStarted: false, terminalEvidence: null,
            directoryEnvelope: { fragment: { cleanup: { removedOwnedRoot: false } } },
            finalizeRunOwnedDirectoriesAfterPhysical() { throw secondary; } });
        let rejected = false;
        try { await run(); } catch (reason) { rejected = true; assert.equal(reason, first); }
        assert.equal(rejected, true);
        const observed = failures.observeExecutionFailure(failureOwner);
        assert.equal(observed.failed, true);
        assert.equal(observed.reason, first);
        assert.equal(observed.secondaryFailures[0], secondary);
        assert.equal(observed.diagnostic.secondary.message, secondary.message);
    });

    for (const terminal of [null, 'zero-members'])
    {
        test(`actual matrix cleanup preserves ${label}; terminal=${terminal ?? 'unknown'}`, async () =>
        {
            const failureOwner = failures.createExecutionFailureOwner();
            const physicalExecution = terminal === null ? null : { postObservation: terminal };
            const adapter = physicalAdapter(async (options) =>
            {
                if (physicalExecution) options.observePhysicalExecution(physicalExecution);
                throw first;
            });
            try { await adapter.run({ failureOwner }); } catch (reason) { assert.equal(reason, first); }
            let capacityReleased = 0, freshReleased = 0;
            const run = vm.runInNewContext(`(async () => { try { throw first; } ${managedSuffix} })`, {
                ...failures, first, failureOwner, observePhysicalExecutionFailure: adapter.observePhysicalExecutionFailure,
                reservation: { activeFile: '/owned/reservation', release() { capacityReleased++; } },
                lease: { leasePath: '/owned/lease', release() { freshReleased++; } }
            });
            let rejected = false;
            try { await run(); } catch (reason) { rejected = true; assert.equal(reason, first); }
            assert.equal(rejected, true);
            assert.equal(capacityReleased, terminal === null ? 0 : 1);
            assert.equal(freshReleased, terminal === null ? 0 : 1);
            assert.equal(Boolean(failures.observeExecutionFailure(failureOwner).recoveryObligation), terminal === null);
        });
    }
}

test('actual matrix finally retains Fresh when capacity release throws undefined', async () =>
{
    const failureOwner = failures.createExecutionFailureOwner();
    let freshReleased = 0;
    const run = vm.runInNewContext(`(async () => { try {} ${managedSuffix} })`, {
        ...failures, failureOwner, observePhysicalExecutionFailure: () => ({ physicalStarted: false }),
        reservation: { release() { throw undefined; } }, lease: { release() { freshReleased++; } }
    });
    let rejected = false;
    try { await run(); } catch (reason) { rejected = true; assert.equal(reason, undefined); }
    assert.equal(rejected, true);
    assert.equal(freshReleased, 0);
});

test('actual private physical observer cannot be replaced through thrown metadata or copied handles', async () =>
{
    const owner = failures.createExecutionFailureOwner();
    const first = new Error('original');
    const adapter = physicalAdapter(async () => { throw first; });
    await assert.rejects(adapter.run({ failureOwner: owner }), (reason) => reason === first);
    first.physicalStarted = false;
    first.physicalExecution = { postObservation: 'zero-members' };
    const observation = adapter.observePhysicalExecutionFailure(owner);
    assert.throws(() => { observation.physicalTerminal = 'zero-members'; }, TypeError);
    assert.equal(adapter.observePhysicalExecutionFailure(owner).physicalTerminal, null);
    assert.equal(adapter.observePhysicalExecutionFailure({ ...owner }).physicalStarted, false);
    assert.throws(() => failures.observeExecutionFailure({}), /foreign/u);
});

for (const [label, first] of reasons)
{
    test(`actual physical invocation observes terminal independently before ${label} propagation`, async () =>
    {
        const owner = failures.createExecutionFailureOwner();
        const evidence = { postObservation: 'zero-members' };
        const adapter = physicalAdapter(async (options) =>
        {
            options.observePhysicalExecution(evidence);
            throw first;
        });
        let rejected = false;
        try { await adapter.run({ failureOwner: owner, observePhysicalExecution() { assert.fail('caller observer override'); } }); }
        catch (reason) { rejected = true; assert.equal(reason, first); }
        assert.equal(rejected, true);
        evidence.postObservation = 'unverifiable';
        assert.equal(adapter.observePhysicalExecutionFailure(owner).physicalTerminal, 'zero-members');
    });
}

const adapterSource = fs.readFileSync(new URL('tools/test/physical-execution-linux-systemd-adapter.mjs', root), 'utf8');
const adapterStart = adapterSource.indexOf('            const adapterFailureOwner = createExecutionFailureOwner();');
const adapterState = adapterSource.slice(adapterStart, adapterSource.indexOf('            let cleanup;', adapterStart));
const adapterTailStart = adapterSource.indexOf('            observePhysicalExecution(evidence);');
const adapterTail = adapterSource.slice(adapterTailStart, adapterSource.indexOf('\n        }\n    };\n}', adapterTailStart));

for (const [label, first] of reasons)
{
    test(`actual Linux adapter reports independent terminal before propagating ${label}`, async () =>
    {
        const events = [];
        const evidence = { postObservation: 'zero-members' };
        const run = vm.runInNewContext(`(async () => {
            ${adapterState}
            recordPrimaryFailure(first);
            ${adapterTail}
        })`, { ...failures, first, evidence, cleanupVerified: true, cleanup: { status: 'verified' },
            observePhysicalExecution(value) { events.push(value); } });
        let rejected = false;
        try { await run(); } catch (reason) { rejected = true; assert.equal(reason, first); }
        assert.equal(rejected, true);
        assert.deepEqual(events, [evidence]);
    });
}

test('a later actual zero terminal cannot overwrite an earlier unknown physical invocation', async () =>
{
    const owner = failures.createExecutionFailureOwner();
    let calls = 0;
    const adapter = physicalAdapter(async (options) =>
    {
        if (++calls === 1) throw new Error('unknown initial terminal');
        return { postObservation: 'zero-members' };
    });
    await assert.rejects(adapter.run({ failureOwner: owner }), /unknown initial/u);
    await adapter.run({ failureOwner: owner });
    assert.equal(adapter.observePhysicalExecutionFailure(owner).physicalTerminal, null);
});

test('an unsettled actual invocation cannot supply a cleanup terminal through an early callback', async () =>
{
    const owner = failures.createExecutionFailureOwner();
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const adapter = physicalAdapter(async (options) =>
    {
        options.observePhysicalExecution({ postObservation: 'zero-members' });
        await pending;
        return { postObservation: 'zero-members' };
    });
    const result = adapter.run({ failureOwner: owner });
    assert.equal(adapter.observePhysicalExecutionFailure(owner).physicalTerminal, null);
    finish();
    await result;
    assert.equal(adapter.observePhysicalExecutionFailure(owner).physicalTerminal, 'zero-members');
});

test('primitive first reason renders its independently retained redacted secondary without replacement', () =>
{
    const owner = failures.createExecutionFailureOwner();
    failures.retainExecutionFailure(owner, null);
    failures.retainExecutionFailure(owner, new Error('PASSWORD=private'));
    assert.equal(failures.observeExecutionFailure(owner).reason, null);
    const text = failures.formatExecutionFailure(null, owner);
    assert.equal(text.includes('private'), false);
    assert.equal(text.includes('[redacted sensitive diagnostic]'), true);
});

const runBoundSource = fs.readFileSync(new URL('tools/test/run-once.mjs', root), 'utf8');
const runBoundStart = runBoundSource.indexOf('export async function runBoundExecution');
const producerBodyStart = runBoundSource.indexOf('        const producerWaitMs', runBoundStart);
const producerBodyEnd = runBoundSource.indexOf('\nasync function collectFiles', producerBodyStart);
const producerBody = runBoundSource.slice(producerBodyStart, producerBodyEnd).trimEnd().slice(0, -1);
for (const [label, first] of reasons)
{
    for (const writeFails of [false, true])
    {
        test(`actual run-bound producer retains ${label}; receipt writer refusal=${writeFails}`, async () =>
        {
            const failureOwner = failures.createExecutionFailureOwner();
            const secondary = new Error('owned receipt writer refused');
            const writes = [];
            let releases = 0;
            const run = vm.runInNewContext(`(async () => { try { ${producerBody} })`, {
                ...failures, failureOwner, requestedAt: Date.now(), normalizedOutputs: [], signal: undefined,
                operation() { throw first; }, captureOutputStates: async () => [],
                observePhysicalExecutionFailure: () => ({ physicalStarted: true, physicalExecution: null, physicalTerminal: null }),
                runBoundSchema: 'fsusblog.test-physical-execution.v1', contract: {}, contractDigest: 'test', consumerId: 'controlled',
                receiptFile: '/pure-fixture/receipt.json', process: { pid: 1 }, digestValue: () => 'controlled',
                async writeJsonAtomic(_file, receipt) { writes.push(receipt); if (writeFails) throw secondary; },
                consume() { assert.fail('failed current invocation must not consume a reconstructed Error'); },
                lock: { async release() { releases++; } }
            });
            let rejected = false;
            try { await run(); } catch (reason) { rejected = true; assert.equal(reason, first); }
            assert.equal(rejected, true);
            assert.equal(writes.length, 1);
            assert.equal(writes[0].status, 'failure');
            assert.equal(writes[0].physicalExecution, null);
            assert.equal(releases, 1);
            if (writeFails) assert.equal(failures.observeExecutionFailure(failureOwner).secondaryFailures[0], secondary);
        });
    }
}

const prepareSource = fs.readFileSync(new URL('tools/docs/prepare-behavior-doc-nuget.mjs', root), 'utf8');
const prepareEnd = prepareSource.indexOf('\nif (process.argv[1]');
const prepareCatch = prepareSource.lastIndexOf('\n    catch (error)', prepareEnd);
const prepareSuffix = prepareSource.slice(prepareCatch, prepareEnd).trimEnd().slice(0, -1);
for (const [label, first] of reasons)
{
    for (const terminal of [null, 'zero-members'])
    {
        test(`actual prepare cleanup retains ${label}; actual terminal=${terminal ?? 'unknown'}`, async () =>
        {
            const failureOwner = failures.createExecutionFailureOwner();
            const adapter = physicalAdapter(async (options) =>
            {
                if (terminal) options.observePhysicalExecution({ postObservation: terminal });
                throw first;
            });
            try { await adapter.run({ failureOwner }); } catch {}
            let capacityReleased = 0, freshReleased = 0, directoriesCleaned = 0;
            const run = vm.runInNewContext(`(async () => { try { throw first; } ${prepareSuffix} })`, {
                ...failures, first, failureOwner, observePhysicalExecutionFailure: adapter.observePhysicalExecutionFailure,
                directories: { fragment: { ownedRoot: '/pure-fixture/directory', cleanup: { removedOwnedRoot: false } } },
                attemptRoot: null, complete: false, parentOwner: null,
                finalizeRunOwnedDirectories() { directoriesCleaned++; },
                reservation: { activeFile: '/pure-fixture/reservation', receipt: { reservationId: 'fixture' }, release() { capacityReleased++; } },
                lease: { leasePath: '/pure-fixture/lease', release() { freshReleased++; } },
                controller: new AbortController(), process: { removeListener() {} }, onSigint() {}, onSigterm() {}
            });
            let rejected = false;
            try { await run(); } catch (reason) { rejected = true; assert.equal(reason, first); }
            assert.equal(rejected, true);
            assert.equal(capacityReleased, terminal === null ? 0 : 1);
            assert.equal(freshReleased, terminal === null ? 0 : 1);
            assert.equal(directoriesCleaned, terminal === null ? 0 : 1);
        });
    }
}

const abortCheckStart = runBoundSource.indexOf('function throwIfAborted(signal)');
const abortCheckBody = runBoundSource.slice(abortCheckStart, runBoundSource.indexOf('\nasync function sleep', abortCheckStart));
for (const [label, first] of reasons)
{
    test(`actual run-bound cancellation retains ${label} reason`, () =>
    {
        const check = vm.runInNewContext(`(${abortCheckBody})`);
        let rejected = false;
        try { check({ aborted: true, reason: first }); }
        catch (reason) { rejected = true; assert.equal(reason, first); }
        assert.equal(rejected, true);
    });
}

const atomicStart = runBoundSource.indexOf('async function writeJsonAtomic(');
const atomicBody = runBoundSource.slice(atomicStart, runBoundSource.indexOf('\nfunction sanitizeSegment', atomicStart));
for (const [label, first] of reasons)
{
    test(`actual atomic cancellation cleanup preserves ${label} first reason`, async () =>
    {
        const failureOwner = failures.createExecutionFailureOwner();
        const secondary = new Error('owned temporary cleanup refused');
        const signal = { aborted: false, reason: first };
        let committed = 0;
        const run = vm.runInNewContext(`(${atomicBody})`, { ...failures, signal,
            throwIfAborted: vm.runInNewContext(`(${abortCheckBody})`),
            path: { dirname: () => '/in-memory' }, process: { pid: 1 }, randomUUID: () => 'controlled',
            mkdir: async () => {}, writeFile: async () => { signal.aborted = true; },
            renameSync() { committed++; }, rm: async () => { throw secondary; }
        });
        let rejected = false;
        try { await run('/in-memory/receipt', { status: 'success' }, signal, failureOwner); }
        catch (reason) { rejected = true; assert.equal(reason, first); }
        assert.equal(rejected, true);
        assert.equal(committed, 0);
        assert.equal(failures.observeExecutionFailure(failureOwner).secondaryFailures[0], secondary);
    });
}

// SCM composition controls execute the actual private observer/cleanup bodies with component I/O.
// These object stand-ins do not issue a native carrier, service binding or cleanup qualification.
test('SCM union matching terminal rejects a foreign carrier and preserves default observation', async () =>
{
    const owner = failures.createExecutionFailureOwner();
    const carrier = Object.freeze({});
    const foreign = Object.freeze({});
    const adapter = physicalAdapter(async () => ({ postObservation: 'zero-members' }));
    await adapter.run({ failureOwner: owner, originalNativeInputCarrier: carrier });
    assert.equal(adapter.observePhysicalExecutionFailure(owner).physicalTerminal, 'zero-members');
    assert.equal(adapter.observePhysicalExecutionFailure(owner, { originalNativeInputCarrier: carrier }).physicalTerminal, 'zero-members');
    assert.equal(adapter.observePhysicalExecutionFailure(owner, { originalNativeInputCarrier: foreign }).physicalTerminal, null);
    assert.equal(adapter.observePhysicalExecutionFailure(failures.createExecutionFailureOwner(), { originalNativeInputCarrier: carrier }).physicalTerminal, null);
});

test('SCM union matching terminal retains unknown and mixed original invocations', async () =>
{
    const owner = failures.createExecutionFailureOwner();
    const carrier = Object.freeze({});
    let calls = 0;
    const adapter = physicalAdapter(async () =>
    {
        if (++calls === 1) throw Object.freeze(new Error('unknown original invocation'));
        return { postObservation: 'zero-members' };
    });
    await assert.rejects(adapter.run({ failureOwner: owner, originalNativeInputCarrier: carrier }), /unknown original/u);
    await adapter.run({ failureOwner: owner, originalNativeInputCarrier: carrier });
    assert.equal(adapter.observePhysicalExecutionFailure(owner, { originalNativeInputCarrier: carrier }).physicalTerminal, null);
    const mixedOwner = failures.createExecutionFailureOwner();
    await adapter.run({ failureOwner: mixedOwner, originalNativeInputCarrier: carrier });
    await adapter.run({ failureOwner: mixedOwner });
    assert.equal(adapter.observePhysicalExecutionFailure(mixedOwner).physicalTerminal, 'zero-members');
    assert.equal(adapter.observePhysicalExecutionFailure(mixedOwner, { originalNativeInputCarrier: carrier }).physicalTerminal, null);
});

test('SCM union matching terminal waits for the original invocation settlement', async () =>
{
    const owner = failures.createExecutionFailureOwner();
    const carrier = Object.freeze({});
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const adapter = physicalAdapter(async (options) =>
    {
        options.observePhysicalExecution({ postObservation: 'zero-members' });
        await pending;
        return { postObservation: 'zero-members' };
    });
    const result = adapter.run({ failureOwner: owner, originalNativeInputCarrier: carrier });
    assert.equal(adapter.observePhysicalExecutionFailure(owner, { originalNativeInputCarrier: carrier }).physicalTerminal, null);
    finish();
    await result;
    assert.equal(adapter.observePhysicalExecutionFailure(owner, { originalNativeInputCarrier: carrier }).physicalTerminal, 'zero-members');
});

const nativeCarrierSource = fs.readFileSync(new URL('tools/test/physical-execution-native-input-carrier.mjs', root), 'utf8');
const nativeCloseStart = nativeCarrierSource.indexOf('export async function closeOriginalNativeInputCarrier(');
const nativeCloseBody = nativeCarrierSource.slice(nativeCloseStart,
    nativeCarrierSource.indexOf('\n/** Startup only:', nativeCloseStart)).replace('export ', '')
    .replace("const { observePhysicalExecutionFailure } = await import('./physical-execution-process-tree.mjs');", '')
    .replace("const { assertProductionBuildRetainedNativeInputIntent } = await import('../test-matrix/production-build-layout.mjs');", '');

test('SCM union held cleanup ignores caller terminal JSON and rechecks exact matching invocation', async () =>
{
    const owner = failures.createExecutionFailureOwner();
    const carrier = Object.freeze({});
    const foreign = Object.freeze({});
    const adapter = physicalAdapter(async () => ({ postObservation: 'zero-members' }));
    await adapter.run({ failureOwner: owner, originalNativeInputCarrier: foreign });
    const held = { retentionStarted: true, pending: false, authority: { phase: 'pre-exec', serviceBinding: {} },
        boundary: {}, context: {}, descriptor: null, directory: {} };
    let removals = 0;
    let serviceObservations = 0;
    const close = vm.runInNewContext(`(${nativeCloseBody})`, { carriers: new WeakMap([[carrier, held]]),
        observePhysicalExecutionFailure: adapter.observePhysicalExecutionFailure,
        fail(message) { throw new Error(message); },
        assertProductionSystemdExecutionBoundary() {},
        inspectProductionSystemdServiceBinding()
        {
            serviceObservations++;
            return { status: 'absent' };
        },
        closeClosedNativeInputDirectory() { removals++; } });
    await assert.rejects(close(carrier, { failureOwner: owner, brokerGone: true, postObservation: 'zero-members' }),
        /unverified target cleanup/u);
    assert.equal(removals, 0);
    assert.equal(serviceObservations, 0);
    const matchingOwner = failures.createExecutionFailureOwner();
    await adapter.run({ failureOwner: matchingOwner, originalNativeInputCarrier: carrier });
    await close(carrier, { failureOwner: matchingOwner, brokerGone: true, postObservation: 'unverifiable' });
    assert.equal(removals, 1);
    assert.equal(serviceObservations, 2);
});

const nestedSource = fs.readFileSync(new URL('tools/test/physical-execution-nested-channel.mjs', root), 'utf8');
const nestedStartupCatchStart = nestedSource.indexOf('    catch (error)\n    {\n        retainExecutionFailure(channelFailureOwner, error);');
const nestedStartupCatch = nestedSource.slice(nestedStartupCatchStart,
    nestedSource.indexOf('    const nativeBrokerIdentity', nestedStartupCatchStart));
for (const [label, first] of reasons.filter(([label]) => label !== 'hostile'))
{
    test(`SCM union startup keeps ${label} first cause ahead of independent cleanup failure`, () =>
    {
        const channelFailureOwner = failures.createExecutionFailureOwner();
        const secondary = new Error('original startup cleanup retained');
        const run = vm.runInNewContext(`(() => { try { throw first; } ${nestedStartupCatch} })`, {
            ...failures, first, channelFailureOwner,
            native: { binding: {} }, originalNativeInputCarrier: {}, directory: null,
            retainNativeCleanupObservation(error, value)
            {
                failures.retainExecutionRecovery(channelFailureOwner, { nativeInputCleanupObservation: value });
                failures.retainExecutionFailureCompatibility(error, 'nativeInputCleanupObservation', value);
            },
            closeOriginalNativeInputCarrierBeforeSpawn() { throw secondary; } });
        let rejected = false;
        try { run(); } catch (reason) { rejected = true; assert.equal(reason, first); }
        assert.equal(rejected, true);
        assert.equal(failures.observeExecutionFailure(channelFailureOwner).secondaryFailures.length, 1);
        assert.equal(failures.observeExecutionFailure(channelFailureOwner).recoveryObligation.nativeInputCleanupObservation.executionAuthority, false);
    });
}

const carrierFactoryCatchStart = nativeCarrierSource.indexOf('    catch (error)\n    {\n        const failureOwner = createExecutionFailureOwner();');
const carrierFactoryCatch = nativeCarrierSource.slice(carrierFactoryCatchStart,
    nativeCarrierSource.indexOf('\n}\n\nexport function inspectOriginalNativeInputCarrier', carrierFactoryCatchStart));
for (const [label, first] of reasons.filter(([label]) => label !== 'hostile'))
{
    test(`SCM union carrier factory keeps ${label} first cause on retained directory cleanup`, () =>
    {
        const held = { directory: {} };
        const secondary = new Error('original directory cleanup retained');
        const run = vm.runInNewContext(`(() => { try { throw first; } ${carrierFactoryCatch} })`, {
            ...failures, first, held,
            closeClosedNativeInputDirectory() { throw secondary; } });
        let rejected = false;
        try { run(); } catch (reason) { rejected = true; assert.equal(reason, first); }
        assert.equal(rejected, true);
        assert.equal(held.revoked, true);
        assert.equal(held.closed, undefined);
    });
}

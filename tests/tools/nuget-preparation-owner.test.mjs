import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifySchedulerProcessAuthority } from '../../tools/test-matrix/scheduler-run-owner.mjs';
import { acquireProductionFreshExclusiveLease, assertProductionFreshExclusiveLease } from '../../tools/test-matrix/production-fresh-exclusive-lease.mjs';
import { acquireProductionCapacityReservation, assertProductionCapacityReservation } from '../../tools/test-matrix/production-capacity-reservation.mjs';
import { productionDiskDemandDigest, readProductionDiskDemandCatalog, bindBehaviorDocNugetPreparationDiskDemand,
    bindNugetParentControlDiskDemand } from '../../tools/test-matrix/production-disk-demand.mjs';
import { assertNugetPreparationOwner, assertNugetScheduledTier, executeOwnedNugetStage, runOwnedNugetPreparation } from '../../tools/test/nuget-preparation-owner.mjs';
import { validateProductionRunId } from '../../tools/test-matrix/production-build-layout.mjs';
import { parseNugetParentArguments } from '../../tools/docs/run-nuget-preparation.mjs';
import { matrixGovernanceArguments } from '../../tools/test/matrix-governance-command.mjs';

import { observePinnedNugetToolchain, observePreparedNugetParentSdk, assertPreparedNugetParentSdkPhysical } from '../../tools/test/behavior-doc-nuget-preparation.mjs';

const canonicalize = (value) => Array.isArray(value) ? value.map(canonicalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) : value;
function reseal(record)
{
    const { contentDigest, ...payload } = record;
    return { ...payload, contentDigest: 'sha256:' + createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex') };
}
function fixture(t, verifyAuthority = null)
{
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nuget-parent-control-'));
    const root = path.join(parent, 'repository'); fs.mkdirSync(root, { mode: 0o700 });
    execFileSync('git', ['init', '-q'], { cwd: root });
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
    const runId = 'nuget-source-control';
    const lease = acquireProductionFreshExclusiveLease({ root, runId, sourceState,
        targetTierId: 'production-correctness', heartbeatEveryMs: 60000,
        ...(verifyAuthority ? { verifyAuthority } : {}),
        verifyDescendants: () => ({ status: 'verified', identities: [] }) });
    const expected = { root, runId, sourceState };
    t.after(() => { try { lease.release('complete'); } catch {} fs.rmSync(parent, { recursive: true, force: true }); });
    return { parent, root, runId, sourceState, lease, expected };
}
function reserve(f)
{
    const declarations = [{ producerId: 'matrix-nuget-preparation', rootId: 'fixture', peakAdditionalBytes: 16,
        terminalRetainedBytes: 16, rollbackOrRecoveryBytes: 16, uncertaintyBytes: 16,
        concurrencyClass: 'source-control', sourceOfEstimate: 'inert control fixture', estimatorVersion: 'fixture' }];
    const plan = { planDigest: productionDiskDemandDigest('plan'), producerDeclarationDigest: productionDiskDemandDigest(declarations),
        producerDeclarations: declarations, filesystems: [{ filesystemIdentity: 'fixture', canonicalPaths: [f.root],
            rootIds: ['fixture'], observedFreeBytes: 4096, requestedBytes: 64, safetyBytes: 64 }] };
    const reservation = acquireProductionCapacityReservation({ plan, runId: f.runId,
        candidateIdentityDigest: f.lease.owner.candidateIdentityDigest, repositoryRoot: f.root,
        repositoryLeaseOwner: f.lease.owner, authorityRoot: path.join(f.parent, 'authority'),
        remeasureFilesystem: () => 4096, heartbeatEveryMs: 60000 });
    return { reservation, expected: { plan, runId: f.runId, repositoryRoot: f.root,
        repositoryLeaseOwnerToken: f.lease.owner.ownerToken } };
}

test('original issued Fresh owner accepts actual live control and rejects forgery, foreign source and revocation', (t) =>
{
    const f = fixture(t);
    assertProductionFreshExclusiveLease(f.lease, f.expected);
    assert.throws(() => assertProductionFreshExclusiveLease({ ...f.lease }, f.expected), /actual live issued/u);
    assert.throws(() => assertProductionFreshExclusiveLease(f.lease, { ...f.expected,
        sourceState: { ...f.sourceState, commit: 'c'.repeat(40) } }), /drifted/u);
    f.lease.release('complete');
    assert.throws(() => assertProductionFreshExclusiveLease(f.lease, f.expected), /actual live issued/u);
});

test('original issued Fresh snapshots reject caller-mutated source and exposed owner even when sealed record follows', (t) =>
{
    const f = fixture(t); const file = path.join(f.lease.leasePath, 'owner.json');
    const original = structuredClone(f.lease.owner);
    f.sourceState.commit = 'c'.repeat(40);
    assert.throws(() => assertProductionFreshExclusiveLease(f.lease, f.expected), /drifted/u);
    f.sourceState.commit = original.candidateIdentityDigest ? 'a'.repeat(40) : '';
    const changed = reseal({ ...f.lease.owner, commandDigest: 'sha256:' + 'c'.repeat(64) });
    Object.assign(f.lease.owner, changed); fs.writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => assertProductionFreshExclusiveLease(f.lease, f.expected), /identity drifted|source or state drifted/u);
    Object.assign(f.lease.owner, original); fs.writeFileSync(file, JSON.stringify(original));
});

test('original issued Fresh rejects same-byte inode replacement', (t) =>
{
    const f = fixture(t); const file = path.join(f.lease.leasePath, 'owner.json');
    const saved = file + '.replacement'; fs.copyFileSync(file, saved); fs.chmodSync(saved, 0o600); fs.renameSync(saved, file);
    assert.throws(() => assertProductionFreshExclusiveLease(f.lease, f.expected), /record identity drifted/u);
});

test('original issued capacity accepts live lease and rejects public clone, plan drift and released capability', (t) =>
{
    const f = fixture(t); const r = reserve(f);
    assertProductionCapacityReservation(r.reservation, r.expected);
    assert.throws(() => assertProductionCapacityReservation({ ...r.reservation }, r.expected), /actual live issued/u);
    const altered = structuredClone(r.expected.plan); altered.filesystems[0].requestedBytes++;
    assert.throws(() => assertProductionCapacityReservation(r.reservation, { ...r.expected, plan: altered }), /issued identity, plan/u);
    r.reservation.release();
    assert.throws(() => assertProductionCapacityReservation(r.reservation, r.expected), /actual live issued/u);
});

test('original issued capacity rejects mutation of exposed receipt plus resealed record and same-byte replacement', (t) =>
{
    const f = fixture(t); const r = reserve(f); const original = structuredClone(r.reservation.receipt);
    const changed = reseal({ ...original, planDigest: productionDiskDemandDigest('foreign-plan') });
    Object.assign(r.reservation.receipt, changed); fs.writeFileSync(r.reservation.activeFile, JSON.stringify(changed));
    assert.throws(() => assertProductionCapacityReservation(r.reservation, r.expected), /issued identity, plan/u);
    Object.assign(r.reservation.receipt, original); fs.writeFileSync(r.reservation.activeFile, JSON.stringify(original));
    const copy = r.reservation.activeFile + '.copy'; fs.copyFileSync(r.reservation.activeFile, copy);
    fs.chmodSync(copy, 0o600); fs.renameSync(copy, r.reservation.activeFile);
    assert.throws(() => assertProductionCapacityReservation(r.reservation, r.expected), /issued identity, plan/u);
    r.reservation.release();
});

test('fixed owner cannot be minted from JSON or stage labels', async () =>
{
    const fake = { root: process.cwd(), runId: 'run', stage: { id: 'matrix-nuget-preparation' } };
    assert.throws(() => assertNugetPreparationOwner(fake, {}), /foreign, revoked/u);
    assert.throws(() => assertNugetScheduledTier(fake, { id: 'matrix-nuget-preparation' }), /actual live parent/u);
    await assert.rejects(() => executeOwnedNugetStage(fake, { id: 'matrix-nuget-preparation' }, {}), /actual live parent/u);
});

test('parent admission syntax is explicit and closed, with no implicit native request', () =>
{
    const argv = ['--purpose', 'matrix-governance', '--run-id', 'r', '--out', '/owned/descriptor',
        '--feed-root', '/sealed/feed', '--feed-digest', 'a'.repeat(64), '--cpu-units', '1', '--memory-gib', '2'];
    assert.equal(parseNugetParentArguments(argv).memoryGiB, 2);
    assert.throws(() => parseNugetParentArguments(argv.slice(0, -2)), /Missing/u);
    assert.throws(() => parseNugetParentArguments([...argv, '--cpu-units', '2']), /unique/u);
    assert.throws(() => parseNugetParentArguments([...argv, '--grant-json', '{}']), /unique/u);
});

test('parent reserve adds exact control roots without reducing original archive, recovery, uncertainty or safety', () =>
{
    const original = bindBehaviorDocNugetPreparationDiskDemand(readProductionDiskDemandCatalog(process.cwd()),
        { allocatedBytes: 1024, expandedAllocatedBytes: 4096, treeDigest: 'a'.repeat(64) }, 'matrix-governance');
    const actual = bindNugetParentControlDiskDemand(original, 'matrix-nuget-preparation');
    assert.equal(actual.safetyBytes, original.safetyBytes);
    const previous = original.producers.at(-1).demands, current = actual.producers.at(-1).demands;
    assert.deepEqual(current.slice(0, previous.length), previous);
    assert.deepEqual(current.slice(previous.length).map((entry) => entry.rootId),
        ['nuget-parent-control', 'nuget-parent-carrier', 'nuget-systemd-management', 'nuget-systemd-runtime']);
    assert.ok(current.slice(previous.length).every((entry) => entry.sourceOfEstimate.includes('not measured capacity acceptance')));
});

test('shared matrix source retains original native producer argv and every gate binding', () =>
{
    const argv = matrixGovernanceArguments({ root: '/root', consumerId: 'validate-matrix', preparationFile: '/descriptor' });
    const original = execFileSync('git', ['show', '434004c5fd928ad53c85b5ba6eb36a774f7d7c8d:tools/test/run-matrix-governance-once.sh'], { encoding: 'utf8' });
    for (const match of original.matchAll(/--path ([^ \\\n]+)/gu)) assert.ok(argv.includes(match[1]), match[1]);
    const command = original.split("-- bash -c '")[1].trim().slice(0, -1);
    assert.equal(argv.at(-1), command);
    assert.equal(argv[argv.indexOf('--producer-id') + 1], 'validate-matrix');
    assert.throws(() => matrixGovernanceArguments({ root: '/root', consumerId: 'behavior-doc-static-admission', preparationFile: '/descriptor' }), /exact consumer/u);
});

function body(file, start, end)
{
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

test('actual spawnCommand body preserves observed argv and injected private environment over parent options', async () =>
{
    const actual = body('../../tools/test/run-deterministic-command.mjs', 'async function spawnCommand(', '\nasync function executeCommand(');
    let observed;
    const invoke = vm.runInNewContext('(' + actual.trim() + ')', { runPhysicalExecution: async (value) => { observed = value; return value; } });
    const env = { NUGET_PACKAGES: '/owned/private', HOME: '/owned/home' };
    await invoke(['native', 'exact'], '/root', 'actual-signal', env,
        { command: ['foreign-wrapper'], cwd: '/foreign', env: { HOME: '/ambient' }, signal: 'foreign', resourceBoundary: 'actual-boundary' });
    assert.deepEqual(observed.command, ['native', 'exact']); assert.equal(observed.env, env);
    assert.equal(observed.cwd, '/root'); assert.equal(observed.signal, 'actual-signal');
    assert.equal(observed.resourceBoundary, 'actual-boundary');
});

test('actual parent body admits original Fresh and capacity before any owner write for both fixed purposes', async () =>
{
    const source = fs.readFileSync(new URL('../../tools/test/nuget-preparation-owner.mjs', import.meta.url), 'utf8');
    const actual = source.slice(source.indexOf('export async function runOwnedNugetPreparation(')).replace('export ', '');
    for (const purpose of ['behavior-doc', 'matrix-governance'])
    for (const rejectCapacity of [false, true])
    for (const runtimeSourceDrift of [false, true])
    {
        const events = [];
        const sdkPurposes = [];
        let commit = 'a';
        const sandbox = { ownerRepositoryRoot: '/repository', validateProductionRunId, equal: (a, b) => JSON.stringify(a) === JSON.stringify(b), path, Object, Map, Set, Number, String, process: { execPath: '/node', getuid: () => 1 },
            fs: { realpathSync: (p) => p, existsSync: () => true, statfsSync: () => ({ bsize: 4096 }),
                lstatSync: () => ({ mode: 0o700, uid: 1 }) }, os: { tmpdir: () => '/private-tmp' },
            execFileSync: () => '', sealSourceIdentity: () => ({ commit }), snapshotSourceState: async () => ({ commit }),
            nugetPreparationDeclaration: (p) => ({ owner: p === 'matrix-governance' ? 'matrix-nuget-preparation' : 'behavior-doc-nuget-preparation',
                solution: 'fixed.slnx', consumers: ['matrix-governance', 'validate-matrix'] }),
            nugetPreparationClosure: () => ({ sourceClosureDigests: [{ path: 'project.cs' }] }),
            observeNugetPreparationToolchain: (_root, p) => { sdkPurposes.push(p); return p === 'behavior-doc' ? null
                : { executable: '/sdk/dotnet', files: [{ path: 'sdk/compiler.dll' }] }; },
            inventoryNugetOfflineFeed: () => ({ root: '/feed', treeDigest: 'a'.repeat(64) }),
            defaultProductionDiskRoots: () => ({}), readProductionDiskDemandCatalog: () => ({}),
            bindBehaviorDocNugetPreparationDiskDemand: () => ({}), bindNugetParentControlDiskDemand: () => ({}),
            buildProductionDiskDemandPlan: () => ({}), parentSources: ['parent-source'], command: (a) => a.join(' '), owners: new WeakMap(),
            acquireProductionFreshExclusiveLease: () => { events.push('fresh'); return { owner: { candidateIdentityDigest: 'candidate' }, release: () => events.push('release-fresh') }; },
            acquireProductionCapacityReservation: () => { events.push('capacity'); if (rejectCapacity) throw new Error('capacity rejected');
                return { guardProducer: () => events.push('guard'), release: () => events.push('release-capacity') }; },
            assertNugetPreparationOwner: () => events.push('live-guard'), loadPhysicalExecutionProcessPolicy: () => ({}),
            createSystemdResourceTransport: () => ({}), observeNugetSystemdRuntimeRoot: () =>
            { if (runtimeSourceDrift) commit = 'b'; return { root: '/run/user/1/systemd/transient' }; },
            guardNugetSystemdTransport: (value) => value,
            runProductionBuildLifecycle: async () => { events.push('owner-write'); throw new Error('controlled stop before native'); }
        };
        const invoke = vm.runInNewContext('(' + actual + ')', sandbox);
        for (const invalid of ['.', '..', '.leading', ' run '])
        {
            await assert.rejects(() => invoke({ repositoryRoot: '/repository', runId: invalid, purpose, cpuUnits: 1, memoryGiB: 2 }), /unsafe production build run id|explicit fixed purpose/u);
            assert.deepEqual(events, []);
        }
        await assert.rejects(() => invoke({ repositoryRoot: '/repository', runId: 'run', purpose,
            outputFile: '/repository/.tmp/' + (purpose === 'matrix-governance' ? 'matrix' : 'behavior-doc') + '-nuget-preparation/input.json',
            feedRoot: '/feed', feedDigest: 'a'.repeat(64), cpuUnits: 1, memoryGiB: 2 }),
            runtimeSourceDrift ? /preflight source/u : rejectCapacity ? /capacity rejected/u : /controlled stop/u);
        if (runtimeSourceDrift) { assert.deepEqual(events, []); continue; }
        assert.ok(sdkPurposes.length >= 2 && sdkPurposes.every((value) => value === 'matrix-governance')); // Parent pins actual SDK bytes without changing the fixed BD descriptor purpose.
        assert.equal(events[0], 'fresh'); assert.equal(events[1], 'capacity');
        if (rejectCapacity) assert.equal(events.includes('owner-write'), false);
        else assert.ok(events.indexOf('guard') < events.indexOf('owner-write'));
        assert.equal(events.at(-1), 'release-fresh');
    }
});

test('actual original Fresh validator rejects owner replacement during authority observation', (t) =>
{
    let f, injected = false, active = false;
    f = fixture(t, (owner, authority) =>
    {
        if (active && !injected)
        {
            injected = true;
            const ownerFile = path.join(f.lease.leasePath, 'owner.json');
            const replacement = ownerFile + '.replacement';
            fs.copyFileSync(ownerFile, replacement); fs.chmodSync(replacement, 0o600); fs.renameSync(replacement, ownerFile);
        }
        return verifySchedulerProcessAuthority(owner, authority);
    });
    active = true;
    assert.throws(() => assertProductionFreshExclusiveLease(f.lease, f.expected), /identity drifted/u);
    active = false;
    assert.equal(injected, true);
});

test('actual original capacity validator rejects journal replacement during live process/lease observation', (t) =>
{
    const f = fixture(t); const r = reserve(f);
    const originalRead = fs.readFileSync;
    let injected = false;
    fs.readFileSync = function(file, ...args)
    {
        if (!injected && typeof file === 'string' && file.startsWith('/proc/'))
        {
            injected = true;
            const replacement = r.reservation.activeFile + '.replacement';
            fs.copyFileSync(r.reservation.activeFile, replacement); fs.chmodSync(replacement, 0o600);
            fs.renameSync(replacement, r.reservation.activeFile);
        }
        return originalRead.call(this, file, ...args);
    };
    try { assert.throws(() => assertProductionCapacityReservation(r.reservation, r.expected), /drifted during authority/u); }
    finally { fs.readFileSync = originalRead; }
    assert.equal(injected, true);
    r.reservation.release();
});

test('actual original resource-service body preserves registration/resume and fails closed on missing native evidence', async () =>
{
    const failures = await import(new URL('../../tools/test/execution-failure-diagnostic.mjs', import.meta.url));
    const { PassThrough } = await import('node:stream');
    const { finished } = await import('node:stream/promises');
    let actual = body('../../tools/test-matrix/scheduler.mjs', 'function beginResourceService(', '\nexport function verifyResidentProcessResourceScope(');
    actual = actual.replace("await import('../test/nuget-preparation-owner.mjs')", 'await controlledPorts');
    const physicalSource = fs.readFileSync(new URL('../../tools/test/physical-execution-process-tree.mjs', import.meta.url), 'utf8');
    const observer = physicalSource.slice(physicalSource.indexOf('export function observePhysicalExecutionFailure('),
        physicalSource.indexOf('\nexport const physicalExecutionProcessTreeSchema')).replace('export ', '');
    const physical = physicalSource.slice(physicalSource.indexOf('export async function runPhysicalExecution(')).replace('export ', '');
    const ownerSource = fs.readFileSync(new URL('../../tools/test/nuget-preparation-owner.mjs', import.meta.url), 'utf8');
    const ownerHelpers = ownerSource.slice(ownerSource.indexOf('const sdkIdentity ='), ownerSource.indexOf('const parentSources ='));
    const stageObserver = body('../../tools/test/nuget-preparation-owner.mjs', 'export function observeOwnedNugetStageFailure(',
        '\n/** Called only through').replace('export ', '');
    for (const variant of ['zero', 'descriptor-only', 'unknown', 'cancelled', 'post-cancel'])
    {
        const events = [];
        const evidence = { postObservation: variant === 'unknown' ? 'unverifiable' : 'zero-members',
            containmentAuthority: { complete: true }, resourceExecutionAdmission: { original: true }, logComplete: true };
        const stageOwner = failures.createExecutionFailureOwner();
        const capability = Object.freeze({});
        const state = { closed: false, stage: { id: 'matrix-nuget-preparation', argv: ['fixed'], inputs: ['fixed-source'] },
            sdk: { fixed: true }, failureOwner: stageOwner };
        // These original VM controls own no production capability or native qualification.
        const context = vm.createContext({ ...failures, AbortController, PassThrough, finished,
            resourceServiceFailureOwners: new WeakMap(),
            setTimeout, clearTimeout, Date, Number, Error, Object, Promise,
            owners: new WeakMap([[capability, state]]),
            createHash,
            loadPhysicalExecutionProcessPolicy: () => ({}), resourceServiceContainmentIsComplete: (value) => value?.complete === true,
            executePhysicalExecution: async (options) =>
            {
                await options.processOwner.register({ pid: 123 }, evidence.containmentAuthority);
                events.push('first-native-step');
                const observed = variant === 'descriptor-only' ? { descriptor: '/not-native-evidence' } : evidence;
                options.observePhysicalExecution(observed);
                if (variant === 'post-cancel')
                {
                    execution.terminate(new Error('controlled post-physical cancellation'));
                }
                return observed;
            } });
        vm.runInContext('const physicalInvocationObservations = new WeakMap();\n' + ownerHelpers + observer + '\n' + physical + '\n' + stageObserver, context);
        context.controlledPorts = { executeOwnedNugetStage: async (_cap, _tier, options) =>
            context.runPhysicalExecution({ ...options, failureOwner: stageOwner }),
        observeOwnedNugetStageFailure: context.observeOwnedNugetStageFailure };
        const ownedCommand = vm.runInContext(`command(${JSON.stringify(state.stage.argv)})`, context);
        const ownedSdkIdentity = vm.runInContext(`sdkIdentity(${JSON.stringify(state.sdk)})`, context);
        const invoke = vm.runInContext('(' + actual.trim() + ')', context);
        const outputPipeline = { attach: (stream) => stream.resume(), onFailure: () => () =>
        {} };
        const execution = invoke({ id: 'matrix-nuget-preparation', command: ownedCommand, cacheInputs: state.stage.inputs,
            nugetSdkIdentity: ownedSdkIdentity, budgetMs: 1000 },
        { root: '/root', env: {}, outputPipeline, boundary: { actual: true }, resourceContext: {},
            processOwner: { register: async () =>
            {
                events.push('registered');
                return { retained: true };
            } },
            terminationGraceMs: 1, residualRoot: '/owned/residual', nugetPreparationOwner: capability });
        await execution.registrationReady;
        assert.deepEqual(events, ['registered']);
        if (variant === 'cancelled')
        {
            execution.terminate(new Error('controlled cancel'));
        }
        else
        {
            execution.resume();
        }
        const result = await execution.promise;
        if (variant === 'zero')
        {
            assert.equal(result.code, 0);
            assert.equal(result.physicalExecutionTermination.terminated, true);
            assert.equal(result.resourceExecutionAdmission, evidence.resourceExecutionAdmission);
            assert.deepEqual(events, ['registered', 'first-native-step']);
        }
        else
        {
            assert.notEqual(result.code, 0);
            assert.equal(result.physicalExecutionTermination.terminated, variant === 'post-cancel');
        }
    }
});

test('actual parent liveOwner body checks original issued owners and complete parent SDK binding for both purposes', (t) =>
{
    const actual = body('../../tools/test/nuget-preparation-owner.mjs', 'function liveOwner(', '\nexport function assertNugetPreparationOwner(');
    for (const purpose of ['behavior-doc', 'matrix-governance'])
    {
        const f = fixture(t); const r = reserve(f); const cap = Object.freeze({});
        const sdk = { executable: '/fixture-sdk/dotnet', sdkVersionRoster: ['10.0.302'], files: [{ path: 'compiler', sha256: 'a' }] };
        const closure = { purpose, packages: purpose === 'behavior-doc' ? 115 : 83 };
        const state = { root: f.root, runId: f.runId, purpose, stage: { id: purpose === 'behavior-doc'
            ? 'behavior-doc-nuget-preparation' : 'matrix-nuget-preparation' }, closed: false,
            lease: f.lease, sourceState: f.sourceState, reservations: [{ value: r.reservation, plan: r.expected.plan }],
            source: { current: true }, closure, sdk, systemdRuntime: null, systemdTransport: {}, feed: { root: '/inert-feed', treeDigest: 'feed' } };
        const owners = new WeakMap([[cap, state]]); let sdkDrift = false;
        const invoke = vm.runInNewContext('(' + actual.trim() + ')', { owners, Error, Object, JSON,
            equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
            assertProductionFreshExclusiveLease, assertProductionCapacityReservation,
            sealSourceIdentity: () => ({ current: true }), nugetPreparationClosure: (_root, actualPurpose) => {
                assert.equal(actualPurpose, purpose); return closure;
            }, observeNugetPreparationToolchain: (_root, sdkPurpose) => {
                assert.equal(sdkPurpose, 'matrix-governance'); // Toolchain bytes only, never a transfer purpose.
                return sdkDrift ? { ...sdk, files: [{ path: 'compiler', sha256: 'altered' }] } : structuredClone(sdk);
            }, observeNugetSystemdRuntimeRoot: () => null, inventoryNugetOfflineFeed: () => ({ treeDigest: 'feed' }) });
        const expected = { root: f.root, runId: f.runId, purpose, producerId: state.stage.id };
        assert.equal(invoke(cap, expected), state);
        sdkDrift = true;
        assert.throws(() => invoke(cap, expected), /source, SDK or archive declaration drifted/u);
        state.closed = true;
        assert.throws(() => invoke(cap, expected), /foreign, revoked/u);
        r.reservation.release();
    }
});

test('all six original wrapper routes keep controlled native argv and matrix-only SDK/descriptor ingress', () =>
{
    const wrapper = fileURLToPath(new URL('../../tools/test/run-matrix-governance-once.sh', import.meta.url));
    for (const consumerId of ['matrix-governance', 'validate-matrix', 'release-evidence-plan',
        'static-evidence-plan', 'static-matrix-contract', 'static-matrix-schema'])
    {
        const matrix = ['matrix-governance', 'validate-matrix'].includes(consumerId);
        const observed = execFileSync('bash', [wrapper, consumerId], { encoding: 'utf8',
            env: { ...process.env, FSUSBLOG_NODE: '/bin/echo', FSUSBLOG_MATRIX_NUGET_PREPARATION: '/descriptor' } });
        const argv = matrixGovernanceArguments({ root: process.cwd(), consumerId,
            preparationFile: matrix ? '/descriptor' : null });
        assert.ok(observed.includes('--producer-id ' + consumerId));
        assert.equal(observed.includes('--env FSUSBLOG_CONTENT_FIELD_DOTNET'), matrix);
        assert.equal(argv.includes('FSUSBLOG_CONTENT_FIELD_DOTNET'), matrix);
        assert.equal(argv.includes('--prepared-nuget'), matrix);
        assert.ok(observed.includes(argv.at(-1)));
        for (let index = 0; index < argv.length; index++)
            if (['--test-id', '--output'].includes(argv[index])) assert.ok(observed.includes(argv[index + 1]));
    }
});


test('additional BehaviorDoc SDK input is reread and joined to the original physical transfer, without changing purpose', (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-sdk-control-'));
    fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sdk = path.join(root, 'sdk-root');
    fs.mkdirSync(path.join(root, 'ops/docker'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ops/docker/FsusBlog.Server.Dockerfile'), 'ARG DOTNET_SDK_VERSION=10.0.302\nARG DOTNET_RUNTIME_VERSION=10.0.6\n');
    for (const relative of ['dotnet', 'sdk/10.0.302/MSBuild.dll', 'sdk/10.0.302/Roslyn/bincore/csc.dll',
        'host/fxr/10.0.6/libhostfxr.so', 'shared/Microsoft.NETCore.App/10.0.6/libcoreclr.so',
        'shared/Microsoft.NETCore.App/10.0.6/System.Private.CoreLib.dll', 'packs/Ref/10.0.6/ref.dll'])
    {
        const file = path.join(sdk, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, relative, { mode: 0o700 });
    }
    const previousPath = process.env.PATH;
    process.env.PATH = sdk;
    t.after(() => { process.env.PATH = previousPath; });
    const parentSdk = observePinnedNugetToolchain(root, path.join(sdk, 'dotnet'));
    const declaration = { purpose: 'behavior-doc', sdk: null, parentSdk };
    assert.deepEqual(observePreparedNugetParentSdk(root, declaration), parentSdk);
    assert.equal(declaration.sdk, null);
    assert.equal(observePreparedNugetParentSdk(root, { purpose: 'behavior-doc', sdk: null }), null);
    // These recording receipt fragments do not satisfy the native transfer validator or qualify execution.
    const physical = { parentSdk, toolchain: { absolutePath: parentSdk.executable, version: parentSdk.sdkVersion } };
    assertPreparedNugetParentSdkPhysical(physical, parentSdk);
    assert.throws(() => assertPreparedNugetParentSdkPhysical({ toolchain: physical.toolchain }, parentSdk), /original physical transfer/u);
    assert.throws(() => assertPreparedNugetParentSdkPhysical({ ...physical, toolchain: { ...physical.toolchain, absolutePath: '/foreign/dotnet' } }, parentSdk), /original physical transfer/u);
    assert.throws(() => observePreparedNugetParentSdk(root, { ...declaration, purpose: 'matrix-governance' }), /original BehaviorDoc purpose/u);
    for (const relative of ['sdk-manifests', 'metadata', 'workloads'])
    {
        const before = observePinnedNugetToolchain(root, path.join(sdk, 'dotnet'));
        const file = path.join(sdk, relative, 'fixture.props');
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'workload inputs');
        const after = observePinnedNugetToolchain(root, path.join(sdk, 'dotnet'));
        assert.notDeepEqual(after, before);
        assert.ok(after.files.some((entry) => entry.path === relative + '/fixture.props'));
    }
    fs.appendFileSync(path.join(sdk, 'packs/Ref/10.0.6/ref.dll'), 'drift');
    assert.throws(() => observePreparedNugetParentSdk(root, declaration), /bytes, roster or current dotnet selector drifted/u);
});


test('actual original atomic publication refuses cancellation during its asynchronous write window', async () =>
{
    const source = fs.readFileSync(new URL('../../tools/test/run-once.mjs', import.meta.url), 'utf8');
    const actual = source.slice(source.indexOf('async function writeJsonAtomic('), source.indexOf('\nfunction sanitizeSegment(', source.indexOf('async function writeJsonAtomic(')));
    const guard = source.slice(source.indexOf('function throwIfAborted('), source.indexOf('\nasync function ', source.indexOf('function throwIfAborted(')));
    for (const cancellation of ['none', 'write', 'after-commit'])
    {
        const controller = new AbortController(); const events = [];
        const sandbox = { path, Error, process: { pid: 1 }, randomUUID: () => 'control', JSON,
            mkdir: async () => events.push('mkdir'),
            writeFile: async () => { events.push('write'); if (cancellation === 'write') controller.abort(new Error('parent budget expired')); },
            renameSync: () =>
            {
                assert.equal(controller.signal.aborted, false);
                events.push('rename');
                if (cancellation === 'after-commit') queueMicrotask(() =>
                { events.push('cancel-after-commit'); controller.abort(new Error('parent budget expired')); });
            }, rename: async () => { throw new Error('asynchronous commit must not be called'); },
            rm: async () => events.push('remove-private-temporary') };
        const publish = vm.runInNewContext(guard + '\n(' + actual + ')', sandbox);
        if (cancellation === 'write') await assert.rejects(() => publish('/private-control/receipt.json', { status: 'success' }, controller.signal), /parent budget expired/u);
        else await publish('/private-control/receipt.json', { status: 'success' }, controller.signal);
        assert.equal(events.includes('rename'), cancellation !== 'write');
        assert.equal(events.includes('remove-private-temporary'), cancellation === 'write');
        // A later event cannot turn a pre-abort completed commit into an aborted-before-commit publication.
        if (cancellation === 'after-commit') assert.ok(events.indexOf('rename') < events.indexOf('cancel-after-commit'));
    }
});


test('actual consumer publisher refuses local cancellation during its transfer validation await', async () =>
{
    const source = fs.readFileSync(new URL('../../tools/test/run-deterministic-command.mjs', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('async function publishConsumerProjection('), source.indexOf('\nfunction git(', source.indexOf('async function publishConsumerProjection(')));
    const local = new AbortController(), parent = new AbortController();
    const combined = AbortSignal.any([local.signal, parent.signal]);
    let writes = 0;
    const publish = vm.runInNewContext('(' + body + ')', { path, sanitizeSegment: (v) => v,
        validateRunBoundProjection: async () => { local.abort(new Error('local SIGINT')); return {}; },
        fs: { mkdirSync: () => writes++ }, repoRoot: '/repository' });
    await assert.rejects(() => publish({ result: { receiptFile: '/control', projectionFile: '/control' },
        cwd: '/repository', directory: '.tmp/projection', runId: 'run', key: 'matrix', consumerId: 'validate-matrix',
        parentGuard: () => combined.throwIfAborted() }), /local SIGINT/u);
    assert.equal(parent.signal.aborted, false);
    assert.equal(writes, 0);
});


test('actual parent entry rejects a foreign source repository before lease, capacity or output writes', async (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-parent-source-'));
    fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await assert.rejects(() => runOwnedNugetPreparation({ repositoryRoot: root, runId: 'foreign',
        purpose: 'matrix-governance', cpuUnits: 1, memoryGiB: 1 }), /actual imported source repository/u);
    assert.deepEqual(fs.readdirSync(root), []);
});

test('actual issued readers open without blocking and reject a replaced non-regular opened descriptor', () =>
{
    const metadata = { dev: 1, ino: 2, mode: 0o100600, uid: 1, gid: 1, size: 10, ctimeMs: 3, mtimeMs: 3,
        nlink: 1, isFile: () => true, isSymbolicLink: () => false, isDirectory: () => true };
    for (const kind of ['fresh', 'capacity'])
    {
        const source = fs.readFileSync(new URL(kind === 'fresh'
            ? '../../tools/test-matrix/production-fresh-exclusive-lease.mjs' : '../../tools/test-matrix/production-capacity-reservation.mjs', import.meta.url), 'utf8');
        const name = kind === 'fresh' ? 'readIssuedOwner' : 'readPrivateReservation';
        const next = kind === 'fresh' ? 'immutableIssuedOwner' : 'recoverOrBlock';
        const body = source.slice(source.indexOf('function ' + name + '('), source.indexOf('\nfunction ' + next + '('));
        let flags = null, closed = false;
        const fakeFs = { constants: fs.constants, lstatSync: () => metadata,
            realpathSync: Object.assign((p) => p, { native: (p) => p }),
            openSync: (_p, options) => { flags = options; return 1; },
            fstatSync: () => ({ ...metadata, isFile: () => false }), closeSync: () => { closed = true; },
            readSync: () => { throw new Error('non-regular input must refuse before reading'); } };
        const reader = vm.runInNewContext('(' + body + ')', { fs: fakeFs, path,
            process: { platform: 'linux', getuid: () => 1 }, JSON, Error, Buffer,
            issuedRecordIdentity: () => ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'ctimeMs', 'mtimeMs'].map((field) => metadata[field]),
            assertPrivateReservationDirectory: () => {} });
        assert.throws(() => reader('/authority/active/record.json', kind === 'fresh'
            ? ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'ctimeMs', 'mtimeMs'].map((field) => metadata[field]) : '/authority'), /changed during open/u);
        assert.ok((flags & fs.constants.O_NONBLOCK) !== 0);
        assert.ok((flags & fs.constants.O_NOFOLLOW) !== 0);
        assert.equal(closed, true);
    }
});

test('actual preparation publication input guard rejects local cancellation before source or parent checks', () =>
{
    const source = fs.readFileSync(new URL('../../tools/docs/prepare-behavior-doc-nuget.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('        const assertInputs = () =>');
    const body = source.slice(start, source.indexOf('        assertInputs();', start));
    const local = new AbortController(), parent = new AbortController();
    local.abort(new Error('local SIGTERM'));
    let observations = 0;
    const guard = vm.runInNewContext(body + '\nassertInputs', { executionSignal: AbortSignal.any([local.signal, parent.signal]),
        parentOwner: {}, parentModule: { requireNugetPreparationExecution: () => observations++ } });
    assert.throws(guard, /local SIGTERM/u);
    assert.equal(parent.signal.aborted, false);
    assert.equal(observations, 0);
});

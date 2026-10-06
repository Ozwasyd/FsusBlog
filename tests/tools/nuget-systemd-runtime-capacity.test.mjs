import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readProductionDiskDemandCatalog, bindBehaviorDocNugetPreparationDiskDemand,
    bindNugetParentControlDiskDemand, buildProductionDiskDemandPlan } from '../../tools/test-matrix/production-disk-demand.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'tools/test/nuget-preparation-owner.mjs'), 'utf8');
const actual = (name, next) => source.slice(source.indexOf('function ' + name + '('), source.indexOf('\n' + next, source.indexOf('function ' + name + '(')));
const observerBody = actual('observeNugetSystemdRuntimeRoot', '/** Only the fixed parent');
function fixture()
{
    let device = 46, inode = 97, free = 10_000, alias = false, badUid = false;
    const identity = { uid: 1000, busSocket: { path: '/run/user/1000/bus', device: 46, inode: 71 }, managerConnection: { pid: 52 } };
    const observe = vm.runInNewContext('(' + observerBody + ')', { path, Error,
        process: { getuid: () => 1000, env: { XDG_RUNTIME_DIR: '/spoofed/runtime' } },
        fs: { realpathSync: (p) => alias ? '/alias' : p,
            lstatSync: (p) => ({ isDirectory: () => true, isSymbolicLink: () => false,
                uid: badUid ? 999 : 1000, gid: 1000, dev: device, ino: inode,
                mode: p === '/run/user/1000' ? 0o40700 : 0o40755, mtimeMs: free }) },
        canonicalFilesystemIdentity: (p) => ({ filesystemIdentity: 'linux:device:' + device + ':type:tmpfs', canonicalPath: p, availableBytes: free }) });
    return { observe: () => observe({ runtimeIdentity: () => structuredClone(identity) }), identity,
        change: (field, value) => { if (field === 'free') free = value; if (field === 'device') device = value;
            if (field === 'inode') inode = value; if (field === 'alias') alias = value; if (field === 'badUid') badUid = value; } };
}

test('actual original runtime input derives literal UID target, ignores XDG and excludes changing directory times/free capacity', () =>
{
    const f = fixture(), first = f.observe();
    assert.equal(first.root, '/run/user/1000/systemd/transient');
    f.change('free', 8_000); assert.deepEqual(f.observe(), first);
    f.change('device', 99); assert.notDeepEqual(f.observe(), first);
    f.change('device', 46); f.change('inode', 98); assert.notDeepEqual(f.observe(), first);
});

test('actual runtime input rejects foreign bus/UID, aliases and foreign directory ownership before budget roots', () =>
{
    for (const variant of ['bus', 'uid', 'alias', 'badUid'])
    {
        const f = fixture();
        if (variant === 'bus') f.identity.busSocket.path = '/spoofed/runtime/bus';
        if (variant === 'uid') f.identity.uid = 999;
        if (variant === 'alias' || variant === 'badUid') f.change(variant, true);
        assert.throws(f.observe, /original current-UID bus|literal and current-UID/u);
    }
});

test('original plan unions the real runtime filesystem separately and retains each demand and filesystem safety', () =>
{
    const catalog = bindNugetParentControlDiskDemand(bindBehaviorDocNugetPreparationDiskDemand(readProductionDiskDemandCatalog(root),
        { allocatedBytes: 1024, expandedAllocatedBytes: 4096, treeDigest: 'a'.repeat(64) }, 'matrix-governance'), 'matrix-nuget-preparation');
    const roots = Object.fromEntries(Object.values(catalog.rootBindings).map((binding) => [binding, '/vdb/' + binding]));
    roots.nugetSystemdManagementRoot = '/var/tmp'; roots.nugetSystemdRuntimeRoot = '/run/user/1000/systemd/transient';
    const resolveFilesystem = (p) => ({ filesystemIdentity: p.startsWith('/run/') ? 'tmpfs:46' : p === '/var/tmp' ? 'disk:64771' : 'vdb:8',
        canonicalPath: p, availableBytes: 10 ** 10 });
    const options = { root, roots, catalog, maxParallel: 1, tiers: [{ id: 'matrix-nuget-preparation', executionDependsOn: [], exclusiveResources: [] }], resolveFilesystem };
    const plan = buildProductionDiskDemandPlan(options);
    const runtime = plan.filesystems.find((entry) => entry.filesystemIdentity === 'tmpfs:46');
    assert.deepEqual(runtime.rootIds, ['nuget-systemd-runtime']);
    assert.equal(runtime.safetyBytes, catalog.safetyBytes);
    assert.equal(runtime.requestedBytes, 3 * 67108864);
    const demand = plan.producerDeclarations.find((entry) => entry.rootId === 'nuget-systemd-runtime');
    for (const field of ['peakAdditionalBytes', 'terminalRetainedBytes', 'rollbackOrRecoveryBytes', 'uncertaintyBytes']) assert.equal(demand[field], 67108864);
    const missing = { ...roots }; delete missing.nugetSystemdRuntimeRoot;
    assert.throws(() => buildProductionDiskDemandPlan({ ...options, roots: missing }), /root nuget-systemd-runtime cannot be resolved/u);
});

test('actual private genuine transport wrapper guards every positive mutation and preserves readonly/stop cleanup after refusal', () =>
{
    const wrap = vm.runInNewContext('(' + actual('guardNugetSystemdTransport', 'function guardNugetSystemdMutation') + ')', { Object });
    const events = []; let reject = false;
    const original = Object.fromEntries(['start', 'startLauncher', 'setLimits', 'stop', 'runtimeIdentity', 'inspect', 'cgroup', 'artifacts']
        .map((name) => [name, (...argv) => { events.push(name); return { name, argv }; }]));
    const guarded = wrap(original, () => { events.push('guard'); if (reject) throw new Error('original capacity refused'); });
    for (const name of ['start', 'startLauncher', 'setLimits'])
    {
        events.length = 0; assert.equal(guarded[name]('original-arg').argv[0], 'original-arg'); assert.deepEqual(events, ['guard', name]);
        reject = true; events.length = 0; assert.throws(() => guarded[name]('original-arg'), /original capacity refused/u); assert.deepEqual(events, ['guard']); reject = false;
    }
    reject = true;
    for (const name of ['stop', 'runtimeIdentity', 'inspect', 'cgroup', 'artifacts'])
    { events.length = 0; guarded[name]('owned'); assert.deepEqual(events, [name]); }
});

test('actual original physical beforeCreation callback guards before effect and returns the original retained digest', () =>
{
    const start = source.indexOf('markManagedContainmentCreationAttempt: ');
    const callback = source.slice(start + 'markManagedContainmentCreationAttempt: '.length, source.indexOf(',\n                    registerManagedProcess:', start));
    let reject = false; const events = [];
    const invoke = vm.runInNewContext('(' + callback + ')', { capability: {}, buildLayout: {},
        guardNugetSystemdMutation: () => { events.push('guard'); if (reject) throw new Error('runtime drift'); },
        markProductionBuildServiceCreationAttempt: (_layout, authority, sender) => { events.push('retain'); return { authorityDigest: authority.digest, sender }; } });
    assert.deepEqual(invoke({ digest: 'original' }, null, 'sender'), { authorityDigest: 'original', sender: 'sender' });
    assert.deepEqual(events, ['guard', 'retain']); events.length = 0; reject = true;
    assert.throws(() => invoke({ digest: 'original' }, null, 'sender'), /runtime drift/u); assert.deepEqual(events, ['guard']);
});

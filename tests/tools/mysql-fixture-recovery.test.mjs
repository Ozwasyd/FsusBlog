import assert from 'node:assert/strict';
import test from 'node:test';

function retainedMySqlRecoveryFixture()
{
    const controller = { pid: 123, processStartIdentity: 'original-start', executableDigest: 'sha256:' + 'a'.repeat(64), commandDigest: 'sha256:' + 'b'.repeat(64) };
    const binding = { root: '/owned/repository', runId: 'owned-run', namespace: 'owned-namespace',
        sourceState: { commit: 'c'.repeat(40), worktreeFingerprint: 'sha256:' + 'd'.repeat(64) },
        resourceBundleIds: ['backend-tests'], schedulerOwner: controller };
    const context = { root: binding.root, runId: binding.runId, namespace: binding.namespace,
        sourceState: { ...binding.sourceState }, bundleId: 'backend-tests', stepId: 'migration-services' };
    const record = { context, stateFile: '/owned/repository/retained/mysql/state.json',
        bindingDigest: 'sha256:' + 'e'.repeat(64), status: 'prepared' };
    const canonicalStateFile = record.stateFile;
    const calls = [];
    const lifecycle = {
        readRetainedMySqlFixtureLifecycle(value, digest)
        {
            calls.push('read');
            assert.deepEqual(value, context);
            assert.equal(digest, record.bindingDigest);
            return { paths: { stateFile: canonicalStateFile }, state: { controllerIdentity: controller } };
        },
        async recoverMySqlFixtureService(value, options)
        {
            calls.push('recover');
            assert.deepEqual(value, context);
            assert.equal(options.expectedBindingDigest, record.bindingDigest);
        },
        verifyMySqlFixtureServiceCleanup(value, options)
        {
            calls.push('verify');
            assert.deepEqual(value, context);
            assert.equal(options.expectedBindingDigest, record.bindingDigest);
            return { qualificationEligible: false, stateFile: record.stateFile,
                bindingDigest: record.bindingDigest, stateDigest: 'sha256:' + 'f'.repeat(64),
                cleanup: { containerAbsent: true, credentialsRemoved: true } };
        }
    };
    return { binding, allocations: { 'physical-backend-tests': record }, record, context, controller, calls, lifecycle,
        assertRecovery: () => calls.push('guard') };
}

test('scheduler MySQL recovery proves both cleanup observations without qualifying execution', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const result = await reconcileRetainedMySqlFixtureServices(fixture);
    assert.deepEqual(fixture.calls.filter(value => value !== 'guard'), ['read', 'recover', 'verify']);
    assert.equal(result.length, 1);
    assert.equal(result[0].qualificationEligible, false);
    assert.deepEqual(result[0].cleanup, { containerAbsent: true, credentialsRemoved: true });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result[0]), true);
});


test('scheduler MySQL recovery rejects root before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.root = '/foreign';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects run before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.runId = 'foreign';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects namespace before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.namespace = 'foreign';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects source commit before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.sourceState.commit = '0'.repeat(40);
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects source fingerprint before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.sourceState.worktreeFingerprint = 'sha256:' + '0'.repeat(64);
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects bundle before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.bundleId = 'frontend';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects step before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.stepId = 'foreign';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects resource roster before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.binding.resourceBundleIds = [];
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects missing digest before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    delete fixture.record.bindingDigest;
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects unknown status before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.record.status = 'assumed';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects unknown field before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.record.approved = true;
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects a foreign retained controller and duplicate allocation before cleanup', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    for (const key of ['pid', 'processStartIdentity', 'executableDigest', 'commandDigest'])
    {
        const fixture = retainedMySqlRecoveryFixture();
        fixture.binding.schedulerOwner = { ...fixture.controller, [key]: key === 'pid' ? 124 : 'foreign' };
        await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /foreign path, controller or duplicate identity/u);
        assert.equal(fixture.calls.includes('recover'), false);
    }
    const duplicate = retainedMySqlRecoveryFixture();
    duplicate.allocations.second = structuredClone(duplicate.record);
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(duplicate), /foreign path, controller or duplicate identity/u);
    assert.equal(duplicate.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects incomplete cleanup and preserves the original lifecycle failure', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    for (const key of ['containerAbsent', 'credentialsRemoved'])
    {
        const fixture = retainedMySqlRecoveryFixture();
        const verify = fixture.lifecycle.verifyMySqlFixtureServiceCleanup;
        fixture.lifecycle.verifyMySqlFixtureServiceCleanup = (...args) =>
        {
            const observed = verify(...args);
            observed.cleanup[key] = false;
            return observed;
        };
        await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /prove exact container and credential cleanup/u);
    }
    const failed = retainedMySqlRecoveryFixture();
    const original = new Error('owned container still present');
    failed.lifecycle.recoverMySqlFixtureService = async () =>
    {
        throw original;
    };
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(failed), error => error === original);
    assert.equal(failed.calls.includes('verify'), false);
});

test('scheduler MySQL recovery requires the held guard and treats no allocation as zero work', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices({ ...fixture, assertRecovery: undefined }), /acquired recovery guard/u);
    const original = new Error('recovery lease lost');
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices({ ...fixture, assertRecovery: () =>
    {
        throw original;
    } }), error => error === original);
    assert.deepEqual(await reconcileRetainedMySqlFixtureServices({ ...fixture, allocations: undefined }), []);
    assert.deepEqual(await reconcileRetainedMySqlFixtureServices({ ...fixture, allocations: {} }), []);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery supports the independent standalone resource identity without adopting it', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.bundleId = 'matrix:backend-unit';
    fixture.binding.resourceBundleIds = ['backend-unit'];
    const results = await reconcileRetainedMySqlFixtureServices(fixture);
    assert.equal(results[0].qualificationEligible, false);
    assert.equal(fixture.context.bundleId, 'matrix:backend-unit');
});

test('scheduler MySQL recovery preflights foreign paths and later allocations before any cleanup', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const foreignPath = retainedMySqlRecoveryFixture();
    foreignPath.record.stateFile = '/foreign/state.json';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(foreignPath), /foreign path/u);
    assert.equal(foreignPath.calls.includes('recover'), false);
    const later = retainedMySqlRecoveryFixture();
    later.allocations.second = structuredClone(later.record);
    later.allocations.second.context.runId = 'foreign';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(later), /original run\/source\/resource binding/u);
    assert.equal(later.calls.includes('recover'), false);
});

test('scheduler MySQL recovery refuses a lease lost during cleanup without accepting its result', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const original = new Error('held scheduler recovery lease changed');
    let held = true;
    fixture.assertRecovery = () =>
    {
        if (!held)
        {
            throw original;
        }
    };
    fixture.lifecycle.recoverMySqlFixtureService = async () =>
    {
        fixture.calls.push('recover');
        held = false;
    };
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), error => error === original);
    assert.equal(fixture.calls.includes('verify'), false);
});

test('scheduler MySQL recovery completion reobserves the exact state before grant release and seals replay', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = await reconcileRetainedMySqlFixtureServices(fixture);
    fixture.calls.length = 0;
    assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records });
    assert.deepEqual(fixture.calls, ['verify']);
    fixture.record.status = 'cleaned';
    fixture.record.cleanup = { containerAbsent: true, credentialsRemoved: true };
    assertRetainedMySqlFixtureRecoveryComplete({ allocations: fixture.allocations, records: structuredClone(records), requireCleaned: true });
    assert.deepEqual(fixture.calls, ['verify'], 'durable replay validation must not claim a new live observation');
});


test('scheduler MySQL recovery completion rejects absent proof before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records.length = 0;
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects foreign tier before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].tierId = 'foreign';
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects foreign path before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].stateFile = '/foreign/state.json';
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects foreign digest before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].bindingDigest = 'sha256:' + '0'.repeat(64);
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects missing state digest before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    delete records[0].stateDigest;
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects missing container absence before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].cleanup.containerAbsent = false;
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects missing credential removal before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].cleanup.credentialsRemoved = false;
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects forged qualification before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].qualificationEligible = true;
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects unknown proof field before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].approved = true;
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects unknown cleanup field before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].cleanup.approved = true;
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects stale cleanup observations and preserves observer failures', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    for (const mutate of [
        observed => observed.stateDigest = 'sha256:' + '0'.repeat(64),
        observed => observed.stateFile = '/foreign/state.json',
        observed => observed.bindingDigest = 'sha256:' + '0'.repeat(64),
        observed => observed.cleanup.containerAbsent = false,
        observed => observed.cleanup.credentialsRemoved = false,
        observed => observed.qualificationEligible = true
    ])
    {
        const fixture = retainedMySqlRecoveryFixture();
        const records = await reconcileRetainedMySqlFixtureServices(fixture);
        const verify = fixture.lifecycle.verifyMySqlFixtureServiceCleanup;
        fixture.lifecycle.verifyMySqlFixtureServiceCleanup = (...args) =>
        {
            const observed = verify(...args);
            mutate(observed);
            return observed;
        };
        assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /changed before grant release/u);
    }
    const fixture = retainedMySqlRecoveryFixture();
    const records = await reconcileRetainedMySqlFixtureServices(fixture);
    const original = new Error('Docker daemon identity no longer matches');
    fixture.lifecycle.verifyMySqlFixtureServiceCleanup = () =>
    {
        throw original;
    };
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), error => error === original);
});

test('scheduler MySQL recovery completion rejects incomplete durable cleanup and malformed rosters', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = await reconcileRetainedMySqlFixtureServices(fixture);
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records, requireCleaned: true }), /crosses its retained allocation/u);
    fixture.record.status = 'cleaned';
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records, requireCleaned: true }), /crosses its retained allocation/u);
    for (const allocations of [null, [], 'foreign'])
    {
        assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ allocations, records: [] }), /retained allocation map/u);
    }
    for (const value of [undefined, null, {}])
    {
        assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ allocations: undefined, records: value }), /allocation roster/u);
    }
    const duplicate = structuredClone(records);
    duplicate.push(structuredClone(duplicate[0]));
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ allocations: { ...fixture.allocations, second: fixture.record }, records: duplicate }), /invalid cleanup proof/u);
    assertRetainedMySqlFixtureRecoveryComplete({ allocations: undefined, records: [] });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { currentProcessIdentity } = await import(new URL("../../tools/test/process-identity.mjs", import.meta.url));
const { parseMatrix } = await import(new URL("../../tools/test-matrix/parse-matrix.mjs", import.meta.url));
const { acquireProductionCapacityReservation } = await import(new URL("../../tools/test-matrix/production-capacity-reservation.mjs", import.meta.url));
const { buildProductionDiskDemandPlan, calculateProductionDiskPeak, canonicalFilesystemIdentity, productionDiskDemandDigest, readProductionDiskDemandCatalog, remeasureProductionFilesystemAvailability } = await import(new URL("../../tools/test-matrix/production-disk-demand.mjs", import.meta.url));

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

test('catalog exactly covers Production pre-admission and physical disk owners', () =>
{
    const catalog = readProductionDiskDemandCatalog(repositoryRoot);
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    const physicalProducerIds = [
        'behavior-doc-static-admission',
        'logical-projection-resume',
        ...matrix.localProfiles.production.bundles.map((producer) => producer.id),
        'managed-production-build-gc'
    ].sort();
    assert.deepEqual(
        catalog.producers.map((producer) => producer.producerId).sort(),
        physicalProducerIds);
    for (const producer of catalog.producers)
    {
        assert.ok(producer.demands.length > 0);
        for (const demand of producer.demands)
        {
            assert.ok(demand.peakAdditionalBytes > 0);
            assert.ok(demand.uncertaintyBytes > 0);
            assert.ok(demand.sourceOfEstimate.length > 12);
        }
    }
});

test('canonical identity merges a path and symlink on the same filesystem', (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-identity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, 'real');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias, 'dir');
    assert.equal(
        canonicalFilesystemIdentity(real).filesystemIdentity,
        canonicalFilesystemIdentity(alias).filesystemIdentity);
});

test('capacity remeasurement exact-matches filesystem identity and fails closed on unknown capacity', () =>
{
    const filesystem = {
        filesystemIdentity: 'linux:device:7:type:fixture',
        canonicalPaths: ['/planned/leaf'],
        rootIds: ['fixture']
    };
    assert.equal(remeasureProductionFilesystemAvailability(filesystem, {
        resolveFilesystem: () => ({
            filesystemIdentity: filesystem.filesystemIdentity,
            canonicalPath: '/planned',
            availableBytes: 8192
        })
    }), 8192);
    assert.throws(() => remeasureProductionFilesystemAvailability(filesystem, {
        resolveFilesystem: () => ({
            filesystemIdentity: 'linux:device:8:type:fixture',
            canonicalPath: '/planned',
            availableBytes: 8192
        })
    }), /filesystem identity drifted/u);
    assert.throws(() => remeasureProductionFilesystemAvailability(filesystem, {
        resolveFilesystem: () => ({
            filesystemIdentity: filesystem.filesystemIdentity,
            canonicalPath: '/planned',
            availableBytes: Number.NaN
        })
    }), /capacity is unknown/u);
});

test('filesystem type is required for a canonical capacity identity', () =>
{
    assert.throws(() => canonicalFilesystemIdentity('/planned/leaf', {
        lstat: () => ({}),
        realpath: (candidate) => candidate,
        stat: () => ({ dev: 7 }),
        statfs: () => ({ bavail: 8, bsize: 1024 })
    }), /filesystem type is unknown/u);
});

test('filesystem path resolution does not turn permission errors into ancestor fallback', () =>
{
    const permissionError = Object.assign(new Error('fixture permission denied'), {
        code: 'EACCES'
    });
    assert.throws(() => canonicalFilesystemIdentity('/planned/leaf', {
        lstat: () =>
        {
            throw permissionError;
        },
        realpath: (candidate) => candidate,
        stat: () => ({ dev: 7 }),
        statfs: () => ({ type: 'fixture', bavail: 8, bsize: 1024 })
    }), /fixture permission denied/u);
});

test('peak calculation uses concurrent DAG live sets and retained terminal bytes', () =>
{
    const tiers = [
        { id: 'a', executionDependsOn: [], exclusiveResources: [] },
        { id: 'b', executionDependsOn: [], exclusiveResources: [] },
        { id: 'c', executionDependsOn: ['a', 'b'], exclusiveResources: [] }
    ];
    const demand = (peak, terminal) => [{
        rootId: 'run-output',
        peakAdditionalBytes: peak,
        terminalRetainedBytes: terminal,
        rollbackOrRecoveryBytes: 10,
        uncertaintyBytes: 5
    }];
    const peak = calculateProductionDiskPeak({
        tiers,
        declarationsByProducer: new Map([
            ['a', demand(100, 40)],
            ['b', demand(200, 50)],
            ['c', demand(80, 20)]
        ]),
        maxParallel: 2
    });
    assert.equal(peak.get('run-output'), 330);
});

test('plan merges same-filesystem roots once and preserves different filesystems', () =>
{
    const catalog = {
        schema: 'fsusblog.production-disk-demand-catalog.v1',
        estimatorVersion: 'fixture-v1',
        safetyBytes: 10,
        rootBindings: { first: 'firstPath', second: 'secondPath', docker: 'dockerPath' },
        producers: [{
            producerId: 'producer',
            demands: [
                { rootId: 'first', peakAdditionalBytes: 100, terminalRetainedBytes: 10, rollbackOrRecoveryBytes: 5, concurrencyClass: 'x', uncertaintyBytes: 5, sourceOfEstimate: 'fixture measurement' },
                { rootId: 'second', peakAdditionalBytes: 200, terminalRetainedBytes: 10, rollbackOrRecoveryBytes: 5, concurrencyClass: 'x', uncertaintyBytes: 5, sourceOfEstimate: 'fixture measurement' },
                { rootId: 'docker', peakAdditionalBytes: 300, terminalRetainedBytes: 10, rollbackOrRecoveryBytes: 5, concurrencyClass: 'x', uncertaintyBytes: 5, sourceOfEstimate: 'fixture measurement' }
            ]
        }]
    };
    const identities = new Map([
        ['/first', { filesystemIdentity: 'fs-a', canonicalPath: '/first', availableBytes: 1000 }],
        ['/second', { filesystemIdentity: 'fs-a', canonicalPath: '/second', availableBytes: 900 }],
        ['/docker', { filesystemIdentity: 'fs-b', canonicalPath: '/docker', availableBytes: 2000 }]
    ]);
    const plan = buildProductionDiskDemandPlan({
        root: repositoryRoot,
        tiers: [{ id: 'producer', executionDependsOn: [], exclusiveResources: [] }],
        roots: { firstPath: '/first', secondPath: '/second', dockerPath: '/docker' },
        maxParallel: 1,
        catalog,
        resolveFilesystem: (candidate) => identities.get(candidate)
    });
    assert.equal(plan.filesystems.length, 2);
    assert.deepEqual(plan.filesystems.find((entry) => entry.filesystemIdentity === 'fs-a').rootIds, ['first', 'second']);
    assert.equal(plan.filesystems.find((entry) => entry.filesystemIdentity === 'fs-a').observedFreeBytes, 900);
});

test('same-filesystem admission uses one DAG-state peak instead of summing per-root maxima', (t) =>
{
    const catalog = {
        schema: 'fsusblog.production-disk-demand-catalog.v1',
        estimatorVersion: 'fixture-v1',
        safetyBytes: 10,
        rootBindings: { first: 'firstPath', second: 'secondPath' },
        producers: [
            {
                producerId: 'first-producer',
                demands: [{
                    rootId: 'first',
                    peakAdditionalBytes: 100,
                    terminalRetainedBytes: 0,
                    rollbackOrRecoveryBytes: 0,
                    concurrencyClass: 'sequential',
                    uncertaintyBytes: 1,
                    sourceOfEstimate: 'fixture measurement'
                }]
            },
            {
                producerId: 'second-producer',
                demands: [{
                    rootId: 'second',
                    peakAdditionalBytes: 100,
                    terminalRetainedBytes: 0,
                    rollbackOrRecoveryBytes: 0,
                    concurrencyClass: 'sequential',
                    uncertaintyBytes: 1,
                    sourceOfEstimate: 'fixture measurement'
                }]
            }
        ]
    };
    const plan = buildProductionDiskDemandPlan({
        root: repositoryRoot,
        tiers: [
            { id: 'first-producer', executionDependsOn: [], exclusiveResources: [] },
            { id: 'second-producer', executionDependsOn: ['first-producer'], exclusiveResources: [] }
        ],
        roots: { firstPath: '/first', secondPath: '/second' },
        maxParallel: 2,
        catalog,
        resolveFilesystem: (candidate) => ({
            filesystemIdentity: 'fs-shared',
            canonicalPath: candidate,
            availableBytes: 150
        })
    });
    assert.deepEqual(
        plan.rootDemandPeaks.map(({ rootId, requestedBytes }) => ({ rootId, requestedBytes })),
        [
            { rootId: 'first', requestedBytes: 101 },
            { rootId: 'second', requestedBytes: 101 }
        ]);
    assert.equal(plan.filesystems[0].requestedBytes, 101);
    assert.equal(plan.filesystems[0].safetyBytes, 10);

    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-peak-admission-'));
    const reservationRoot = path.join(parent, 'capacity-authority');
    const reservationRepository = path.join(parent, 'repository');
    fs.mkdirSync(reservationRepository);
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const reservation = acquireProductionCapacityReservation({
        plan,
        runId: 'same-state-peak',
        candidateIdentityDigest: productionDiskDemandDigest('same-state-candidate'),
        repositoryRoot: reservationRepository,
        repositoryLeaseOwner: { ownerToken: 'same-state-lease-owner' },
        authorityRoot: reservationRoot,
        ownerIdentity: currentProcessIdentity(),
        remeasureFilesystem: () => 150
    });
    assert.equal(reservation.receipt.filesystems[0].admittedBytes, 111);
    reservation.release('released');
});

test('Production maxParallel two has an exact same-state host filesystem peak', () =>
{
    const catalog = readProductionDiskDemandCatalog(repositoryRoot);
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    const managedGc = {
        id: 'managed-production-build-gc',
        executionDependsOn: ['behavior-doc-static-admission'],
        exclusiveResources: ['build-root-gc', 'disk-heavy']
    };
    const tiers = [
        {
            id: 'behavior-doc-static-admission',
            executionDependsOn: [],
            exclusiveResources: ['behavior-doc-contract-build']
        },
        managedGc,
        ...matrix.localProfiles.production.bundles.map((producer) => ({
            id: producer.id,
            executionDependsOn: [
                'behavior-doc-static-admission',
                managedGc.id,
                ...producer.dependsOn.filter((dependency) => dependency !== 'behavior-doc-static-admission')
            ],
            exclusiveResources: producer.exclusiveResources
        }))
    ];
    const roots = Object.fromEntries(
        Object.values(catalog.rootBindings).map((binding) => [binding, `/${binding}`]));
    const plan = buildProductionDiskDemandPlan({
        root: repositoryRoot,
        tiers,
        roots,
        maxParallel: 2,
        catalog,
        resolveFilesystem: (candidate) => ({
            filesystemIdentity: candidate === '/dockerStorageRoot' ? 'fs-docker' : 'fs-host',
            canonicalPath: candidate,
            availableBytes: Number.MAX_SAFE_INTEGER
        })
    });
    const hostFilesystem = plan.filesystems.find((entry) => entry.filesystemIdentity === 'fs-host');
    assert.equal(hostFilesystem.requestedBytes, 19_886_243_840);
    assert.notEqual(hostFilesystem.requestedBytes, 22_699_573_248);
    assert.equal(
        plan.rootDemandPeaks
            .filter((entry) => entry.filesystemIdentity === 'fs-host')
            .reduce((total, entry) => total + entry.requestedBytes, 0),
        23_314_038_784);
});

test('BehaviorDoc cache hit and miss reserve one digest-bound worst-case declaration', () =>
{
    const catalog = readProductionDiskDemandCatalog(repositoryRoot);
    const declaration = catalog.producers
        .find((producer) => producer.producerId === 'behavior-doc-static-admission')
        ?.demands[0];
    assert.equal(declaration?.rootId, 'behavior-doc-cache');
    assert.equal(declaration?.peakAdditionalBytes, 402_653_184);
    assert.equal(declaration?.terminalRetainedBytes, 402_653_184);
    assert.equal(declaration?.reusePolicy, 'reserve-worst-case-on-cache-hit-and-cache-miss');
    const behaviorDemands = catalog.producers
        .find((producer) => producer.producerId === 'behavior-doc-static-admission')
        .demands;
    assert.deepEqual(
        behaviorDemands.map((entry) => entry.rootId),
        ['behavior-doc-cache', 'behavior-doc-observations', 'os-temp']);
    assert.ok(behaviorDemands.every((entry) =>
        entry.reusePolicy === 'reserve-worst-case-on-cache-hit-and-cache-miss'));

    const roots = Object.fromEntries(
        Object.values(catalog.rootBindings).map((binding) => [binding, `/${binding}`]));
    const tier = {
        id: 'behavior-doc-static-admission',
        executionDependsOn: [],
        exclusiveResources: ['behavior-doc-contract-build']
    };
    const resolveFilesystem = (candidate) => ({
        filesystemIdentity: 'fs-host',
        canonicalPath: candidate,
        availableBytes: Number.MAX_SAFE_INTEGER
    });
    const first = buildProductionDiskDemandPlan({
        root: repositoryRoot,
        tiers: [tier],
        roots,
        maxParallel: 1,
        catalog,
        resolveFilesystem
    });
    const second = buildProductionDiskDemandPlan({
        root: repositoryRoot,
        tiers: [tier],
        roots,
        maxParallel: 1,
        catalog,
        resolveFilesystem
    });
    assert.equal(first.planDigest, second.planDigest);
    assert.equal(first.producerDeclarationDigest, second.producerDeclarationDigest);
    assert.equal(first.filesystems[0].requestedBytes, 649_068_544);

    const driftedCatalog = structuredClone(catalog);
    driftedCatalog.producers
        .find((producer) => producer.producerId === 'behavior-doc-static-admission')
        .demands[0].reusePolicy = 'cache-hit-is-free';
    assert.throws(() => buildProductionDiskDemandPlan({
        root: repositoryRoot,
        tiers: [tier],
        roots,
        maxParallel: 1,
        catalog: driftedCatalog,
        resolveFilesystem
    }), /cache reuse policy drifted/u);
});

test('projection-only resume demand excludes every physical producer and managed GC', () =>
{
    const catalog = readProductionDiskDemandCatalog(repositoryRoot);
    const roots = Object.fromEntries(
        Object.values(catalog.rootBindings).map((binding) => [binding, `/${binding}`]));
    const plan = buildProductionDiskDemandPlan({
        root: repositoryRoot,
        tiers: [
            {
                id: 'behavior-doc-static-admission',
                executionDependsOn: [],
                exclusiveResources: ['behavior-doc-contract-build']
            },
            {
                id: 'logical-projection-resume',
                executionDependsOn: ['behavior-doc-static-admission'],
                exclusiveResources: ['projection-finalization'],
                capacityIdentity: `sha256:${'a'.repeat(64)}`
            }
        ],
        roots,
        maxParallel: 2,
        catalog,
        resolveFilesystem: (candidate) => ({
            filesystemIdentity: 'fs-host',
            canonicalPath: candidate,
            availableBytes: Number.MAX_SAFE_INTEGER
        })
    });
    assert.deepEqual(
        [...new Set(plan.producerDeclarations.map((entry) => entry.producerId))],
        ['behavior-doc-static-admission', 'logical-projection-resume']);
    assert.equal(
        plan.producerDeclarations.some((entry) =>
            ['managed-production-build-gc', 'build-static', 'backend-tests', 'frontend-tests',
                'runtime-browser', 'performance-evidence'].includes(entry.producerId)),
        false);
    const changed = buildProductionDiskDemandPlan({
        root: repositoryRoot,
        tiers: [
            {
                id: 'behavior-doc-static-admission',
                executionDependsOn: [],
                exclusiveResources: ['behavior-doc-contract-build']
            },
            {
                id: 'logical-projection-resume',
                executionDependsOn: ['behavior-doc-static-admission'],
                exclusiveResources: ['projection-finalization'],
                capacityIdentity: `sha256:${'b'.repeat(64)}`
            }
        ],
        roots,
        maxParallel: 2,
        catalog,
        resolveFilesystem: (candidate) => ({
            filesystemIdentity: 'fs-host',
            canonicalPath: candidate,
            availableBytes: Number.MAX_SAFE_INTEGER
        })
    });
    assert.notEqual(changed.planDigest, plan.planDigest);
    assert.throws(() => buildProductionDiskDemandPlan({
        root: repositoryRoot,
        tiers: [
            {
                id: 'behavior-doc-static-admission',
                executionDependsOn: [],
                exclusiveResources: ['behavior-doc-contract-build']
            },
            {
                id: 'logical-projection-resume',
                executionDependsOn: ['behavior-doc-static-admission'],
                exclusiveResources: ['projection-finalization']
            }
        ],
        roots,
        maxParallel: 2,
        catalog,
        resolveFilesystem: (candidate) => ({
            filesystemIdentity: 'fs-host',
            canonicalPath: candidate,
            availableBytes: Number.MAX_SAFE_INTEGER
        })
    }), /capacity identity must bind the checkpoint authority digest/u);
});

test('unknown Docker/root identity fails closed', () =>
{
    const catalog = {
        schema: 'fsusblog.production-disk-demand-catalog.v1',
        estimatorVersion: 'fixture-v1',
        safetyBytes: 10,
        rootBindings: { docker: 'dockerPath' },
        producers: [{
            producerId: 'producer',
            demands: [{
                rootId: 'docker',
                peakAdditionalBytes: 1,
                terminalRetainedBytes: 0,
                rollbackOrRecoveryBytes: 1,
                concurrencyClass: 'docker',
                uncertaintyBytes: 1,
                sourceOfEstimate: 'fixture measurement'
            }]
        }]
    };
    assert.throws(() => buildProductionDiskDemandPlan({
        root: repositoryRoot,
        tiers: [{ id: 'producer', executionDependsOn: [], exclusiveResources: [] }],
        roots: { dockerPath: '/unknown' },
        maxParallel: 1,
        catalog,
        resolveFilesystem: () =>
        {
            throw new Error('unknown volume');
        }
    }), /unknown volume/u);
});

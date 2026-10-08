import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { compilePhysicalProducerFilesystemPlan, physicalProducerFilesystemCatalogSchema } = await import(new URL('../../tools/test-matrix/physical-producer-filesystem.mjs', import.meta.url));
const { compilePhysicalProducerGcOrdering } = await import(new URL('../../tools/test-matrix/physical-producer-gc-ordering.mjs', import.meta.url));
const { runDag } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));

function fixture(t)
{
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'physical-gc-ordering-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const builds = path.join(root, 'builds');
    const source = path.join(root, 'source');
    fs.mkdirSync(builds);
    fs.mkdirSync(source);
    const input = {
        catalog: {
            schema: physicalProducerFilesystemCatalogSchema,
            domains: [
                { domainId: 'managed-builds', rootIds: ['build-pool', 'current'], sourceOfDeclaration: 'explicit managed build domain' },
                { domainId: 'repository-source', rootIds: ['source'], sourceOfDeclaration: 'explicit repository source domain' }
            ],
            producers: [
                { producerId: 'collector', ownerKind: 'executable', sourceOfDeclaration: 'explicit managed output mutation contract', accesses: [{ rootId: 'build-pool', domainId: 'managed-builds', accessMode: 'delete' }] },
                { producerId: 'reader', ownerKind: 'executable', sourceOfDeclaration: 'explicit current build read contract', accesses: [{ rootId: 'current', domainId: 'managed-builds', accessMode: 'read' }] },
                { producerId: 'writer', ownerKind: 'executable', sourceOfDeclaration: 'explicit current build write contract', accesses: [{ rootId: 'current', domainId: 'managed-builds', accessMode: 'create' }] },
                { producerId: 'source', ownerKind: 'executable', sourceOfDeclaration: 'explicit repository source read contract', accesses: [{ rootId: 'source', domainId: 'repository-source', accessMode: 'read' }] }
            ]
        },
        physicalOwners: [
            { producerId: 'collector', ownerKind: 'executable', spawnEligibility: true },
            { producerId: 'reader', ownerKind: 'executable', spawnEligibility: true },
            { producerId: 'writer', ownerKind: 'executable', spawnEligibility: true },
            { producerId: 'source', ownerKind: 'executable', spawnEligibility: true }
        ],
        roots: [
            { rootId: 'build-pool', path: builds, boundaryPath: root, role: 'repository' },
            { rootId: 'current', path: path.join(builds, 'current'), boundaryPath: builds, role: 'current', runId: 'current' },
            { rootId: 'source', path: source, boundaryPath: root, role: 'repository' }
        ],
        context: { runId: 'current', attemptId: 'attempt-1', sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` } }
    };
    return input;
}

function compile(input)
{
    return compilePhysicalProducerGcOrdering({
        filesystemPlan: compilePhysicalProducerFilesystemPlan(input),
        filesystemInput: input,
        gcProducerId: 'collector'
    });
}

function schedulerOptions(input)
{
    const ordering = compile(input);
    const tiers = input.physicalOwners.map((owner) => ({
        id: owner.producerId,
        command: process.execPath,
        executionDependsOn: ordering.dependentProducerIds.includes(owner.producerId) ? [ordering.gcProducerId] : [],
        services: [],
        parallelizable: true,
        exclusiveResources: [],
        phase: 0,
        resourceClass: 'cpu',
        maxParallel: 8,
        cpuUnits: 1,
        memoryGiB: 0.1,
        cacheInputs: [],
        executionKey: `controlled/${owner.producerId}`,
        executionVariant: 'ordinary',
        coverage: []
    }));
    return {
        tiers,
        root: input.roots[0].boundaryPath,
        runsRoot: path.join(input.roots[0].boundaryPath, 'runs'),
        runId: 'controlled-overlap',
        mode: 'fresh',
        maxParallel: 2,
        wallClockBudgetMs: 5000,
        collectFailures: true,
        systemResources: { cpuCount: 4, availableMemoryGiB: 4, load1: 0 },
        currentFreeMemoryGiB: () => 4,
        snapshotWorktree: async () => ({ fingerprint: 'controlled-unit-probe', entries: {} })
    };
}

test('GC dependencies contain only exact filesystem mutation overlap witnesses', (t) =>
{
    const input = fixture(t);
    const before = structuredClone(input);
    const plan = compile(input);
    assert.deepEqual(plan.dependentProducerIds, ['reader', 'writer']);
    assert.deepEqual(plan.independentProducerIds, ['source']);
    assert.equal(plan.edges.length, 2);
    assert.equal(plan.edges[0].dependentProducer, 'reader');
    assert.equal(plan.edges[0].gcMutation.accessMode, 'delete');
    assert.equal(plan.edges[0].gcMutation.resolvedRoot, input.roots[0].path);
    assert.equal(plan.edges[0].resolvedRoot, input.roots[1].path);
    assert.deepEqual(input, before);
    assert.equal(plan.executionEligible, false);
    assert.equal(plan.qualificationEligible, false);
    assert.equal(fs.existsSync(input.roots[1].path), false);
});

test('all producer read create write replace delete modes conflict with overlapping GC deletion', (t) =>
{
    const input = fixture(t);
    input.catalog.producers[1].accesses = [
        { rootId: 'current', domainId: 'managed-builds', accessMode: 'read' },
        { rootId: 'current', domainId: 'managed-builds', accessMode: 'create' },
        { rootId: 'current', domainId: 'managed-builds', accessMode: 'write' },
        { rootId: 'current', domainId: 'managed-builds', accessMode: 'replace' },
        { rootId: 'current', domainId: 'managed-builds', accessMode: 'delete' }
    ];
    assert.deepEqual(compile(input).edges.filter((edge) => edge.dependentProducer === 'reader').map((edge) => edge.accessMode).sort(), ['create', 'delete', 'read', 'replace', 'write']);
});

test('GC access matrix rejects only overlapping read-read while retaining every mutation conflict', (t) =>
{
    const input = fixture(t);
    input.catalog.producers[0].accesses = [
        { rootId: 'build-pool', domainId: 'managed-builds', accessMode: 'read' },
        { rootId: 'build-pool', domainId: 'managed-builds', accessMode: 'create' },
        { rootId: 'build-pool', domainId: 'managed-builds', accessMode: 'write' },
        { rootId: 'build-pool', domainId: 'managed-builds', accessMode: 'replace' },
        { rootId: 'build-pool', domainId: 'managed-builds', accessMode: 'delete' }
    ];
    const plan = compile(input);
    assert.equal(plan.edges.filter((edge) => edge.dependentProducer === 'reader').length, 4);
    assert.equal(plan.edges.filter((edge) => edge.dependentProducer === 'writer').length, 5);
    assert.ok(!plan.edges.some((edge) => edge.accessMode === 'read' && edge.gcMutation.accessMode === 'read'));
});

test('GC observation and producer mutation conflict but disjoint read-read observations do not', (t) =>
{
    const input = fixture(t);
    input.catalog.producers[0].accesses.push({ rootId: 'source', domainId: 'repository-source', accessMode: 'read' });
    assert.deepEqual(compile(input).independentProducerIds, ['source']);
    input.catalog.producers[3].accesses[0].accessMode = 'write';
    const witness = compile(input).edges.find((edge) => edge.dependentProducer === 'source');
    assert.equal(witness.gcMutation.accessMode, 'read');
    assert.match(witness.orderingReason, /producer mutation overlaps GC observation/u);
});

test('same filesystem disjoint roots and lexical sibling prefixes have no dependency', (t) =>
{
    const input = fixture(t);
    input.roots[2].path = `${input.roots[0].path}-source`;
    fs.mkdirSync(input.roots[2].path);
    const plan = compile(input);
    assert.deepEqual(plan.independentProducerIds, ['source']);
    const filesystem = plan.edges[0].filesystemIdentity;
    assert.equal(compilePhysicalProducerFilesystemPlan(input).producers.find((producer) => producer.producerId === 'source').resolvedRoots[0].filesystemIdentity, filesystem);
});

test('an ancestor reader overlaps a GC mutation of its descendant', (t) =>
{
    const input = fixture(t);
    input.catalog.producers[0].accesses[0].rootId = 'current';
    input.catalog.producers[1].accesses[0].rootId = 'build-pool';
    assert.deepEqual(compile(input).dependentProducerIds, ['reader', 'writer']);
});

test('symlink alias to a GC pool retains the dependency of a future child', (t) =>
{
    const input = fixture(t);
    const alias = path.join(input.roots[0].boundaryPath, 'alias');
    fs.symlinkSync(input.roots[0].path, alias, 'dir');
    input.roots[1].path = path.join(alias, 'current');
    input.roots[1].boundaryPath = alias;
    const plan = compile(input);
    assert.deepEqual(plan.dependentProducerIds, ['reader', 'writer']);
    assert.equal(plan.edges[0].resolvedRoot, path.join(input.roots[0].path, 'current'));
});

test('renaming every owner cannot alter filesystem-derived dependency membership', (t) =>
{
    const input = fixture(t);
    const names = new Map([['collector', 'random-a'], ['reader', 'source-looking-b'], ['writer', 'fixture-looking-c'], ['source', 'backend-tests']]);
    for (const producer of input.catalog.producers)
    {
        producer.producerId = names.get(producer.producerId);
    }
    for (const owner of input.physicalOwners)
    {
        owner.producerId = names.get(owner.producerId);
    }
    const plan = compilePhysicalProducerGcOrdering({ filesystemPlan: compilePhysicalProducerFilesystemPlan(input), filesystemInput: input, gcProducerId: 'random-a' });
    assert.deepEqual(plan.dependentProducerIds, ['fixture-looking-c', 'source-looking-b']);
    assert.deepEqual(plan.independentProducerIds, ['backend-tests']);
});

test('unknown missing or non-mutating GC authority fails closed', (t) =>
{
    const input = fixture(t);
    const plan = compilePhysicalProducerFilesystemPlan(input);
    assert.throws(() => compilePhysicalProducerGcOrdering({ filesystemPlan: plan, filesystemInput: input, gcProducerId: 'unknown' }), /explicitly declared executable mutation owner/u);
    input.catalog.producers[0].accesses[0].accessMode = 'read';
    assert.throws(() => compile(input), /explicitly declared executable mutation owner/u);
    input.catalog.producers[0].accesses[0].accessMode = 'delete';
    input.catalog.producers[0].accesses[0].rootId = 'unknown';
    assert.throws(() => compile(input), /unknown filesystem root/u);
});

test('saved filesystem plan drift cannot be hidden by a recomputed GC plan', (t) =>
{
    const input = fixture(t);
    const filesystemPlan = compilePhysicalProducerFilesystemPlan(input);
    input.context.attemptId = 'attempt-2';
    assert.throws(() => compilePhysicalProducerGcOrdering({ filesystemPlan, filesystemInput: input, gcProducerId: 'collector' }), /identity drift/u);
});

test('current resume active resident retained metadata are preserved without deleting or weakening protection', (t) =>
{
    const input = fixture(t);
    input.context.resumeRunId = 'resume-run';
    input.roots.push(
        { ...input.roots[1], rootId: 'resume', path: path.join(input.roots[0].path, 'resume'), role: 'resume', runId: 'resume-run' },
        { ...input.roots[1], rootId: 'active', path: path.join(input.roots[0].path, 'active'), role: 'active', runId: 'active-run' },
        { ...input.roots[1], rootId: 'resident', path: path.join(input.roots[0].path, 'resident'), role: 'resident', runId: 'resident-run' },
        { ...input.roots[1], rootId: 'retained', path: path.join(input.roots[0].path, 'retained'), role: 'retained', runId: 'retained-run' }
    );
    input.catalog.producers[1].accesses.push(
        { rootId: 'resume', domainId: 'managed-builds', accessMode: 'read' },
        { rootId: 'active', domainId: 'managed-builds', accessMode: 'read' },
        { rootId: 'resident', domainId: 'managed-builds', accessMode: 'read' },
        { rootId: 'retained', domainId: 'managed-builds', accessMode: 'read' }
    );
    input.catalog.domains[0].rootIds.push('resume', 'active', 'resident', 'retained');
    const filesystemPlan = compilePhysicalProducerFilesystemPlan(input);
    const before = structuredClone(filesystemPlan);
    const plan = compilePhysicalProducerGcOrdering({ filesystemPlan, filesystemInput: input, gcProducerId: 'collector' });
    assert.deepEqual(filesystemPlan, before);
    assert.equal(plan.edges.filter((edge) => edge.dependentProducer === 'reader').length, 5);
    assert.deepEqual(fs.readdirSync(input.roots[0].path), []);
});

test('canonical scheduler consumes derived edges and confines GC failure to dependent closure', async (t) =>
{
    const input = fixture(t);
    const executed = [];
    const options = schedulerOptions(input);
    options.tiers.push({ ...options.tiers[1], id: 'downstream', executionKey: 'controlled/downstream', executionDependsOn: ['reader'] });
    const result = await runDag({
        ...options,
        executeTier: async (tier) =>
        {
            executed.push(tier.id);
            return { code: tier.id === 'collector' ? 1 : 0, signal: null };
        }
    });
    assert.equal(result.status, 'failure');
    assert.equal(result.checkpoint.authoritative, false);
    assert.equal(result.checkpoint.tiers.source.status, 'success');
    assert.equal(result.checkpoint.tiers.reader.status, 'blocked');
    assert.equal(result.checkpoint.tiers.writer.status, 'blocked');
    assert.equal(result.checkpoint.tiers.downstream.status, 'blocked');
    assert.deepEqual(executed.sort(), ['collector', 'source']);
});

test('canonical scheduler overlaps unrelated work while conflicting consumers have zero early executor calls', async (t) =>
{
    const input = fixture(t);
    const events = [];
    let finishGc;
    const gcPending = new Promise((resolve) =>
    {
        finishGc = resolve;
    });
    const result = await runDag({
        ...schedulerOptions(input),
        executeTier: async (tier) =>
        {
            events.push(`start:${tier.id}`);
            if (tier.id === 'collector')
            {
                await gcPending;
            }
            else if (tier.id === 'source')
            {
                assert.ok(events.includes('start:collector'));
                assert.ok(!events.includes('end:collector'));
                assert.ok(!events.includes('start:reader'));
                assert.ok(!events.includes('start:writer'));
                finishGc();
            }
            else
            {
                assert.ok(events.includes('end:collector'));
            }
            events.push(`end:${tier.id}`);
            return { code: 0, signal: null };
        }
    });
    assert.equal(result.status, 'success');
    assert.equal(result.checkpoint.authoritative, false);
    assert.ok(events.indexOf('start:source') < events.indexOf('end:collector'));
    assert.ok(events.indexOf('start:reader') > events.indexOf('end:collector'));
    assert.ok(events.indexOf('start:writer') > events.indexOf('end:collector'));
});

test('canonical before-start gate can refuse unsealed reservation with zero executor calls', async (t) =>
{
    const input = fixture(t);
    const executed = [];
    const result = await runDag({
        ...schedulerOptions(input),
        beforeTierStart: () =>
        {
            throw new Error('unsealed reservation rejection control');
        },
        executeTier: async (tier) =>
        {
            executed.push(tier.id);
            return { code: 0, signal: null };
        }
    });
    assert.equal(result.status, 'failure');
    assert.equal(result.checkpoint.authoritative, false);
    assert.deepEqual(executed, []);
    assert.equal(result.checkpoint.tiers.collector.producerSpawnCount, 0);
    assert.match(result.checkpoint.tiers.collector.reason, /unsealed reservation/u);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createDataScaleDiskDemandPlan } = await import(new URL('../../tools/test/data-scale-disk-demand.mjs', import.meta.url));
const { readProductionDiskDemandCatalog } = await import(new URL('../../tools/test-matrix/production-disk-demand.mjs', import.meta.url));

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const sourcePaths = [
    'config/testing/production-disk-demand.json',
    'tools/data-scale/seed.sh',
    'src/backend/Services/Fixtures/DataScale/ArticleScalePlan.cs',
    'src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphFactory.cs',
    'src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphModels.cs',
    'src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphVerifier.cs'
];

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-scale-demand-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const relative of sourcePaths)
    {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, relative), target);
    }
    const buildRoot = path.join(root, 'build');
    const dockerRoot = path.join(root, 'docker');
    fs.mkdirSync(buildRoot);
    fs.mkdirSync(dockerRoot);
    return { root, runId: 'data-scale-demand-test', buildRoot, resolveDockerRoot: () => dockerRoot };
}

test('dedicated producer registers source-derived growth with explicit calibration pending', () =>
{
    const catalog = readProductionDiskDemandCatalog(repositoryRoot);
    const producer = catalog.producers.find((entry) => entry.producerId === 'release-reliability-fresh');
    assert.deepEqual(producer.demands.map((demand) => demand.rootId), ['run-output', 'docker-storage', 'os-temp']);
    for (const demand of producer.demands)
    {
        assert.match(demand.sourceOfEstimate, /Source-derived, not measured; calibration pending/u);
        assert.equal(demand.uncertaintyBytes, demand.peakAdditionalBytes);
    }
    const [output, docker, temporary] = producer.demands;
    assert.equal(output.peakAdditionalBytes, 4 * 10000 * 64 * 1024 + 100000 * 2 * 1024 + 256 * 1024 ** 2);
    assert.equal(output.rollbackOrRecoveryBytes, 10000 * 64 * 1024 + 64 * 1024 ** 2);
    assert.equal(docker.peakAdditionalBytes, 3 * (10000 * 64 * 1024 + 100000 * 4 * 1024) + (512 + 256) * 1024 ** 2);
    assert.equal(docker.rollbackOrRecoveryBytes, 10000 * 64 * 1024 + 100000 * 4 * 1024);
    assert.equal(temporary.peakAdditionalBytes, 128 * 1024 ** 2);
    assert.equal(docker.terminalRetainedBytes, 0);
});

test('plan uses only real dedicated declarations and charges shared filesystem growth together', (t) =>
{
    const options = fixture(t);
    const plan = createDataScaleDiskDemandPlan(options);
    assert.equal(plan.schema, 'fsusblog.production-disk-demand-plan.v1');
    assert.match(plan.planDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(plan.maxParallel, 1);
    assert.deepEqual([...new Set(plan.producerDeclarations.map((entry) => entry.producerId))], ['release-reliability-fresh']);
    assert.deepEqual(plan.producerDeclarations.map((entry) =>
    {
        const demand = { ...entry };
        delete demand.producerId;
        delete demand.estimatorVersion;
        return demand;
    }),
    readProductionDiskDemandCatalog(options.root).producers.find((entry) => entry.producerId === 'release-reliability-fresh').demands);
    const requestedBytes = plan.producerDeclarations.reduce((sum, demand) => sum
        + demand.peakAdditionalBytes + demand.rollbackOrRecoveryBytes + demand.uncertaintyBytes, 0);
    assert.equal(plan.filesystems.reduce((sum, filesystem) => sum + filesystem.requestedBytes, 0), requestedBytes);
    assert.ok(plan.filesystems.some((filesystem) => filesystem.rootIds.includes('docker-storage')));
    assert.equal(Object.hasOwn(plan, 'reservation'), false);
    assert.equal(Object.hasOwn(plan, 'qualificationEligible'), false);
});

test('capacity identity binds run and canonical graph source bytes', (t) =>
{
    const options = fixture(t);
    const first = createDataScaleDiskDemandPlan(options);
    assert.equal(createDataScaleDiskDemandPlan(options).planDigest, first.planDigest);
    assert.notEqual(createDataScaleDiskDemandPlan({ ...options, runId: 'another-run' }).planDigest, first.planDigest);
    fs.appendFileSync(path.join(options.root, sourcePaths[3]), '\n// source binding mutation fixture\n');
    assert.notEqual(createDataScaleDiskDemandPlan(options).planDigest, first.planDigest);
});

test('scale workload drift refuses before resolving Docker storage', (t) =>
{
    const options = fixture(t);
    const seed = path.join(options.root, 'tools/data-scale/seed.sh');
    fs.writeFileSync(seed, fs.readFileSync(seed, 'utf8').replace('comments=100000\n', 'comments=100001\n'));
    let resolutions = 0;
    assert.throws(() => createDataScaleDiskDemandPlan({
        ...options,
        resolveDockerRoot: () =>
        {
            resolutions += 1;
            return options.root;
        }
    }),
    /fixed scale-m source counts drifted/u);
    assert.equal(resolutions, 0);
});

test('missing dedicated declaration never falls back to performance-evidence', (t) =>
{
    const options = fixture(t);
    const file = path.join(options.root, sourcePaths[0]);
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    catalog.producers = catalog.producers.filter((entry) => entry.producerId !== 'release-reliability-fresh');
    fs.writeFileSync(file, JSON.stringify(catalog));
    assert.throws(() => createDataScaleDiskDemandPlan(options), /dedicated producer declarations are incomplete/u);
});

test('relative, absent, aliased and escaped roots and unsafe run identities refuse', (t) =>
{
    const options = fixture(t);
    assert.throws(() => createDataScaleDiskDemandPlan({ ...options, root: '.' }), /canonical absolute directory/u);
    assert.throws(() => createDataScaleDiskDemandPlan({ ...options, buildRoot: path.join(options.root, 'missing') }));
    assert.throws(() => createDataScaleDiskDemandPlan({ ...options, runId: '../escape' }), /bounded run identifier/u);
    assert.throws(() => createDataScaleDiskDemandPlan({ ...options, resolveDockerRoot: undefined }), /actual Docker storage root resolver/u);
    assert.throws(() => createDataScaleDiskDemandPlan({ ...options, resolveDockerRoot: () => null }), /Docker filesystem identity is unavailable/u);
    const alias = path.join(options.root, 'docker-alias');
    fs.symlinkSync(options.resolveDockerRoot(), alias, 'dir');
    assert.throws(() => createDataScaleDiskDemandPlan({ ...options, resolveDockerRoot: () => alias }), /canonical absolute directory/u);
    fs.symlinkSync(options.buildRoot, path.join(options.root, '.tmp'), 'dir');
    assert.throws(() => createDataScaleDiskDemandPlan(options), /output root escapes/u);
});

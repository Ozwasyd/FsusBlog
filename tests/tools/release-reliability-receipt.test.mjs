import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    createQualifiedReceipt,
    digestValue,
    verifyQualifiedReceipt
} = await import(pathToFileURL(path.join(root, 'tools/test/release-reliability-receipt.mjs')).href);

const scenarioIds = [
    'release-soak-min',
    'release-load-peak',
    'release-load-burst',
    'release-data-scale-m',
    'release-mutation-critical-slice',
    'release-memory-leak-budget',
    'release-open-handle-budget'
];
const digest = (character) => `sha256:${character.repeat(64)}`;

function identity()
{
    return {
        source: {
            commit: '0123456789abcdef0123456789abcdef01234567',
            worktreeFingerprint: digest('a')
        },
        build: {
            status: 'complete',
            path: '.tmp/build/receipt.json',
            digest: digest('b'),
            imageDigest: digest('c')
        },
        fixture: {
            collectorStatus: 'complete',
            root: '.tmp/fixture/reliability',
            namespace: 'reliability-fixture',
            configDigest: digest('d'),
            topology: 'postgres-redis-local'
        },
        machine: {
            collectorStatus: 'complete',
            os: 'linux 6.0',
            architecture: 'x64',
            cpuModels: ['test-cpu'],
            cpuCount: 8,
            memoryBytes: 16_000_000,
            containerLimits: 'complete'
        },
        policy: {
            catalogDigest: digest('e'),
            thresholdDigest: digest('f'),
            executorSchema: 'fsusblog.release-reliability-scenario-result.v1'
        }
    };
}

function results(runIdentity = identity())
{
    return scenarioIds.map((scenarioId) => ({
        schema: 'fsusblog.release-reliability-scenario-result.v1',
        invocationId: 'reliability-run',
        scenarioId,
        status: 'passed',
        source: structuredClone(runIdentity.source),
        policy: structuredClone(runIdentity.policy),
        identityDigest: digestValue(runIdentity),
        authoritativeEvidence: {
            path: `.tmp/reliability/${scenarioId}.json`,
            digest: digest('1'),
            status: 'ok'
        },
        isolation: {
            precondition: { status: 'complete' },
            reset: { status: 'complete' },
            postcondition: { status: 'complete' }
        }
    }));
}

function qualifiedReceipt(runIdentity = identity(), scenarioResults = results(runIdentity))
{
    const receipt = createQualifiedReceipt({
        invocationId: 'reliability-run',
        scenarioResults,
        identity: runIdentity,
        createdAt: '2026-07-26T00:00:00.000Z'
    });
    assert.equal(receipt.status, 'qualified', receipt.failure);
    return receipt;
}

test('qualified receipt binds the exact seven sealed scenario results', () =>
{
    const runIdentity = identity();
    const scenarioResults = results(runIdentity);
    const receipt = qualifiedReceipt(runIdentity, scenarioResults);
    assert.equal(receipt.scenarios.length, 7);
    assert.equal(receipt.contentDigest, digestValue({ ...receipt, contentDigest: undefined }));
    verifyQualifiedReceipt({ receipt, scenarioResults });
});

test('missing, duplicate, extra, or single diagnostic scenario cannot become qualified', () =>
{
    const runIdentity = identity();
    for (const mutated of [
        results(runIdentity).slice(1),
        [...results(runIdentity), structuredClone(results(runIdentity)[0])],
        [...results(runIdentity).slice(0, -1), { ...results(runIdentity)[0], scenarioId: 'unknown-scenario' }],
        [results(runIdentity)[0]]
    ])
    {
        const receipt = createQualifiedReceipt({
            invocationId: 'reliability-run',
            scenarioResults: mutated,
            identity: runIdentity,
            createdAt: '2026-07-26T00:00:00.000Z'
        });
        assert.equal(receipt.status, 'failed');
    }
});

test('source, worktree, build, fixture, machine, and policy identity mismatches fail closed', () =>
{
    const mutations = [
        (runIdentity, scenarioResults) => { scenarioResults[0].source.commit = 'fedcba9876543210fedcba9876543210fedcba98'; },
        (runIdentity, scenarioResults) => { scenarioResults[0].source.worktreeFingerprint = digest('9'); },
        (runIdentity) => { runIdentity.build.imageDigest = digest('8'); },
        (runIdentity) => { runIdentity.fixture.configDigest = digest('7'); },
        (runIdentity) => { runIdentity.machine.collectorStatus = 'unavailable'; },
        (runIdentity, scenarioResults) => { scenarioResults[0].policy.catalogDigest = digest('6'); }
    ];
    for (const mutate of mutations)
    {
        const runIdentity = identity();
        const scenarioResults = results(runIdentity);
        mutate(runIdentity, scenarioResults);
        const receipt = createQualifiedReceipt({
            invocationId: 'reliability-run',
            scenarioResults,
            identity: runIdentity,
            createdAt: '2026-07-26T00:00:00.000Z'
        });
        assert.equal(receipt.status, 'failed');
    }
});

test('scenario evidence tamper, failed status, reset failure, collector failure, and partial status fail closed', () =>
{
    const cases = [
        (receipt, scenarioResults) => { scenarioResults[0].authoritativeEvidence.digest = digest('0'); },
        (receipt, scenarioResults) => { scenarioResults[0].status = 'failed'; },
        (receipt, scenarioResults) => { scenarioResults[0].isolation.reset.status = 'failed'; },
        (receipt, scenarioResults, runIdentity) => { runIdentity.build.status = 'unavailable'; },
        (receipt) => { receipt.status = 'partial'; }
    ];
    for (const apply of cases)
    {
        const runIdentity = identity();
        const scenarioResults = results(runIdentity);
        const receipt = qualifiedReceipt(runIdentity, scenarioResults);
        apply(receipt, scenarioResults, runIdentity);
        receipt.contentDigest = digestValue(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest')));
        assert.throws(() => verifyQualifiedReceipt({ receipt, scenarioResults }));
    }
});

test('a receipt rejects a scenario result from another invocation or source', () =>
{
    const runIdentity = identity();
    const scenarioResults = results(runIdentity);
    scenarioResults[0].invocationId = 'other-run';
    const receipt = createQualifiedReceipt({
        invocationId: 'reliability-run',
        scenarioResults,
        identity: runIdentity,
        createdAt: '2026-07-26T00:00:00.000Z'
    });
    assert.equal(receipt.status, 'failed');
});

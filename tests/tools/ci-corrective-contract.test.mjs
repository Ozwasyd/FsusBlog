import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const fixtureRoot = path.join(root, 'tests/fixtures/issue-orchestration');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), 'utf8'));
const contract = readJson('ci-corrective-test-contract.json');
const acceptance = readJson('ci-corrective-acceptance-map.json');
const expected = readJson('ci-corrective-expected-initial-failures.json');
const mutations = readJson('ci-corrective-mutation-controls.json');
const runtime = readJson('ci-corrective-runtime-probes.json');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
{
    if (Array.isArray(value))
    {
        return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};
const digest = (value) => sha256(JSON.stringify(canonical(value)));

function workflowJob(source, job, nextJob)
{
    const start = source.indexOf(`    ${job}:\n`);
    assert.ok(start >= 0, `missing workflow job ${job}`);
    const end = nextJob ? source.indexOf(`    ${nextJob}:\n`, start + 1) : source.length;
    assert.ok(end > start, `missing workflow job boundary ${nextJob}`);
    return source.slice(start, end);
}

function runScaleAggregator(base, env = {})
{
    return spawnSync(process.execPath, [
        path.join(root, 'tools/test/aggregate-data-scale-evidence.mjs'),
        '--root', base
    ], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...env }
    });
}

function writeScale(base, tier, runIdentity)
{
    const file = path.join(base, `.tmp/downloaded-artifacts/integration-runtime/.tmp/scale/release-summaries/${tier}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
        schema: 'fsusblog.data-scale-tier-summary.v1',
        status: 'ok',
        tier,
        runIdentity,
        expectedSeed: tier === 'scale-xs' ? { articles: 1, comments: 0 } : { articles: 100, comments: 1000 },
        seed: { status: 'ok' },
        observed: { status: 'ok' },
        cleanup: { status: 'ok' }
    })}\n`);
}

test('frozen #1822 CI corrective identities are self-consistent', () =>
{
    assert.equal(contract.baseSha, runtime.baseSha);
    assert.deepEqual(contract.allowedImplementationPaths, [
        '.github/workflows/change-contract.yml',
        '.github/workflows/quality-gate.yml',
        'tools/test/aggregate-data-scale-evidence.mjs'
    ]);
    assert.deepEqual(acceptance.acceptance.map(({ id }) => id), ['CI01', 'CI02', 'CI03', 'CI04']);
    assert.deepEqual(mutations.controls.map(({ id }) => id), [
        'trusted-checkout-remains-shallow',
        'release-evidence-omits-plan-authority',
        'identityless-scale-artifact-admitted',
        'missing-required-scale-evidence-softened'
    ]);
    for (const [relative, expectedHash] of Object.entries(contract.fileHashes))
    {
        assert.equal(sha256(fs.readFileSync(path.join(root, relative))), expectedHash, `${relative} drifted`);
    }
    assert.equal(digest(contract.fileHashes), contract.frozenTreeDigest);
    const input = structuredClone(contract);
    delete input.contractDigest;
    delete input.candidateIdentity;
    assert.equal(digest(input), contract.contractDigest);
    assert.equal(contract.candidateIdentity.candidateDigest, digest({
        baseSha: contract.baseSha,
        contractDigest: contract.contractDigest,
        implementationFiles: contract.candidateIdentity.implementationFiles
    }));
    assert.deepEqual(expected.expectedFailingTests, ['CI01', 'CI02', 'CI03']);
});

test('CI01 trusted change-contract checkouts carry complete blame-ignore history', () =>
{
    const source = fs.readFileSync(path.join(root, '.github/workflows/change-contract.yml'), 'utf8');
    for (const name of ['Checkout trusted pull request gate', 'Checkout trusted pre-push gate'])
    {
        const start = source.indexOf(`- name: ${name}`);
        assert.ok(start >= 0, `missing ${name}`);
        const block = source.slice(start, source.indexOf('\n            - name:', start + 1));
        assert.match(block, /fetch-depth:\s*0/u, `${name} must make reviewed blame-ignore revisions reachable`);
    }
});

test('CI02 release evidence carries current plan authority and the scale producer artifact', () =>
{
    const source = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
    const release = workflowJob(source, 'release-evidence', 'production-summary');
    assert.match(release, /-\s+plan-pr-risk/u);
    assert.match(release, /-\s+integration-runtime/u);
    assert.match(release, /name:\s+integration-runtime/u);
});

test('CI03 required scale artifacts must exact-match the current GitHub run identity', (context) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-1822-scale-identity-'));
    context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const current = { commit: 'a'.repeat(40), runId: '42', runAttempt: '3', producerJob: 'integration-runtime' };
    writeScale(temp, 'scale-xs', undefined);
    writeScale(temp, 'scale-s', { ...current, runId: '41' });
    const result = runScaleAggregator(temp, {
        GITHUB_SHA: current.commit,
        GITHUB_RUN_ID: current.runId,
        GITHUB_RUN_ATTEMPT: current.runAttempt,
        FSUSBLOG_DATA_SCALE_PRODUCER_JOB: current.producerJob
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /current run identity|run identity mismatch/u);
});

test('CI04 required scale evidence remains fail-closed when an artifact is absent', (context) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-1822-scale-missing-'));
    context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    writeScale(temp, 'scale-s', {
        commit: 'a'.repeat(40), runId: '42', runAttempt: '3', producerJob: 'integration-runtime'
    });
    const result = runScaleAggregator(temp, {
        GITHUB_SHA: 'a'.repeat(40),
        GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '3',
        FSUSBLOG_DATA_SCALE_PRODUCER_JOB: 'integration-runtime'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing scale-xs data-scale evidence/u);
});

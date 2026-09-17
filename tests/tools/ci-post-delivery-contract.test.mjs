import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const fixtureRoot = path.join(root, 'tests/fixtures/issue-orchestration');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), 'utf8'));
const acceptance = readJson('ci-post-delivery-acceptance-map.json');
const expected = readJson('ci-post-delivery-expected-initial-failures.json');
const mutations = readJson('ci-post-delivery-mutation-controls.json');
const runtime = readJson('ci-post-delivery-runtime-probes.json');
const contract = readJson('ci-post-delivery-test-contract.json');
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
    assert.ok(end > start, `missing workflow boundary ${nextJob}`);
    return source.slice(start, end);
}

function classifyRun({ integrationResult, artifactAvailable, producerIdentityAvailable })
{
    if (integrationResult !== 'success')
    {
        return {
            disposition: 'possible-remote-contract-impact',
            consumerResult: 'fail-closed',
            reason: 'required-upstream-not-success'
        };
    }
    if (!artifactAvailable || !producerIdentityAvailable)
    {
        return {
            disposition: 'in-scope-current-run-contract-defect',
            consumerResult: 'fail-closed',
            reason: 'required-current-run-evidence-missing'
        };
    }
    return { disposition: 'in-scope-satisfied', consumerResult: 'success', reason: 'none' };
}

test('frozen #1822 revision-9 identities and ownership ledger are self-consistent', () =>
{
    assert.equal(contract.testOwnerId, 'test-owner-1822-ci-r9');
    assert.equal(contract.baseSha, 'f394429c02c4ac7e83f1e277918c87e6ffb525cd');
    assert.deepEqual(contract.allowedImplementationPaths, []);
    assert.deepEqual(acceptance.acceptance.map(({ id }) => id), ['R9CI01', 'R9CI02', 'R9CI03', 'R9CI04']);
    assert.deepEqual(mutations.controls.map(({ id }) => id), [
        'unnamed-artifact-fallback',
        'stale-run-artifact-admitted',
        'missing-producer-identity-softened',
        'external-failure-absorbed-into-1822'
    ]);
    assert.deepEqual(expected.expectedFailingTests, []);
    assert.equal(runtime.externalImpacts.length, 6);
    assert.ok(runtime.externalImpacts.every(({ disposition }) => disposition === 'possible-remote-contract-impact'));
    for (const [relative, expectedHash] of Object.entries(contract.fileHashes))
    {
        assert.equal(sha256(fs.readFileSync(path.join(root, relative))), expectedHash, `${relative} drifted`);
    }
    assert.equal(digest(contract.fileHashes), contract.frozenTreeDigest);
    const input = structuredClone(contract);
    delete input.contractDigest;
    assert.equal(digest(input), contract.contractDigest);
});

test('R9CI01 release evidence names the current-run integration producer and has no fallback', () =>
{
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
    const release = workflowJob(workflow, 'release-evidence', 'production-summary');
    const named = release.slice(
        release.indexOf('- name: Download current integration scale producer'),
        release.indexOf('- run: ./tools/test.sh data-scale-evidence-summary')
    );
    assert.match(named, /name:\s+integration-runtime/u);
    assert.match(named, /path:\s+\.tmp\/downloaded-artifacts\/integration-runtime/u);
    assert.doesNotMatch(named, /continue-on-error:\s*true/u);
    assert.equal((release.match(/name:\s+integration-runtime/gu) ?? []).length, 1);
});

test('R9CI02 missing current-run artifact and producer identity remain fail-closed', () =>
{
    assert.deepEqual(classifyRun({
        integrationResult: 'success',
        artifactAvailable: false,
        producerIdentityAvailable: true
    }), {
        disposition: 'in-scope-current-run-contract-defect',
        consumerResult: 'fail-closed',
        reason: 'required-current-run-evidence-missing'
    });
    assert.deepEqual(classifyRun({
        integrationResult: 'success',
        artifactAvailable: true,
        producerIdentityAvailable: false
    }), {
        disposition: 'in-scope-current-run-contract-defect',
        consumerResult: 'fail-closed',
        reason: 'required-current-run-evidence-missing'
    });
});

test('R9CI03 failed upstream producers are external impacts, not evidence-contract success', () =>
{
    assert.deepEqual(classifyRun({
        integrationResult: 'skipped',
        artifactAvailable: false,
        producerIdentityAvailable: false
    }), {
        disposition: 'possible-remote-contract-impact',
        consumerResult: 'fail-closed',
        reason: 'required-upstream-not-success'
    });
    assert.ok(runtime.externalImpacts.some(({ job, evidence }) => (
        job === 'Fast Backend DAG' && evidence.includes('SpaAssetManifestServiceTests.cs')
    )));
    assert.ok(runtime.externalImpacts.some(({ job, evidence }) => (
        job === 'Fast Frontend Unit DAG' && evidence.includes('relative URL')
    )));
});

test('R9CI04 mutation catalog preserves exact fail-closed and ownership controls', () =>
{
    const mapped = acceptance.acceptance.flatMap(({ mutations: ids }) => ids).sort();
    assert.deepEqual(mapped, mutations.controls.map(({ id }) => id).sort());
    assert.equal(new Set(mapped).size, 4);
    assert.equal(classifyRun({
        integrationResult: 'failure',
        artifactAvailable: true,
        producerIdentityAvailable: true
    }).consumerResult, 'fail-closed');
});

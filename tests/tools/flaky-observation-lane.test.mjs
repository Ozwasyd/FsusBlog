import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
    classifyAttempts,
    validateFlakyObservationSet
} from '../../tools/test-observations/flaky-observer.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const observer = path.join(repositoryRoot, 'tools/test-observations/flaky-observer.mjs');
const fixture = path.join(repositoryRoot, 'tests/tools/fixtures/flaky-observation-command.mjs');

function observe(scenario, attempts = 3, extra = [])
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-flaky-observation-'));
    const output = path.join(directory, 'observation.json');
    const result = spawnSync(process.execPath, [
        observer,
        '--test-id', `fixture:${scenario}`,
        '--attempts', String(attempts),
        '--output', output,
        ...extra,
        '--', process.execPath, fixture, scenario
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    const evidence = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null;
    return { directory, output, result, evidence };
}

test('stable pass records every isolated attempt and seed', () =>
{
    const run = observe('stable-pass', 3, ['--seed', '100']);
    try
    {
        assert.equal(run.result.status, 0, run.result.stderr);
        const candidate = run.evidence.candidates[0];
        assert.equal(candidate.classification, 'stable-pass');
        assert.deepEqual(candidate.attempts.map((attempt) => attempt.seed), [100, 101, 102]);
        assert.ok(candidate.attempts.every((attempt) => attempt.processIsolation === 'new-process-per-attempt'));
        assert.ok(candidate.attempts.every((attempt) => attempt.rawEvidenceDigest.startsWith('sha256:')));
        assert.deepEqual(validateFlakyObservationSet(run.evidence, {
            evidenceRoot: `${run.output}.d`
        }), []);
    }
    finally { fs.rmSync(run.directory, { recursive: true, force: true }); }
});

test('local checker rejects modified raw evidence', () =>
{
    const run = observe('stable-pass', 2);
    try
    {
        const stdout = path.join(`${run.output}.d`, '001', 'attempts', '001', 'stdout.log');
        fs.appendFileSync(stdout, 'tampered\n');
        const check = spawnSync(process.execPath, [
            observer, 'check', '--evidence', run.output
        ], { cwd: repositoryRoot, encoding: 'utf8' });
        assert.equal(check.status, 1);
        assert.match(check.stderr, /evidence is missing or modified/u);
    }
    finally { fs.rmSync(run.directory, { recursive: true, force: true }); }
});

test('stable and differing failures preserve signature semantics', () =>
{
    for (const [scenario, classification, signatureCount] of [
        ['stable-fail', 'stable-fail', 1],
        ['different-failures', 'signature-inconsistent', 2]
    ])
    {
        const run = observe(scenario, 4);
        try
        {
            assert.equal(run.result.status, 0, run.result.stderr);
            const candidate = run.evidence.candidates[0];
            assert.equal(candidate.classification, classification);
            assert.equal(new Set(candidate.attempts.map((attempt) => attempt.failureSignature)).size, signatureCount);
        }
        finally { fs.rmSync(run.directory, { recursive: true, force: true }); }
    }
});

test('alternating outcome is inconsistent and cannot rewrite canonical first failure', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-canonical-evidence-'));
    const canonical = path.join(directory, 'correctness.json');
    const original = `${JSON.stringify({ attempts: [{ status: 'failure' }], finalStatus: 'failed-no-retry' })}\n`;
    fs.writeFileSync(canonical, original);
    const run = observe('alternating', 4, ['--canonical-evidence', canonical]);
    try
    {
        assert.equal(run.result.status, 0, run.result.stderr);
        assert.equal(run.evidence.affectsCanonicalCorrectness, false);
        assert.equal(run.evidence.satisfiesReleaseCorrectness, false);
        const candidate = run.evidence.candidates[0];
        assert.equal(candidate.classification, 'outcome-inconsistent');
        assert.equal(candidate.canonical.canonicalFirstOutcome, 'failed');
        assert.equal(candidate.canonical.observationAffectsCanonical, false);
        assert.equal(candidate.canonical.observationSatisfiesReleaseCorrectness, false);
        assert.equal(fs.readFileSync(canonical, 'utf8'), original);
    }
    finally
    {
        fs.rmSync(run.directory, { recursive: true, force: true });
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('environment failures and too few attempts are classified completely', () =>
{
    for (const [scenario, attempts, classification] of [
        ['environment', 3, 'environment-failure'],
        ['stable-pass', 1, 'insufficient-samples']
    ])
    {
        const run = observe(scenario, attempts);
        try
        {
            assert.equal(run.result.status, 0, run.result.stderr);
            assert.equal(run.evidence.candidates[0].classification, classification);
        }
        finally { fs.rmSync(run.directory, { recursive: true, force: true }); }
    }
});

test('attempts with mismatched source runner or producer identity cannot merge', () =>
{
    const base = {
        attemptIndex: 1,
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: `sha256:${'b'.repeat(64)}`,
        producerDigest: `sha256:${'c'.repeat(64)}`,
        runnerDigest: `sha256:${'d'.repeat(64)}`,
        outcome: 'passed'
    };
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'producerDigest', 'runnerDigest'])
    {
        const changed = { ...base, attemptIndex: 2, [field]: `${base[field]}-changed` };
        assert.throws(() => classifyAttempts([base, changed]), new RegExp(field, 'u'));
    }
});

test('manifest selection is explicit and runs only declared candidates', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-flaky-manifest-'));
    const manifest = path.join(directory, 'manifest.json');
    const output = path.join(directory, 'result.json');
    fs.writeFileSync(manifest, `${JSON.stringify({
        schema: 'fsusblog.flaky-observation-candidates.v1',
        candidates: [{
            testId: 'fixture:manifest-pass',
            attempts: 2,
            seed: 7,
            command: [process.execPath, fixture, 'stable-pass']
        }]
    })}\n`);
    const result = spawnSync(process.execPath, [
        observer, '--manifest', manifest, '--output', output
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    try
    {
        assert.equal(result.status, 0, result.stderr);
        const evidence = JSON.parse(fs.readFileSync(output, 'utf8'));
        assert.equal(evidence.candidateSelection, 'explicit-manifest');
        assert.deepEqual(evidence.candidates.map((candidate) => candidate.testId), ['fixture:manifest-pass']);
    }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('checked-in schemas and candidate registry expose the versioned local contract', () =>
{
    const schema = JSON.parse(fs.readFileSync(path.join(
        repositoryRoot, 'config/schemas/flaky-observation-set.schema.json'
    ), 'utf8'));
    const registry = JSON.parse(fs.readFileSync(path.join(
        repositoryRoot, 'config/testing/flaky-observation-candidates.json'
    ), 'utf8'));
    assert.equal(schema.properties.schema.const, 'fsusblog.flaky-observation-set.v1');
    assert.deepEqual(schema.properties.candidates.items.properties.classification.enum, [
        'stable-pass',
        'stable-fail',
        'outcome-inconsistent',
        'signature-inconsistent',
        'environment-failure',
        'insufficient-samples'
    ]);
    assert.equal(registry.schema, 'fsusblog.flaky-observation-candidates.v1');
    assert.deepEqual(registry.candidates, []);
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { digestJson, seal } = await import(new URL('../../tools/resource-model/contract.mjs', import.meta.url));
const {
    activateProductionModel, evaluateActivationCandidate, publishCandidatePointer,
    rollbackCandidatePointer, selectCandidateModel, shadowModel, validateModelBundle
} = await import(new URL('../../tools/resource-model/model-lifecycle.mjs', import.meta.url));

import { modelFixture } from './support/adaptive-resource-fixtures.mjs';

function publication(data, overrides = {})
{
    return {
        directory: data.modelDirectory, model: data.model, identity: data.identity, shadow: data.shadow,
        evidenceRoot: data.evidenceRoot, confirmationLocators: data.confirmations(), expectedPointerDigest: null,
        ...overrides
    };
}

function selection(data, overrides = {})
{
    return { directory: data.modelDirectory, identity: data.identity,
        defaults: data.defaults, planSealed: false, ...overrides };
}

test('adaptive lifecycle shadow has no mutation and Production activation refuses missing upstream authority', (context) =>
{
    const data = modelFixture(context);
    const original = structuredClone(data.actualDecisions);
    const shadow = shadowModel({ model: data.model, identity: data.identity, actualDecisions: data.actualDecisions });
    assert.deepEqual(data.actualDecisions, original);
    assert.equal(shadow.schedulerMutationCount, 0);
    assert.ok(shadow.differences.some((row) => row.changed));
    assert.throws(() => activateProductionModel({ verified: true }), { code: 'upstream-verification-unavailable' });
});

test('adaptive lifecycle publishes only a DATA_ONLY candidate after three independent confirmations', (context) =>
{
    const data = modelFixture(context);
    const terminal = publishCandidatePointer(publication(data));
    assert.equal(terminal.state, 'active-candidate');
    assert.equal(terminal.authority, 'DATA_ONLY');
    const selected = selectCandidateModel(selection(data));
    assert.equal(selected.selection, 'candidate');
    assert.equal(selected.model.digest, data.model.digest);
    assert.ok(Object.isFrozen(selected.model.recommendations.cpu.recommendations[0]));
    assert.throws(() =>
    {
        selected.model.defaults[0].cpuWeight = 99;
    }, TypeError);
    assert.throws(() => selectCandidateModel(selection(data, { planSealed: true })), { code: 'selection-after-plan-seal' });
});

test('adaptive lifecycle rejects missing duplicate and training-run confirmation reuse', (context) =>
{
    const data = modelFixture(context);
    const input = publication(data);
    for (const confirmationLocators of [input.confirmationLocators.slice(0, 2),
        [input.confirmationLocators[0], input.confirmationLocators[0], input.confirmationLocators[1]]])
    {
        const terminal = evaluateActivationCandidate({ ...input, confirmationLocators });
        assert.equal(terminal.state, 'reject');
        assert.ok(terminal.reasons.some((row) => row.code === 'independent-confirmations-required'));
    }
    const training = data.confirmations(() =>
    {}, 'learning');
    const terminal = evaluateActivationCandidate({ ...input, confirmationLocators: training });
    assert.ok(terminal.reasons.some((row) => row.code === 'independent-confirmations-required'));
});

test('adaptive lifecycle vetoes p50 p90 swap OOM resource kill isolation CV and resumed attempts', (context) =>
{
    const data = modelFixture(context);
    for (const mutate of [
        (row) =>
        {
            row.currentWallMs = 990;
        },
        (row, index) =>
        {
            row.currentWallMs = index === 2 ? 1400 : 800;
        },
        (row) =>
        {
            row.swap = 1;
        },
        (row) =>
        {
            row.oom = 1;
        },
        (row) =>
        {
            row.resourceKills = 1;
        },
        (row) =>
        {
            row.benchmarkIsolationValid = false;
        },
        (row) =>
        {
            row.currentCv = 0.03;
        },
        (row) =>
        {
            row.resumed = true;
        },
        (row) =>
        {
            row.attemptOrdinal = 2;
        }
    ])
    {
        const terminal = evaluateActivationCandidate({ ...publication(data),
            confirmationLocators: data.confirmations(mutate) });
        assert.equal(terminal.state, 'reject');
    }
    const rejected = publishCandidatePointer({ ...publication(data),
        confirmationLocators: data.confirmations((row) =>
        {
            row.swap = 1;
        }) });
    assert.equal(rejected.state, 'reject');
    assert.equal(fs.existsSync(path.join(data.modelDirectory, 'candidate-active.json')), false);
});

test('adaptive lifecycle rejects exactness wrong attempt raw tamper and model identity drift', (context) =>
{
    const data = modelFixture(context);
    const input = publication(data);
    assert.throws(() => evaluateActivationCandidate({ ...input,
        confirmationLocators: data.confirmations((row) =>
        {
            row.current.coverageDigest = digestJson('changed');
        }) }),
    { code: 'confirmation-exactness-drift' });
    const locators = data.confirmations((row) =>
    {
        row.attemptId = 'wrong-attempt';
    });
    assert.throws(() => evaluateActivationCandidate({ ...input, confirmationLocators: locators }),
        { code: 'confirmation-performance-rejected' });
    const fresh = data.confirmations();
    fs.writeFileSync(path.join(data.evidenceRoot, fresh[0].ref), '{}');
    assert.throws(() => evaluateActivationCandidate({ ...input, confirmationLocators: fresh }), { code: 'evidence-tamper' });
    assert.throws(() => validateModelBundle(data.model, { ...data.identity, machineId: 'other-host' }),
        { code: 'identity-drift' });
});

test('adaptive lifecycle permits honest no change without activating a different pointer', (context) =>
{
    const unchanged = {
        actualCpuUnits: 1, criticalPath: false, capacityBlockedMs: 0, peakRssGiB: 4 / 1.3,
        downstreamUnlockValue: 0, startupCapacityBlockedMs: 0, queueAgeMs: 0
    };
    const data = modelFixture(context, { row: { alpha: unchanged, beta: unchanged } });
    const terminal = publishCandidatePointer({ ...publication(data),
        confirmationLocators: data.confirmations((row) =>
        {
            row.currentWallMs = 1000;
        }) });
    assert.equal(terminal.state, 'no-change');
    assert.equal(fs.existsSync(path.join(data.modelDirectory, 'candidate-active.json')), false);
    assert.equal(selectCandidateModel(selection(data)).selection, 'defaults');
});

test('adaptive lifecycle CAS switch retains old models and explicit rollback terminal', (context) =>
{
    const data = modelFixture(context);
    const first = publishCandidatePointer(publication(data));
    const next = modelFixture(context, { count: 6 });
    const second = publishCandidatePointer(publication(next, {
        directory: data.modelDirectory, expectedPointerDigest: first.pointer.digest
    }));
    assert.notEqual(first.pointer.modelDigest, second.pointer.modelDigest);
    assert.throws(() => publishCandidatePointer(publication(data)), { code: 'pointer-cas-conflict' });
    const rollback = rollbackCandidatePointer({ directory: data.modelDirectory, identity: data.identity,
        expectedPointerDigest: second.pointer.digest });
    assert.equal(rollback.state, 'rollback');
    assert.equal(rollback.pointer.modelDigest, data.model.digest);
    assert.equal(selectCandidateModel(selection(data)).model.digest, data.model.digest);
    assert.throws(() => rollbackCandidatePointer({ directory: data.modelDirectory, identity: data.identity,
        expectedPointerDigest: second.pointer.digest }), { code: 'rollback-unavailable' });
});

test('adaptive lifecycle failed pointer rename leaves complete old pointer and immutable retained model', (context) =>
{
    const data = modelFixture(context);
    const first = publishCandidatePointer(publication(data));
    const before = fs.readFileSync(path.join(data.modelDirectory, 'candidate-active.json'));
    const next = modelFixture(context, { count: 6 });
    const originalRename = fs.renameSync;
    try
    {
        fs.renameSync = () =>
        {
            throw Object.assign(new Error('injected pre-rename crash'), { code: 'EIO' });
        };
        assert.throws(() => publishCandidatePointer(publication(next, {
            directory: data.modelDirectory, expectedPointerDigest: first.pointer.digest
        })), { code: 'EIO' });
    }
    finally
    {
        fs.renameSync = originalRename;
    }
    assert.deepEqual(fs.readFileSync(path.join(data.modelDirectory, 'candidate-active.json')), before);
    assert.equal(selectCandidateModel(selection(data)).model.digest, data.model.digest);
    assert.ok(fs.existsSync(path.join(data.modelDirectory, `${next.model.digest.slice(7)}.json`)));
    assert.equal(fs.existsSync(path.join(data.modelDirectory, '.writer-lock')), false);
});

test('adaptive lifecycle concurrent readers observe complete old or new pointers', async (context) =>
{
    const data = modelFixture(context);
    const first = publishCandidatePointer(publication(data));
    const next = modelFixture(context, { count: 6 });
    const pointerFile = path.join(data.modelDirectory, 'candidate-active.json');
    const program = `const fs = require('node:fs'); let count = 0; const digests = new Set();
        const timer = setInterval(() => { const p = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
            digests.add(p.modelDigest); count++; if (count >= 100) { clearInterval(timer);
                process.stdout.write(JSON.stringify({count, digests: [...digests]})); } }, 1);
        process.stderr.write('ready');`;
    const child = spawn(process.execPath, ['-e', program, pointerFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    context.after(() => child.kill());
    let output = '';
    child.stdout.on('data', (chunk) =>
    {
        output += chunk;
    });
    const completion = new Promise((resolve, reject) =>
    {
        child.once('error', reject);
        child.once('exit', (code) =>
        {
 code === 0 ? resolve() : reject(new Error(`reader exit ${code}`));
        });
    });
    await new Promise((resolve) => child.stderr.once('data', resolve));
    const second = publishCandidatePointer(publication(next, { directory: data.modelDirectory,
        expectedPointerDigest: first.pointer.digest }));
    await completion;
    const report = JSON.parse(output);
    assert.equal(report.count, 100);
    assert.ok(report.digests.every((digest) => [data.model.digest, next.model.digest].includes(digest)));
    assert.equal(selectCandidateModel(selection(data)).model.digest, second.modelDigest);
});

test('adaptive lifecycle falls back deterministically on corrupt low confidence infeasible and drifted candidates', (context) =>
{
    const data = modelFixture(context);
    publishCandidatePointer(publication(data));
    const pointerFile = path.join(data.modelDirectory, 'candidate-active.json');
    const pointer = JSON.parse(fs.readFileSync(pointerFile));
    const file = path.join(data.modelDirectory, `${data.model.digest.slice(7)}.json`);
    fs.writeFileSync(file, '{}');
    assert.equal(selectCandidateModel(selection(data)).selection, 'defaults');
    fs.writeFileSync(file, JSON.stringify(data.model));
    assert.equal(selectCandidateModel(selection(data, { identity: { ...data.identity, machineId: 'other' } })).selection, 'defaults');
    assert.equal(selectCandidateModel(selection(data, { defaults: [{ ...data.defaults[0], cpuWeight: 100 }, data.defaults[1]] })).selection,
        'defaults');
    const mutated = structuredClone(data.model);
    const cpu = mutated.recommendations.cpu;
    cpu.recommendations[0].recommendedCpuUnits = 100;
    const cpuPayload = { ...cpu };
    delete cpuPayload.digest;
    mutated.recommendations.cpu = seal(cpuPayload);
    mutated.recommendationDigests.cpu = mutated.recommendations.cpu.digest;
    const modelPayload = { ...mutated };
    delete modelPayload.digest;
    assert.throws(() => validateModelBundle(seal(modelPayload), data.identity), { code: 'infeasible-cpu-envelope' });
    fs.writeFileSync(pointerFile, JSON.stringify({ ...pointer, modelDigest: digestJson('other') }));
    const firstFallback = selectCandidateModel(selection(data));
    assert.deepEqual(selectCandidateModel(selection(data)), firstFallback);
    assert.deepEqual(firstFallback.defaults, data.defaults);
});

test('adaptive lifecycle low confidence candidate storage falls back and invalid metadata cannot authorize selection', (context) =>
{
    const data = modelFixture(context, { count: 1 });
    const evaluated = evaluateActivationCandidate(publication(data));
    assert.equal(evaluated.state, 'reject');
    assert.ok(evaluated.reasons.some((row) => row.code === 'low-confidence'));
    // Synthetic DATA_ONLY storage proves even a claimed active state cannot bypass confidence checks.
    fs.mkdirSync(data.modelDirectory);
    const terminal = seal({ schema: 'fsusblog.adaptive.lifecycle-terminal.v1', authority: 'DATA_ONLY',
        identity: data.identity, modelDigest: data.model.digest, state: 'active-candidate' });
    fs.writeFileSync(path.join(data.modelDirectory, `terminal-${terminal.digest.slice(7)}.json`), JSON.stringify(terminal));
    fs.writeFileSync(path.join(data.modelDirectory, `${data.model.digest.slice(7)}.json`), JSON.stringify(data.model));
    const pointer = seal({ schema: 'fsusblog.adaptive.candidate-pointer.v1', authority: 'DATA_ONLY',
        identity: data.identity, modelDigest: data.model.digest, evaluationDigest: terminal.digest });
    const pointerFile = path.join(data.modelDirectory, 'candidate-active.json');
    fs.writeFileSync(pointerFile, JSON.stringify(pointer));
    const fallback = selectCandidateModel(selection(data));
    assert.equal(fallback.selection, 'defaults');
    assert.equal(fallback.reason, 'low-confidence');
    const payload = { ...pointer };
    delete payload.digest;
    fs.writeFileSync(pointerFile, JSON.stringify(seal({ ...payload, evaluationDigest: 'sha256:../foreign' })));
    assert.equal(selectCandidateModel(selection(data)).reason, 'invalid-terminal-digest');
    const malformed = structuredClone(data.model);
    const cpu = { ...malformed.recommendations.cpu };
    delete cpu.digest;
    cpu.recommendations[0].confidence = 100;
    malformed.recommendations.cpu = seal(cpu);
    malformed.recommendationDigests.cpu = malformed.recommendations.cpu.digest;
    delete malformed.digest;
    assert.throws(() => validateModelBundle(seal(malformed), data.identity), { code: 'invalid-confidence' });
});

test('adaptive lifecycle benchmark shadow never changes CPU or memory during measurement', (context) =>
{
    const data = modelFixture(context, { defaults: { alpha: { benchmark: true, cpuUnits: 3 } } });
    const row = data.shadow.differences.find((item) => item.producerId === 'alpha');
    assert.equal(row.wouldGrant.cpuUnits, row.actual.cpuUnits);
    assert.equal(row.wouldGrant.memoryGiB, row.actual.memoryGiB);
});

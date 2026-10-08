import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { runCli } = await import(new URL("../../tools/perf/production-fresh-cli.mjs", import.meta.url));
const { captureCohort, inspectCohort, ledgerGenesis } = await import(new URL("../../tools/perf/production-fresh-cohort.mjs", import.meta.url));
const { digest, loadPerformanceRun, readDocument, seal } = await import(new URL("../../tools/perf/production-fresh-contract.mjs", import.meta.url));
const { classifyPerformanceRun } = await import(new URL("../../tools/perf/production-fresh-disposition.mjs", import.meta.url));

import { fixture } from './support/production-fresh-performance-fixture.mjs';

function capture(f, locators, expectedHead = ledgerGenesis, outputLocator = 'cohort.json')
{
    return captureCohort({ root: f.root, ledgerLocator: 'ledger.jsonl', runLocators: locators, expectedHead, outputLocator });
}

test('cohort retains all clean samples and independently recomputes identity/statistics', t =>
{
    const f = fixture(t);
    const cohort = capture(f, [f.run('a', { wall: 1000 }).locator, f.run('b', { wall: 1200 }).locator, f.run('c', { wall: 1100 }).locator]);
    assert.deepEqual(cohort.statistics.find(metric => metric.name === 'wallClockMs').distribution.values, [1000, 1200, 1100]);
    assert.equal(cohort.statistics.find(metric => metric.name === 'wallClockMs').distribution.p90, 1200);
    assert.equal(Object.hasOwn(cohort, 'verdict'), false);
    assert.deepEqual(inspectCohort(f.root, 'cohort.json').cohort, cohort);
});

test('baseline rejects failed retry resume partial and non-first-attempt runs', t =>
{
    for (const [index, options] of [{ execution: { status: 'failed' } }, { execution: { retryCount: 1 } },
        { execution: { resumed: true } }, { execution: { complete: false } }, { attempt: 2 },
        { execution: { terminal: false } }, { execution: { mode: 'resume' } }].entries())
    {
        const f = fixture(t);
        assert.throws(() => capture(f, [f.run(`bad${index}`, options).locator]), /ineligible baseline/u);
        assert.equal(fs.readFileSync(path.join(f.root, 'ledger.jsonl'), 'utf8'), '');
    }
});

test('baseline rejects swap OOM resource kill thermal noise CV isolation and exactness drift', t =>
{
    for (const [index, options] of [{ health: { swapBytes: 1 } }, { health: { oomCount: 1 } },
        { health: { resourceKillCount: 1 } }, { health: { thermalValid: false } }, { noise: { valid: false } },
        { noise: { complete: false } }, { health: { benchmarkCv: 0.2 } }, { health: { isolationValid: false } },
        { execution: { executedDigest: digest('wrong-plan') } }].entries())
    {
        const f = fixture(t);
        assert.throws(() => capture(f, [f.run(`bad${index}`, options).locator]), /ineligible baseline/u);
    }
});

test('baseline rejects duplicate receipts same run under another locator and insufficient samples', t =>
{
    const f = fixture(t);
    const a = f.run('a');
    const b = f.run('b');
    assert.throws(() => capture(f, [a.locator, a.locator, b.locator]), /duplicate/u);
    const { value } = readDocument(f.root, a.locator);
    f.put('alias.json', value);
    assert.throws(() => capture(f, [a.locator, 'alias.json', b.locator]), /duplicate/u);
    assert.throws(() => capture(f, [a.locator, b.locator]), /at least three/u);
});

test('append preserves old snapshots and rejects replacement stale anchors and truncation', t =>
{
    const f = fixture(t);
    const original = f.baseline();
    const originalBytes = fs.readFileSync(path.join(f.root, 'cohort.json'));
    const next = capture(f, [f.run('d', { wall: 1400 }).locator], original.ledger.head, 'cohort-2.json');
    assert.equal(next.runs.length, 4);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'cohort.json')), originalBytes);
    assert.equal(inspectCohort(f.root, 'cohort.json').cohort.runs.length, 3);
    assert.throws(() => capture(f, [f.run('e').locator], original.ledger.head, 'cohort-3.json'), /anchor mismatch/u);
    assert.throws(() => capture(f, [f.run('f').locator], next.ledger.head, 'cohort.json'), /already exists/u);
    const ledger = path.join(f.root, 'ledger.jsonl');
    const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n');
    fs.writeFileSync(ledger, `${lines.slice(0, 2).join('\n')}\n`);
    assert.throws(() => inspectCohort(f.root, 'cohort.json'), /truncated/u);
});

test('ledger rejects resealed slot replacement reordered samples and partial append', t =>
{
    const f = fixture(t);
    const cohort = f.baseline();
    const ledger = path.join(f.root, 'ledger.jsonl');
    const original = fs.readFileSync(ledger, 'utf8');
    const entries = original.trim().split('\n').map(line => JSON.parse(line));
    const replacement = f.run('replacement');
    let previous = ledgerGenesis;
    for (const entry of entries)
    {
        const payload = { ...entry };
        delete payload.digest;
        payload.previous = previous;
        if (payload.sequence === 1)
        {
            payload.runRef = readDocument(f.root, replacement.locator).ref;
            payload.runId = 'replacement';
        }
        const updated = seal(payload);
        Object.assign(entry, updated);
        previous = updated.digest;
    }
    fs.writeFileSync(ledger, entries.map(entry => `${JSON.stringify(entry)}\n`).join(''));
    assert.throws(() => inspectCohort(f.root, 'cohort.json'), /anchor tampered/u);
    assert.equal(cohort.runs.length, 3);
    fs.writeFileSync(ledger, original.trim().split('\n').reverse().join('\n') + '\n');
    assert.throws(() => inspectCohort(f.root, 'cohort.json'), /chain\/sequence/u);
    fs.writeFileSync(ledger, original.slice(0, -1));
    assert.throws(() => inspectCohort(f.root, 'cohort.json'), /partial append/u);
});

test('every machine plan toolchain policy collector identity change refuses append', t =>
{
    const f = fixture(t);
    const original = f.baseline();
    for (const [index, identity] of [{ machineTopology: { observed: 'same-model-other-machine' } },
        { physicalPlan: { observed: 'changed' } }, { toolchain: { observed: 'changed' } },
        { kernel: { observed: 'changed' } }, { collector: { observed: 'changed' } }].entries())
    {
        assert.throws(() => capture(f, [f.run(`drift${index}`, { identity }).locator], original.ledger.head, `new${index}.json`), /identity drift/u);
    }
});

test('explicit locators refuse latest traversal symlinks and missing run lists', t =>
{
    const f = fixture(t);
    f.run('a');
    assert.throws(() => capture(f, []), /explicit run locators/u);
    for (const locator of ['latest', '../a.json', '/a.json', 'x/../a.json'])
    {
        assert.throws(() => loadPerformanceRun(f.root, locator), /explicit immutable locator/u);
    }
    fs.symlinkSync(path.join(f.root, 'a.json'), path.join(f.root, 'alias.json'));
    assert.throws(() => loadPerformanceRun(f.root, 'alias.json'), /regular file/u);
    assert.throws(() => runCli(['compare', '--root', f.root, '--baseline', 'cohort.json']), /required/u);
});

test('raw receipt tampering wrong attempt and resealed statistics fail independent validation', t =>
{
    const f = fixture(t);
    const cohort = f.baseline();
    const payload = { ...cohort };
    delete payload.digest;
    payload.statistics[0].distribution.p50 = 1;
    f.put('forged.json', seal(payload));
    assert.throws(() => inspectCohort(f.root, 'forged.json'), /distribution\/provenance tampered/u);
    const raw = JSON.parse(fs.readFileSync(path.join(f.root, 'a-resource.json'), 'utf8'));
    raw.binding.attempt = 2;
    f.put('a-resource.json', raw);
    assert.throws(() => inspectCohort(f.root, 'cohort.json'), /tampered evidence/u);
});

test('classifier distinguishes actual CPU benchmark quiet and authoritative wait categories', t =>
{
    for (const [index, [kind, expected, authority, detail]] of [
        ['dependency-blocked', 'dependency-blocked', 'scheduler', { edge: 'a -> b' }],
        ['readiness-marker-blocked', 'readiness-blocked', 'marker', { marker: 'ready' }],
        ['capacity-blocked', 'capacity-blocked', 'scheduler', { cpu: true }],
        ['exclusive-resource-blocked', 'exclusive-blocked', 'scheduler', { resource: 'browser' }],
        ['external-service-io-blocked', 'external-io', 'scheduler', { service: 'database' }],
        ['benchmark-isolation-cooldown', 'legitimate-isolation', 'scheduler', { exclusive: true }]
    ].entries())
    {
        const f = fixture(t);
        const run = f.run(`wait${index}`, { waitKind: kind, waitAuthority: authority, waitDetail: detail });
        const actual = classifyPerformanceRun(f.root, loadPerformanceRun(f.root, run.locator));
        assert.equal(actual.status, 'classified');
        assert.equal(actual.intervals[0].classification, 'productive');
        assert.equal(actual.intervals[1].classification, expected);
        assert.deepEqual(actual, classifyPerformanceRun(f.root, loadPerformanceRun(f.root, run.locator)));
        assert.equal(Object.hasOwn(actual, 'verdict'), false);
    }
});

test('CPU efficiency applies only to complete CPU-heavy actual evidence', t =>
{
    const f = fixture(t);
    const nonCpu = f.run('coordination', { cpuHeavy: false });
    const output = classifyPerformanceRun(f.root, loadPerformanceRun(f.root, nonCpu.locator));
    assert.equal(output.metrics.find(metric => metric.name === 'cpuGrantEfficiency').disposition, 'not-applicable');
    const partial = f.run('partial', { samplingComplete: false });
    const unknown = classifyPerformanceRun(f.root, loadPerformanceRun(f.root, partial.locator));
    assert.equal(unknown.status, 'not-evaluable');
    assert.equal(unknown.metrics.find(metric => metric.name === 'cpuGrantEfficiency').value, null);
});

test('unsupported metrics remain null and required missing metrics fail closed', t =>
{
    const f = fixture(t);
    const run = f.run('unsupported', { metrics: { cpuPressure: { status: 'unsupported', value: null } } });
    const result = classifyPerformanceRun(f.root, loadPerformanceRun(f.root, run.locator));
    assert.equal(result.status, 'not-evaluable');
    assert.equal(result.metrics.find(metric => metric.name === 'cpuPressure').value, null);
    assert.throws(() => capture(f, [run.locator]), /classification/u);
    const bad = f.run('zero', { metrics: { cpuPressure: { status: 'unsupported', value: 0 } } });
    assert.throws(() => classifyPerformanceRun(f.root, loadPerformanceRun(f.root, bad.locator)), /must be null/u);
});

test('overlapping conflicting and unexplained critical intervals are not admitted', t =>
{
    const f = fixture(t);
    const overlap = f.run('overlap', { intervals: items =>
    {
        items[1].startMs = items[0].endMs - 1;
        items[1].evidence = [];
    } });
    assert.throws(() => classifyPerformanceRun(f.root, loadPerformanceRun(f.root, overlap.locator)), /overlapping/u);
    const unknown = f.run('unknown', { intervals: items =>
    {
        items[1].evidence = [];
    } });
    assert.equal(classifyPerformanceRun(f.root, loadPerformanceRun(f.root, unknown.locator)).status, 'not-evaluable');
    const conflict = f.run('conflict', { intervals: (items, put, binding) =>
    {
        const interval = items[1];
        interval.evidence.push(put('conflict-extra.json', { binding, authority: 'resource', intervalId: interval.id,
            bundleId: interval.bundleId, stepId: interval.stepId, startMs: interval.startMs, endMs: interval.endMs,
            kind: 'actual-cpu', detail: { actualCpuSeconds: 1 } }));
    } });
    assert.equal(classifyPerformanceRun(f.root, loadPerformanceRun(f.root, conflict.locator)).intervals[1].reason, 'conflicting-authority');
});

test('machine identity requires physical machine calibration and verified finite boundary facts', t =>
{
    const f = fixture(t);
    const run = f.run('invalid', { identity: { effectiveCpuCalibration: { effectiveCpuUnits: 9, finiteBoundaryCpuUnits: 8 } } });
    assert.throws(() => loadPerformanceRun(f.root, run.locator), /finite CPU boundary/u);
    const missing = f.run('missing');
    const raw = readDocument(f.root, 'missing-identity.json').value;
    delete raw.values.machineTopology.machineId;
    const ref = f.put('missing-identity.json', raw);
    const receipt = { ...missing.receipt };
    delete receipt.digest;
    receipt.identity = ref;
    f.put('missing.json', seal(receipt));
    assert.throws(() => loadPerformanceRun(f.root, 'missing.json'), /machineId/u);
});

test('capture and inspect CLI round-trip explicit frozen locators and reject lock contention', t =>
{
    const f = fixture(t);
    const locators = ['a', 'b', 'c'].map(id => f.run(id).locator);
    const args = ['capture', '--root', f.root, '--ledger', 'ledger.jsonl', '--expected-head', ledgerGenesis,
        '--out', 'cohort.json', ...locators.flatMap(locator => ['--run', locator])];
    const cohort = runCli(args);
    assert.deepEqual(runCli(['inspect', '--root', f.root, '--baseline', 'cohort.json']), cohort);
    fs.writeFileSync(path.join(f.root, 'ledger.jsonl.lock'), 'owner');
    assert.throws(() => capture(f, [f.run('d').locator], cohort.ledger.head, 'cohort-2.json'), /EEXIST/u);
    assert.equal(fs.readFileSync(path.join(f.root, 'ledger.jsonl.lock'), 'utf8'), 'owner');
});

test('CPU applicability and metric interval owners must match the sealed physical plan', t =>
{
    const f = fixture(t);
    const run = f.run('drift');
    const raw = readDocument(f.root, 'drift-resource.json').value;
    raw.steps[0].cpuHeavy = false;
    const receipt = { ...run.receipt };
    delete receipt.digest;
    receipt.resource = f.put('drift-resource.json', raw);
    f.put(run.locator, seal(receipt));
    assert.throws(() => classifyPerformanceRun(f.root, loadPerformanceRun(f.root, run.locator)), /sealed physical plan/u);
    const impossible = f.run('impossible', { wall: 500, critical: 800 });
    assert.equal(classifyPerformanceRun(f.root, loadPerformanceRun(f.root, impossible.locator)).status, 'not-evaluable');
});

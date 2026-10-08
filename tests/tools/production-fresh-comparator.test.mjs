import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { comparePerformance } = await import(new URL("../../tools/perf/production-fresh-comparator.mjs", import.meta.url));
const { canonical, digest, readDocument, seal } = await import(new URL("../../tools/perf/production-fresh-contract.mjs", import.meta.url));
const { createPerformanceVerdict, consumePerformanceVerdicts } = await import(new URL("../../tools/perf/production-fresh-verdict.mjs", import.meta.url));

import { fixture } from './support/production-fresh-performance-fixture.mjs';

function compare(f, currentLocator)
{
    return comparePerformance({ root: f.root, currentLocator, baselineLocator: 'cohort.json' });
}

function verdict(f, options = {})
{
    const run = f.run('current', options);
    const comparison = compare(f, run.locator);
    f.put('comparison.json', comparison);
    const result = createPerformanceVerdict(f.root, 'comparison.json', run.binding);
    const ref = f.put('verdict.json', result);
    return { run, comparison, result, ref };
}

test('significant wall-clock and critical-path regressions locate machine noise and baseline distribution', t =>
{
    const f = fixture(t);
    f.baseline();
    const run = f.run('current', { wall: 1300, critical: 1050 });
    const result = compare(f, run.locator);
    assert.equal(result.verdict, 'regression');
    const wall = result.differences.find(item => item.metric === 'wallClockMs');
    assert.equal(wall.currentValue, 1300);
    assert.equal(wall.baselineDistribution.p90, 1000);
    assert.equal(wall.relativeDelta, 0.3);
    assert.equal(wall.noiseFloor, 5);
    assert.equal(wall.bundleId, 'production');
});

test('genuine wall-clock improvement and noise-only change are separate deterministic results', t =>
{
    const f = fixture(t);
    f.baseline();
    const better = f.run('better', { wall: 800, critical: 640 });
    assert.equal(compare(f, better.locator).verdict, 'improvement');
    const noise = f.run('noise', { wall: 1010, critical: 802 });
    const first = compare(f, noise.locator);
    assert.equal(first.verdict, 'noise-only');
    assert.equal(canonical(first), canonical(compare(f, noise.locator)));
});

test('same CPU model on a different machine and toolchain policy drift are not evaluable', t =>
{
    const f = fixture(t);
    f.baseline();
    for (const [index, identity] of [{ machineTopology: { observed: 'same-CPU-other-machine' } },
        { toolchain: { observed: 'new' } }, { physicalPlan: { observed: 'new' } }].entries())
    {
        const run = f.run(`drift${index}`, { identity });
        assert.equal(compare(f, run.locator).verdict, 'not-evaluable');
    }
});

test('higher actual CPU cannot conceal wall-clock regression', t =>
{
    const f = fixture(t);
    f.baseline();
    const run = f.run('burner', { actual: 8, wall: 1400, critical: 1000 });
    const result = compare(f, run.locator);
    assert.equal(result.verdict, 'regression');
    assert.equal(result.differences.find(item => item.metric === 'cpuGrantEfficiency').currentValue, 1);
});

test('lower CPU with faster wall-clock and legitimate benchmark quiet passes', t =>
{
    const f = fixture(t);
    f.baseline({ waitKind: 'benchmark-isolation-cooldown', waitDetail: { exclusive: true } });
    const current = verdict(f, { wall: 750, critical: 650, actual: 2,
        waitKind: 'benchmark-isolation-cooldown', waitDetail: { exclusive: true } });
    assert.equal(current.comparison.verdict, 'improvement');
    assert.equal(current.result.verdict, 'pass');
    assert.equal(current.comparison.classification.intervals[1].classification, 'legitimate-isolation');
    assert.equal(consumePerformanceVerdicts({ root: f.root, verdictRefs: [current.ref], expectedBinding: current.run.binding }).qualificationEligible, true);
});

test('dependency sleep hidden by CPU burner is a localized regression despite faster wall-clock', t =>
{
    const f = fixture(t);
    f.baseline();
    const run = f.run('sleep', { actual: 8, wall: 900, critical: 800, wait: 300 });
    const result = compare(f, run.locator);
    assert.equal(result.verdict, 'regression');
    const interval = result.differences.find(item => item.metric === 'longestUnproductiveMs');
    assert.equal(interval.intervalId, 'wait');
    assert.equal(interval.stepId, 'compile');
    assert.equal(interval.currentValue, 300);
    assert.equal(interval.baselineDistribution.p50, 100);
});

test('swap OOM resource kill CV isolation invalid and exactness drift veto faster runs', t =>
{
    const f = fixture(t);
    f.baseline();
    for (const [index, options] of [{ health: { swapBytes: 1 } }, { health: { oomCount: 1 } },
        { health: { resourceKillCount: 1 } }, { health: { benchmarkCv: 0.2 } },
        { health: { isolationValid: false } }, { execution: { executedDigest: digest('drift') } }].entries())
    {
        const run = f.run(`veto${index}`, { wall: 500, critical: 500, ...options });
        assert.equal(compare(f, run.locator).verdict, 'regression');
    }
});

test('unsupported required metric unavailable noise and partial current remain visible not-evaluable', t =>
{
    const f = fixture(t);
    f.baseline();
    const unsupported = f.run('unsupported', { metrics: { cpuPressure: { status: 'unsupported', value: null } } });
    const result = compare(f, unsupported.locator);
    assert.equal(result.verdict, 'not-evaluable');
    assert.equal(result.differences.find(item => item.metric === 'cpuPressure').currentValue, null);
    const unknownFloor = f.run('floor');
    const document = readDocument(f.root, 'floor-noise.json').value;
    delete document.floors.wallClockMs;
    const noiseRef = f.put('floor-noise.json', document);
    const receipt = { ...unknownFloor.receipt };
    delete receipt.digest;
    receipt.noise = noiseRef;
    f.put(unknownFloor.locator, seal(receipt));
    assert.equal(compare(f, unknownFloor.locator).verdict, 'not-evaluable');
    const partial = f.run('partial', { execution: { complete: false } });
    assert.equal(compare(f, partial.locator).verdict, 'not-evaluable');
});

test('regression requires both relative movement and machine noise envelope', t =>
{
    const f = fixture(t);
    f.baseline({ floors: { wallClockMs: 200 } });
    const run = f.run('noisy', { wall: 1150, floors: { wallClockMs: 200 } });
    assert.equal(compare(f, run.locator).verdict, 'noise-only');
    const cpu = f.run('cpu-only', { actual: 8 });
    assert.equal(compare(f, cpu.locator).verdict, 'noise-only');
});

test('terminal verdict consumer rejects missing duplicate provisional tampered and wrong-attempt evidence', t =>
{
    const f = fixture(t);
    f.baseline();
    const current = verdict(f);
    const consume = refs => consumePerformanceVerdicts({ root: f.root, verdictRefs: refs, expectedBinding: current.run.binding });
    assert.equal(consume([]).qualificationEligible, false);
    assert.equal(consume([current.ref, current.ref]).qualificationEligible, false);
    assert.equal(consume([current.ref]).qualificationEligible, true);
    const wrong = consumePerformanceVerdicts({ root: f.root, verdictRefs: [current.ref], expectedBinding: { ...current.run.binding, attempt: 2 } });
    assert.equal(wrong.qualificationEligible, false);
    assert.throws(() => createPerformanceVerdict(f.root, 'comparison.json', { ...current.run.binding, runId: 'foreign' }), /wrong-run/u);
    const payload = { ...current.result };
    delete payload.digest;
    payload.terminal = false;
    const provisional = f.put('provisional.json', seal(payload));
    assert.equal(consume([provisional]).qualificationEligible, false);
    fs.appendFileSync(path.join(f.root, 'verdict.json'), ' ');
    assert.equal(consume([current.ref]).qualificationEligible, false);
});

test('resealed verdict cannot override regression or remove reproduce command', t =>
{
    const f = fixture(t);
    f.baseline();
    const current = verdict(f, { wall: 1300 });
    assert.equal(current.result.verdict, 'regression');
    const payload = { ...current.result };
    delete payload.digest;
    payload.verdict = 'pass';
    const forged = f.put('forged-verdict.json', seal(payload));
    const result = consumePerformanceVerdicts({ root: f.root, verdictRefs: [forged], expectedBinding: current.run.binding });
    assert.equal(result.qualificationEligible, false);
    const actual = consumePerformanceVerdicts({ root: f.root, verdictRefs: [current.ref], expectedBinding: current.run.binding });
    assert.equal(actual.performanceFailure.classification, 'performance-regression');
    assert.equal(actual.performanceFailure.reproduce.currentLocator, 'current.json');
});

test('correctness authority remains first failure alongside performance regression', t =>
{
    const f = fixture(t);
    f.baseline();
    const current = verdict(f, { wall: 1300 });
    const correctnessFailure = { classification: 'correctness-failed', receiptDigest: digest('correctness') };
    const actual = consumePerformanceVerdicts({ root: f.root, verdictRefs: [current.ref], expectedBinding: current.run.binding, correctnessFailure });
    assert.equal(actual.qualificationEligible, false);
    assert.equal(actual.correctnessFailure, correctnessFailure);
    assert.equal(actual.firstFailure, correctnessFailure);
    assert.equal(actual.performanceFailure.classification, 'performance-regression');
});

test('not-evaluable identity drift blocks qualification with calibration-required attribution', t =>
{
    const f = fixture(t);
    f.baseline();
    const current = verdict(f, { identity: { kernel: { observed: 'changed' } } });
    const actual = consumePerformanceVerdicts({ root: f.root, verdictRefs: [current.ref], expectedBinding: current.run.binding });
    assert.equal(actual.qualificationEligible, false);
    assert.equal(actual.performanceFailure.classification, 'calibration-required/not-evaluable');
});

test('consumer imports no comparator producer and spawns zero processes with missing evidence', t =>
{
    const f = fixture(t);
    f.baseline();
    const current = verdict(f);
    const childScript = `import childProcess from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        let count = 0;
        for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
            childProcess[name] = () => { count++; throw new Error('producer spawn trap'); };
        syncBuiltinESMExports();
        const { consumePerformanceVerdicts } = await import('./tools/perf/production-fresh-verdict.mjs');
        const options = ${JSON.stringify({ root: f.root, verdictRefs: [current.ref], expectedBinding: current.run.binding })};
        const pass = consumePerformanceVerdicts(options);
        const missing = consumePerformanceVerdicts({ ...options, verdictRefs: [] });
        console.log(JSON.stringify({ count, pass: pass.qualificationEligible, missing: missing.qualificationEligible }));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { count: 0, pass: true, missing: false });
});

test('CLI writes immutable comparison and verdict outputs with pass regression and not-evaluable exits', t =>
{
    const f = fixture(t);
    f.baseline();
    const run = f.run('current', { wall: 1300 });
    const cwd = path.resolve(import.meta.dirname, '../..');
    const args = ['tools/perf/production-fresh-cli.mjs', 'compare', '--root', f.root, '--current-run', run.locator,
        '--baseline', 'cohort.json', '--out', 'cli-comparison.json'];
    const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).verdict, 'regression');
    const again = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
    assert.equal(again.status, 2);
    assert.match(again.stderr, /EEXIST/u);
    assert.equal(readDocument(f.root, 'cli-comparison.json').value.verdict, 'regression');
});

test('verdict producer rejects provisional comparison even with a valid new seal', t =>
{
    const f = fixture(t);
    f.baseline();
    const run = f.run('current');
    const comparison = { ...compare(f, run.locator) };
    delete comparison.digest;
    comparison.terminal = false;
    f.put('provisional-comparison.json', seal(comparison));
    assert.throws(() => createPerformanceVerdict(f.root, 'provisional-comparison.json', run.binding), /provisional comparator/u);
});

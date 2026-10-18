import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture } from './support/production-fresh-performance-fixture.mjs';

const { comparePerformance } = await import(new URL('../../tools/perf/production-fresh-comparator.mjs', import.meta.url));
const { loadPerformanceRun } = await import(new URL('../../tools/perf/production-fresh-contract.mjs', import.meta.url));
const { classifyPerformanceRun } = await import(new URL('../../tools/perf/production-fresh-disposition.mjs', import.meta.url));

function diagnosticMetric(name, status = 'unsupported')
{
    return { metrics: { readBytes: { name, status, value: null } } };
}

for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty'])
{
    for (const status of ['unsupported', 'unavailable'])
    {
        test(`classifier rejects inherited metric ${name} with ${status} null`, t =>
        {
            const f = fixture(t);
            const run = f.run('unknown', diagnosticMetric(name, status));
            assert.throws(() => classifyPerformanceRun(f.root, loadPerformanceRun(f.root, run.locator)),
                /unknown\/derived resource metric/u);
        });
    }

    test(`inherited metric ${name} cannot enter a cohort and produce noise-only`, t =>
    {
        const f = fixture(t);
        const options = diagnosticMetric(name);
        assert.throws(() =>
        {
            const cohort = f.baseline(options);
            const current = f.run('current', options);
            const classified = classifyPerformanceRun(f.root, loadPerformanceRun(f.root, current.locator));
            const comparison = comparePerformance({ root: f.root, currentLocator: current.locator,
                baselineLocator: 'cohort.json' });
            t.diagnostic(JSON.stringify({ name, classification: classified.status,
                cohortRuns: cohort.runs.length, verdict: comparison.verdict }));
        }, /unknown\/derived resource metric/u);
    });

    test(`comparison rejects inherited current metric ${name} with a valid cohort`, t =>
    {
        const f = fixture(t);
        f.baseline();
        const current = f.run('current', diagnosticMetric(name));
        assert.throws(() => comparePerformance({ root: f.root, currentLocator: current.locator,
            baselineLocator: 'cohort.json' }), /unknown\/derived resource metric/u);
    });
}

test('classifier rejects non-string JSON metric names including registered-name arrays', t =>
{
    const f = fixture(t);
    for (const [index, name] of [null, 0, true, {}, [], ['readBytes'], ['constructor']].entries())
    {
        const run = f.run(`invalid${index}`, diagnosticMetric(name));
        assert.throws(() => classifyPerformanceRun(f.root, loadPerformanceRun(f.root, run.locator)),
            /unknown\/derived resource metric/u);
    }
});

test('classifier rejects non-string metric names without invoking property coercion', t =>
{
    const f = fixture(t);
    const run = f.run('coercion');
    const loaded = loadPerformanceRun(f.root, run.locator);
    let coercions = 0;
    loaded.resource.metrics.find(metric => metric.name === 'readBytes').name = {
        [Symbol.toPrimitive]()
        {
            coercions++;
            return 'readBytes';
        }
    };
    assert.throws(() => classifyPerformanceRun(f.root, loaded), /unknown\/derived resource metric/u);
    assert.equal(coercions, 0);
});

test('ordinary unknown names are rejected before metric status or value validation', t =>
{
    const f = fixture(t);
    for (const [index, status] of ['measured', 'unsupported', 'invalid-status'].entries())
    {
        const run = f.run(`unknown${index}`, diagnosticMetric('not-a-resource-metric', status));
        assert.throws(() => classifyPerformanceRun(f.root, loadPerformanceRun(f.root, run.locator)),
            /unknown\/derived resource metric/u);
    }
});

test('derived and health metric inputs remain rejected', t =>
{
    const f = fixture(t);
    for (const [index, name] of ['cpuGrantEfficiency', 'longestUnproductiveMs', 'waitMs:productive', 'swapBytes'].entries())
    {
        const run = f.run(`derived${index}`, diagnosticMetric(name));
        assert.throws(() => classifyPerformanceRun(f.root, loadPerformanceRun(f.root, run.locator)),
            /unknown\/derived resource metric/u);
    }
});

for (const status of ['unsupported', 'unavailable'])
{
    test(`registered diagnostic ${status} null remains classifiable and comparable`, t =>
    {
        const f = fixture(t);
        const options = diagnosticMetric('readBytes', status);
        f.baseline(options);
        const run = f.run('current', options);
        const classification = classifyPerformanceRun(f.root, loadPerformanceRun(f.root, run.locator));
        const metric = classification.metrics.find(item => item.name === 'readBytes');
        assert.equal(classification.status, 'classified');
        assert.equal(metric.status, status);
        assert.equal(metric.value, null);
        assert.equal(metric.required, false);
        assert.equal(metric.disposition, status === 'unsupported' ? 'unsupported' : 'diagnostic');
        const comparison = comparePerformance({ root: f.root, currentLocator: run.locator,
            baselineLocator: 'cohort.json' });
        assert.equal(comparison.verdict, 'noise-only');
        assert.equal(comparison.differences.find(item => item.metric === 'readBytes').currentValue, null);
    });

    test(`registered required ${status} null remains not-evaluable and cannot enter a cohort`, t =>
    {
        const f = fixture(t);
        f.baseline();
        const run = f.run('required', { metrics: { cpuPressure: { status, value: null } } });
        const classification = classifyPerformanceRun(f.root, loadPerformanceRun(f.root, run.locator));
        const metric = classification.metrics.find(item => item.name === 'cpuPressure');
        assert.equal(classification.status, 'not-evaluable');
        assert.equal(metric.status, status);
        assert.equal(metric.value, null);
        assert.equal(metric.required, true);
        assert.equal(metric.disposition, status === 'unsupported' ? 'unsupported' : 'gate');
        assert.equal(classification.reasons.some(reason => reason.startsWith('unknown-required:')), true);
        assert.equal(comparePerformance({ root: f.root, currentLocator: run.locator,
            baselineLocator: 'cohort.json' }).verdict, 'not-evaluable');
        const baseline = fixture(t);
        assert.throws(() => baseline.baseline({ metrics: { cpuPressure: { status, value: null } } }),
            /ineligible baseline classification/u);
    });
}

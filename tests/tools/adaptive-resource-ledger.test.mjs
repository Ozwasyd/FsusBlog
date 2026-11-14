import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { digestJson, inspectPerformancePrerequisite } = await import(new URL('../../tools/resource-model/contract.mjs', import.meta.url));
const {
    appendSampleCandidate, createSampleCandidate, enrollProductionSample, readSampleLedger, validateSampleCandidate
} = await import(new URL('../../tools/resource-model/sample-ledger.mjs', import.meta.url));

import { fixture } from './support/adaptive-resource-fixtures.mjs';

test('adaptive ledger appends once and deterministically reconstructs all raw evidence', (context) =>
{
    const data = fixture(context);
    assert.equal(readSampleLedger(data.inputs.ledger).samples.length, 5);
    assert.deepEqual(validateSampleCandidate(data.samples[0], data.evidenceRoot), data.samples[0]);
    assert.equal(data.samples[0].authority, 'DATA_ONLY');
    assert.throws(() => enrollProductionSample({ verified: true }), { code: 'upstream-verification-unavailable' });
});

test('adaptive ledger rejects every unclean run state and missing qualification fact', (context) =>
{
    const data = fixture(context, { count: 0 });
    const mutations = [
        (facts) =>
        {
            facts.run.status = 'failed';
        },
        (facts) =>
        {
            facts.run.status = 'cancelled';
        },
        (facts) =>
        {
            facts.run.attemptOrdinal = 2;
        },
        (facts) =>
        {
            facts.run.resumed = true;
        },
        (facts) =>
        {
            facts.run.fresh = false;
        },
        (facts) =>
        {
            facts.run.complete = false;
        },
        (facts) =>
        {
            facts.run.calibrated = false;
        },
        (facts) =>
        {
            delete facts.run.correctnessPassed;
        }
    ];
    for (const [index, mutate] of mutations.entries())
    {
        const input = data.makeSample(index, mutate);
        assert.throws(() => createSampleCandidate(input), (error) => error.code === 'unclean-run'
            && error.evidenceRef === input.receipts.run.ref);
    }
});

test('adaptive ledger rejects resource performance boundary benchmark noise and membership drift', (context) =>
{
    const data = fixture(context, { count: 0 });
    const mutations = [
        (facts) =>
        {
            facts.resource.swap = 1;
        },
        (facts) =>
        {
            facts.resource.oom = 1;
        },
        (facts) =>
        {
            facts.resource.resourceKills = 1;
        },
        (facts) =>
        {
            facts.resource.complete = false;
        },
        (facts) =>
        {
            facts.resource.unsupportedRequiredMetrics = 1;
        },
        (facts) =>
        {
            facts.performance.verdict = 'regression';
        },
        (facts) =>
        {
            facts.performance.evaluable = false;
        },
        (facts) =>
        {
            facts.performance.terminal = false;
        },
        (facts) =>
        {
            facts.collector.drift = true;
        },
        (facts) =>
        {
            facts.enforcement.drift = true;
        },
        (facts) =>
        {
            facts.benchmark.isolationValid = false;
        },
        (facts) =>
        {
            facts.benchmark.cvValid = false;
        },
        (facts) =>
        {
            facts.noise.thermalInvalid = true;
        },
        (facts) =>
        {
            facts.noise.externalNoiseInvalid = true;
        },
        (facts) =>
        {
            facts.plan.executed.pop();
        },
        (facts) =>
        {
            facts.plan.executed.push('extra');
        },
        (facts) =>
        {
            facts.resource.observations.pop();
        }
    ];
    for (const [index, mutate] of mutations.entries())
    {
        const input = data.makeSample(index, mutate);
        let first;
        try
        {
            createSampleCandidate(input);
            assert.fail('unclean input accepted');
        }
        catch (error)
        {
            first = { code: error.code, ref: error.evidenceRef };
        }
        assert.ok(first.code && first.ref);
        assert.throws(() => createSampleCandidate(input), (error) => error.code === first.code
            && error.evidenceRef === first.ref);
    }
});

test('adaptive ledger refuses duplicate aliases replacement and cross identity appends', (context) =>
{
    const data = fixture(context);
    const append = (sample, head = data.head) => appendSampleCandidate({ ...data.inputs.ledger, sample, head });
    assert.throws(() => append(data.samples[0]), { code: 'duplicate-run' });
    for (const key of Object.keys(data.identity))
    {
        const sample = structuredClone(data.samples[0]);
        sample.identity[key] = key === 'machineId' ? 'same-cpu-different-host' : digestJson(key);
        assert.throws(() => append(sample), { code: 'identity-drift' });
    }
    const input = data.makeSample(8);
    const receipts = structuredClone(input.receipts);
    for (const locator of Object.values(receipts))
    {
        fs.copyFileSync(path.join(data.evidenceRoot, locator.ref), path.join(data.evidenceRoot, `copy-${locator.ref}`));
        locator.ref = `copy-${locator.ref}`;
    }
    const sample = createSampleCandidate(input);
    const head = append(sample);
    assert.throws(() => append(createSampleCandidate({ ...input, receipts }), head), { code: 'duplicate-run' });
    assert.throws(() => append(createSampleCandidate(data.makeSample(9))), { code: 'replacement-refused' });
});

test('adaptive ledger detects raw tamper missing receipts rewritten chain and truncated head', (context) =>
{
    const data = fixture(context);
    const ref = data.samples[0].receipts.resource.ref;
    const file = path.join(data.evidenceRoot, ref);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, '{}');
    assert.throws(() => readSampleLedger(data.inputs.ledger), { code: 'evidence-tamper', evidenceRef: ref });
    fs.rmSync(file);
    assert.throws(() => readSampleLedger(data.inputs.ledger), { code: 'evidence-unreadable' });
    fs.writeFileSync(file, original);
    assert.throws(() => readSampleLedger({ ...data.inputs.ledger, head: { ...data.head, count: 4 } }),
        { code: 'ledger-head-drift' });
    const recordFile = path.join(data.directory, '1.json');
    const record = JSON.parse(fs.readFileSync(recordFile));
    record.sample.observations[0].peakRssGiB = 0;
    fs.writeFileSync(recordFile, JSON.stringify(record));
    assert.throws(() => readSampleLedger(data.inputs.ledger), { code: 'document-tamper' });
});

test('adaptive ledger rejects ambient locators incomplete observations and wrong attempts', (context) =>
{
    const data = fixture(context, { count: 0 });
    const input = data.makeSample(1);
    for (const ref of ['../escape.json', 'latest/run.json', '/tmp/absolute.json'])
    {
        assert.throws(() => createSampleCandidate({ ...input,
            receipts: { ...input.receipts, run: { ...input.receipts.run, ref } } }), { code: 'invalid-locator' });
    }
    assert.throws(() => createSampleCandidate({ ...input, attemptId: 'wrong' }), { code: 'wrong-run-attempt' });
    assert.throws(() => createSampleCandidate({ ...input, receipts: { run: input.receipts.run } }),
        { code: 'missing-raw-evidence' });
    assert.throws(() => createSampleCandidate(data.makeSample(2, (facts) =>
    {
        delete facts.resource.observations[0].allocationPressure;
    })), { code: 'invalid-optional-metric' });
    const alias = path.join(data.evidenceRoot, 'alias.json');
    fs.symlinkSync(path.join(data.evidenceRoot, input.receipts.run.ref), alias);
    assert.throws(() => createSampleCandidate({ ...input,
        receipts: { ...input.receipts, run: { ...input.receipts.run, ref: 'alias.json' } } }),
    { code: 'invalid-evidence-file' });
});

test('adaptive CLI publishes explicit samples and refuses ambiguous arguments and runtime enrollment', (context) =>
{
    const data = fixture(context, { count: 0 });
    const input = path.join(data.root, 'input.json');
    const output = path.join(data.root, 'output.json');
    fs.writeFileSync(input, JSON.stringify(data.makeSample(0)));
    const cli = new URL('../../tools/resource-model/cli.mjs', import.meta.url);
    const run = (args) => spawnSync(process.execPath, [cli.pathname, ...args], { encoding: 'utf8' });
    assert.equal(run(['sample', '--input', input, '--out', output]).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(output)).authority, 'DATA_ONLY');
    assert.equal(run(['sample', '--input', input, '--out', output]).status, 1);
    assert.equal(run(['sample', '--input', input, '--input', input]).status, 1);
    assert.equal(run(['sample', '--latest', input]).status, 1);
    assert.equal(run(['unknown', '--input', input]).status, 1);
    const runtime = run(['production-enroll', '--input', input]);
    assert.equal(runtime.status, 1);
    assert.equal(JSON.parse(runtime.stderr).code, 'upstream-verification-unavailable');
});

test('adaptive performance prerequisite refuses absent and byte drifted upstream capabilities', async (context) =>
{
    const data = fixture(context, { count: 0 });
    const input = { capabilityRoot: data.root, root: data.evidenceRoot, verdictRefs: [], expectedBinding: {} };
    await assert.rejects(() => inspectPerformancePrerequisite(input), { code: 'performance-capability-unavailable' });
    const source = path.join(data.root, 'tools', 'perf');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'production-fresh-contract.mjs'), 'export const verified = true;\n');
    await assert.rejects(() => inspectPerformancePrerequisite(input), { code: 'performance-capability-drift' });
});

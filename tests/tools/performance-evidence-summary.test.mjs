import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolvePerformanceEvidenceWorkers } from '../../tools/test/aggregate-performance-evidence.mjs';
import {
    bindMeasurementNoiseAuthority,
    evaluateMeasurementObservation,
    readMeasurementNoisePolicy
} from '../../tools/test/measurement-noise-envelope.mjs';
import { matrixGeneratedRuntimePaths } from '../../tools/test-matrix/local-profile.mjs';
import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const aggregateScript = path.join(root, 'tools/test/aggregate-performance-evidence.mjs');
const sourceFiles = {
    'load-baseline': '.tmp/perf/release-summaries/load-baseline.json',
    'load-peak': '.tmp/perf/release-summaries/load-expected-peak.json',
    'backend-benchmark-regression': '.tmp/perf/release-summaries/backend-benchmark-regression.json'
};
const measurementPolicy = readMeasurementNoisePolicy();

function performanceSourceFixture(id)
{
    if (!id.startsWith('load-'))
    {
        return { schema: `fixture.${id}.v1`, status: 'ok', id };
    }
    const metrics = Object.fromEntries(Object.entries(measurementPolicy.metrics).map(([name, declaration]) => [
        name,
    Number.isFinite(declaration.minimum) ? declaration.minimum : 0
    ]));
    const record = {
        observation: { durationMs: 1000, metrics },
        evaluation: evaluateMeasurementObservation({ metrics }, measurementPolicy)
    };
    const receipt = bindMeasurementNoiseAuthority({
        schema: 'fsusblog.measurement-noise-envelope.v1',
        windowId: `fixture/${id}`,
        status: 'clean',
        classification: null,
        qualificationEligible: true,
        productConclusionEligible: true,
        productOutcome: { status: 'completed' },
        timing: {
            admissionWaitMs: 1,
            measurementDurationMs: 1000,
            measurementStartedAfterAdmission: true
        },
        phases: {
            preflight: { status: 'clean', attempts: [structuredClone(record)] },
            during: {
                status: 'clean',
                observations: [structuredClone(record)],
                firstNoisyObservation: null
            },
            post: structuredClone(record)
        }
    }, {
        runId: `fixture-${id}`,
        attemptId: `fixture-${id}:attempt-1`
    });
    return {
        schema: 'fsusblog.qualified-load-profile-summary.v1',
        status: 'ok',
        id,
        qualificationEligible: true,
        productConclusionEligible: true,
        measurementNoiseAuthority: {
            runId: receipt.authority.runId,
            windowId: receipt.windowId,
            attemptId: receipt.authority.attemptId,
            attemptSequence: receipt.authority.attemptSequence,
            receiptDigest: receipt.authority.contentDigest
        },
        measurementNoiseEnvelope: receipt,
        measurementNoiseAuthoritySequence: [receipt]
    };
}

function writeJson(base, relative, payload)
{
    const absolute = path.join(base, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify(payload, null, 2)}\n`);
}

function runAggregator(base, env = {})
{
    return spawnSync(process.execPath, [aggregateScript, '--root', base], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        timeout: 10_000
    });
}

test('performance summary is the only required generated runtime evidence', () =>
{
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const tier = matrix.tiers.find((candidate) => candidate.id === 'performance-evidence-summary');

    assert.ok(tier);
    assert.deepEqual(matrixGeneratedRuntimePaths(tier), [
        '.tmp/release-evidence/perf-summary.json'
    ]);
});

test('performance evidence workers follow the complete scheduler grant and source count', () =>
{
    assert.equal(resolvePerformanceEvidenceWorkers({
        sourceCount: 4,
        env: {
            FSUSBLOG_STEP_CPU_BUDGET: '3',
            FSUSBLOG_STEP_MEMORY_GIB: '2'
        },
        cpuCount: 8,
        freeMemoryBytes: 512,
        totalMemoryBytes: 8192,
        load1: 8
    }), 3);
    assert.equal(resolvePerformanceEvidenceWorkers({
        sourceCount: 2,
        env: {
            FSUSBLOG_STEP_CPU_BUDGET: '8',
            FSUSBLOG_STEP_MEMORY_GIB: '8'
        },
        cpuCount: 16,
        freeMemoryBytes: 16384,
        totalMemoryBytes: 16384,
        load1: 0
    }), 2);
});

test('performance evidence aggregation reports every missing producer in one run', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-perf-summary-missing-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    const result = runAggregator(temp);
    assert.notEqual(result.status, 0);
    for (const id of Object.keys(sourceFiles))
    {
        assert.match(result.stderr, new RegExp(`missing ${id} performance evidence`, 'u'));
    }
});

test('correctness performance producers stay isolated from browser diagnostics', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-perf-summary-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    for (const [id, relative] of Object.entries(sourceFiles))
    {
        writeJson(temp, relative, performanceSourceFixture(id));
    }
    writeJson(temp, '.tmp/release-evidence/perf-summary.json', { stale: true });

    const first = runAggregator(temp);
    assert.equal(first.status, 0, first.stderr);
    const outputFile = path.join(temp, '.tmp/release-evidence/perf-summary.json');
    const firstSummary = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    assert.equal(firstSummary.schema, 'fsusblog.performance-evidence-summary.v1');
    assert.equal(firstSummary.status, 'blocked');
    assert.equal(firstSummary.stale, undefined);
    assert.deepEqual(firstSummary.entries.map((entry) => entry.id), [
        ...Object.keys(sourceFiles),
        'performance-saturation-v2'
    ]);
    assert.ok(firstSummary.entries.slice(0, 3).every((entry) => entry.status === 'ok' && entry.summary.id === entry.id));
    assert.equal(firstSummary.entries.at(-1).status, 'blocked');
    assert.match(firstSummary.entries.at(-1).summary.reason, /not supplied/u);

    for (const relative of Object.values(sourceFiles))
    {
        assert.ok(fs.existsSync(path.join(temp, relative)));
    }

    writeJson(temp, sourceFiles['load-baseline'], {
        status: 'ok',
        id: 'load-baseline',
        metrics: { rps: 100 }
    });
    const unqualified = runAggregator(temp);
    assert.notEqual(unqualified.status, 0);
    assert.match(unqualified.stderr, /no qualified measurement authority/u);
    writeJson(temp, sourceFiles['load-baseline'], performanceSourceFixture('load-baseline'));

    writeJson(temp, sourceFiles['backend-benchmark-regression'], {
        status: 'failed',
        id: 'backend-benchmark-regression'
    });
    const third = runAggregator(temp);
    assert.equal(third.status, 0, third.stderr);
    assert.equal(JSON.parse(fs.readFileSync(outputFile, 'utf8')).status, 'failed');
});

test('performance aggregate restores producer summaries from a transport manifest', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-perf-summary-ci-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const objects = [];
    for (const [id, relative] of Object.entries(sourceFiles))
    {
        const extracted = path.join('artifacts/current-run/transport', path.basename(relative));
        writeJson(temp, extracted, performanceSourceFixture(id));
        objects.push({
            authorityId: `evidence-consumer.test.aggregate-performance-evidence.${id}`,
            archiveEntries: [{ path: extracted, extractedPath: extracted }]
        });
    }
    writeJson(temp, 'artifacts/current-run/transport-manifest.json', {
        schema: 'fsusblog.current-run-evidence-transport-manifest.v1',
        objects
    });
    const result = runAggregator(temp, {
        FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST: path.join(temp, 'artifacts/current-run/transport-manifest.json')
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(fs.readFileSync(path.join(temp, '.tmp/release-evidence/perf-summary.json'), 'utf8'));
    assert.deepEqual(summary.entries.map((entry) => entry.id), [
        ...Object.keys(sourceFiles),
        'performance-saturation-v2'
    ]);
    assert.ok(summary.entries.slice(0, 3).every((entry) => entry.sourceLocation.includes('artifacts/current-run/transport/')));
    assert.equal(summary.entries.at(-1).sourceLocation, null);
});

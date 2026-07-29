import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { bindMeasurementNoiseAuthority, evaluateMeasurementObservation, readMeasurementNoisePolicy } = await import(new URL("../../tools/test/measurement-noise-envelope.mjs", import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const probe = path.join(root, 'tools/test/lanes/runtime-evidence-probe.mjs');

function cleanReceipt(mode)
{
    const policy = readMeasurementNoisePolicy();
    const metrics = Object.fromEntries(Object.entries(policy.metrics).map(([name, declaration]) => [
        name,
    Number.isFinite(declaration.minimum) ? declaration.minimum : 0
    ]));
    const record = {
        observation: { durationMs: 1000, metrics, externalProcesses: { identities: [], unknownCount: 0 } },
        evaluation: evaluateMeasurementObservation({ metrics }, policy)
    };
    return bindMeasurementNoiseAuthority({
        schema: 'fsusblog.measurement-noise-envelope.v1',
        windowId: `external-soak/${mode}`,
        status: 'clean',
        classification: null,
        qualificationEligible: true,
        productConclusionEligible: true,
        timing: {
            admissionWaitMs: 1000,
            measurementDurationMs: 72 * 60 * 60 * 1000,
            measurementStartedAfterAdmission: true
        },
        phases: {
            preflight: { status: 'clean', attempts: [record] },
            during: { status: 'clean', observations: [record], firstNoisyObservation: null },
            post: record
        }
    }, {
        runId: `external-soak-${mode}`,
        attemptId: `external-soak-${mode}:attempt-1`,
        attemptSequence: 1
    });
}

function runImport(importFile, outputFile)
{
    return spawnSync(process.execPath, [probe, 'soak', '72h', outputFile], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_SOAK_LONG_EVIDENCE_FILE: importFile,
            FSUSBLOG_SOAK_REQUIRE_IMPORTED_EVIDENCE: '1'
        }
    });
}

test('external long soak is release-final only with a fully verified noise-envelope receipt', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-long-soak-noise-'));
    try
    {
        const importedFile = path.join(directory, 'imported.json');
        const outputFile = path.join(directory, 'summary.json');
        fs.writeFileSync(importedFile, `${JSON.stringify({ status: 'ok', mode: '72h' })}\n`);
        const rejected = runImport(importedFile, outputFile);
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stderr, /no valid measurement noise authority/u);

        const tamperedReceipt = cleanReceipt('72h');
        tamperedReceipt.phases.during.observations[0].observation.metrics.hostCpuUtilization = 1;
        fs.writeFileSync(importedFile, `${JSON.stringify({
            status: 'ok',
            mode: '72h',
            measurementNoiseEnvelope: tamperedReceipt,
            measurementNoiseAuthoritySequence: [tamperedReceipt]
        })}\n`);
        const tampered = runImport(importedFile, outputFile);
        assert.notEqual(tampered.status, 0);
        assert.match(tampered.stderr, /authority content digest is invalid|phase record \d+ (?:is invalid|does not match policy recomputation)/u);

        const omittedFirst = cleanReceipt('72h');
        const retryDocument = structuredClone(omittedFirst);
        delete retryDocument.authority;
        const cleanRetry = bindMeasurementNoiseAuthority(retryDocument, {
            runId: 'external-soak-72h',
            attemptId: 'external-soak-72h:attempt-2',
            attemptSequence: 2,
            previousReceiptDigest: omittedFirst.authority.contentDigest
        });
        fs.writeFileSync(importedFile, `${JSON.stringify({
            status: 'ok',
            mode: '72h',
            measurementNoiseEnvelope: cleanRetry,
            measurementNoiseAuthoritySequence: [cleanRetry]
        })}\n`);
        const omitted = runImport(importedFile, outputFile);
        assert.notEqual(omitted.status, 0);
        assert.match(omitted.stderr, /attempt sequence is not contiguous/u);

        const acceptedReceipt = cleanReceipt('72h');
        fs.writeFileSync(importedFile, `${JSON.stringify({
            status: 'ok',
            mode: '72h',
            measurementNoiseEnvelope: acceptedReceipt,
            measurementNoiseAuthoritySequence: [acceptedReceipt]
        })}\n`);
        const accepted = runImport(importedFile, outputFile);
        assert.equal(accepted.status, 0, accepted.stderr);
        const summary = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
        assert.equal(summary.countsAsReleaseFinal, true);
        assert.equal(summary.importedEvidence.measurementNoiseAuthorityVerified, true);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

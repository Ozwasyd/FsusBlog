import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { publishBaselineResult } = await import(new URL('../../tools/security/zap-baseline-result-outlet.mjs', import.meta.url));
const { writeRetainedRuntimeResult } = await import(new URL('../../tools/test/run-retained-runtime-scenario.mjs', import.meta.url));

// These controls call only ordinary file transport APIs. They never dispatch a
// retained command, resolve runtime identity or invoke cleanup/receipt readers.
async function files(t)
{
    const directory = await mkdtemp(path.join(os.tmpdir(), 'retained-raw-result-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return {
        directory,
        outputFile: path.join(directory, 'retained.json'),
        rawResultFile: path.join(directory, 'zap-baseline-results.jsonl')
    };
}

function originalOutcome(exitCode = 0)
{
    return {
        control: 'ordinary outcome transport only',
        result: {
            status: exitCode === 0 ? 'pass' : 'failure',
            diagnostics: { exitCode, signal: null }
        }
    };
}

test('retained writer preserves the original output when raw transport is absent', async (t) =>
{
    const { outputFile } = await files(t);
    const document = originalOutcome();
    assert.equal(writeRetainedRuntimeResult(outputFile, document), document);
    assert.equal(await readFile(outputFile, 'utf8'), `${JSON.stringify(document, null, 2)}\n`);
    assert.equal(Object.hasOwn(document.result.diagnostics, 'rawResultFile'), false);
});

test('retained writer consumes exact published ZAP outlet bytes and preserves scanner failure', async (t) =>
{
    const { directory, outputFile, rawResultFile } = await files(t);
    const report = path.join(directory, 'observed-report.json');
    await writeFile(report, 'synthetic report bytes');
    const published = await publishBaselineResult({
        target: 'http://example.invalid',
        scannerExitCode: 7,
        reportPaths: [report, path.join(directory, 'missing-report.html')]
    }, (result) => appendFile(rawResultFile, `${JSON.stringify(result)}\n`));
    const originalBytes = await readFile(rawResultFile);
    const document = originalOutcome(7);
    assert.equal(writeRetainedRuntimeResult(outputFile, document, rawResultFile), document);
    const written = JSON.parse(await readFile(outputFile, 'utf8'));
    assert.deepEqual(Buffer.from(written.result.diagnostics.rawResultFile.bytesBase64, 'base64'), originalBytes);
    assert.equal(written.result.diagnostics.rawResultFile.path, rawResultFile);
    assert.equal(written.result.status, 'failure');
    assert.equal(written.result.diagnostics.exitCode, 7);
    assert.equal(published.result.scannerExitCode, 7);
    assert.deepEqual(published.result.missingReportPaths, [path.join(directory, 'missing-report.html')]);
    assert.deepEqual(written.result.diagnostics, { exitCode: 7, signal: null,
        rawResultFile: { path: rawResultFile, bytesBase64: originalBytes.toString('base64') } });
});

test('retained writer transports arbitrary raw bytes without interpreting report contents', async (t) =>
{
    const { outputFile, rawResultFile } = await files(t);
    const bytes = Buffer.from([0xff, 0x00, 0x0a, 0xc0]);
    await writeFile(rawResultFile, bytes);
    const document = originalOutcome();
    writeRetainedRuntimeResult(outputFile, document, rawResultFile);
    assert.deepEqual(Buffer.from(document.result.diagnostics.rawResultFile.bytesBase64, 'base64'), bytes);
});

test('retained writer preserves the original command result before propagating missing raw input', async (t) =>
{
    const { outputFile, rawResultFile } = await files(t);
    const document = originalOutcome(9);
    assert.throws(() => writeRetainedRuntimeResult(outputFile, document, rawResultFile), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(outputFile, 'utf8')), document);
    assert.equal(document.result.status, 'failure');
    assert.equal(document.result.diagnostics.exitCode, 9);
    assert.equal(Object.hasOwn(document.result.diagnostics, 'rawResultFile'), false);
});

test('retained writer rejects overlapping input and output without overwriting raw bytes', async (t) =>
{
    const { rawResultFile } = await files(t);
    const rawBytes = 'synthetic original raw record\n';
    await writeFile(rawResultFile, rawBytes);
    assert.throws(() => writeRetainedRuntimeResult(rawResultFile, originalOutcome(), rawResultFile), /input must differ/u);
    assert.equal(await readFile(rawResultFile, 'utf8'), rawBytes);
});

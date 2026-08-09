import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
    captureProductionFreshOutputInventory,
    createProductionFreshOutputRoot,
    outputPath,
    sealTerminalProductionFreshOutputs
} = await import(new URL("../../tools/test-matrix/production-fresh-run-bound-outputs.mjs", import.meta.url));
const {
    assertNoProductionFreshAmbientConsumption,
    createProductionFreshConsumerInputReceipt,
    createProductionFreshOutputLocator,
    readProductionFreshJsonOutput,
    readProductionFreshOutput,
    readProductionFreshOutputDiagnostic
} = await import(new URL("../../tools/test-matrix/production-fresh-output-locator.mjs", import.meta.url));

const sha256 = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const fileDigest = (file) => sha256(fs.readFileSync(file));

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-consumer-'));
    const makeWritable = (directory) =>
    {
        for (const name of fs.readdirSync(directory))
        {
            const child = path.join(directory, name);
            if (fs.lstatSync(child).isSymbolicLink())
            {
                continue;
            }
            if (fs.lstatSync(child).isDirectory())
            {
                makeWritable(child);
            }
            else
            {
                fs.chmodSync(child, 0o644);
            }
        }
        fs.chmodSync(directory, 0o755);
    };
    return {
        root,
        makeWritable,
        close: () =>
        {
            makeWritable(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

function writeRun({
    value,
    runId,
    summaryText,
    producerId = 'summary-writer',
    receiptStatus = 'complete',
    seal = true,
    extraFiles = []
})
{
    const layout = createProductionFreshOutputRoot({ root: value.root, runId });
    const relative = 'reports/summary.json';
    const file = outputPath(layout, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, summaryText);
    const perOutputDigest = { [relative]: fileDigest(file) };
    const receipt = {
        schema: 'fsusblog.production-fresh.producer-receipt.v1',
        runId: layout.runId,
        attemptId: layout.attemptId,
        producerId,
        outputRoot: layout.relativeOutputRoot,
        relativeOutputs: [relative],
        perOutputDigest,
        outputInventoryDigest: sha256(JSON.stringify(perOutputDigest)),
        status: receiptStatus
    };
    for (const extra of extraFiles)
    {
        const extraFile = outputPath(layout, extra.relative);
        fs.mkdirSync(path.dirname(extraFile), { recursive: true });
        fs.writeFileSync(extraFile, extra.contents);
    }
    const receiptFile = outputPath(layout, `artifacts/producer-receipts/${producerId}.json`);
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    const inventory = captureProductionFreshOutputInventory(layout);
    const attemptInventoryDigest = sha256(JSON.stringify(inventory));
    if (seal)
    {
        sealTerminalProductionFreshOutputs(layout);
    }
    const locator = createProductionFreshOutputLocator({
        schema: 'fsusblog.production-fresh.summary.v1',
        runId: layout.runId,
        attemptId: layout.attemptId,
        producerId,
        producerReceiptRef: path.relative(value.root, receiptFile).replaceAll(path.sep, '/'),
        producerReceiptDigest: fileDigest(receiptFile),
        outputInventoryDigest: attemptInventoryDigest,
        relativePath: relative,
        contentDigest: fileDigest(file),
        candidateIdentityDigest: sha256(`candidate-${runId}`)
    });
    return { layout, file, receiptFile, locator, relative };
}

// The production-fresh consumer contract under test: an explicit immutable
// locator is the only way to open a report/summary output. No discovery, no
// env fallback, no mtime/latest/first-match, no alternative-file scanning.
function consumeSummary({ root, locator, expectedCandidateIdentityDigest })
{
    const result = readProductionFreshJsonOutput({
        root,
        locator,
        expectedCandidateIdentityDigest
    });
    return result;
}

function aggregateToOwnRoot(consumerLayout, consumed)
{
    const receipt = createProductionFreshConsumerInputReceipt({
        consumerId: 'exactness-aggregator',
        locators: consumed.map((result) => result.locator),
        consumerRunId: consumerLayout.runId,
        consumerAttemptId: consumerLayout.attemptId
    });
    const aggregate = {
        schema: 'fsusblog.production-fresh.consumer-aggregate.v1',
        consumerRunId: consumerLayout.runId,
        summaries: consumed.map((result) => result.json),
        inputs: receipt
    };
    const file = outputPath(consumerLayout, 'reports/consumer-aggregate.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(aggregate, null, 2)}\n`);
    return { file, aggregate };
}

test('run A/B same-name summary: A consumer reads only A locator, B mtime is irrelevant', () =>
{
    const value = fixture();
    try
    {
        const runA = writeRun({
            value,
            runId: 'run-a',
            summaryText: '{"run":"A","status":"ok"}'
        });
        const runB = writeRun({
            value,
            runId: 'run-b',
            summaryText: '{"run":"B","status":"ok"}'
        });
        fs.utimesSync(runB.file, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
        const consumed = consumeSummary({
            root: value.root,
            locator: runA.locator,
            expectedCandidateIdentityDigest: runA.locator.candidateIdentityDigest
        });
        assert.equal(consumed.json.run, 'A');
        assert.equal(consumed.locator.runId, 'run-a');
        const consumedB = consumeSummary({
            root: value.root,
            locator: runB.locator,
            expectedCandidateIdentityDigest: runB.locator.candidateIdentityDigest
        });
        assert.equal(consumedB.json.run, 'B');
        assert.notEqual(consumed.json.run, consumedB.json.run);
    }
    finally
    {
        value.close();
    }
});

test('locator points at run A but env points at B global directory: env cannot override', () =>
{
    const value = fixture();
    const previousRoot = process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT;
    const previousAttempt = process.env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID;
    try
    {
        const runA = writeRun({
            value,
            runId: 'env-a',
            summaryText: '{"run":"env-a"}'
        });
        const runB = writeRun({
            value,
            runId: 'env-b',
            summaryText: '{"run":"env-b"}'
        });
        process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT = runB.layout.outputRoot;
        process.env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID = runB.layout.attemptId;
        const consumed = consumeSummary({
            root: value.root,
            locator: runA.locator,
            expectedCandidateIdentityDigest: runA.locator.candidateIdentityDigest
        });
        assert.equal(consumed.json.run, 'env-a');
        assert.throws(
            () => consumeSummary({
                root: runB.layout.outputRoot,
                locator: runA.locator,
                expectedCandidateIdentityDigest: runA.locator.candidateIdentityDigest
            }),
            /missing|invalid|escape/u
        );
    }
    finally
    {
        if (previousRoot === undefined)
        {
            delete process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT;
        }
        else
        {
            process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT = previousRoot;
        }
        if (previousAttempt === undefined)
        {
            delete process.env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID;
        }
        else
        {
            process.env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID = previousAttempt;
        }
        value.close();
    }
});

test('file exists but producer receipt is not terminal: read fails closed', () =>
{
    const value = fixture();
    try
    {
        const pending = writeRun({
            value,
            runId: 'pending-run',
            summaryText: '{"status":"pending"}',
            receiptStatus: 'pending'
        });
        assert.throws(
            () => consumeSummary({
                root: value.root,
                locator: pending.locator,
                expectedCandidateIdentityDigest: pending.locator.candidateIdentityDigest
            }),
            /producer receipt is not terminal/u
        );

        const unsealed = writeRun({
            value,
            runId: 'unsealed-run',
            summaryText: '{"status":"unsealed"}',
            seal: false
        });
        assert.throws(
            () => consumeSummary({
                root: value.root,
                locator: unsealed.locator,
                expectedCandidateIdentityDigest: unsealed.locator.candidateIdentityDigest
            }),
            /terminal|authority/u
        );
    }
    finally
    {
        value.close();
    }
});

test('file replaced after hash before read: output-drift detected', () =>
{
    const value = fixture();
    const originalReadFileSync = fs.readFileSync;
    try
    {
        const run = writeRun({
            value,
            runId: 'drift-run',
            summaryText: '{"status":"original"}',
            seal: false
        });
        let replaced = false;
        fs.readFileSync = function patched(file, ...rest)
        {
            if (rest[0] === 'utf8' && String(file).endsWith('summary.json') && !replaced)
            {
                replaced = true;
                fs.writeFileSync(String(file), '{"status":"replaced-during-read"}');
            }
            return originalReadFileSync.call(fs, file, ...rest);
        };
        assert.throws(
            () => readProductionFreshOutput({
                root: value.root,
                locator: run.locator,
                expectedCandidateIdentityDigest: run.locator.candidateIdentityDigest,
                requireTerminal: false
            }),
            /output-drift/u
        );
        assert.equal(replaced, true);
    }
    finally
    {
        fs.readFileSync = originalReadFileSync;
        value.close();
    }
});

test('digest mismatch fails closed and never scans alternative files', () =>
{
    const value = fixture();
    try
    {
        const run = writeRun({
            value,
            runId: 'digest-run',
            summaryText: '{"run":"digest","status":"ok"}',
            extraFiles: [{ relative: 'reports/summary-fallback.json', contents: '{"run":"fallback"}' }]
        });
        const wrongDigest = { ...run.locator, contentDigest: sha256('not-the-file') };
        const fallback = path.join(run.layout.outputRoot, 'reports', 'summary-fallback.json');
        assert.throws(
            () => consumeSummary({
                root: value.root,
                locator: wrongDigest,
                expectedCandidateIdentityDigest: run.locator.candidateIdentityDigest
            }),
            /content digest mismatch before read|does not bind the requested output/u
        );
        assert.equal(
            fs.readFileSync(fallback, 'utf8'),
            '{"run":"fallback"}'
        );
    }
    finally
    {
        value.close();
    }
});

test('locator candidate identity mismatch fails closed', () =>
{
    const value = fixture();
    try
    {
        const run = writeRun({
            value,
            runId: 'candidate-run',
            summaryText: '{"status":"ok"}'
        });
        assert.throws(
            () => consumeSummary({
                root: value.root,
                locator: run.locator,
                expectedCandidateIdentityDigest: sha256('different-candidate')
            }),
            /candidate identity mismatch/u
        );
    }
    finally
    {
        value.close();
    }
});

test('static governance rejects a consumer source reading fixed .tmp/local-production/summary.json', () =>
{
    const value = fixture();
    try
    {
        const badSource = `
function readSummary() {
    return JSON.parse(fs.readFileSync(path.join(root, '.tmp/local-production/summary.json'), 'utf8'));
}
`;
        assert.throws(
            () => assertNoProductionFreshAmbientConsumption(badSource),
            /fixed-global-summary-read/u
        );
    }
    finally
    {
        value.close();
    }
});

test('diagnostic viewer browsing another run never yields a qualification-eligible locator', () =>
{
    const value = fixture();
    try
    {
        const run = writeRun({
            value,
            runId: 'viewer-run',
            summaryText: '{"status":"diagnostic"}'
        });
        const diagnostic = readProductionFreshOutputDiagnostic({
            root: value.root,
            locator: run.locator
        });
        assert.equal(diagnostic.qualificationEligible, false);
        assert.equal(diagnostic.diagnostic, true);
        assert.equal(JSON.parse(diagnostic.value).status, 'diagnostic');
        assert.throws(
            () => consumeSummary({
                root: value.root,
                locator: run.locator,
                expectedCandidateIdentityDigest: undefined
            }),
            /correctness consumers must supply expectedCandidateIdentityDigest/u
        );
        const correctness = consumeSummary({
            root: value.root,
            locator: run.locator,
            expectedCandidateIdentityDigest: run.locator.candidateIdentityDigest
        });
        assert.equal(correctness.qualificationEligible, true);
    }
    finally
    {
        value.close();
    }
});

test('consumer aggregation leaves the original producer file digest unchanged', () =>
{
    const value = fixture();
    try
    {
        const runA = writeRun({
            value,
            runId: 'aggregate-a',
            summaryText: '{"run":"aggregate-a","status":"ok"}'
        });
        const runB = writeRun({
            value,
            runId: 'aggregate-b',
            summaryText: '{"run":"aggregate-b","status":"ok"}'
        });
        const beforeA = fileDigest(runA.file);
        const beforeB = fileDigest(runB.file);
        const consumed = [
            consumeSummary({
                root: value.root,
                locator: runA.locator,
                expectedCandidateIdentityDigest: runA.locator.candidateIdentityDigest
            }),
            consumeSummary({
                root: value.root,
                locator: runB.locator,
                expectedCandidateIdentityDigest: runB.locator.candidateIdentityDigest
            })
        ];
        const consumerLayout = createProductionFreshOutputRoot({
            root: value.root,
            runId: 'aggregate-consumer'
        });
        const { file, aggregate } = aggregateToOwnRoot(consumerLayout, consumed);
        assert.equal(fileDigest(runA.file), beforeA);
        assert.equal(fileDigest(runB.file), beforeB);
        assert.equal(aggregate.summaries.length, 2);
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).inputs.contentDigest,
            aggregate.inputs.contentDigest);
    }
    finally
    {
        value.close();
    }
});

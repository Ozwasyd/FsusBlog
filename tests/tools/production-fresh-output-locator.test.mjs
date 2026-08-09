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
    assertProductionFreshConsumerInputReceipt,
    createProductionFreshRunBoundLocator,
    createProductionFreshConsumerInputReceipt,
    createProductionFreshOutputLocator,
    readProductionFreshJsonOutput,
    readProductionFreshOutput,
    readProductionFreshOutputDiagnostic,
    resolveProductionFreshLocatorEnvironment,
    scanProductionFreshConsumerSource
} = await import(new URL("../../tools/test-matrix/production-fresh-output-locator.mjs", import.meta.url));

const sha256 = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const fileDigest = (file) => sha256(fs.readFileSync(file));

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-locator-'));
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

function sealedRun({
    value,
    runId,
    summaryText = '{"status":"ok","count":1}',
    producerId = 'summary-writer',
    status = 'complete',
    candidateIdentityDigest = sha256(`candidate-${runId}`)
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
        status
    };
    const receiptFile = outputPath(layout, `artifacts/producer-receipts/${producerId}.json`);
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    const inventory = captureProductionFreshOutputInventory(layout);
    const attemptInventoryDigest = sha256(JSON.stringify(inventory));
    sealTerminalProductionFreshOutputs(layout);
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
        candidateIdentityDigest
    });
    return { layout, file, receiptFile, locator };
}

test('locator rejects malformed and non-immutable inputs', () =>
{
    const value = fixture();
    try
    {
        assert.throws(
            () => createProductionFreshOutputLocator({
                runId: 'run-a',
                attemptId: 'attempt-0001',
                producerId: 'p',
                producerReceiptRef: 'receipt.json',
                producerReceiptDigest: `sha256:${'a'.repeat(64)}`,
                outputInventoryDigest: `sha256:${'b'.repeat(64)}`,
                relativePath: '../escape.json',
                contentDigest: `sha256:${'c'.repeat(64)}`,
                schema: 'x',
                candidateIdentityDigest: `sha256:${'d'.repeat(64)}`
            }),
            /traversal/u
        );
        assert.throws(
            () => createProductionFreshOutputLocator({
                runId: 'run-a',
                attemptId: 'attempt-0001',
                producerId: 'p',
                producerReceiptRef: 'receipt.json',
                producerReceiptDigest: 'not-a-digest',
                outputInventoryDigest: `sha256:${'b'.repeat(64)}`,
                relativePath: 'reports/summary.json',
                contentDigest: `sha256:${'c'.repeat(64)}`,
                schema: 'x',
                candidateIdentityDigest: `sha256:${'d'.repeat(64)}`
            }),
            /producerReceiptDigest/u
        );
        assert.throws(
            () => readProductionFreshOutput({
                root: value.root,
                locator: { runId: 'run-a' },
                expectedCandidateIdentityDigest: `sha256:${'d'.repeat(64)}`
            }),
            /relativePath is required|runId is required|schema is required/u
        );
    }
    finally
    {
        value.close();
    }
});

test('sealed attempt read verifies receipt, inventory and content binding', () =>
{
    const value = fixture();
    try
    {
        const run = sealedRun({ value, runId: 'sealed-a' });
        const result = readProductionFreshJsonOutput({
            root: value.root,
            locator: run.locator,
            expectedCandidateIdentityDigest: run.locator.candidateIdentityDigest
        });
        assert.equal(result.json.status, 'ok');
        assert.equal(result.qualificationEligible, true);
        assert.equal(result.contentDigest, run.locator.contentDigest);
        assert.equal(result.producerReceipt.path.endsWith('summary-writer.json'), true);
    }
    finally
    {
        value.close();
    }
});

test('consumer input receipt records exact locator digests and is tamper-evident', () =>
{
    const value = fixture();
    try
    {
        const run = sealedRun({ value, runId: 'receipt-run' });
        const consumer = createProductionFreshOutputRoot({
            root: value.root,
            runId: 'consumer-run'
        });
        const receipt = createProductionFreshConsumerInputReceipt({
            consumerId: 'fixture-aggregator',
            locators: [run.locator],
            consumerRunId: consumer.runId,
            consumerAttemptId: consumer.attemptId
        });
        assert.equal(receipt.schema, 'fsusblog.production-fresh.consumer-input-receipt.v1');
        assert.equal(receipt.inputs[0].contentDigest, run.locator.contentDigest);
        assert.equal(receipt.inputs[0].producerReceiptDigest, run.locator.producerReceiptDigest);
        assert.equal(receipt.inputs[0].candidateIdentityDigest, run.locator.candidateIdentityDigest);
        assert.equal(assertProductionFreshConsumerInputReceipt(receipt), true);
        const tampered = { ...receipt, inputs: receipt.inputs.map((input) => ({ ...input, contentDigest: sha256('tampered') })) };
        assert.throws(() => assertProductionFreshConsumerInputReceipt(tampered), /digest mismatch/u);
    }
    finally
    {
        value.close();
    }
});

test('static governance rejects fixed global summary reads in consumer source', () =>
{
    const violations = scanProductionFreshConsumerSource(
        'const file = path.join(root, ".tmp/local-production/summary.json");'
    );
    assert.ok(violations.some((hit) => hit.id === 'fixed-global-summary-read'));
    assert.throws(
        () => assertNoProductionFreshAmbientConsumption(
            'const file = path.join(root, ".tmp/local-production/summary.json");'
        ),
        /fixed-global-summary-read/u
    );
    assert.equal(
        assertNoProductionFreshAmbientConsumption(
            'const result = readProductionFreshOutput({ root, locator, expectedCandidateIdentityDigest });'
        ),
        true
    );
    assert.throws(
        () => assertNoProductionFreshAmbientConsumption('const m = latestManifest();'),
        /latest-manifest-selection/u
    );
    assert.throws(
        () => assertNoProductionFreshAmbientConsumption('items.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];'),
        /mtime-selection/u
    );
    assert.throws(
        () => assertNoProductionFreshAmbientConsumption('const first = glob("**/summary.json")[0];'),
        /glob-first-match/u
    );
});

test('run-bound bridge requires explicit locator environment and fails closed otherwise', () =>
{
    const previous = {
        run: process.env.FSUSBLOG_PRODUCTION_FRESH_RUN_ID,
        attempt: process.env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID,
        root: process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT
    };
    try
    {
        delete process.env.FSUSBLOG_PRODUCTION_FRESH_RUN_ID;
        delete process.env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID;
        delete process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT;
        assert.throws(
            () => resolveProductionFreshLocatorEnvironment(process.env),
            /FSUSBLOG_PRODUCTION_FRESH_RUN_ID, FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID, FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT/u
        );
    }
    finally
    {
        process.env.FSUSBLOG_PRODUCTION_FRESH_RUN_ID = previous.run;
        process.env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID = previous.attempt;
        process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT = previous.root;
    }
});

test('run-bound bridge builds an immutable locator only inside the sealed attempt', () =>
{
    const value = fixture();
    try
    {
        const run = sealedRun({ value, runId: 'bridge-sealed' });
        const env = resolveProductionFreshLocatorEnvironment({
            FSUSBLOG_PRODUCTION_FRESH_RUN_ID: run.layout.runId,
            FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID: run.layout.attemptId,
            FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT: run.layout.outputRoot
        });
        assert.equal(env.runId, run.layout.runId);
        assert.equal(env.attemptId, run.layout.attemptId);
        assert.equal(env.outputRoot, path.resolve(run.layout.outputRoot));
        const binding = createProductionFreshRunBoundLocator({
            repositoryRoot: value.root,
            runId: run.layout.runId,
            attemptId: run.layout.attemptId,
            outputRoot: run.layout.outputRoot,
            producerId: 'summary-writer',
            relativePath: 'reports/summary.json',
            schema: 'fsusblog.production-fresh.summary.v1',
            candidateIdentityDigest: run.locator.candidateIdentityDigest,
            receiptRef: path.relative(value.root, run.receiptFile).replaceAll(path.sep, '/')
        });
        assert.equal(binding.contentDigest, run.locator.contentDigest);
        assert.equal(binding.locator.runId, run.layout.runId);
        assert.equal(binding.locator.attemptId, run.layout.attemptId);
        const consumed = readProductionFreshJsonOutput({
            root: value.root,
            locator: binding.locator,
            expectedCandidateIdentityDigest: binding.locator.candidateIdentityDigest
        });
        assert.equal(consumed.json.status, 'ok');
    }
    finally
    {
        value.close();
    }
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createMeasurementNoiseEnvelope } = await import(new URL("../../tools/test/measurement-noise-envelope.mjs", import.meta.url));
const { beginProductionFreshForbiddenOutputObservation, captureProductionFreshOutputInventory, createProductionFreshOutputRoot, finalizeProductionFreshAttempt, finishProductionFreshForbiddenOutputObservation, isProductionFreshExpectedLifecycleRemoval, isProductionFreshRuntimeCleanupOutput, mutateProductionFreshOutput, outputPath, productionFreshGovernanceOutputs, productionFreshOutputEnvironment, productionFreshSchedulerRunDirectoryPreservation, resolveProductionFreshOutputAttempt, sealTerminalProductionFreshOutputs, verifyProducerOutputDelta, verifyProducerOutputs, verifyProductionFreshReceiptInventory, verifyTerminalProductionFreshOutputs } = await import(new URL("../../tools/test-matrix/production-fresh-run-bound-outputs.mjs", import.meta.url));

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-run-output-'));
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

function write(layout, relative, value = relative)
{
    const file = outputPath(layout, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
}

test('runtime scratch special files stay outside correctness inventory', {
    skip: process.platform === 'win32'
}, () =>
{
    const value = fixture();
    try
    {
        const layout = createProductionFreshOutputRoot({
            root: value.root,
            runId: 'runtime-scratch-inventory'
        });
        const environment = productionFreshOutputEnvironment(layout, 'backend-tests');
        fs.mkdirSync(environment.FSUSBLOG_DATA_ROOT, { recursive: true });
        execFileSync('mkfifo', [path.join(environment.FSUSBLOG_DATA_ROOT, 'clr-debug-pipe')]);
        assert.deepEqual(captureProductionFreshOutputInventory(layout), {});

        const correctnessPipe = path.join(layout.outputRoot, 'runtime', 'clr-debug-pipe');
        execFileSync('mkfifo', [correctnessPipe]);
        assert.throws(
            () => captureProductionFreshOutputInventory(layout),
            /non-regular correctness output is not allowed/u
        );
    }
    finally
    {
        value.close();
    }
});

test('scheduler runtime-cleanup owner accepts only aggregate and exact attempt receipts', () =>
{
    for (const relative of [
        'runtime/runtime-cleanup.json',
        `runtime/runtime-cleanup-receipts/preflight-${'a'.repeat(32)}.json`,
        `runtime/runtime-cleanup-receipts/postflight-${'0'.repeat(32)}.json`
    ])
    {
        assert.equal(isProductionFreshRuntimeCleanupOutput(relative), true, relative);
    }
    for (const relative of [
        'runtime/runtime-cleanup-receipts/preflight.json',
        `runtime/runtime-cleanup-receipts/retry-${'a'.repeat(32)}.json`,
        `runtime/runtime-cleanup-receipts/preflight-${'a'.repeat(31)}.json`,
        'release-evidence/runtime-cleanup/preflight.json',
        'runtime/runtime-cleanup-receipts/nested/postflight.json'
    ])
    {
        assert.equal(isProductionFreshRuntimeCleanupOutput(relative), false, relative);
    }
});

function stableValue(value)
{
    if (Array.isArray(value))
    {
        return value.map(stableValue);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function structuredDigest(value)
{
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

async function persistBlockedMeasurement(layout, attemptSequence, priorAuthorityRoots = [])
{
    const authorityRoot = outputPath(
        layout,
        'bundles/performance-evidence/steps/fixture.measurement-noise-authority'
    );
    const authorityManifestRoot = path.join(
        layout.runOutputRoot,
        'runtime',
        'measurement-noise-authority-manifests',
        'performance-evidence',
        'fixture'
    );
    const envelope = createMeasurementNoiseEnvelope({
        windowId: 'terminal-anchor-fixture',
        evidenceFile: outputPath(
            layout,
            'bundles/performance-evidence/steps/fixture.measurement-noise.json'
        ),
        runId: layout.runId,
        attemptId: layout.attemptId,
        attemptSequence,
        authorityRoot,
        authorityManifestRoot,
        priorAuthorityRoots,
        collector: {
            collect()
            {
                const error = new Error('fixture measurement collector unavailable');
                error.classification = 'infra.measurement-collector-unavailable';
                throw error;
            }
        }
    });
    await assert.rejects(envelope.preflight(), /fixture measurement collector unavailable/);
    return { authorityRoot, authorityManifestRoot };
}

async function anchoredAttemptPair(root, runId)
{
    const first = createProductionFreshOutputRoot({ root, runId });
    const firstMeasurement = await persistBlockedMeasurement(first, 1);
    sealTerminalProductionFreshOutputs(first);
    const firstProtection = fs.readFileSync(
        path.join(first.runOutputRoot, 'terminal-attempts.json'),
        'utf8'
    );
    const second = createProductionFreshOutputRoot({ root, runId, resume: true });
    const secondMeasurement = await persistBlockedMeasurement(
        second,
        2,
        [firstMeasurement.authorityRoot]
    );
    sealTerminalProductionFreshOutputs(second);
    const [windowDirectoryName] = fs.readdirSync(firstMeasurement.authorityManifestRoot);
    const manifestWindowDirectory = path.join(
        firstMeasurement.authorityManifestRoot,
        windowDirectoryName
    );
    return {
        first,
        second,
        firstMeasurement,
        secondMeasurement,
        firstProtection,
        manifestWindowDirectory,
        protectionFile: path.join(first.runOutputRoot, 'terminal-attempts.json')
    };
}

async function anchoredSingleAttempt(root, runId)
{
    const first = createProductionFreshOutputRoot({ root, runId });
    const measurement = await persistBlockedMeasurement(first, 1);
    sealTerminalProductionFreshOutputs(first);
    return {
        first,
        measurement,
        protectionFile: path.join(first.runOutputRoot, 'terminal-attempts.json'),
        runAuthorityFile: path.join(
            path.dirname(first.runOutputRoot),
            'production-fresh-output-authority.json'
        ),
        terminalAuthorityRoot: path.join(
            path.dirname(first.runOutputRoot),
            'production-fresh-terminal-authority'
        )
    };
}

test('parallel Fresh runs isolate same named outputs and inventories', () =>
{
    const value = fixture();
    try
    {
        const a = createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' });
        const b = createProductionFreshOutputRoot({ root: value.root, runId: 'run-b' });
        write(a, 'bundles/shared.json', 'a');
        write(b, 'bundles/shared.json', 'b');
        const receiptA = verifyProducerOutputs({ layout: a, producerId: 'a', relativeOutputs: ['bundles/shared.json'] });
        const receiptB = verifyProducerOutputs({ layout: b, producerId: 'b', relativeOutputs: ['bundles/shared.json'] });
        assert.notEqual(receiptA.perOutputDigest['bundles/shared.json'], receiptB.perOutputDigest['bundles/shared.json']);
        assert.notEqual(a.outputRoot, b.outputRoot);
    }
    finally
    {
        value.close();
    }
});

test('Fresh scheduler preservation binds the initialized run authority and output root', () =>
{
    const value = fixture();
    try
    {
        const layout = createProductionFreshOutputRoot({
            root: value.root,
            runId: 'scheduler-preservation'
        });
        assert.deepEqual(productionFreshSchedulerRunDirectoryPreservation(layout), {
            entries: [
                { name: 'production-fresh-output-authority.json', type: 'file' },
                { name: 'outputs', type: 'directory' }
            ]
        });
        fs.rmSync(path.join(
            path.dirname(layout.runOutputRoot),
            'production-fresh-output-authority.json'
        ));
        assert.throws(
            () => productionFreshSchedulerRunDirectoryPreservation(layout),
            /run authority is missing/u
        );
    }
    finally
    {
        value.close();
    }
});

test('undeclared outputs and symlink escapes fail closed', () =>
{
    const value = fixture();
    try
    {
        const layout = createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' });
        write(layout, 'reports/declared.json');
        write(layout, 'reports/undeclared.json');
        assert.throws(() => verifyProducerOutputs({ layout, producerId: 'producer', relativeOutputs: ['reports/declared.json'] }), /undeclared=reports\/undeclared.json/);
        fs.rmSync(outputPath(layout, 'reports/undeclared.json'));
        fs.symlinkSync(path.join(value.root, 'outside'), outputPath(layout, 'reports/escape'));
        assert.throws(() => verifyProducerOutputs({ layout, producerId: 'producer', relativeOutputs: ['reports/declared.json'] }), /symlink/);
    }
    finally
    {
        value.close();
    }
});

test('ancestor and intermediate symlinks fail before output creation or write', () =>
{
    const value = fixture();
    try
    {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-output-outside-'));
        fs.symlinkSync(outside, path.join(value.root, '.tmp'));
        assert.throws(
            () => createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' }),
            /symlink is not allowed/);
        assert.deepEqual(fs.readdirSync(outside), []);
        fs.rmSync(path.join(value.root, '.tmp'));
        const layout = createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' });
        fs.rmSync(path.join(layout.outputRoot, 'reports'), { recursive: true });
        fs.symlinkSync(outside, path.join(layout.outputRoot, 'reports'));
        assert.throws(() => outputPath(layout, 'reports/escaped.json'), /symlink is not allowed/);
        assert.equal(fs.existsSync(path.join(outside, 'escaped.json')), false);
        fs.rmSync(outside, { recursive: true, force: true });
    }
    finally
    {
        value.close();
    }
});

test('terminal roots reject real cross-run delete overwrite rename and chmod actions', () =>
{
    const value = fixture();
    try
    {
        const a = createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' });
        write(a, 'summary/result.json', 'old');
        const before = verifyProducerOutputs({ layout: a, producerId: 'producer', relativeOutputs: ['summary/result.json'] });
        sealTerminalProductionFreshOutputs(a);
        const b = createProductionFreshOutputRoot({ root: value.root, runId: 'run-b' });
        write(b, 'summary/result.json', 'new');
        const aFile = outputPath(a, 'summary/result.json');
        for (const mutation of [
            { operation: 'delete' },
            { operation: 'overwrite', contents: 'corrupt' },
            { operation: 'rename', destination: outputPath(b, 'summary/stolen.json') },
            { operation: 'chmod', mode: 0o644 }
        ])
        {
            assert.throws(
                () => mutateProductionFreshOutput({ layout: b, target: aFile, ...mutation }),
                /output escapes run root/);
        }
        const after = verifyProducerOutputs({ layout: a, producerId: 'producer', relativeOutputs: ['summary/result.json'] });
        assert.deepEqual(after, before);
        assert.equal(fs.statSync(aFile).mode & 0o777, 0o444);
        assert.equal(fs.existsSync(outputPath(b, 'summary/stolen.json')), false);
        assert.equal(verifyTerminalProductionFreshOutputs(a).attempts.length, 1);
        assert.throws(() => outputPath(a, '../run-b/summary/result.json'), /safe non-empty relative/);
    }
    finally
    {
        value.close();
    }
});

test('resume seals the old attempt and allocates a distinct append-only attempt', () =>
{
    const value = fixture();
    try
    {
        const first = createProductionFreshOutputRoot({ root: value.root, runId: 'same-run' });
        write(first, 'reports/result.json', 'first');
        const before = captureProductionFreshOutputInventory(first);
        sealTerminalProductionFreshOutputs(first);
        const resumed = createProductionFreshOutputRoot({ root: value.root, runId: 'same-run', resume: true });
        assert.equal(resumed.attemptId, 'attempt-0002');
        assert.notEqual(resumed.outputRoot, first.outputRoot);
        write(resumed, 'reports/result.json', 'second');
        assert.deepEqual(captureProductionFreshOutputInventory(first), before);
        assert.equal(resolveProductionFreshOutputAttempt({ root: value.root, runId: 'same-run' }).attemptId, 'attempt-0002');
    }
    finally
    {
        value.close();
    }
});

test('terminal attempt anchors reject deleted roots, joint deletion, and manifest or receipt rollback', async () =>
{
    const value = fixture();
    try
    {
        const missingRoot = await anchoredAttemptPair(value.root, 'missing-prior-root');
        value.makeWritable(value.root);
        fs.rmSync(missingRoot.firstMeasurement.authorityRoot, { recursive: true });
        assert.throws(
            () => verifyTerminalProductionFreshOutputs(missingRoot.second),
            /terminal Production Fresh attempt changed|measurement authority root/);

        const jointDeletion = await anchoredAttemptPair(value.root, 'joint-deletion');
        value.makeWritable(value.root);
        fs.rmSync(jointDeletion.firstMeasurement.authorityRoot, { recursive: true });
        fs.rmSync(jointDeletion.firstMeasurement.authorityManifestRoot, { recursive: true });
        assert.throws(
            () => createProductionFreshOutputRoot({
                root: value.root,
                runId: jointDeletion.second.runId,
                resume: true
            }),
            /terminal Production Fresh attempt changed|terminal measurement authority manifest/);

        const missingManifest = await anchoredAttemptPair(value.root, 'missing-manifest');
        value.makeWritable(value.root);
        fs.rmSync(missingManifest.firstMeasurement.authorityManifestRoot, { recursive: true });
        assert.throws(
            () => verifyTerminalProductionFreshOutputs(missingManifest.second),
            /terminal measurement authority manifest changed/);

        const oldManifest = await anchoredAttemptPair(value.root, 'old-manifest-snapshot');
        value.makeWritable(value.root);
        const manifestFiles = fs.readdirSync(oldManifest.manifestWindowDirectory).sort();
        fs.writeFileSync(
            path.join(oldManifest.manifestWindowDirectory, manifestFiles.at(-1)),
            fs.readFileSync(path.join(oldManifest.manifestWindowDirectory, manifestFiles[0]))
        );
        assert.throws(
            () => verifyTerminalProductionFreshOutputs(oldManifest.second),
            /measurement authority manifest chain is invalid|terminal measurement authority manifest changed/);

        const oldProtection = await anchoredAttemptPair(value.root, 'old-terminal-snapshot');
        value.makeWritable(value.root);
        fs.writeFileSync(oldProtection.protectionFile, oldProtection.firstProtection);
        assert.throws(
            () => verifyTerminalProductionFreshOutputs(oldProtection.second),
            /terminal Production Fresh attempt roster changed|terminal authority roster changed/);

        const missingProtection = await anchoredAttemptPair(value.root, 'missing-terminal-protection');
        value.makeWritable(value.root);
        fs.rmSync(missingProtection.protectionFile);
        assert.throws(
            () => createProductionFreshOutputRoot({
                root: value.root,
                runId: missingProtection.second.runId,
                resume: true
            }),
            /terminal Production Fresh attempt roster changed|requires non-empty terminal authority/);

        const deletedAttemptAndProtection = await anchoredSingleAttempt(
            value.root,
            'deleted-attempt-and-protection'
        );
        value.makeWritable(value.root);
        fs.rmSync(deletedAttemptAndProtection.first.outputRoot, { recursive: true });
        fs.rmSync(deletedAttemptAndProtection.protectionFile);
        assert.throws(
            () => createProductionFreshOutputRoot({
                root: value.root,
                runId: deletedAttemptAndProtection.first.runId,
                resume: true
            }),
            /terminal authority roster changed|requires non-empty terminal authority/);

        const deletedAllMutableAuthority = await anchoredSingleAttempt(
            value.root,
            'deleted-all-mutable-authority'
        );
        value.makeWritable(value.root);
        fs.rmSync(deletedAllMutableAuthority.first.outputRoot, { recursive: true });
        fs.rmSync(deletedAllMutableAuthority.protectionFile);
        fs.rmSync(deletedAllMutableAuthority.terminalAuthorityRoot, { recursive: true });
        assert.throws(
            () => createProductionFreshOutputRoot({
                root: value.root,
                runId: deletedAllMutableAuthority.first.runId,
                resume: true
            }),
            /requires non-empty terminal authority/);

        const deletedRunAuthority = await anchoredSingleAttempt(
            value.root,
            'deleted-run-authority'
        );
        value.makeWritable(value.root);
        fs.rmSync(deletedRunAuthority.first.outputRoot, { recursive: true });
        fs.rmSync(deletedRunAuthority.protectionFile);
        fs.rmSync(deletedRunAuthority.terminalAuthorityRoot, { recursive: true });
        fs.rmSync(deletedRunAuthority.runAuthorityFile);
        assert.throws(
            () => createProductionFreshOutputRoot({
                root: value.root,
                runId: deletedRunAuthority.first.runId,
                resume: true
            }),
            /resume requires an existing run authority/);

        const forgedProtection = await anchoredSingleAttempt(value.root, 'forged-protection');
        value.makeWritable(value.root);
        fs.rmSync(forgedProtection.measurement.authorityRoot, { recursive: true });
        fs.rmSync(forgedProtection.measurement.authorityManifestRoot, { recursive: true });
        const protection = JSON.parse(fs.readFileSync(forgedProtection.protectionFile, 'utf8'));
        const currentInventory = captureProductionFreshOutputInventory(forgedProtection.first);
        protection.attempts[0].outputInventoryDigest = `sha256:${
            crypto.createHash('sha256').update(JSON.stringify(currentInventory)).digest('hex')
        }`;
        protection.attempts[0].measurementAuthorityAnchors = [];
        const attemptWithoutDigest = structuredClone(protection.attempts[0]);
        delete attemptWithoutDigest.contentDigest;
        protection.attempts[0].contentDigest = structuredDigest(attemptWithoutDigest);
        fs.writeFileSync(forgedProtection.protectionFile, `${JSON.stringify(protection, null, 2)}\n`);
        assert.throws(
            () => createProductionFreshOutputRoot({
                root: value.root,
                runId: forgedProtection.first.runId,
                resume: true
            }),
            /terminal authority binding changed|terminal protection digest changed/);
    }
    finally
    {
        value.close();
    }
});

test('producer delta receipts bind only newly declared files and reject overwrite or removal', () =>
{
    const value = fixture();
    try
    {
        const layout = createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' });
        write(layout, 'reports/existing.json', 'sealed-input');
        const before = captureProductionFreshOutputInventory(layout);
        write(layout, 'reports/new.json', 'new');
        const receipt = verifyProducerOutputDelta({
            layout,
            producerId: 'lane-a',
            before,
            relativeOutputs: ['reports/new.json']
        });
        assert.equal(receipt.runId, 'run-a');
        assert.equal(receipt.attemptId, 'attempt-0001');
        assert.deepEqual(receipt.relativeOutputs, ['reports/new.json']);

        const secondBefore = captureProductionFreshOutputInventory(layout);
        write(layout, 'reports/existing.json', 'overwritten');
        assert.throws(() => verifyProducerOutputDelta({
            layout,
            producerId: 'lane-b',
            before: secondBefore,
            relativeOutputs: ['reports/declared.json']
        }), /undeclared=reports\/existing\.json.*missing=reports\/declared\.json/);

        const thirdBefore = captureProductionFreshOutputInventory(layout);
        fs.rmSync(outputPath(layout, 'reports/new.json'));
        assert.throws(() => verifyProducerOutputDelta({
            layout,
            producerId: 'lane-c',
            before: thirdBefore,
            relativeOutputs: ['reports/another.json']
        }), /removed=reports\/new\.json/);
    }
    finally
    {
        value.close();
    }
});

test('producer delta attribution is local to exact owner roots during concurrent bundle writes', () =>
{
    const value = fixture();
    try
    {
        const layout = createProductionFreshOutputRoot({
            root: value.root,
            runId: 'concurrent-owner-roots'
        });
        const before = captureProductionFreshOutputInventory(layout);
        write(layout, 'bundles/frontend-tests/steps/frontend-static.log', 'frontend');
        write(layout, 'bundles/backend-tests/steps/dotnet-restore.log', 'backend');
        const settled = captureProductionFreshOutputInventory(layout);
        const receipt = verifyProducerOutputDelta({
            layout,
            producerId: 'frontend-tests/frontend-static',
            before,
            after: settled,
            relativeOutputs: ['bundles/frontend-tests/steps/frontend-static.log'],
            ownedOutputRoots: ['bundles/frontend-tests/steps/frontend-static.log']
        });
        assert.deepEqual(receipt.relativeOutputs, [
            'bundles/frontend-tests/steps/frontend-static.log'
        ]);
        const concurrentReceipt = verifyProducerOutputDelta({
            layout,
            producerId: 'backend-tests/dotnet-restore',
            before,
            after: settled,
            relativeOutputs: ['bundles/backend-tests/steps/dotnet-restore.log'],
            ownedOutputRoots: ['bundles/backend-tests/steps/dotnet-restore.log']
        });
        assert.deepEqual(
            verifyProductionFreshReceiptInventory({
                layout,
                receipts: [receipt, concurrentReceipt]
            }).relativeOutputs,
            [
                'bundles/backend-tests/steps/dotnet-restore.log',
                'bundles/frontend-tests/steps/frontend-static.log'
            ]
        );
        write(layout, 'bundles/frontend-tests/steps/frontend-static.unknown', 'unknown');
        assert.throws(() => verifyProducerOutputDelta({
            layout,
            producerId: 'frontend-tests/frontend-static',
            before,
            relativeOutputs: ['bundles/frontend-tests/steps/frontend-static.log'],
            ownedOutputRoots: ['bundles/frontend-tests/steps']
        }), /undeclared=bundles\/frontend-tests\/steps\/frontend-static\.unknown/u);
        assert.throws(() => verifyProductionFreshReceiptInventory({
            layout,
            receipts: [receipt, concurrentReceipt]
        }), /undeclared=bundles\/frontend-tests\/steps\/frontend-static\.unknown/u);
    }
    finally
    {
        value.close();
    }
});

test('producer delta allows only exact bootstrap lifecycle removals', () =>
{
    const value = fixture();
    try
    {
        const layout = createProductionFreshOutputRoot({
            root: value.root,
            runId: 'lifecycle-removal'
        });
        const lifecycleOutput =
            'logs/acceptance/run-a/parallel-database-services-123-456/wave-0-2.env';
        const arbitraryOutput = 'logs/acceptance/run-a/arbitrary.env';
        write(layout, lifecycleOutput, 'FSUSBLOG_STEP_CPU_BUDGET=1\n');
        write(layout, arbitraryOutput, 'keep\n');
        const before = captureProductionFreshOutputInventory(layout);
        fs.rmSync(outputPath(layout, lifecycleOutput));
        write(layout, 'reports/result.json', 'result');
        assert.equal(isProductionFreshExpectedLifecycleRemoval(lifecycleOutput), true);
        assert.equal(isProductionFreshExpectedLifecycleRemoval(arbitraryOutput), false);
        assert.doesNotThrow(() => verifyProducerOutputDelta({
            layout,
            producerId: 'lane-a',
            before,
            relativeOutputs: ['reports/result.json'],
            ownedOutputRoots: ['reports/result.json'],
            allowedRemovedOutputs: [lifecycleOutput]
        }));

        const secondBefore = captureProductionFreshOutputInventory(layout);
        fs.rmSync(outputPath(layout, arbitraryOutput));
        write(layout, 'reports/second.json', 'second');
        assert.throws(() => verifyProducerOutputDelta({
            layout,
            producerId: 'lane-b',
            before: secondBefore,
            relativeOutputs: ['reports/second.json'],
            ownedOutputRoots: ['logs/acceptance/run-a', 'reports/second.json']
        }), /removed=logs\/acceptance\/run-a\/arbitrary\.env/u);
        assert.throws(() => verifyProducerOutputDelta({
            layout,
            producerId: 'lane-b',
            before: secondBefore,
            relativeOutputs: ['reports/second.json'],
            ownedOutputRoots: ['logs/acceptance/run-a', 'reports/second.json'],
            allowedRemovedOutputs: [arbitraryOutput]
        }), /allows non-lifecycle output removal/u);
    }
    finally
    {
        value.close();
    }
});

test('concurrent removal is attributed only to its exact owner root', () =>
{
    const value = fixture();
    try
    {
        const layout = createProductionFreshOutputRoot({
            root: value.root,
            runId: 'concurrent-removal-owner'
        });
        const otherStableOutput = 'artifacts/backend/stable.json';
        const otherLifecycleOutput =
            'logs/acceptance/run-a/parallel-database-services-123-456/1.status';
        write(layout, otherStableOutput, 'stable');
        write(layout, otherLifecycleOutput, '0\n');
        const before = captureProductionFreshOutputInventory(layout);
        fs.rmSync(outputPath(layout, otherStableOutput));
        fs.rmSync(outputPath(layout, otherLifecycleOutput));
        write(layout, 'reports/frontend/result.json', 'frontend');
        write(layout, 'reports/backend/result.json', 'backend');
        const settled = captureProductionFreshOutputInventory(layout);

        assert.doesNotThrow(() => verifyProducerOutputDelta({
            layout,
            producerId: 'frontend-tests/frontend-static',
            before,
            after: settled,
            relativeOutputs: ['reports/frontend/result.json'],
            ownedOutputRoots: ['reports/frontend']
        }));
        assert.throws(() => verifyProducerOutputDelta({
            layout,
            producerId: 'backend-tests/backend-step',
            before,
            after: settled,
            relativeOutputs: ['reports/backend/result.json'],
            ownedOutputRoots: ['artifacts/backend', 'reports/backend'],
            allowedRemovedOutputs: [otherLifecycleOutput]
        }), /removed=artifacts\/backend\/stable\.json/u);
        assert.doesNotThrow(() => verifyProducerOutputDelta({
            layout,
            producerId: 'backend-tests/bootstrap-lifecycle',
            before,
            after: settled,
            relativeOutputs: ['reports/backend/result.json'],
            ownedOutputRoots: [
                'logs/acceptance/run-a/parallel-database-services-123-456',
                'reports/backend'
            ],
            allowedRemovedOutputs: [otherLifecycleOutput]
        }));
    }
    finally
    {
        value.close();
    }
});

test('settlement-bound receipts reject a later producer overwrite of another owner', () =>
{
    const value = fixture();
    try
    {
        const layout = createProductionFreshOutputRoot({ root: value.root, runId: 'settled-owner' });
        const beforeA = captureProductionFreshOutputInventory(layout);
        write(layout, 'reports/a.json', 'owned-by-a');
        const settledA = captureProductionFreshOutputInventory(layout);

        const beforeB = settledA;
        write(layout, 'coverage/b.json', 'owned-by-b');
        write(layout, 'reports/a.json', 'overwritten-by-b');
        const settledB = captureProductionFreshOutputInventory(layout);

        const a = verifyProducerOutputDelta({
            layout,
            producerId: 'a',
            before: beforeA,
            after: settledA,
            relativeOutputs: ['reports/a.json'],
            allowedConcurrentOutputs: ['coverage/b.json']
        });
        const b = verifyProducerOutputDelta({
            layout,
            producerId: 'b',
            before: beforeB,
            after: settledB,
            relativeOutputs: ['coverage/b.json'],
            allowedConcurrentOutputs: ['reports/a.json']
        });
        assert.throws(
            () => verifyProductionFreshReceiptInventory({ layout, receipts: [a, b] }),
            /producer receipt digest mismatch: a/u
        );
    }
    finally
    {
        value.close();
    }
});

test('aggregate receipt inventory rejects gaps and overlapping producer ownership', () =>
{
    const value = fixture();
    try
    {
        const layout = createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' });
        let before = captureProductionFreshOutputInventory(layout);
        write(layout, 'reports/a.json', 'a');
        const a = verifyProducerOutputDelta({
            layout,
            producerId: 'a',
            before,
            relativeOutputs: ['reports/a.json']
        });
        before = captureProductionFreshOutputInventory(layout);
        write(layout, 'coverage/b.json', 'b');
        const b = verifyProducerOutputDelta({
            layout,
            producerId: 'b',
            before,
            relativeOutputs: ['coverage/b.json']
        });
        const aggregate = verifyProductionFreshReceiptInventory({ layout, receipts: [a, b] });
        assert.deepEqual(aggregate.relativeOutputs, ['coverage/b.json', 'reports/a.json']);
        assert.throws(
            () => verifyProductionFreshReceiptInventory({
                layout,
                receipts: [
                    { ...a, status: 'partial' },
                    { ...b, status: 'complete' }
                ],
                requiredReceiptStatus: 'complete'
            }),
            /producer receipt status is not complete: a \(partial\)/u
        );

        write(layout, 'summary/undeclared.json', 'gap');
        assert.throws(
            () => verifyProductionFreshReceiptInventory({ layout, receipts: [a, b] }),
            /undeclared=summary\/undeclared\.json/);
        assert.throws(
            () => verifyProductionFreshReceiptInventory({
                layout,
                receipts: [a, { ...a, producerId: 'other' }],
                governanceOutputs: ['summary/undeclared.json']
            }),
            /multiple owners: reports\/a\.json/);
    }
    finally
    {
        value.close();
    }
});

test('partial bundle finalization has explicit non-governance receipt ownership', () =>
{
    const value = fixture();
    try
    {
        const layout = createProductionFreshOutputRoot({ root: value.root, runId: 'partial-bundle' });
        let before = captureProductionFreshOutputInventory(layout);
        write(layout, 'bundles/backend-tests/steps/dotnet-restore.log', 'failed');
        const step = verifyProducerOutputDelta({
            layout,
            producerId: 'backend-tests/dotnet-restore',
            before,
            relativeOutputs: ['bundles/backend-tests/steps/dotnet-restore.log']
        });
        before = captureProductionFreshOutputInventory(layout);
        write(layout, 'bundles/backend-tests/resource-utilization.json', JSON.stringify({
            status: 'partial'
        }));
        write(layout, 'bundles/backend-tests/summary.json', JSON.stringify({
            schema: 'fsusblog.local-production.bundle.v1',
            physicalBundleId: 'backend-tests',
            status: 'partial'
        }));
        const finalizer = verifyProducerOutputDelta({
            layout,
            producerId: 'backend-tests/failure-finalizer',
            before,
            relativeOutputs: [
                'bundles/backend-tests/resource-utilization.json',
                'bundles/backend-tests/summary.json'
            ]
        });
        const governance = productionFreshGovernanceOutputs(layout);
        assert.equal(Object.hasOwn(governance, 'bundles/backend-tests/summary.json'), false);
        assert.equal(Object.hasOwn(governance, 'bundles/backend-tests/resource-utilization.json'), false);
        assert.deepEqual(
            verifyProductionFreshReceiptInventory({
                layout,
                receipts: [step, finalizer],
                governanceOutputs: governance
            }).relativeOutputs,
            [
                'bundles/backend-tests/resource-utilization.json',
                'bundles/backend-tests/steps/dotnet-restore.log',
                'bundles/backend-tests/summary.json'
            ]
        );
        assert.throws(
            () => verifyProductionFreshReceiptInventory({
                layout,
                receipts: [step],
                governanceOutputs: governance
            }),
            /undeclared=bundles\/backend-tests\/resource-utilization\.json,bundles\/backend-tests\/summary\.json/u
        );
        assert.throws(
            () => verifyProductionFreshReceiptInventory({
                layout,
                receipts: [step, finalizer, { ...finalizer, producerId: 'duplicate-finalizer' }],
                governanceOutputs: governance
            }),
            /multiple owners: bundles\/backend-tests\/resource-utilization\.json/u
        );
    }
    finally
    {
        value.close();
    }
});

test('namespace environment and immutable plan have one exact governance owner', () =>
{
    const value = fixture();
    try
    {
        const layout = createProductionFreshOutputRoot({ root: value.root, runId: 'run-a' });
        const before = captureProductionFreshOutputInventory(layout);
        write(layout, 'reports/producer.json', 'producer');
        const receipt = verifyProducerOutputDelta({
            layout,
            producerId: 'physical-producer',
            before,
            relativeOutputs: ['reports/producer.json']
        });
        write(layout, 'runtime/acceptance-env/run-a.env', 'FSUSBLOG_TEST_RUN_ID=run-a\n');
        write(
            layout,
            'runtime/acceptance-fixtures/run-a/planned-profile.json',
            '{"profile":"production"}\n');
        const governance = productionFreshGovernanceOutputs(layout);
        assert.equal(
            governance['runtime/acceptance-env/run-a.env'],
            'runtime-environment-coordinator');
        assert.equal(
            governance['runtime/acceptance-fixtures/run-a/planned-profile.json'],
            'runtime-environment-coordinator');
        assert.equal(
            verifyProductionFreshReceiptInventory({
                layout,
                receipts: [receipt],
                governanceOutputs: governance
            }).relativeOutputs.includes('runtime/acceptance-env/run-a.env'),
            true);
        write(layout, 'runtime/acceptance-fixtures/run-a/physical-fixture.json', '{}\n');
        const governanceWithPhysicalFixture = productionFreshGovernanceOutputs(layout);
        assert.equal(
            Object.hasOwn(
                governanceWithPhysicalFixture,
                'runtime/acceptance-fixtures/run-a/physical-fixture.json'),
            false);
        assert.throws(() => verifyProductionFreshReceiptInventory({
            layout,
            receipts: [receipt],
            governanceOutputs: governanceWithPhysicalFixture
        }), /undeclared=runtime\/acceptance-fixtures\/run-a\/physical-fixture\.json/u);
    }
    finally
    {
        value.close();
    }
});

test('forbidden output observation kills summary-only, global-stage-and-move, and global-lock implementations', () =>
{
    const value = fixture();
    try
    {
        const summaryOnly = createProductionFreshOutputRoot({ root: value.root, runId: 'summary-only' });
        const summaryObservation = beginProductionFreshForbiddenOutputObservation({ repositoryRoot: value.root });
        write(summaryOnly, 'summary/run.json', 'summary');
        assert.throws(
            () => fs.writeFileSync(path.join(value.root, '.tmp/test-results/result.trx'), 'global trx'),
            /EACCES|EPERM/);
        finishProductionFreshForbiddenOutputObservation({
            observation: summaryObservation,
            layout: summaryOnly,
            receiptFile: 'runtime/forbidden-output-observation.json'
        });

        const staged = createProductionFreshOutputRoot({ root: value.root, runId: 'staged' });
        const stagedObservation = beginProductionFreshForbiddenOutputObservation({ repositoryRoot: value.root });
        const forbiddenCoverageRoot = path.join(value.root, '.tmp/coverage');
        fs.chmodSync(forbiddenCoverageRoot, 0o755);
        fs.writeFileSync(path.join(forbiddenCoverageRoot, 'Summary.json'), 'global first');
        fs.renameSync(
            path.join(forbiddenCoverageRoot, 'Summary.json'),
            outputPath(staged, 'coverage/Summary.json'));
        fs.chmodSync(forbiddenCoverageRoot, 0o555);
        assert.throws(
            () => finishProductionFreshForbiddenOutputObservation({
                observation: stagedObservation,
                layout: staged,
                receiptFile: 'runtime/forbidden-output-observation.json'
            }),
            /forbidden global correctness output/);

        const locked = createProductionFreshOutputRoot({ root: value.root, runId: 'locked' });
        const lockObservation = beginProductionFreshForbiddenOutputObservation({ repositoryRoot: value.root });
        assert.throws(
            () => fs.openSync(path.join(value.root, '.tmp/release-evidence/summary.json.lock'), 'wx'),
            /EACCES|EPERM/);
        finishProductionFreshForbiddenOutputObservation({
            observation: lockObservation,
            layout: locked,
            receiptFile: 'runtime/forbidden-output-observation.json'
        });
    }
    finally
    {
        value.close();
    }
});

test('forbidden output guards reject bundle, Vitest, TRX, coverage, Playwright, and BenchmarkDotNet defaults', () =>
{
    const value = fixture();
    try
    {
        const layout = createProductionFreshOutputRoot({ root: value.root, runId: 'default-output-fixtures' });
        const observation = beginProductionFreshForbiddenOutputObservation({ repositoryRoot: value.root });
        for (const relative of [
            '.tmp/local-production/backend-tests/summary.json',
            '.tmp/test-results/vitest/results.json',
            '.tmp/test-results/backend/result.trx',
            '.tmp/coverage/backend/Summary.json',
            'src/frontend/coverage/coverage-final.json',
            'src/frontend/test-results/results.json',
            'src/frontend/playwright-report/index.html',
            'BenchmarkDotNet.Artifacts/results/benchmark.json'
        ])
        {
            assert.throws(() =>
            {
                const file = path.join(value.root, relative);
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, relative);
            }, /EACCES|EPERM/, relative);
        }
        finishProductionFreshForbiddenOutputObservation({
            observation,
            layout,
            receiptFile: 'runtime/forbidden-output-observation.json'
        });
    }
    finally
    {
        value.close();
    }
});

test('physical failure and aggregate verifier failure both seal their terminal attempt', async () =>
{
    const value = fixture();
    try
    {
        const physicalFailure = createProductionFreshOutputRoot({ root: value.root, runId: 'physical-failure' });
        write(physicalFailure, 'logs/partial.log', 'partial');
        await assert.rejects(
            finalizeProductionFreshAttempt(physicalFailure, async () =>
            {
                throw new Error('physical producer failed');
            }),
            /physical producer failed/);
        assert.equal(verifyTerminalProductionFreshOutputs(physicalFailure).attempts.length, 1);
        assert.equal(fs.statSync(outputPath(physicalFailure, 'logs/partial.log')).mode & 0o777, 0o444);

        const verifierFailure = createProductionFreshOutputRoot({ root: value.root, runId: 'inventory-failure' });
        write(verifierFailure, 'reports/undeclared.json', 'undeclared');
        await assert.rejects(
            finalizeProductionFreshAttempt(verifierFailure, async () =>
            {
                verifyProductionFreshReceiptInventory({ layout: verifierFailure, receipts: [] });
            }),
            /requires producer receipts/);
        assert.equal(verifyTerminalProductionFreshOutputs(verifierFailure).attempts.length, 1);
        const resumed = createProductionFreshOutputRoot({
            root: value.root,
            runId: 'inventory-failure',
            resume: true
        });
        assert.equal(resumed.attemptId, 'attempt-0002');
        assert.notEqual(resumed.outputRoot, verifierFailure.outputRoot);
    }
    finally
    {
        value.close();
    }
});

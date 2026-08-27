import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runner = path.join(root, 'tools/test/run-deterministic-command.mjs');
const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
}).stdout.trim();

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function systemdUserManagerAvailable()
{
    return spawnSync('systemctl', ['--user', 'show', '--property=Version'], {
        encoding: 'utf8'
    }).status === 0;
}

function invoke(source, { env = {}, projection = false } = {})
{
    const runId = `execution-envelope-integration-${randomUUID()}`;
    const projectionDirectory = `.tmp/execution-envelope-integration-projections/${runId}`;
    const result = spawnSync(process.execPath, [
        runner,
        '--key',
        'integration',
        '--execution-class',
        'correctness',
        '--producer-id',
        'backend-source-file-size',
        ...(projection ? [
            '--projection-directory',
            projectionDirectory,
            '--consumer',
            'backend-source-file-size'
        ] : []),
        '--',
        process.execPath,
        '-e',
        source
    ], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceCommit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: `sha256:${sha256(runId)}`,
            ...env
        }
    });
    return { result, runId, projectionDirectory: path.join(root, projectionDirectory) };
}

test('correctness child does not inherit unallowlisted ambient or proxy values', (context) =>
{
    if (process.platform !== 'linux' || !systemdUserManagerAvailable())
    {
        context.skip('real correctness sandbox requires the Linux user systemd manager');
        return;
    }
    const { result, runId } = invoke(`
        const assert = require('node:assert/strict');
        assert.equal(process.env.FSUSBLOG_UNALLOWLISTED_VALUE, undefined);
        assert.equal(process.env.HTTP_PROXY, undefined);
        setTimeout(() => console.log('minimal-environment-confirmed'), 30);
    `, {
        env: {
            FSUSBLOG_UNALLOWLISTED_VALUE: 'must-not-cross-boundary',
            HTTP_PROXY: 'http://ambient-proxy.invalid:8080'
        }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /minimal-environment-confirmed/u);
    assert.equal(fs.existsSync(path.join(
        root,
        '.tmp/test-execution-envelope/run-owned',
        runId
    )), false);
});

test('producer receipt, temporal replay plan, and release evidence bind one envelope', (context) =>
{
    if (process.platform !== 'linux' || !systemdUserManagerAvailable())
    {
        context.skip('real correctness sandbox requires the Linux user systemd manager');
        return;
    }
    const { result, runId, projectionDirectory } = invoke(`
        setTimeout(() => console.log('bound-envelope'), 30);
    `, { projection: true });
    try
    {
        assert.equal(result.status, 0, result.stderr);
        const evidenceFile = fs.readdirSync(projectionDirectory)
            .map((name) => path.join(projectionDirectory, name))
            .find((file) => file.endsWith('.json'));
        const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
        assert.match(evidence.executionEnvelopeDigest, /^sha256:[a-f0-9]{64}$/u);
        assert.match(evidence.executionEnvelopeReceiptDigest,
            /^sha256:[a-f0-9]{64}$/u);
        assert.equal(
            evidence.executionEnvelopeDigest,
            evidence.physicalExecutionReceiptDocument.executionEnvelopeDigest
        );
        const envelopeReceipt = JSON.parse(fs.readFileSync(path.join(
            root,
            evidence.executionEnvelopeReceipt
        ), 'utf8'));
        assert.equal(envelopeReceipt.envelopeDigest, evidence.executionEnvelopeDigest);
        assert.equal(envelopeReceipt.receiptDigest,
            evidence.executionEnvelopeReceiptDigest);
        const temporalPlan = fs.readdirSync(path.join(
            root,
            '.tmp/physical-executions',
            runId,
            'receipts/integration'
        )).map((name) => path.join(
            root,
            '.tmp/physical-executions',
            runId,
            'receipts/integration',
            name
        )).find((file) => file.endsWith('-temporal-plan.json'));
        const replay = JSON.parse(fs.readFileSync(temporalPlan, 'utf8'));
        assert.equal(replay.executionEnvelopeDigest, evidence.executionEnvelopeDigest);
        assert.equal(replay.executionEnvelopeReceiptDigest,
            evidence.executionEnvelopeReceiptDigest);
    }
    finally
    {
        fs.rmSync(projectionDirectory, { recursive: true, force: true });
    }
});

test('correctness external connection is denied and rejects postflight evidence', (context) =>
{
    if (process.platform !== 'linux' || !systemdUserManagerAvailable())
    {
        context.skip('real correctness sandbox requires the Linux user systemd manager');
        return;
    }
    const { result, runId } = invoke(`
        const net = require('node:net');
        const socket = net.connect({ host: '1.1.1.1', port: 80 });
        socket.once('connect', () => { socket.destroy(); process.exitCode = 2; });
        socket.once('error', () => setTimeout(() => console.log('external-denied'), 30));
    `);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /network planned\/actual drift/u);
    assert.equal(fs.existsSync(path.join(
        root,
        '.tmp/test-execution-envelope/run-owned',
        runId
    )), false);
});

test('correctness filesystem sandbox prevents writes to repository sources', (context) =>
{
    if (process.platform !== 'linux' || !systemdUserManagerAvailable())
    {
        context.skip('real correctness sandbox requires the Linux user systemd manager');
        return;
    }
    const target = path.join(root, 'AGENTS.md');
    const before = fs.readFileSync(target);
    const { result, runId } = invoke(`
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        assert.throws(
            () => fs.appendFileSync(${JSON.stringify(target)}, 'must-not-be-written'),
            (error) => ['EACCES', 'EROFS'].includes(error?.code)
        );
        setTimeout(() => console.log('source-write-denied'), 30);
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /source-write-denied/u);
    assert.deepEqual(fs.readFileSync(target), before);
    assert.equal(fs.existsSync(path.join(
        root,
        '.tmp/test-execution-envelope/run-owned',
        runId
    )), false);
});

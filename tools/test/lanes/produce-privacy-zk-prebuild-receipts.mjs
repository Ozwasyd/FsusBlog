#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { createPrivacyPrebuildProducerReceipt } from './project-privacy-zk-prebuild.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const freshOutputRoot = process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT
    ? path.resolve(process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT)
    : null;
const projectionDirectory = path.resolve(
    process.env.FSUSBLOG_PHYSICAL_EXECUTION_PROJECTION_DIR
        ?? path.join(root, '.tmp/physical-execution-projections'));
const outputDirectory = freshOutputRoot
    ? path.join(freshOutputRoot, 'artifacts/privacy-zk-canonical')
    : path.join(
        process.env.FSUSBLOG_SECURITY_OUTPUT_ROOT ?? path.join(root, '.tmp/security'),
        'privacy-zk-canonical');
const { verifyConsumerEvidenceFile } = await import(pathToFileURL(path.join(
    root,
    'tools/test/check-physical-execution-consumer-evidence.mjs'
)).href);

function readJson(file, label)
{
    if (!fs.existsSync(file))
    {
        throw new Error(`${label} is missing: ${path.relative(root, file)}`);
    }
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink())
    {
        throw new Error(`${label} must be a regular file`);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function digestFile(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function writeReceipt(name, receipt)
{
    fs.mkdirSync(outputDirectory, { recursive: true });
    const output = path.join(outputDirectory, `${name}.json`);
    const pending = `${output}.pending-${process.pid}`;
    fs.writeFileSync(pending, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.renameSync(pending, output);
}

function sourceState()
{
    return {
        commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
        worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
    };
}

export async function producePrivacyZkPrebuildReceipts({
    matrixEvidenceFile = path.join(projectionDirectory, 'validate-matrix-matrix-governance.json'),
    staticEvidenceFile = freshOutputRoot
        ? path.join(freshOutputRoot, 'bundles/frontend-tests/frontend-static-concurrent.json')
        : path.join(root, '.tmp/local-production/frontend-tests/frontend-static-concurrent.json'),
    runId = process.env.FSUSBLOG_TEST_RUN_ID,
    expectedSourceState = sourceState()
} = {})
{
    const matrixEvidence = readJson(matrixEvidenceFile, 'matrix consumer evidence');
    await verifyConsumerEvidenceFile(matrixEvidenceFile);
    if (matrixEvidence.schedulerRunId !== runId
      || matrixEvidence.executionKey !== 'matrix-governance'
      || matrixEvidence.consumerId !== 'validate-matrix')
    {
        throw new Error('matrix consumer evidence identity mismatch');
    }
    const matrixSource = {
        commit: matrixEvidence.physicalExecutionReceiptDocument.commit,
        worktreeFingerprint: matrixEvidence.physicalExecutionReceiptDocument.worktreeFingerprint
    };
    if (matrixSource.commit !== expectedSourceState.commit
      || matrixSource.worktreeFingerprint !== expectedSourceState.worktreeFingerprint)
    {
        throw new Error('matrix governance source state mismatch');
    }
    const requiredMatrixAssertions = ['matrix-evidence-plan', 'matrix-preflight', 'matrix-validate'];
    for (const assertion of requiredMatrixAssertions)
    {
        if (!matrixEvidence.testIds.includes(assertion))
        {
            throw new Error(`matrix evidence is missing assertion ${assertion}`);
        }
    }

    const staticEvidence = readJson(staticEvidenceFile, 'frontend static concurrent evidence');
    if (staticEvidence.schema !== 'fsusblog.local-production.frontend-static-governance-phase.v2'
      || staticEvidence.status !== 'success' || staticEvidence.schedulerRunId !== runId)
    {
        throw new Error('frontend static concurrent receipt is invalid');
    }
    if (staticEvidence.sourceState?.commit !== expectedSourceState.commit
      || staticEvidence.sourceState?.worktreeFingerprint !== expectedSourceState.worktreeFingerprint)
    {
        throw new Error('frontend static concurrent source state mismatch');
    }
    const requiredStaticAssertions = ['frame-schema', 'openapi-sync', 'security-matrices'];
    for (const assertion of requiredStaticAssertions)
    {
        if (!staticEvidence.execution?.commandIds?.includes(assertion))
        {
            throw new Error(`frontend static receipt is missing assertion ${assertion}`);
        }
    }

    const matrixReceipt = createPrivacyPrebuildProducerReceipt({
        producerId: 'matrix-governance',
        runId,
        sourceState: expectedSourceState,
        assertions: requiredMatrixAssertions.map(id => ({ id, outcome: 'Passed' })),
        artifacts: [{
            id: 'matrix-governance-consumer-evidence',
            path: path.relative(root, matrixEvidenceFile).replaceAll(path.sep, '/'),
            digest: digestFile(matrixEvidenceFile)
        }]
    });
    const staticReceipt = createPrivacyPrebuildProducerReceipt({
        producerId: 'frontend-static-governance',
        runId,
        sourceState: expectedSourceState,
        assertions: requiredStaticAssertions.map(id => ({ id, outcome: 'Passed' })),
        artifacts: [{
            id: 'frontend-static-concurrent-evidence',
            path: path.relative(root, staticEvidenceFile).replaceAll(path.sep, '/'),
            digest: digestFile(staticEvidenceFile)
        }]
    });
    writeReceipt('matrix-governance', matrixReceipt);
    writeReceipt('frontend-static-governance', staticReceipt);
    return { matrixReceipt, staticReceipt };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
{
    try
    {
        await producePrivacyZkPrebuildReceipts();
        console.log('[privacy-zk-prebuild-producers] ok producers=2');
    }
    catch (error)
    {
        console.error(`[privacy-zk-prebuild-producers] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

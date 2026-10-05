#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import {
    buildCommentFixtureAcceptanceReceipt,
    buildCommentFixtureCleanupReceipt,
    buildCommentFixtureModelReport,
    COMMENT_FIXTURE_REPOSITORY_ROOT,
    isCommentFixtureModelEvidence,
    verifyCommentFixtureAcceptanceReceipt
} from './comment-fixture-governance.mjs';
const { canonicalJson } = await import(new URL('../test-fixtures/receipt/canonical.mjs', import.meta.url));

try
{
    const args = process.argv.slice(2);
    const modelOnly = args[0] === '--model-contract';
    if (modelOnly)
    {
        args.shift();
    }
    if (args.length > 1 || args.some((item) => item.startsWith('--')))
    {
        throw new Error('usage: check-comment-fixture-governance.mjs [--model-contract] [evidence.json]');
    }
    const evidencePath = args[0]
        ? path.resolve(process.cwd(), args[0])
        : modelOnly
        ? path.join(COMMENT_FIXTURE_REPOSITORY_ROOT, '.tmp/test-evidence/comment-fixture-model.json')
        : path.join(COMMENT_FIXTURE_REPOSITORY_ROOT, '.tmp/test-evidence/comment-fixture-runtime.json');
    const document = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    // Embedded report is not an observation input or an authority override.
    const { modelContract, ...runtimeEvidence } = document;
    if (modelOnly)
    {
        const report = buildCommentFixtureModelReport(runtimeEvidence);
        if (report.status !== 'accepted' || modelContract && canonicalJson(modelContract) !== canonicalJson(report))
        {
            throw new Error(`model contract rejected: ${JSON.stringify(report.violations)}`);
        }
        process.stdout.write(`${JSON.stringify(report)}\n`);
    }
    else
    {
        if (isCommentFixtureModelEvidence(runtimeEvidence))
        {
            throw new Error('model-only evidence cannot become terminal runtime accepted');
        }
        if (runtimeEvidence.schema !== 'fsusblog.comment-fixture-runtime-evidence.v2')
        {
            throw new Error('comment fixture evidence is not terminal accepted: current runtime schema required');
        }
        const cleanup = buildCommentFixtureCleanupReceipt();
        const acceptance = buildCommentFixtureAcceptanceReceipt(cleanup, runtimeEvidence);
        verifyCommentFixtureAcceptanceReceipt(acceptance, cleanup, runtimeEvidence);
        const outputRoot = path.join(COMMENT_FIXTURE_REPOSITORY_ROOT, '.tmp/test-evidence');
        const cleanupPath = path.join(outputRoot, 'comment-fixture-cleanup.json');
        const acceptancePath = path.join(outputRoot, 'comment-fixture-acceptance.json');
        fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
        fs.writeFileSync(cleanupPath, `${JSON.stringify(cleanup, null, 4)}\n`, { mode: 0o600 });
        fs.writeFileSync(acceptancePath, `${JSON.stringify(acceptance, null, 4)}\n`, { mode: 0o600 });
        process.stdout.write(`${JSON.stringify({
            status: acceptance.status,
            violations: acceptance.violations.length,
            warnings: acceptance.warnings.length,
            cleanupReceipt: path.relative(COMMENT_FIXTURE_REPOSITORY_ROOT, cleanupPath),
            acceptanceReceipt: path.relative(COMMENT_FIXTURE_REPOSITORY_ROOT, acceptancePath),
            contentDigest: acceptance.contentDigest
        })}\n`);
    }
}
catch (error)
{
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}

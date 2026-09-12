#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import {
    buildCommentFixtureAcceptanceReceipt,
    buildCommentFixtureCleanupReceipt,
    COMMENT_FIXTURE_REPOSITORY_ROOT,
    verifyCommentFixtureAcceptanceReceipt
} from './comment-fixture-governance.mjs';

try
{
    const evidencePath = process.argv[2]
        ? path.resolve(process.cwd(), process.argv[2])
        : path.join(COMMENT_FIXTURE_REPOSITORY_ROOT, '.tmp/test-evidence/comment-fixture-runtime.json');
    const runtimeEvidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
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
catch (error)
{
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}

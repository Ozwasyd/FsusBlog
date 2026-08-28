#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import {
    buildMessagingFixtureAcceptanceReceipt,
    buildMessagingFixtureCleanupReceipt,
    MESSAGING_FIXTURE_REPOSITORY_ROOT,
    verifyMessagingFixtureAcceptanceReceipt
} from './messaging-fixture-governance.mjs';

const outputRoot = path.join(MESSAGING_FIXTURE_REPOSITORY_ROOT, '.tmp/test-evidence');
const cleanupPath = path.join(outputRoot, 'messaging-fixture-cleanup.json');
const acceptancePath = path.join(outputRoot, 'messaging-fixture-acceptance.json');

try
{
    const cleanup = buildMessagingFixtureCleanupReceipt();
    const acceptance = buildMessagingFixtureAcceptanceReceipt(cleanup);
    verifyMessagingFixtureAcceptanceReceipt(acceptance, cleanup);
    fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(cleanupPath, `${JSON.stringify(cleanup, null, 4)}\n`, { mode: 0o600 });
    fs.writeFileSync(acceptancePath, `${JSON.stringify(acceptance, null, 4)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
        status: acceptance.status,
        violations: acceptance.violations.length,
        warnings: acceptance.warnings.length,
        cleanupReceipt: path.relative(MESSAGING_FIXTURE_REPOSITORY_ROOT, cleanupPath),
        acceptanceReceipt: path.relative(MESSAGING_FIXTURE_REPOSITORY_ROOT, acceptancePath),
        contentDigest: acceptance.contentDigest
    })}\n`);
}
catch (error)
{
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}

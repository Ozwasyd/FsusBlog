import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readCleanAttemptConsumerInventory } from '../release/browser-release-clean-attempt-consumers.mjs';
import { readSemanticOutcomeConsumerInventory } from '../release/semantic-outcome-clean-attempt-consumers.mjs';

import {
    canonicalJson,
    digestCanonical,
    sealContentDigest,
    sha256, readRetryPolicyRegistry
} from './attempt-provenance.mjs';
import { validateCorrectnessAttemptMigration } from './correctness-attempt-migration.mjs';
import {
    scanHiddenRetries,
    validateRetryDispositionRegistry
} from './hidden-retry-scanner.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const attemptGovernanceAcceptanceSchema = 'fsusblog.attempt-governance-acceptance.v1';

export const acceptanceAuthorityFiles = Object.freeze([
    'config/schemas/clean-attempt-consumer-inventory.schema.json',
    'config/schemas/correctness-attempt-producers.schema.json',
    'config/schemas/producer-semantic-outcome-candidate.schema.json',
    'config/schemas/retry-disposition-registry.schema.json',
    'config/schemas/retry-policy-registry.schema.json',
    'config/schemas/semantic-outcome-clean-attempt-consumer-inventory.schema.json',
    'config/schemas/test-attempt-aggregate-receipt.schema.json',
    'config/schemas/test-attempt-receipt.schema.json',
    'config/testing/clean-attempt-consumers.json',
    'config/testing/correctness-attempt-producers.json',
    'config/testing/retry-disposition-registry.json',
    'config/testing/retry-policy-registry.json',
    'config/testing/semantic-outcome-clean-attempt-consumers.json'
]);

export const acceptanceTestFiles = Object.freeze([
    'tests/tools/attempt-provenance.test.mjs',
    'tests/tools/browser-release-clean-attempt-consumers.test.mjs',
    'tests/tools/build-projection-clean-attempt-consumers.test.mjs',
    'tests/tools/correctness-attempt-browser-contract.test.mjs',
    'tests/tools/correctness-attempt-build-release.test.mjs',
    'tests/tools/correctness-attempt-migration.test.mjs',
    'tests/tools/correctness-attempt-test-producers.test.mjs',
    'tests/tools/hidden-retry-governance.test.mjs',
    'tests/tools/release-cohort-clean-attempt-admission.test.mjs',
    'tests/tools/retry-policy-registry.test.mjs'
]);

function git(root, args)
{
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0)
    {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
}

function sourceIdentity(root)
{
    const trackedStatus = git(root, ['status', '--porcelain=v1', '--untracked-files=no']);
    if (trackedStatus)
    {
        throw new Error('terminal acceptance requires a clean tracked worktree');
    }
    return Object.freeze({
        commit: git(root, ['rev-parse', 'HEAD']),
        worktreeFingerprint: sha256(git(root, ['ls-files', '-s', '-z']))
    });
}

function authorityDigests(root)
{
    return Object.fromEntries(acceptanceAuthorityFiles.map((relative) => [
        relative,
        sha256(fs.readFileSync(path.join(root, relative)))
    ]));
}

function scannerVerification(root)
{
    const scan = scanHiddenRetries(root);
    const registry = JSON.parse(fs.readFileSync(
        path.join(root, 'config/testing/retry-disposition-registry.json'),
        'utf8'
    ));
    validateRetryDispositionRegistry(root, registry, scan, readRetryPolicyRegistry(
        path.join(root, 'config/testing/retry-policy-registry.json')
    ));
    return Object.freeze({
        schema: scan.schema,
        scannerVersion: scan.scannerVersion,
        findingCount: scan.findings.length,
        scanDigest: scan.contentDigest,
        dispositionDigest: registry.contentDigest,
        warnings: 0
    });
}

function consumerVerification()
{
    const direct = readCleanAttemptConsumerInventory();
    const semantic = readSemanticOutcomeConsumerInventory();
    return Object.freeze({
        directConsumerCount: direct.consumers.length,
        semanticConsumerCount: semantic.consumers.length,
        cohortSlotCount: 3,
        migrationStates: [direct.migrationState, semantic.migrationState],
        qualificationEligible: direct.qualificationEligible === true
            && semantic.qualificationEligible === true,
        warnings: 0
    });
}

function replayVerification(replayRoot, replayReceipt)
{
    const verifier = path.join(replayRoot, 'tools/test/verify-replay-qualification.mjs');
    const result = spawnSync(process.execPath, [verifier, replayReceipt], {
        cwd: replayRoot,
        encoding: 'utf8'
    });
    if (result.status !== 0)
    {
        throw new Error(`replay qualification verification failed: ${result.stderr.trim()}`);
    }
    const verification = JSON.parse(result.stdout);
    if (verification.status !== 'verified' || verification.producerSpawnCount !== 0
        || verification.warnings !== 0)
    {
        throw new Error('replay qualification did not independently verify cleanly');
    }
    return Object.freeze({
        dependencySourceCommit: git(replayRoot, ['rev-parse', 'HEAD']),
        receipt: replayReceipt.replaceAll(path.sep, '/'),
        ...verification
    });
}

function runFocusedAcceptance(root, outputDirectory)
{
    const command = [process.execPath, '--test', ...acceptanceTestFiles];
    const result = spawnSync(command[0], command.slice(1), {
        cwd: root,
        encoding: 'utf8',
        env: process.env
    });
    fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    const stdoutFile = path.join(outputDirectory, 'focused.stdout.log');
    const stderrFile = path.join(outputDirectory, 'focused.stderr.log');
    fs.writeFileSync(stdoutFile, result.stdout ?? '', { mode: 0o600 });
    fs.writeFileSync(stderrFile, result.stderr ?? '', { mode: 0o600 });
    if (result.status !== 0)
    {
        throw new Error(`focused acceptance failed with exit ${result.status}`);
    }
    const match = String(result.stdout).match(/(?:^|\n)[ℹ#]\s+tests\s+(\d+)/u);
    return Object.freeze({
        command,
        status: 'passed',
        exitCode: result.status,
        testCount: match ? Number(match[1]) : null,
        stdout: {
            path: path.relative(root, stdoutFile).replaceAll(path.sep, '/'),
            digest: sha256(fs.readFileSync(stdoutFile))
        },
        stderr: {
            path: path.relative(root, stderrFile).replaceAll(path.sep, '/'),
            digest: sha256(fs.readFileSync(stderrFile))
        }
    });
}

export function buildAttemptGovernanceAcceptance({
    root = defaultRoot,
    outputDirectory,
    replayRoot,
    replayReceipt
})
{
    const migration = validateCorrectnessAttemptMigration(root);
    const receipt = sealContentDigest({
        schema: attemptGovernanceAcceptanceSchema,
        status: 'accepted',
        source: sourceIdentity(root),
        authorities: authorityDigests(root),
        scanner: scannerVerification(root),
        producers: migration,
        consumers: consumerVerification(),
        replay: replayVerification(path.resolve(replayRoot), replayReceipt),
        focusedAcceptance: runFocusedAcceptance(root, outputDirectory),
        warnings: 0
    });
    const file = path.join(outputDirectory, 'attempt-governance-acceptance.json');
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    return Object.freeze({ receipt, file });
}

export function verifyAttemptGovernanceAcceptance(receipt, {
    root = defaultRoot,
    replayRoot,
    replayReceipt
})
{
    if (receipt?.schema !== attemptGovernanceAcceptanceSchema
        || receipt.status !== 'accepted'
        || receipt.warnings !== 0)
    {
        throw new Error('attempt governance acceptance header is invalid');
    }
    const unsigned = { ...receipt };
    delete unsigned.contentDigest;
    if (receipt.contentDigest !== digestCanonical(unsigned)
        || canonicalJson(receipt.source) !== canonicalJson(sourceIdentity(root))
        || canonicalJson(receipt.authorities) !== canonicalJson(authorityDigests(root))
        || canonicalJson(receipt.scanner) !== canonicalJson(scannerVerification(root))
        || canonicalJson(receipt.producers) !== canonicalJson(validateCorrectnessAttemptMigration(root))
        || canonicalJson(receipt.consumers) !== canonicalJson(consumerVerification())
        || canonicalJson(receipt.replay) !== canonicalJson(replayVerification(
            path.resolve(replayRoot),
            replayReceipt
        )))
    {
        throw new Error('attempt governance acceptance authority or current-source drift');
    }
    for (const binding of [receipt.focusedAcceptance.stdout, receipt.focusedAcceptance.stderr])
    {
        const file = path.resolve(root, binding.path);
        if (!file.startsWith(`${path.resolve(root)}${path.sep}`)
            || !fs.existsSync(file)
            || sha256(fs.readFileSync(file)) !== binding.digest)
        {
            throw new Error(`focused acceptance artifact is missing or tampered: ${binding.path}`);
        }
    }
    if (receipt.focusedAcceptance.status !== 'passed'
        || receipt.focusedAcceptance.exitCode !== 0
        || canonicalJson(receipt.focusedAcceptance.command)
            !== canonicalJson([process.execPath, '--test', ...acceptanceTestFiles]))
    {
        throw new Error('focused acceptance result is not canonical');
    }
    return Object.freeze({
        schema: 'fsusblog.attempt-governance-acceptance-verification.v1',
        status: 'verified',
        receiptDigest: receipt.contentDigest,
        sourceCommit: receipt.source.commit,
        producerCount: receipt.producers.producerCount,
        focusedTestCount: receipt.focusedAcceptance.testCount,
        replayTopologyResultCount: receipt.replay.topologyResultCount,
        producerSpawnCount: 0,
        warnings: 0
    });
}

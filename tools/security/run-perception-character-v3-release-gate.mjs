#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot = path.resolve(
    process.env.FSUSBLOG_V3_RELEASE_GATE_OUT
    ?? path.join(repositoryRoot, '.tmp/security/perception-character-v3/release-gate')
);
const logRoot = path.join(outputRoot, 'logs');
const poolRoot = path.join(outputRoot, 'pool');
const poolGeneration = 'release-gate-generation';
const poolManifest = path.join(poolRoot, poolGeneration, 'manifest.json');
const corpusRoot = path.join(outputRoot, 'corpus');
const corpusReport = path.join(corpusRoot, 'perception-character-v3-corpus-report.json');
const benchmarkReport = path.join(outputRoot, 'perception-character-v3-benchmark-report.json');
const migrationReceipt = path.join(outputRoot, 'perception-character-v3-migration-receipt.json');
const commandsPath = path.join(outputRoot, 'exact-commands.json');
const implementationReceipt = path.join(outputRoot, 'implementation-verification-receipt.json');
const independentReceipt = path.join(outputRoot, 'independent-review-receipt.json');
const commands = [];

function commandString(command, args)
{
    return [command, ...args].map(value => /[^-+./:=@_0-9A-Za-z]/u.test(value)
        ? JSON.stringify(value)
        : value).join(' ');
}

function run(id, command, args, environment = {}, record = true)
{
    const rendered = commandString(command, args);
    if (record)
        commands.push(rendered);
    const result = spawnSync(command, args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, ...environment },
        maxBuffer: 64 * 1024 * 1024
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    fs.writeFileSync(path.join(logRoot, `${id}.log`), output, { mode: 0o600 });
    process.stdout.write(output);
    if (result.error || result.status !== 0)
        throw new Error(`${rendered} failed: ${result.error?.message ?? result.status}`);
}

function requireCleanCheckout()
{
    const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
        cwd: repositoryRoot,
        encoding: 'utf8'
    });
    if (status.error || status.status !== 0 || status.stdout.trim().length > 0)
        throw new Error('PerceptionCharacterV3 release gate requires a clean tracked checkout');
}

function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

function main()
{
    requireCleanCheckout();
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: repositoryRoot,
        encoding: 'utf8'
    }).stdout.trim();
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.mkdirSync(logRoot, { recursive: true, mode: 0o700 });
    const poolKey = randomBytes(32);
    const poolEnvironment = {
        FSUSBLOG_V3_GATE_POOL_KEY: poolKey.toString('hex')
    };
    try
    {
        run('generate-target-check', 'node', [
            'tools/contracts/generate-perception-character-v3-release-target.mjs',
            '--check'
        ]);
        run('retirement-check', 'node', [
            'tools/contracts/check-perception-character-v3-retirement.mjs'
        ]);
        run('pool-generate', 'node', [
            'tools/security/perception-character-v3-pool.mjs',
            'generate',
            '--root', poolRoot,
            '--generation', poolGeneration,
            '--key-env', 'FSUSBLOG_V3_GATE_POOL_KEY',
            '--key-version', 'release-gate-k1',
            '--visual', '10',
            '--audio', '2'
        ], poolEnvironment);
        run('pool-validate', 'node', [
            'tools/security/perception-character-v3-pool.mjs',
            'validate',
            '--root', poolRoot,
            '--generation', poolGeneration,
            '--key-env', 'FSUSBLOG_V3_GATE_POOL_KEY'
        ], poolEnvironment);
        run('release-corpus', 'node', [
            'tools/security/perception-character-v3-release-corpus.mjs',
            '--profile', 'release',
            '--visual', '10000',
            '--audio', '2000',
            '--workers', String(Math.max(1, Math.min(8, Number(
                process.env.FSUSBLOG_V3_CORPUS_WORKERS ?? 8
            )))),
            '--output', corpusRoot
        ]);
        run('pool-issue-benchmark', 'dotnet', [
            'run',
            '--project', 'benchmarks/core/FsusBlog.Core.Benchmarks.csproj',
            '-c', 'Release',
            '--no-restore',
            '--',
            '--perception-character-v3-pool-issue-profile',
            '--out', benchmarkReport,
            '--iterations', '96',
            '--warmup', '24'
        ]);
        run('backend-contract-flow', 'dotnet', [
            'test',
            'tests/backend/FsusBlog.Server.Tests.csproj',
            '-c', 'Release',
            '--no-restore',
            '--filter',
            '(FullyQualifiedName~PerceptionCharacterV3Tests|FullyQualifiedName~PerceptionCharacterV3ArtifactPoolTests|FullyQualifiedName~PerceptionCharacterV3ResourcePlannerTests|FullyQualifiedName~SecurityChallengeOrchestratorTests|FullyQualifiedName~SecurityChallengeProtocolActivationGuardTests|FullyQualifiedName~PerceptionCharacterV3ContractCutoverTests)&Fixture!=LocalRedis',
            '--logger', 'console;verbosity=minimal'
        ]);
        run('redis-cutover-pool', 'bash', [
            'tools/test/perception-character-v3-redis-fixture.sh'
        ], {
            FSUSBLOG_V3_GATE_POOL_MANIFEST: poolManifest,
            FSUSBLOG_V3_CUTOVER_EVIDENCE_OUT: migrationReceipt
        });
        run('node-security-contracts', 'node', [
            '--test',
            'tests/security/perception-character-v3-spec.test.mjs',
            'tests/security/perception-character-v3-pool.test.mjs',
            'tests/security/perception-character-v3-release-gate.test.mjs',
            'tests/tools/perception-character-v3-cutover.test.mjs'
        ]);
        run('frontend-v3', 'pnpm', [
            '--dir', 'src/frontend',
            'exec', 'vitest', 'run',
            '../../tests/frontend/unit/services/securityPerceptionCharacterV3Flow.test.ts',
            '../../tests/frontend/unit/security/challengeClient.test.ts',
            '../../tests/frontend/unit/protocol/perceptionCharacterV3Transport.test.ts'
        ]);
        run('server-build', 'dotnet', [
            'build',
            'src/backend/FsusBlog.Server.csproj',
            '-c', 'Release',
            '--no-restore',
            '--nologo'
        ]);
        const implementationReceiptArgs = [
            'tools/security/perception-character-v3-release-receipt.mjs',
            '--commit', commit,
            '--pool-manifest', poolManifest,
            '--corpus-report', corpusReport,
            '--benchmark-report', benchmarkReport,
            '--migration-receipt', migrationReceipt,
            '--commands', commandsPath,
            '--output', implementationReceipt
        ];
        const independentReviewArgs = [
            'tools/security/perception-character-v3-independent-review.mjs',
            '--implementation-receipt', implementationReceipt,
            '--pool-manifest', poolManifest,
            '--corpus-report', corpusReport,
            '--benchmark-report', benchmarkReport,
            '--migration-receipt', migrationReceipt,
            '--output', independentReceipt
        ];
        commands.push(commandString('node', implementationReceiptArgs));
        commands.push(commandString('node', independentReviewArgs));
        writeJson(commandsPath, commands);
        run('implementation-receipt', 'node', implementationReceiptArgs, {}, false);
        run('independent-review', 'node', independentReviewArgs, {}, false);
        const implementation = JSON.parse(fs.readFileSync(implementationReceipt, 'utf8'));
        const independent = JSON.parse(fs.readFileSync(independentReceipt, 'utf8'));
        if (implementation.testedCommit !== commit
            || independent.testedCommit !== commit
            || implementation.releaseTarget.targetFingerprint
                !== independent.releaseTarget.targetFingerprint
            || implementation.unresolvedFindings.high.length > 0
            || implementation.unresolvedFindings.critical.length > 0
            || independent.unresolvedFindings.high.length > 0
            || independent.unresolvedFindings.critical.length > 0)
        {
            throw new Error('PerceptionCharacterV3 release receipts do not converge');
        }
        writeJson(path.join(outputRoot, 'gate-summary.json'), {
            schema: 'fsusblog.security.perception-character-v3-release-gate-summary.v1',
            status: 'passed',
            testedCommit: commit,
            targetFingerprint: implementation.releaseTarget.targetFingerprint,
            implementationReceiptFingerprint: implementation.receiptFingerprint,
            independentReceiptFingerprint: independent.receiptFingerprint,
            corpusReport: path.relative(outputRoot, corpusReport),
            benchmarkReport: path.relative(outputRoot, benchmarkReport),
            migrationReceipt: path.relative(outputRoot, migrationReceipt)
        });
        process.stdout.write(`[perception-v3-release-gate] passed commit=${commit}\n`);
    }
    finally
    {
        poolKey.fill(0);
    }
}

main();

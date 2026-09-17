#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const targetPath = path.join(
    repositoryRoot,
    'src/shared/Contracts/Validation/Security/perception-character-v3-release-target.json'
);
const schema = 'fsusblog.security.perception-character-v3-implementation-verification.v1';

function parse(argv)
{
    const options = {};
    while (argv.length > 0)
    {
        const name = argv.shift();
        const value = argv.shift();
        if (!name?.startsWith('--') || value === undefined)
        {
            throw new Error(`invalid argument ${name ?? '<missing>'}`);
        }
        options[name.slice(2)] = value;
    }
    for (const field of [
        'commit',
        'pool-manifest',
        'corpus-report',
        'benchmark-report',
        'migration-receipt',
        'commands',
        'output'
    ])
    {
        if (!options[field])
        {
            throw new Error(`--${field} is required`);
        }
    }
    return options;
}

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function evidence(file)
{
    const absolute = path.resolve(file);
    return {
        path: path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/'),
        sha256: sha256(fs.readFileSync(absolute))
    };
}

function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

function requireCondition(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function main()
{
    const options = parse(process.argv.slice(2));
    requireCondition(/^[0-9a-f]{40}$/u.test(options.commit), '--commit must be a full Git SHA');
    execFileSync('git', ['cat-file', '-e', `${options.commit}^{commit}`], {
        cwd: repositoryRoot,
        stdio: 'ignore'
    });
    const target = readJson(targetPath);
    const poolManifest = readJson(options['pool-manifest']);
    const corpus = readJson(options['corpus-report']);
    const benchmark = readJson(options['benchmark-report']);
    const migration = readJson(options['migration-receipt']);
    const commands = readJson(options.commands);
    const poolManifestDigest = sha256(fs.readFileSync(options['pool-manifest']));

    requireCondition(poolManifest.contractDigest === target.contractDigest, 'pool contract digest is mixed');
    requireCondition(typeof poolManifest.generationId === 'string' && poolManifest.generationId.length > 0,
        'pool generation is missing');
    requireCondition(corpus.status === 'passed' && corpus.releaseEligible === true,
        'release corpus did not pass');
    requireCondition(corpus.contractDigest === target.contractDigest
        && corpus.releaseTargetFingerprint === target.targetFingerprint
        && corpus.aedsSchemaFingerprint === target.aedsSchemaFingerprint,
    'corpus target binding is mixed');
    requireCondition(corpus.visual.count >= 10_000 && corpus.audio.count >= 2_000,
        'corpus counts are below the release minimum');
    requireCondition(corpus.visual.p50Bytes <= 20 * 1024
        && corpus.visual.p95Bytes <= 28 * 1024
        && corpus.visual.maximumBytes <= 32 * 1024
        && corpus.audio.p95Bytes <= 40 * 1024
        && corpus.audio.maximumBytes <= 48 * 1024,
    'corpus media size budget failed');
    requireCondition(Object.values(corpus.checks ?? {}).every(Boolean), 'corpus checks are incomplete');
    requireCondition(benchmark.status === 'passed'
        && benchmark.sameMachineProcess === true
        && benchmark.retiredRendererLinkedToProduction === false
        && benchmark.measurement?.ratios?.cpu >= 10
        && benchmark.measurement?.ratios?.nonPayloadManagedAllocation >= 8
        && benchmark.preAdmissionRejection?.requests === 1_000
        && benchmark.preAdmissionRejection?.poolLeaseCount === 0,
    'pooled issue benchmark failed');
    requireCondition(migration.status === 'passed'
        && migration.first?.accepted === true
        && migration.second?.accepted === true
        && migration.second?.idempotent === true
        && migration.first?.targetFingerprint === migration.second?.targetFingerprint
        && migration.releaseTargetFingerprint === target.targetFingerprint
        && migration.poolManifestDigest === poolManifestDigest
        && migration.second?.poolLeaseCount === 0,
    'migration double-run evidence failed');
    requireCondition(Array.isArray(commands) && commands.length > 0
        && commands.every(command => typeof command === 'string' && command.length > 0),
    'exact command inventory is invalid');

    const receiptWithoutFingerprint = {
        schema,
        reviewKind: 'clean-checkout-implementation',
        testedCommit: options.commit,
        releaseTarget: {
            targetFingerprint: target.targetFingerprint,
            contractDigest: target.contractDigest,
            aedsSchemaFingerprint: target.aedsSchemaFingerprint
        },
        pool: {
            generationId: poolManifest.generationId,
            manifestDigest: poolManifestDigest
        },
        corpus: {
            corpusDigest: corpus.corpusDigest,
            visualCount: corpus.visual.count,
            audioCount: corpus.audio.count
        },
        benchmark: {
            cpuRatio: benchmark.measurement.ratios.cpu,
            nonPayloadManagedAllocationRatio:
                benchmark.measurement.ratios.nonPayloadManagedAllocation
        },
        migration: {
            receiptFingerprint: migration.first.receiptFingerprint,
            targetFingerprint: migration.first.targetFingerprint,
            releaseTargetFingerprint: migration.releaseTargetFingerprint,
            idempotentSecondRun: migration.second.idempotent
        },
        evidence: {
            poolManifest: evidence(options['pool-manifest']),
            corpusReport: evidence(options['corpus-report']),
            benchmarkReport: evidence(options['benchmark-report']),
            migrationReceipt: evidence(options['migration-receipt'])
        },
        exactCommands: commands,
        unresolvedFindings: {
            high: [],
            critical: []
        },
        status: 'passed'
    };
    const receipt = {
        ...receiptWithoutFingerprint,
        receiptFingerprint: sha256(JSON.stringify(receiptWithoutFingerprint))
    };
    writeJson(path.resolve(options.output), receipt);
    process.stdout.write(`[perception-v3-release-receipt] ${receipt.receiptFingerprint}\n`);
}

main();

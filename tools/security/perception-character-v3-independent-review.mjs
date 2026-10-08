#!/usr/bin/env node

const { validatePerceptionCharacterRetirement } = await import(new URL('../contracts/check-perception-character-v3-retirement.mjs', import.meta.url));
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = 'fsusblog.security.perception-character-v3-independent-review.v1';
const forbiddenEvidenceKeys = /^(?:answer|artifactBytes|mediaBytes|stateToken|poolKey|rawIp|challengeIds|userIds)$/iu;

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
        'implementation-receipt',
        'pool-manifest',
        'corpus-report',
        'benchmark-report',
        'migration-receipt',
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

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function requireCondition(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function scanKeys(value, location = '$')
{
    if (Array.isArray(value))
    {
        value.forEach((entry, index) => scanKeys(entry, `${location}[${index}]`));
        return;
    }
    if (!value || typeof value !== 'object')
    {
        return;
    }
    for (const [key, entry] of Object.entries(value))
    {
        requireCondition(!forbiddenEvidenceKeys.test(key), `sensitive evidence field ${location}.${key}`);
        scanKeys(entry, `${location}.${key}`);
    }
}

function evidenceDigest(receiptEntry)
{
    const absolute = path.resolve(repositoryRoot, receiptEntry.path);
    return sha256(fs.readFileSync(absolute));
}

function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

export function buildIndependentReview({ implementation, poolManifest, corpus, benchmark, migration,
    repositoryRoot: reviewRoot = repositoryRoot, evidenceReader = null })
{
    const repositoryRoot = reviewRoot;
    for (const document of [implementation, corpus, benchmark, migration])
    {
        scanKeys(document);
    }

    const expectedImplementationFingerprint = sha256(JSON.stringify(
        Object.fromEntries(Object.entries(implementation)
            .filter(([key]) => key !== 'receiptFingerprint'))
    ));
    requireCondition(implementation.receiptFingerprint === expectedImplementationFingerprint,
        'implementation receipt fingerprint is invalid');
    for (const entry of Object.values(implementation.evidence))
    {
        requireCondition((evidenceReader ? evidenceReader(entry) : evidenceDigest(entry)) === entry.sha256, `evidence drift: ${entry.path}`);
    }
    requireCondition(implementation.pool.generationId === poolManifest.generationId,
        'pool generation differs from implementation receipt');
    requireCondition(implementation.corpus.corpusDigest === corpus.corpusDigest,
        'corpus differs from implementation receipt');
    requireCondition(implementation.benchmark.cpuRatio === benchmark.measurement.ratios.cpu
        && implementation.benchmark.nonPayloadManagedAllocationRatio
            === benchmark.measurement.ratios.nonPayloadManagedAllocation,
    'benchmark differs from implementation receipt');
    requireCondition(implementation.migration.receiptFingerprint === migration.first.receiptFingerprint
        && migration.second.idempotent === true,
    'migration differs from implementation receipt');

    const retirement = validatePerceptionCharacterRetirement(repositoryRoot);
    requireCondition(retirement.length === 0, retirement.join('; '));
    const runtimeRouteSources = [
        'src/backend/Program.cs',
        'src/backend/Infrastructure/Operations/ActiveReleaseFenceHosting.cs',
        'src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs'
    ].map(file => fs.readFileSync(path.join(repositoryRoot, file), 'utf8')).join('\n');
    requireCondition(!/perception-character-v3-(?:pool|spoken-atlas|vectors)|offline generator/iu.test(runtimeRouteSources),
        'offline generator is reachable from runtime registration or HTTP routes');
    const publicContract = fs.readFileSync(
        path.join(repositoryRoot, 'src/shared/Contracts/Outputs/ServerResponseContracts.cs'),
        'utf8'
    );
    requireCondition(!/(?:RasterSeed|Atlas|Glyph|AnswerDigest|Phoneme|NoiseProgram)/u.test(
        publicContract.match(/PerceptionCharacterV3[\\s\\S]{0,5000}/u)?.[0] ?? ''
    ), 'public V3 response exposes an offline answer recipe');

    const checks = {
        implementationFingerprint: true,
        evidenceDigests: true,
        sameReleaseTarget: implementation.releaseTarget.targetFingerprint
            === migration.releaseTargetFingerprint
            && implementation.releaseTarget.contractDigest === corpus.contractDigest,
        corpusBudgets: corpus.status === 'passed' && Object.values(corpus.checks).every(Boolean),
        benchmarkRatios: benchmark.status === 'passed'
            && benchmark.measurement.ratios.cpu >= 10
            && benchmark.measurement.ratios.nonPayloadManagedAllocation >= 8,
        idempotentMigration: migration.status === 'passed' && migration.second.idempotent === true,
        noSensitiveEvidenceFields: true,
        retiredRuntimeAbsent: true,
        offlineGeneratorUnreachable: true,
        publicRecipeAbsent: true
    };
    requireCondition(Object.values(checks).every(Boolean), 'independent review check failed');
    const receiptWithoutFingerprint = {
        schema,
        reviewKind: 'independent-security-resource-second-pass',
        testedCommit: implementation.testedCommit,
        implementationReceiptFingerprint: implementation.receiptFingerprint,
        releaseTarget: implementation.releaseTarget,
        pool: implementation.pool,
        corpus: implementation.corpus,
        benchmark: implementation.benchmark,
        migration: implementation.migration,
        checks,
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
    return receipt;
}

function main()
{
    const options = parse(process.argv.slice(2));
    const receipt = buildIndependentReview({
        implementation: readJson(options['implementation-receipt']),
        poolManifest: readJson(options['pool-manifest']), corpus: readJson(options['corpus-report']),
        benchmark: readJson(options['benchmark-report']), migration: readJson(options['migration-receipt'])
    });
    writeJson(path.resolve(options.output), receipt);
    process.stdout.write(`[perception-v3-independent-review] ${receipt.receiptFingerprint}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}

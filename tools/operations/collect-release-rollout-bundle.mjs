#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const FINAL_SCHEMA = 'fsusblog.release-rollout-evidence.v2';
const REQUIRED_ARTIFACTS = Object.freeze([
    'publicTraffic', 'notificationStream', 'assetCompatibility',
    'workerReconciliation', 'resourceBudget', 'faultInjection'
]);
const REQUIRED_AUXILIARY = Object.freeze([
    'releaseManifest', 'backupRestoreGate', 'currentSchemaAdmission', 'candidateReadiness',
    'assetMaterialization', 'retentionPrepared', 'retainedAssets', 'publicAotWarm', 'candidateSmoke',
    'compatibilityMatrix', 'gatewayTransition', 'activeFenceAcquire',
    'activeFenceSourceRevoke', 'activeFenceVerify', 'challengeKindCutoverReceipt',
    'challengeKindCutoverAcceptance', 'challengeKindCutoverGate', 'perceptionCharacterV3Cutover',
    'publicTrafficCheckpoint',
    'sourceDrainSnapshot', 'sourceDrainGate', 'targetHealth',
    'retentionDrainComplete', 'operatorNote'
]);

try
{
    const options = parseArgs(process.argv.slice(2));
    const source = path.resolve(options.input);
    const output = path.resolve(options.output);
    const root = path.dirname(source);
    const evidence = readJsonFile(source);
    if (evidence.schema !== FINAL_SCHEMA || evidence.status !== 'pass')
    {
        throw new Error('release rollout evidence must be a passing final bundle');
    }
    if (fs.existsSync(output))
    {
        throw new Error(`bundle output already exists: ${output}`);
    }
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });

    const collected = [];
    const collectedDestinations = new Set();
    const collect = (sourceValue, destination, metadata, label, allowOutside) =>
    {
        const resolvedDestination = path.resolve(destination);
        if (collectedDestinations.has(resolvedDestination))
        {
            return;
        }
        collectedDestinations.add(resolvedDestination);
        collected.push(copyBoundFile(sourceValue, resolvedDestination, metadata, root, output, label, allowOutside));
    };
    collect(source, path.join(output, 'release-rollout.json'), null, 'final evidence', false);
    for (const stage of evidence.stages ?? [])
    {
        const candidates = Array.isArray(stage?.attemptEvidence)
            ? stage.attemptEvidence.map(attempt => attempt?.evidence)
            : [stage?.evidence];
        const unique = new Map(candidates.filter(Boolean).map(metadata => [path.resolve(String(metadata.path ?? '')), metadata]));
        if (!unique.has(path.resolve(String(stage?.evidence?.path ?? ''))))
        {
            throw new Error(`stage ${stage?.stage ?? '<missing>'} successful evidence is absent from attempt evidence`);
        }
        for (const metadata of unique.values())
        {
            const destination = path.join(output, 'commands', path.basename(String(metadata?.path ?? '')));
            collect(metadata?.path, destination, metadata, `stage ${stage?.stage ?? '<missing>'}`, false);
            const stageReport = readJsonFile(metadata.path);
            for (const stream of ['stdout', 'stderr'])
            {
                const outputMetadata = stageReport.output?.[stream];
                if (!outputMetadata)
                {
                    continue;
                }
                const outputDestination = path.join(output, 'commands', path.basename(String(outputMetadata.path ?? '')));
                collect(outputMetadata.path, outputDestination, outputMetadata, `stage ${stage?.stage ?? '<missing>'} ${stream}`, false);
            }
        }
    }
    for (const recovery of evidence.recoveries ?? [])
    {
        if (!recovery?.evidence?.path)
        {
            continue;
        }
        const destination = path.join(output, 'recoveries', path.basename(recovery.evidence.path));
        collect(recovery.evidence.path, destination, recovery.evidence, `recovery ${recovery.action ?? '<missing>'}`, false);
    }
    const artifactNames = Object.keys(evidence.artifacts ?? {}).sort();
    if (artifactNames.join('\n') !== [...REQUIRED_ARTIFACTS].sort().join('\n'))
    {
        throw new Error(`release rollout bundle requires the exact artifact set: ${REQUIRED_ARTIFACTS.join(', ')}`);
    }
    for (const name of REQUIRED_ARTIFACTS)
    {
        const metadata = evidence.artifacts[name];
        const destination = path.join(output, 'artifacts', safeName(name), path.basename(String(metadata?.path ?? '')));
        collect(metadata?.path, destination, metadata, `artifact ${name}`, true);
    }
    const auxiliaryNames = Object.keys(evidence.auxiliary ?? {});
    if (auxiliaryNames.join('\n') !== REQUIRED_AUXILIARY.join('\n'))
    {
        throw new Error(`release rollout bundle requires the exact auxiliary set: ${REQUIRED_AUXILIARY.join(', ')}`);
    }
    for (const name of REQUIRED_AUXILIARY)
    {
        const metadata = evidence.auxiliary[name];
        const destination = path.join(output, 'auxiliary', safeName(name), path.basename(String(metadata?.path ?? '')));
        collect(metadata?.path, destination, metadata, `auxiliary ${name}`, true);
    }

    const index = {
        schema: 'fsusblog.release-rollout-collected-bundle.v1',
        status: 'ok',
        rolloutId: evidence.rolloutId,
        sourceEvidenceSha256: `sha256:${sha256(source)}`,
        fileCount: collected.length,
        files: collected,
        collectedAtUtc: new Date().toISOString()
    };
    writeExclusive(path.join(output, 'bundle-index.json'), index);
    process.stdout.write(`${JSON.stringify(index)}\n`);
}
catch (error)
{
    process.stderr.write(`[collect-release-rollout-bundle] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}

function parseArgs(argv)
{
    const parsed = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value === undefined || value.startsWith('--'))
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        parsed[name.slice(2)] = value;
    }
    if (!parsed.input || !parsed.output)
    {
        throw new Error('--input and --output are required');
    }
    return parsed;
}

function copyBoundFile(sourceValue, destination, metadata, root, bundleRoot, label, allowOutside)
{
    const source = path.resolve(String(sourceValue ?? ''));
    const relative = path.relative(root, source);
    if (!allowOutside && (relative.startsWith('..') || path.isAbsolute(relative)))
    {
        throw new Error(`${label} escapes rollout evidence root`);
    }
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`${label} is not a regular non-symlink file`);
    }
    const digest = `sha256:${sha256(source)}`;
    if (metadata && (metadata.bytes !== stat.size || metadata.sha256 !== digest))
    {
        throw new Error(`${label} hash/size changed after seal`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
    return {
        path: path.relative(bundleRoot, destination),
        bytes: stat.size,
        sha256: digest
    };
}

function readJsonFile(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file)
{
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function safeName(value)
{
    const name = String(value ?? '');
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u.test(name))
    {
        throw new Error(`invalid artifact name: ${name}`);
    }
    return name;
}

function writeExclusive(file, value)
{
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try
    {
        fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

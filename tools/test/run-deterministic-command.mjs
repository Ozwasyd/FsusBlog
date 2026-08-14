#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runPhysicalExecution } from './physical-execution-process-tree.mjs';
import {
    buildRunBoundConsumerEvidence,
    fingerprintPaths,
    runBoundExecution,
    validateRunBoundConsumerEvidence,
    validateRunBoundProjection
} from './run-once.mjs';
import {
    createTemporalActual,
    createTemporalPlan,
    createTemporalReceipt,
    defaultTimeoutPolicyDigest,
    digestCanonical,
    materializeTemporalEnvironment,
    qualificationTemporalContext,
    verifyTemporalReplay
} from './temporal-context.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const physicalExecutionPolicy = 'config/testing/physical-execution-process-policy.json';
const temporalChildObserver = path.join(
    repoRoot,
    'tools/test-fixtures/producers/temporal-child-observer.mjs'
);

function parse(argv)
{
    const options = { paths: [], environmentNames: [], outputs: [], testIds: [] };
    const separator = argv.indexOf('--');
    if (separator < 0 || separator === argv.length - 1)
    {
        throw new Error('run-deterministic-command requires a command after --');
    }
    for (let index = 0; index < separator; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value == null)
        {
            throw new Error(`invalid option: ${name ?? ''}`);
        }
        if (name === '--path')
        {
            options.paths.push(value);
        }
        else if (name === '--env')
        {
            options.environmentNames.push(value);
        }
        else if (name === '--output')
        {
            options.outputs.push(value);
        }
        else if (name === '--test-id')
        {
            options.testIds.push(value);
        }
        else
        {
            options[name.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
        }
    }
    return { options, command: argv.slice(separator + 1) };
}

function digest(value)
{
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sanitizeSegment(value, fallback)
{
    const normalized = String(value ?? '')
        .trim()
        .replace(/[^a-zA-Z0-9_.-]+/gu, '-')
        .replace(/^-+|-+$/gu, '');
    return normalized && normalized !== '.' && normalized !== '..' ? normalized : fallback;
}

async function publishConsumerProjection({ result, directory, cwd, runId, key, consumerId })
{
    const normalizedKey = sanitizeSegment(key, 'execution');
    const validatedProjection = await validateRunBoundProjection({
        runId,
        key: normalizedKey,
        consumerId,
        projectionFile: result.projectionFile,
        receiptFile: result.receiptFile
    });

    const outputDirectory = path.resolve(cwd, directory);
    if (outputDirectory !== repoRoot && !outputDirectory.startsWith(`${repoRoot}${path.sep}`))
    {
        throw new Error('run-bound consumer projection output is outside the repository');
    }
    fs.mkdirSync(outputDirectory, { recursive: true });
    const realRepository = fs.realpathSync(repoRoot);
    const realOutputDirectory = fs.realpathSync(outputDirectory);
    if (realOutputDirectory !== realRepository
      && !realOutputDirectory.startsWith(`${realRepository}${path.sep}`))
    {
        throw new Error('run-bound consumer projection output resolves outside the repository');
    }
    const outputFile = path.join(
        outputDirectory,
        `${sanitizeSegment(consumerId, 'consumer')}-${normalizedKey}.json`
    );
    const document = buildRunBoundConsumerEvidence({ validatedProjection });
    validateRunBoundConsumerEvidence(document, { runId, key: normalizedKey, consumerId });
    const temporary = `${outputFile}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, outputFile);
    return outputFile;
}

function git(args)
{
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function writePrivateJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

function createRunnerTemporalContext({ producerId, runId, sourceCommit, sourceFingerprint })
{
    return qualificationTemporalContext({
        sourceCommit,
        sourceFingerprint: sourceFingerprint.startsWith('sha256:')
            ? sourceFingerprint
            : `sha256:${sourceFingerprint}`,
        producerId,
        schedulerRunId: runId,
        businessEpochUtc: String(
            process.env.FSUSBLOG_TEST_BUSINESS_EPOCH_UTC
      ?? '2024-02-29T23:59:59.000Z'
        ).trim(),
        locale: String(process.env.FSUSBLOG_TEST_LOCALE ?? 'en-US').trim(),
        uiLocale: String(
            process.env.FSUSBLOG_TEST_UI_LOCALE
      ?? process.env.FSUSBLOG_TEST_LOCALE
      ?? 'en-US'
        ).trim(),
        timeoutPolicyDigest: process.env.FSUSBLOG_TIMEOUT_POLICY_DIGEST?.trim()
      || defaultTimeoutPolicyDigest()
    });
}

function publishRunnerTemporalArtifacts({ context, result, key })
{
    const runBoundReceipt = JSON.parse(fs.readFileSync(result.receiptFile, 'utf8'));
    const runBoundProjection = JSON.parse(fs.readFileSync(result.projectionFile, 'utf8'));
    const encodedObservation = String(runBoundReceipt.physicalExecution?.stdout ?? '')
        .match(/^FSUSBLOG_TEMPORAL_ACTUAL_JSON=([A-Za-z0-9_-]+)$/mu)?.[1];
    if (!encodedObservation)
    {
        throw new Error('correctness child did not return an actual temporal observation');
    }
    const observations = JSON.parse(
        Buffer.from(encodedObservation, 'base64url').toString('utf8')
    );
    const plan = createTemporalPlan(context);
    const actual = createTemporalActual(context, observations);
    const receipt = createTemporalReceipt({
        plan,
        actual,
        outcome: {
            status: result.status,
            producerId: context.producerId,
            schedulerRunId: context.schedulerRunId,
            executionKey: key,
            runBoundContractDigest: runBoundReceipt.contractDigest,
            runBoundReceiptDigest: runBoundReceipt.receiptDigest,
            runBoundProjectionReceiptDigest: runBoundProjection.physicalExecutionReceiptDigest,
            requiredOutputStates: runBoundReceipt.requiredOutputStates
        },
        generatedAt: new Date().toISOString()
    });
    verifyTemporalReplay({ plan, actual, receipt });
    const directory = path.dirname(result.receiptFile);
    const prefix = sanitizeSegment(key, 'execution');
    const files = {
        plan: path.join(directory, `${prefix}-temporal-plan.json`),
        actual: path.join(directory, `${prefix}-temporal-actual.json`),
        receipt: path.join(directory, `${prefix}-temporal-receipt.json`)
    };
    writePrivateJson(files.plan, plan);
    writePrivateJson(files.actual, actual);
    writePrivateJson(files.receipt, receipt);
    return files;
}

async function spawnCommand(command, cwd, signal)
{
    return await runPhysicalExecution({
        command,
        cwd,
        env: {
            ...process.env,
            DOTNET_CLI_USE_MSBUILD_SERVER: '0',
            MSBUILDDISABLENODEREUSE: '1',
            UseSharedCompilation: 'false'
        },
        signal
    });
}

async function main(argv)
{
    const { options, command } = parse(argv);
    if (!String(options.key ?? '').trim())
    {
        throw new Error('--key is required');
    }
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const executionClass = String(options.executionClass ?? '').trim();
    const producerId = String(options.producerId ?? '').trim();
    const runId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    const sourceCommit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim();
    const sourceFingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim();
    if (!['correctness', 'diagnostic'].includes(executionClass))
    {
        throw new Error('contract.missing-run-identity: executionClass must be correctness or diagnostic');
    }
    if (executionClass === 'correctness')
    {
        const missing = [
      !producerId ? 'producerId' : null,
      !runId ? 'schedulerRunId' : null,
      !sourceCommit || !sourceFingerprint ? 'sourceIdentity' : null
        ].filter(Boolean);
        if (missing.length > 0)
        {
            throw new Error(`contract.missing-run-identity: ${missing.join(',')}`);
        }
    }
    if (executionClass === 'diagnostic')
    {
        if (options.projectionDirectory)
        {
            throw new Error('diagnostic execution cannot publish a correctness projection');
        }
        await spawnCommand(command, cwd);
        console.log(`[physical-execution] diagnostic-direct key=${options.key} qualificationEligible=false`);
        return;
    }

    const temporalContext = createRunnerTemporalContext({
        producerId,
        runId,
        sourceCommit,
        sourceFingerprint
    });
    Object.assign(process.env, materializeTemporalEnvironment(temporalContext));
    const observedCommand = [
        process.execPath,
        temporalChildObserver,
        '--',
        ...command
    ];
    const commit = git(['rev-parse', 'HEAD']);
    const inputPaths = [...new Set([
        ...options.paths,
        physicalExecutionPolicy,
        'tools/test/temporal-context.mjs',
        'tools/test-fixtures/producers/temporal-child-handshake.bash',
        'tools/test-fixtures/producers/temporal-child-handshake.cjs',
        'tools/test-fixtures/producers/temporal-child-handshake-emitter.cjs',
        'tools/test-fixtures/producers/temporal-child-observer.mjs'
    ])];
    const inputDigest = await fingerprintPaths(inputPaths, {
        root: repoRoot,
        values: [
            'run-bound-physical-execution-v3',
            cwd,
            JSON.stringify(command),
            JSON.stringify([...options.outputs].sort()),
            digestCanonical(temporalContext)
        ]
    });
    const environment = Object.fromEntries([...new Set(options.environmentNames)].sort().map((name) => [name, process.env[name] ?? '']));
    const environmentDigest = digest({
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        environment
    });
    const worktreeFingerprint = digest({
        commit,
        inputDigest,
        status: git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...inputPaths])
    });
    const consumerId = producerId;
    const controller = new AbortController();
    const abort = (signal) => controller.abort(Object.assign(new Error(`received ${signal}`), { name: 'AbortError', signal }));
    const onSigint = () => abort('SIGINT');
    const onSigterm = () => abort('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    try
    {
        const result = await runBoundExecution({
            runId,
            key: options.key,
            command,
            cwd,
            inputDigest,
            environmentDigest,
            outputContract: options.outputs,
            requiredOutputs: options.outputs,
            commit,
            worktreeFingerprint,
            testIds: options.testIds,
            consumerId,
            signal: controller.signal
        }, async () => spawnCommand(observedCommand, cwd, controller.signal));
        const consumerEvidenceFile = options.projectionDirectory
            ? await publishConsumerProjection({
          result,
          directory: options.projectionDirectory,
          cwd,
          runId,
          key: options.key,
          consumerId
        })
            : null;
        const temporalFiles = publishRunnerTemporalArtifacts({
            context: temporalContext,
            result,
            key: options.key
        });
        console.log(`[physical-execution] ${result.status} key=${options.key} receipt=${result.receiptFile} projection=${result.projectionFile}${consumerEvidenceFile ? ` consumer-evidence=${consumerEvidenceFile}` : ''} temporal-receipt=${temporalFiles.receipt}`);
    }
    finally
    {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
    }
}

main(process.argv.slice(2)).catch((error) =>
{
    console.error(`[physical-execution] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = Number.isInteger(error?.exitCode) && error.exitCode > 0 ? error.exitCode : 1;
});

#!/usr/bin/env node
/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    loadExecutionEnvelopeApplicability,
    loadExecutionEnvelopePolicy,
    resolveExecutionEnvelopeProducer
} from '../test-matrix/execution-envelope-policy.mjs';

import {
    finalizeRunOwnedDirectories,
    prepareRunOwnedDirectories
} from './execution-envelope-directories.mjs';
import { prepareCorrectnessEnvironment } from './execution-envelope-environment.mjs';
import {
    finalizeNetworkSandbox,
    loadExecutionNetworkPolicy,
    prepareNetworkSandbox,
    projectPlannedEndpoints
} from './execution-envelope-network.mjs';
import {
    buildExecutionEnvelope,
    observeExecutionEnvelopeHostFacts,
    sealExecutionEnvelopeReceipt,
    verifyExecutionEnvelopeReceipt
} from './execution-envelope-receipt.mjs';
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
import { resolveTemporalRolesForProducerIfBound } from './temporal-role-resolver.mjs';

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

async function publishConsumerProjection({
    result,
    directory,
    cwd,
    runId,
    key,
    consumerId,
    executionEnvelopeBinding
})
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
    const document = buildRunBoundConsumerEvidence({
        validatedProjection,
        executionEnvelopeBinding
    });
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

function readOptionalEnvelopeFragment(file, label)
{
    if (!file)
    {
        return null;
    }
    const resolved = path.resolve(file);
    const metadata = fs.lstatSync(resolved);
    if (!metadata.isFile() || metadata.isSymbolicLink())
    {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    return JSON.parse(fs.readFileSync(fs.realpathSync(resolved), 'utf8'));
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

function bindTemporalArtifact(document, executionEnvelopeBinding)
{
    const payload = { ...document };
    delete payload.digest;
    const bound = {
        ...payload,
        executionEnvelopeDigest: executionEnvelopeBinding.envelopeDigest,
        executionEnvelopeReceiptDigest: executionEnvelopeBinding.receiptDigest
    };
    return Object.freeze({ ...bound, digest: digestCanonical(bound) });
}

function publishRunnerTemporalArtifacts({
    context,
    result,
    key,
    executionEnvelopeBinding
})
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
    const plan = bindTemporalArtifact(
        createTemporalPlan(context),
        executionEnvelopeBinding
    );
    const actual = bindTemporalArtifact(
        createTemporalActual(context, observations),
        executionEnvelopeBinding
    );
    const receipt = bindTemporalArtifact(createTemporalReceipt({
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
            requiredOutputStates: runBoundReceipt.requiredOutputStates,
            executionEnvelopeDigest: executionEnvelopeBinding.envelopeDigest,
            executionEnvelopeReceiptDigest: executionEnvelopeBinding.receiptDigest
        },
        generatedAt: new Date().toISOString()
    }), executionEnvelopeBinding);
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

async function spawnCommand(command, cwd, signal, env, options = {})
{
    return await runPhysicalExecution({ command, cwd, signal, env, ...options });
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
        await spawnCommand(command, cwd, undefined, process.env);
        console.log(`[physical-execution] diagnostic-direct key=${options.key} qualificationEligible=false`);
        return;
    }

    const temporalContext = createRunnerTemporalContext({
        producerId,
        runId,
        sourceCommit,
        sourceFingerprint
    });
    const resolvedTemporalRoles = resolveTemporalRolesForProducerIfBound({
        temporalContext,
        namespace: String(process.env.FSUSBLOG_TEST_NAMESPACE ?? 'default'),
        fixtureId: producerId
    });
    const temporalRoleEnvironment = resolvedTemporalRoles
        ? {
            FSUSBLOG_RESOLVED_TEMPORAL_ROLES_JSON: JSON.stringify(resolvedTemporalRoles),
            FSUSBLOG_TEMPORAL_ROLE_ARTIFACT_DIGEST: resolvedTemporalRoles.contentDigest
        }
        : {};
    const policy = loadExecutionEnvelopePolicy();
    const catalog = loadExecutionEnvelopeApplicability();
    const producerEnvelope = resolveExecutionEnvelopeProducer(producerId, catalog);
    const browserEnvelopeSource = readOptionalEnvelopeFragment(
        options.browserEnvelope,
        'execution browser envelope'
    );
    const browserEnvelope = browserEnvelopeSource?.playwright?.browserIdentity
        ?? browserEnvelopeSource;
    const serviceEnvelope = readOptionalEnvelopeFragment(
        options.serviceEnvelope,
        'execution service envelope'
    );
    const allowedEnvironment = new Set(producerEnvelope.allowedEnvironment);
    for (const name of options.environmentNames)
    {
        if (!allowedEnvironment.has(name))
        {
            throw new Error(
                `${producerId}: environment input is not declared by the applicability catalog: ${name}`
            );
        }
    }
    if (producerEnvelope.fieldApplicability.browserRendering.status === 'required'
      && !browserEnvelope)
    {
        throw new Error(`${producerId}: required execution browser envelope is missing`);
    }
    if (producerEnvelope.fieldApplicability.services.status === 'required')
    {
        if (!serviceEnvelope
          || JSON.stringify(serviceEnvelope.requiredServices)
            !== JSON.stringify(producerEnvelope.requiredServices))
        {
            throw new Error(`${producerId}: required execution service envelope is missing or drifted`);
        }
    }
    const directoryEnvelope = prepareRunOwnedDirectories({
        repositoryRoot: repoRoot,
        cwd,
        runId,
        producerId,
        attemptId: options.key,
        outputs: options.outputs
    });
    let correctnessEnvironment;
    let networkSandbox;
    let executionFailure = null;
    let finalizationFailure = null;
    try
    {
        correctnessEnvironment = prepareCorrectnessEnvironment({
            command,
            parentEnvironment: process.env,
            producerAllowlist: options.environmentNames,
            injectedEnvironment: {
                ...materializeTemporalEnvironment(temporalContext),
                ...temporalRoleEnvironment,
                ...directoryEnvelope.environment,
                FSUSBLOG_TEST_RUN_ID: runId,
                FSUSBLOG_TEST_SOURCE_COMMIT: sourceCommit,
                FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceFingerprint
            },
            policy,
            catalog
        });
        const networkPolicy = loadExecutionNetworkPolicy();
        networkSandbox = prepareNetworkSandbox({
            command: [
                process.execPath,
                temporalChildObserver,
                '--',
                ...correctnessEnvironment.command
            ],
            cwd,
            directories: directoryEnvelope.fragment.directories,
            writableRoots: directoryEnvelope.fragment.writableRoots,
            plannedEndpoints: projectPlannedEndpoints({
                services: producerEnvelope.requiredServices,
                serviceEnvelope,
                policy: networkPolicy
            }),
            environment: correctnessEnvironment.environment,
            policy: networkPolicy
        });
    }
    catch (error)
    {
        finalizeRunOwnedDirectories(directoryEnvelope);
        throw error;
    }
    const observedCommand = [
        ...networkSandbox.command
    ];
    const commit = git(['rev-parse', 'HEAD']);
    const inputPaths = [...new Set([
        ...options.paths,
        physicalExecutionPolicy,
        'config/schemas/test-execution-envelope-applicability.schema.json',
        'config/schemas/test-execution-envelope-policy.schema.json',
        'config/schemas/test-execution-envelope-receipt.schema.json',
        'config/schemas/test-execution-network-policy.schema.json',
        'config/testing/test-execution-envelope-applicability.json',
        'config/testing/test-execution-envelope-policy.json',
        'config/testing/test-execution-network-policy.json',
        'tools/test/execution-envelope-directories.mjs',
        'tools/test/execution-envelope-environment.mjs',
        'tools/test/execution-envelope-network.mjs',
        'tools/test/execution-envelope-receipt.mjs',
        'tools/test/native/execution-envelope-landlock.c',
        'tools/test-matrix/execution-envelope-policy.mjs',
        'tools/test/temporal-context.mjs',
        'tools/test-fixtures/producers/temporal-child-handshake.bash',
        'tools/test-fixtures/producers/temporal-child-handshake.cjs',
        'tools/test-fixtures/producers/temporal-child-handshake-emitter.cjs',
        'tools/test-fixtures/producers/temporal-child-observer.mjs',
        ...(options.browserEnvelope ? [options.browserEnvelope] : []),
        ...(options.serviceEnvelope ? [options.serviceEnvelope] : [])
    ])];
    const inputDigest = await fingerprintPaths(inputPaths, {
        root: repoRoot,
        values: [
            'run-bound-physical-execution-v3',
            cwd,
            JSON.stringify(command),
            JSON.stringify([...options.outputs].sort()),
            digestCanonical(temporalContext),
            correctnessEnvironment.fragmentDigest,
            digest(directoryEnvelope.fragment),
            digest(networkSandbox.fragment)
        ]
    });
    const environmentDigest = digest({
        environment: correctnessEnvironment.fragment,
        directories: directoryEnvelope.fragment,
        network: networkSandbox.fragment
    });
    const worktreeFingerprint = digest({
        commit,
        inputDigest,
        status: git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...inputPaths])
    });
    const consumerId = String(options.consumer ?? producerId).trim() || producerId;
    const envelopeDirectory = path.join(
        repoRoot,
        '.tmp/test-execution-envelope',
        sanitizeSegment(runId, 'run'),
        sanitizeSegment(producerId, 'producer')
    );
    const executionEnvelopePlanFile = path.join(
        envelopeDirectory,
        `${sanitizeSegment(options.key, 'execution')}-plan.json`
    );
    const executionEnvelopeReceiptFile = path.join(
        envelopeDirectory,
        `${sanitizeSegment(options.key, 'execution')}-receipt.json`
    );
    const envelopeIdentity = {
        producerId,
        schedulerRunId: runId,
        attemptId: options.key,
        sourceCommit,
        sourceFingerprint,
        worktreeFingerprint: `sha256:${worktreeFingerprint}`,
        workingDirectory: cwd
    };
    const plan = buildExecutionEnvelope({
        phase: 'planned',
        identity: envelopeIdentity,
        applicability: producerEnvelope,
        policy,
        catalog,
        environment: correctnessEnvironment.fragment,
        directories: directoryEnvelope.fragment,
        network: networkSandbox.fragment,
        browser: browserEnvelope,
        services: serviceEnvelope,
        hostFacts: observeExecutionEnvelopeHostFacts({
            directory: directoryEnvelope.fragment.ownedRoot
        })
    });
    writePrivateJson(executionEnvelopePlanFile, plan);
    const controller = new AbortController();
    const abort = (signal) => controller.abort(Object.assign(new Error(`received ${signal}`), { name: 'AbortError', signal }));
    const onSigint = () => abort('SIGINT');
    const onSigterm = () => abort('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    let postflightAttempted = false;
    let executionEnvelopeBinding = null;
    const finalizeEnvelope = () =>
    {
        if (postflightAttempted)
        {
            return executionEnvelopeBinding;
        }
        postflightAttempted = true;
        let postflightError = null;
        let networkFragment = networkSandbox.fragment;
        let directoryFragment = directoryEnvelope.fragment;
        let actualHostFacts = null;
        try
        {
            networkFragment = finalizeNetworkSandbox(networkSandbox);
        }
        catch (error)
        {
            postflightError = error;
        }
        try
        {
            actualHostFacts = observeExecutionEnvelopeHostFacts({
                directory: directoryEnvelope.fragment.ownedRoot
            });
        }
        catch (error)
        {
            postflightError ??= error;
        }
        try
        {
            directoryFragment = finalizeRunOwnedDirectories(directoryEnvelope);
        }
        catch (error)
        {
            postflightError ??= error;
        }
        if (postflightError)
        {
            writePrivateJson(executionEnvelopeReceiptFile, {
                schema: 'fsusblog.test-execution-envelope-rejection.v1',
                qualificationEligible: false,
                producerId,
                schedulerRunId: runId,
                attemptId: options.key,
                planDigest: plan.envelopeDigest,
                reason: postflightError.message,
                fragments: {
                    environment: correctnessEnvironment.fragment,
                    directories: directoryFragment,
                    network: networkFragment
                }
            });
            throw postflightError;
        }
        const actual = buildExecutionEnvelope({
            phase: 'actual',
            identity: envelopeIdentity,
            applicability: producerEnvelope,
            policy,
            catalog,
            environment: correctnessEnvironment.fragment,
            directories: directoryFragment,
            network: networkFragment,
            browser: browserEnvelope,
            services: serviceEnvelope,
            hostFacts: actualHostFacts
        });
        const receipt = sealExecutionEnvelopeReceipt({ plan, actual });
        writePrivateJson(executionEnvelopeReceiptFile, receipt);
        executionEnvelopeBinding = {
            ...verifyExecutionEnvelopeReceipt(receipt),
            receiptFile: path.relative(repoRoot, executionEnvelopeReceiptFile)
                .replaceAll(path.sep, '/')
        };
        return executionEnvelopeBinding;
    };
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
            executionEnvelopeDigest: plan.envelopeDigest,
            testIds: options.testIds,
            consumerId,
            signal: controller.signal
        }, async () =>
        {
            let physicalExecution;
            let executionError = null;
            try
            {
                physicalExecution = await spawnCommand(
                    observedCommand,
                    cwd,
                    controller.signal,
                    correctnessEnvironment.environment,
                    {
                        linuxPrivateNetwork: networkSandbox.linuxPrivateNetwork,
                        linuxNetworkPolicy: networkSandbox.linuxNetworkPolicy,
                        linuxReadWritePaths: networkSandbox.linuxReadWritePaths
                    }
                );
            }
            catch (error)
            {
                executionError = error;
                physicalExecution = error?.physicalExecution ?? null;
            }
            let envelopeError = null;
            try
            {
                finalizeEnvelope();
            }
            catch (error)
            {
                envelopeError = error;
            }
            if (envelopeError)
            {
                envelopeError.physicalExecution = physicalExecution;
                envelopeError.cause = executionError;
                throw envelopeError;
            }
            if (executionError)
            {
                throw executionError;
            }
            return physicalExecution;
        });
        if (!executionEnvelopeBinding)
        {
            throw new Error('correctness producer completed without an execution envelope receipt');
        }
        const consumerEvidenceFile = options.projectionDirectory
            ? await publishConsumerProjection({
          result,
          directory: options.projectionDirectory,
          cwd,
          runId,
          key: options.key,
          consumerId,
          executionEnvelopeBinding
        })
            : null;
        const temporalFiles = publishRunnerTemporalArtifacts({
            context: temporalContext,
            result,
            key: options.key,
            executionEnvelopeBinding
        });
        console.log(`[physical-execution] ${result.status} key=${options.key} receipt=${result.receiptFile} projection=${result.projectionFile}${consumerEvidenceFile ? ` consumer-evidence=${consumerEvidenceFile}` : ''} temporal-receipt=${temporalFiles.receipt} execution-envelope=${executionEnvelopeReceiptFile}`);
    }
    catch (error)
    {
        executionFailure = error;
    }
    finally
    {
        if (!postflightAttempted)
        {
            try
            {
                finalizeEnvelope();
            }
            catch (error)
            {
                finalizationFailure = error;
            }
        }
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
    }
    if (executionFailure && finalizationFailure)
    {
        throw new AggregateError(
            [executionFailure, finalizationFailure],
            'physical execution and execution-envelope finalization failed',
            { cause: finalizationFailure }
        );
    }
    if (executionFailure)
    {
        throw executionFailure;
    }
    if (finalizationFailure)
    {
        throw finalizationFailure;
    }
}

main(process.argv.slice(2)).catch((error) =>
{
    console.error(`[physical-execution] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = Number.isInteger(error?.exitCode) && error.exitCode > 0 ? error.exitCode : 1;
});

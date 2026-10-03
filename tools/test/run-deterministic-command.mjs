#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    finalizeRunOwnedDirectories,
    finalizeRunOwnedDirectoriesAfterPhysical,
    prepareRunOwnedDirectories
} from './execution-envelope-directories.mjs';
import { prepareCorrectnessEnvironment, prepareCorrectnessEnvironmentAsync } from './execution-envelope-environment.mjs';
import { readPreparedBehaviorDocNuget } from './behavior-doc-nuget-preparation.mjs';
import {
    finalizeNetworkSandbox,
    loadExecutionNetworkPolicy,
    prepareNetworkSandbox,
    prepareNetworkSandboxAsync,
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
const {executionEnvelopeDigest, loadExecutionEnvelopeApplicability, loadExecutionEnvelopePolicy, resolveExecutionEnvelopeProducer} = await import(new URL('../test-matrix/execution-envelope-policy.mjs', import.meta.url));
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

function createRunnerTemporalContext({ producerId, runId, sourceCommit, sourceFingerprint, parentEnvironment = process.env })
{
    return qualificationTemporalContext({
        sourceCommit,
        sourceFingerprint: sourceFingerprint.startsWith('sha256:')
            ? sourceFingerprint
            : `sha256:${sourceFingerprint}`,
        producerId,
        schedulerRunId: runId,
        businessEpochUtc: String(
            parentEnvironment.FSUSBLOG_TEST_BUSINESS_EPOCH_UTC
      ?? '2024-02-29T23:59:59.000Z'
        ).trim(),
        locale: String(parentEnvironment.FSUSBLOG_TEST_LOCALE ?? 'en-US').trim(),
        uiLocale: String(
            parentEnvironment.FSUSBLOG_TEST_UI_LOCALE
      ?? parentEnvironment.FSUSBLOG_TEST_LOCALE
      ?? 'en-US'
        ).trim(),
        timeoutPolicyDigest: parentEnvironment.FSUSBLOG_TIMEOUT_POLICY_DIGEST?.trim()
      || defaultTimeoutPolicyDigest()
    });
}

function bindTemporalArtifact(document, executionEnvelopeBinding)
{
    // eslint-disable-next-line no-unused-vars
    const { digest: _digest, ...payload } = document;
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

async function prepareCorrectnessFragments({
    options, command, cwd, producerId, runId, sourceCommit, sourceFingerprint,
    temporalContext, temporalRoleEnvironment, preparedNuget, policy, catalog, producerEnvelope, serviceEnvelope,
    parentEnvironment = process.env, preparationOwner = null, retainPrepared = null
})
{
    if (preparationOwner !== null && ['executePreparation', 'assertPreparationExecution', 'assertFinalizablePreparation']
        .some((name) => typeof preparationOwner[name] !== 'function'))
    {
        throw new Error('controller-owned preparation requires the original complete private tool-owner port');
    }
    const ownerPort = preparationOwner === null ? null : Object.freeze({
        executePreparation: preparationOwner.executePreparation,
        assertPreparationExecution: preparationOwner.assertPreparationExecution,
        assertFinalizablePreparation: preparationOwner.assertFinalizablePreparation
    });
    const directoryEnvelope = prepareRunOwnedDirectories({
        repositoryRoot: repoRoot, cwd, runId, producerId, attemptId: options.key,
        outputs: options.outputs, preparedNuget, retainPrepared
    });
    const assertPreparationFinalizable = async () =>
    {
        if (ownerPort === null)
        {
            return { physicalStarted: false, physicalExecution: null };
        }
        const state = await ownerPort.assertFinalizablePreparation();
        if (typeof state?.physicalStarted !== 'boolean'
            || (state.physicalStarted && state.physicalExecution?.postObservation !== 'zero-members')
            || (!state.physicalStarted && state.physicalExecution !== null))
        {
            throw Object.assign(new Error('preparation tools retained without a verified finalizable owner state'), {
                recoveryObligation: { ownedRoot: directoryEnvelope.fragment.ownedRoot,
                    reason: 'original preparation owner did not prove all started tools absent' }
            });
        }
        return state;
    };
    try
    {
        const environmentInput = {
            command, parentEnvironment, producerAllowlist: options.environmentNames,
            injectedEnvironment: {
                ...materializeTemporalEnvironment(temporalContext), ...temporalRoleEnvironment,
                ...directoryEnvelope.environment, FSUSBLOG_TEST_RUN_ID: runId,
                FSUSBLOG_TEST_SOURCE_COMMIT: sourceCommit, FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceFingerprint
            }, policy, catalog
        };
        const correctnessEnvironment = ownerPort === null
            ? prepareCorrectnessEnvironment(environmentInput)
            : await prepareCorrectnessEnvironmentAsync({ ...environmentInput, cwd, ...ownerPort });
        const networkPolicy = loadExecutionNetworkPolicy();
        const networkInput = {
            command: [process.execPath, temporalChildObserver, '--', ...correctnessEnvironment.command],
            cwd, directories: directoryEnvelope.fragment.directories, ownedDirectoryEnvelope: directoryEnvelope,
            writableRoots: directoryEnvelope.fragment.writableRoots,
            plannedEndpoints: projectPlannedEndpoints({ services: producerEnvelope.requiredServices, serviceEnvelope, policy: networkPolicy }),
            environment: correctnessEnvironment.environment, policy: networkPolicy, producerId, attemptId: options.key
        };
        const networkSandbox = ownerPort === null
            ? prepareNetworkSandbox(networkInput)
            : await prepareNetworkSandboxAsync({ ...networkInput, ...ownerPort });
        return { directoryEnvelope, correctnessEnvironment, networkSandbox, assertPreparationFinalizable };
    }
    catch (error)
    {
        try
        {
            if (ownerPort === null)
            {
                finalizeRunOwnedDirectories(directoryEnvelope);
            }
            else
            {
                finalizeRunOwnedDirectoriesAfterPhysical(directoryEnvelope, await assertPreparationFinalizable());
            }
        }
        catch (cleanupError)
        {
            error.cleanupError = cleanupError;
            error.recoveryObligation ??= cleanupError.recoveryObligation;
        }
        throw error;
    }
}

async function prepareCorrectnessPlan({ options, command, cwd, producerId, runId, sourceCommit, sourceFingerprint,
    temporalContext, preparedNuget, directoryEnvelope, correctnessEnvironment, networkSandbox, browserEnvelope, serviceEnvelope,
    producerEnvelope, policy, catalog, signal = null })
{
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
        'config/testing/temporal-domain-producer-inventory.json',
        'config/testing/temporal-shape-catalog.json',
        'config/testing/resolved-temporal-roles.schema.json',
        'tools/test/execution-envelope-directories.mjs',
        'tools/test/behavior-doc-nuget-preparation.mjs',
        ...(preparedNuget?.inputPaths ?? []),
        'tools/test/execution-envelope-environment.mjs',
        'tools/test/execution-envelope-network.mjs',
        'tools/test/physical-execution-private-dotnet-scratch.mjs',
        'tools/test/execution-envelope-receipt.mjs',
        'tools/test/native/execution-envelope-landlock.c',
        'tools/test-matrix/execution-envelope-policy.mjs',
        'tools/test/temporal-context.mjs',
        'tools/test/temporal-role-resolver.mjs',
        'tools/test/temporal-shape-catalog.mjs',
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
            preparedNuget?.bindingDigest ?? null,
            digest(networkSandbox.fragment)
        ]
    });
    const environmentDigest = digest({
        environment: correctnessEnvironment.fragment,
        directories: directoryEnvelope.fragment,
        network: networkSandbox.fragment
    });
    if (signal?.aborted)
    {
        throw signal.reason;
    }
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
    return { observedCommand, commit, inputDigest, environmentDigest, worktreeFingerprint, consumerId,
        executionEnvelopePlanFile, executionEnvelopeReceiptFile, envelopeIdentity, plan };
}

export function combinePreparationAndBusinessTerminal(preparation, business, { ownedRoot })
{
    if (preparation === null)
    {
        return business;
    }
    for (const [phase, state] of [['preparation', preparation], ['business', business]])
    {
        if (typeof state?.physicalStarted !== 'boolean'
            || (state.physicalStarted && state.physicalExecution?.postObservation !== 'zero-members')
            || (!state.physicalStarted && state.physicalExecution !== null))
        {
            throw Object.assign(new Error(`Run-owned directories retained for unverifiable ${phase} terminal`), {
                physicalExecution: state?.physicalExecution ?? null,
                recoveryObligation: { ownedRoot,
                    reason: `${phase} owner has not provided its actual started state and zero-member terminal` }
            });
        }
    }
    // The preparation owner already checks every started tool individually. This
    // selects an existing raw proof for the directory guard; it creates no
    // aggregate proof and does not change the business receipt's terminal.
    return {
        physicalStarted: business.physicalStarted || preparation.physicalStarted,
        physicalExecution: business.physicalStarted ? business.physicalExecution : preparation.physicalExecution
    };
}

function createCorrectnessFinalizer({ directoryEnvelope, correctnessEnvironment, networkSandbox,
    executionEnvelopeReceiptFile, producerId, runId, options, plan, envelopeIdentity, producerEnvelope,
    policy, catalog, browserEnvelope, serviceEnvelope, assertPreparationFinalizable = null })
{
    let postflightAttempted = false;
    let executionEnvelopeBinding = null;
    let networkFragment = networkSandbox.fragment;
    let directoryFragment = directoryEnvelope.fragment;
    const finalizeEnvelope = async ({ physicalStarted, physicalExecution }) =>
    {
        let preparationTerminal = null;
        if (assertPreparationFinalizable)
        {
            preparationTerminal = await assertPreparationFinalizable();
        }
        let directoryTerminal;
        try
        {
            directoryTerminal = combinePreparationAndBusinessTerminal(preparationTerminal,
                { physicalStarted, physicalExecution }, { ownedRoot: directoryEnvelope.fragment.ownedRoot });
        }
        catch (error)
        {
            directoryEnvelope.fragment.cleanup = { status: 'retained-for-physical-recovery', removedOwnedRoot: false };
            throw error;
        }
        const terminalEvidence = physicalExecution;
        if (postflightAttempted)
        {
            return executionEnvelopeBinding;
        }
        postflightAttempted = true;
        let postflightError = null;
        networkFragment = networkSandbox.fragment;
        directoryFragment = directoryEnvelope.fragment;
        let actualHostFacts = null;
        if (physicalStarted && terminalEvidence?.postObservation !== 'zero-members')
        {
            try
            {
                finalizeRunOwnedDirectoriesAfterPhysical(directoryEnvelope, directoryTerminal);
            }
            catch (error)
            {
                postflightError = error;
            }
        }
        try
        {
            if (!postflightError)
            {
                networkFragment = finalizeNetworkSandbox(networkSandbox);
            }
        }
        catch (error)
        {
            postflightError ??= error;
        }
        try
        {
            if (!postflightError) actualHostFacts = observeExecutionEnvelopeHostFacts({
                directory: directoryEnvelope.fragment.ownedRoot
            });
        }
        catch (error)
        {
            postflightError ??= error;
        }
        try
        {
            directoryFragment = finalizeRunOwnedDirectoriesAfterPhysical(directoryEnvelope, directoryTerminal);
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
                recoveryObligation: postflightError.recoveryObligation ?? null,
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
    return {
        finalize: finalizeEnvelope,
        get attempted()
        {
            return postflightAttempted;
        },
        get directoryFragment()
        {
            return directoryFragment;
        },
        get networkFragment()
        {
            return networkFragment;
        }
    };
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
        if (options.preparedNuget)
        {
            throw new Error('Offline NuGet ingress cannot be used by a diagnostic command');
        }
        if (options.projectionDirectory)
        {
            throw new Error('diagnostic execution cannot publish a correctness projection');
        }
        await spawnCommand(command, cwd, undefined, process.env);
        console.log(`[physical-execution] diagnostic-direct key=${options.key} qualificationEligible=false`);
        return;
    }

    const controller = new AbortController();
    const abort = (signal) => controller.abort(Object.assign(new Error(`received ${signal}`), { name: 'AbortError', signal }));
    const onSigint = () => abort('SIGINT');
    const onSigterm = () => abort('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    let directoryEnvelope;
    let firstFailure = null;
    let physicalStarted = false;
    let terminalEvidence = null;
    try
    {
        let prepared;
        let finalizer;
        let nestedEnvelopeReference = null;
        if (Object.hasOwn(process.env, 'FSUSBLOG_PHYSICAL_EXECUTION_CHANNEL'))
        {
            const { nestedExecutionChannelKey, prepareNestedExecutionEnvelope, finalizeNestedExecutionEnvelope } =
                await import('./physical-execution-nested-channel.mjs');
            const descriptor = JSON.parse(process.env[nestedExecutionChannelKey]);
            const selectedNames = [...new Set(['PATH', ...options.environmentNames, 'FSUSBLOG_TEST_RUN_ID',
                'FSUSBLOG_TEST_SOURCE_COMMIT', 'FSUSBLOG_TEST_SOURCE_FINGERPRINT', 'FSUSBLOG_TEST_NAMESPACE'])];
            prepared = await prepareNestedExecutionEnvelope({ descriptor, signal: controller.signal,
                invocation: { schema: 'fsusblog.controller-owned-correctness-envelope.v1',
                    options: { ...options, cwd }, command,
                    parentEnvironment: Object.fromEntries(selectedNames.filter((name) => process.env[name] !== undefined)
                        .map((name) => [name, process.env[name]])) } });
            nestedEnvelopeReference = prepared.reference;
            let attempted = false;
            finalizer = { get attempted()
            {
                return attempted;
            }, finalize: async () =>
            {
                attempted = true;
                const result = await finalizeNestedExecutionEnvelope({ descriptor,
                    reference: nestedEnvelopeReference, signal: controller.signal });
                return result.executionEnvelopeBinding;
            } };
        }
        else
        {
            const inputs = await resolveCorrectnessInputs({ options, producerId, runId, sourceCommit, sourceFingerprint });
            const fragments = await prepareCorrectnessFragments({ options, command, cwd, producerId, runId, sourceCommit,
                sourceFingerprint, ...inputs, retainPrepared: (retained) => { directoryEnvelope = retained; } });
            const preparedPlan = await prepareCorrectnessPlan({ options, command, cwd, producerId, runId, sourceCommit,
                sourceFingerprint, ...inputs, ...fragments, signal: controller.signal });
            finalizer = createCorrectnessFinalizer({ options, producerId, runId, ...inputs, ...fragments, ...preparedPlan });
            prepared = { ...preparedPlan, temporalContext: inputs.temporalContext,
                publicExecution: { command: preparedPlan.observedCommand, cwd,
                    env: fragments.correctnessEnvironment.environment,
                    linuxPrivateNetwork: fragments.networkSandbox.linuxPrivateNetwork,
                    linuxNetworkPolicy: fragments.networkSandbox.linuxNetworkPolicy,
                    linuxReadWritePaths: fragments.networkSandbox.linuxReadWritePaths,
                    privateDotnetScratch: fragments.networkSandbox.privateDotnetScratch
                        ? { schema: 'fsusblog.private-dotnet-scratch.v1', path: '/tmp/.dotnet/shm', ...preparedPlan.envelopeIdentity } : null } };
        }
        const { temporalContext, commit, inputDigest, environmentDigest, worktreeFingerprint, consumerId,
            executionEnvelopeReceiptFile, plan, publicExecution } = prepared;
        let executionEnvelopeBinding = null;
        const finalizeEnvelope = async () =>
        {
            executionEnvelopeBinding = await finalizer.finalize({ physicalStarted, physicalExecution: terminalEvidence });
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
                    physicalStarted = true;
                    physicalExecution = await spawnCommand(
                        publicExecution.command,
                        publicExecution.cwd,
                        controller.signal,
                        publicExecution.env,
                        {
                            linuxPrivateNetwork: publicExecution.linuxPrivateNetwork,
                            linuxNetworkPolicy: publicExecution.linuxNetworkPolicy,
                            linuxReadWritePaths: publicExecution.linuxReadWritePaths,
                            linuxOwnedPrivateTmp: directoryEnvelope?.privateTmpCapability ?? null,
                            privateDotnetScratch: publicExecution.privateDotnetScratch,
                            nestedEnvelopeReference
                        }
                    );
                }
                catch (error)
                {
                    executionError = error;
                    physicalExecution = error?.physicalExecution ?? null;
                }
                terminalEvidence = physicalExecution;
                let envelopeError = null;
                try
                {
                    await finalizeEnvelope();
                }
                catch (error)
                {
                    envelopeError = error;
                }
                if (envelopeError)
                {
                    if (executionError)
                    {
                        executionError.cleanupError = envelopeError;
                        executionError.recoveryObligation ??= envelopeError.recoveryObligation;
                        throw executionError;
                    }
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
            firstFailure = error;
            throw error;
        }
        finally
        {
            let finalizationError = null;
            if (!finalizer.attempted)
            {
                try
                {
                    await finalizeEnvelope();
                }
                catch (error)
                {
                    finalizationError = error;
                }
            }
            process.off('SIGINT', onSigint);
            process.off('SIGTERM', onSigterm);
            if (finalizationError)
            {
                if (firstFailure)
                {
                    firstFailure.cleanupError ??= finalizationError;
                }
                else
                {
                    // eslint-disable-next-line no-unsafe-finally
                    throw finalizationError;
                }
            }
        }
    }
    catch (error)
    {
        firstFailure = error;
        throw error;
    }
    finally
    {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
        if (directoryEnvelope && fs.existsSync(directoryEnvelope.fragment.ownedRoot))
        {
            try
            {
                finalizeRunOwnedDirectoriesAfterPhysical(directoryEnvelope, {
                    physicalStarted, physicalExecution: terminalEvidence
                });
            }
            catch (cleanupError)
            {
                if (firstFailure)
                {
                    firstFailure.cleanupError ??= cleanupError;
                    firstFailure.recoveryObligation ??= cleanupError.recoveryObligation;
                }
                else
                {
                    throw cleanupError;
                }
            }
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main(process.argv.slice(2)).catch((error) =>
    {
        console.error(`[physical-execution] ${error instanceof Error ? error.message : String(error)}`);
        if (error?.cleanupError)
        {
            console.error(`[physical-execution] cleanup-failure ${error.cleanupError.message ?? String(error.cleanupError)}`);
        }
        const recovery = error?.recoveryObligation ?? error?.cleanupError?.recoveryObligation;
        if (recovery) console.error(`[physical-execution] recovery-obligation ${JSON.stringify(recovery)}`);
        process.exitCode = Number.isInteger(error?.exitCode) && error.exitCode > 0 ? error.exitCode : 1;
    });
}
async function resolveCorrectnessInputs({ options, producerId, runId, sourceCommit, sourceFingerprint, parentEnvironment = process.env })
{
    const temporalContext = createRunnerTemporalContext({
        producerId,
        runId,
        sourceCommit,
        sourceFingerprint, parentEnvironment
    });
    const resolvedTemporalRoles = resolveTemporalRolesForProducerIfBound({
        temporalContext,
        namespace: String(parentEnvironment.FSUSBLOG_TEST_NAMESPACE ?? 'default'),
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
    if (options.preparedNuget && producerId !== 'behavior-doc-static-admission')
    {
        throw new Error('Prepared NuGet ingress is not declared for this producer');
    }
    const preparedNuget = producerId === 'behavior-doc-static-admission'
        ? await readPreparedBehaviorDocNuget({
            repositoryRoot: repoRoot, runId, file: options.preparedNuget
        })
        : null;
    return { temporalContext, temporalRoleEnvironment, policy, catalog, producerEnvelope, browserEnvelope, serviceEnvelope, preparedNuget };
}

export async function prepareAuthenticatedNestedEnvelope({
    invocation, descriptor, identity, controlEnvironment, assertAdmission, retainAttempt, preparationOwner
})
{
    if (typeof assertAdmission !== 'function' || typeof retainAttempt !== 'function'
        || !preparationOwner || ['executePreparation', 'assertPreparationExecution', 'assertFinalizablePreparation']
            .some((name) => typeof preparationOwner[name] !== 'function'))
    {
        throw new Error('authenticated preparation requires the original retained directory and complete private tool owner');
    }
    await assertAdmission();
    const context = descriptor?.reference?.context;
    const sourceState = context?.sourceState;
    if (!context || fs.realpathSync(context.root) !== fs.realpathSync(repoRoot)
        || !Number.isSafeInteger(identity?.pid) || identity.pid <= 0
        || !identity.processStartIdentity || !/^[a-f0-9]{40}$/u.test(sourceState?.commit ?? '')
        || !/^[a-f0-9]{64}$/u.test(sourceState?.worktreeFingerprint ?? '')
        || controlEnvironment?.FSUSBLOG_TEST_RUN_ID !== context.runId
        || controlEnvironment.FSUSBLOG_TEST_SOURCE_COMMIT !== sourceState.commit
        || String(controlEnvironment.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').replace(/^sha256:/u, '') !== sourceState.worktreeFingerprint)
    {
        throw new Error('authenticated preparation context differs from the actual original source and peer owner');
    }
    const fields = ['schema', 'options', 'command', 'parentEnvironment'];
    const optionFields = ['key', 'cwd', 'executionClass', 'producerId', 'preparedNuget', 'projectionDirectory',
        'browserEnvelope', 'serviceEnvelope', 'environmentNames', 'paths', 'outputs', 'testIds', 'consumer'];
    if (!invocation || Object.keys(invocation).sort().join('\0') !== fields.sort().join('\0')
        || invocation.schema !== 'fsusblog.controller-owned-correctness-envelope.v1'
        || !invocation.options || typeof invocation.options !== 'object' || Array.isArray(invocation.options)
        || Object.keys(invocation.options).some((field) => !optionFields.includes(field))
        || !Array.isArray(invocation.command) || invocation.command.length === 0
        || invocation.command.some((part) => typeof part !== 'string' || part.includes('\0'))
        || !invocation.parentEnvironment || typeof invocation.parentEnvironment !== 'object' || Array.isArray(invocation.parentEnvironment)
        || Object.values(invocation.parentEnvironment).some((value) => typeof value !== 'string'))
    {
        throw new Error('authenticated preparation requires a closed original producer invocation');
    }
    const options = structuredClone(invocation.options);
    const listFields = ['paths', 'environmentNames', 'outputs', 'testIds'];
    if (Object.entries(options).some(([name, value]) => !listFields.includes(name)
        && (typeof value !== 'string' || value.includes('\0'))))
    {
        throw new Error('authenticated preparation scalar options must remain original strings');
    }
    for (const field of listFields)
    {
        options[field] ??= [];
        if (!Array.isArray(options[field]) || options[field].some((value) => typeof value !== 'string' || value.includes('\0')))
        {
            throw new Error(`authenticated preparation ${field} is not an original string list`);
        }
    }
    if (options.executionClass !== 'correctness' || !String(options.key ?? '').trim() || !String(options.producerId ?? '').trim())
    {
        throw new Error('authenticated preparation requires an exact correctness producer and attempt');
    }
    const cwd = path.resolve(options.cwd ?? context.root);
    if (fs.realpathSync(cwd) !== cwd || (cwd !== repoRoot && !cwd.startsWith(`${repoRoot}${path.sep}`)))
    {
        throw new Error('authenticated preparation working directory is outside the original source owner');
    }
    const producerId = options.producerId;
    const runId = context.runId;
    const sourceCommit = sourceState.commit;
    const sourceFingerprint = controlEnvironment.FSUSBLOG_TEST_SOURCE_FINGERPRINT;
    for (const name of [...new Set(['PATH', ...options.environmentNames, 'FSUSBLOG_TEST_RUN_ID',
        'FSUSBLOG_TEST_SOURCE_COMMIT', 'FSUSBLOG_TEST_SOURCE_FINGERPRINT', 'FSUSBLOG_TEST_NAMESPACE'])])
    {
        if (invocation.parentEnvironment[name] !== controlEnvironment[name])
        {
            throw new Error(`authenticated preparation parent environment differs from the actual controller owner: ${name}`);
        }
    }
    if (git(['rev-parse', 'HEAD']) !== sourceCommit)
    {
        throw new Error('authenticated preparation source commit is no longer the original admitted source');
    }
    const command = [...invocation.command];
    const inputs = await resolveCorrectnessInputs({ options, producerId, runId, sourceCommit, sourceFingerprint,
        parentEnvironment: controlEnvironment });
    await assertAdmission();
    let fragments = null;
    try
    {
        fragments = await prepareCorrectnessFragments({ options, command, cwd, producerId, runId, sourceCommit, sourceFingerprint,
            ...inputs, parentEnvironment: controlEnvironment, preparationOwner, retainPrepared: retainAttempt });
        const preparedPlan = await prepareCorrectnessPlan({ options, command, cwd, producerId, runId, sourceCommit, sourceFingerprint,
            ...inputs, ...fragments });
        await assertAdmission();
        const finalizer = createCorrectnessFinalizer({ options, producerId, runId, ...inputs, ...fragments, ...preparedPlan });
        const execution = { command: preparedPlan.observedCommand, cwd, env: fragments.correctnessEnvironment.environment,
            linuxPrivateNetwork: fragments.networkSandbox.linuxPrivateNetwork,
            linuxNetworkPolicy: fragments.networkSandbox.linuxNetworkPolicy,
            linuxReadWritePaths: fragments.networkSandbox.linuxReadWritePaths,
            privateDotnetScratch: fragments.networkSandbox.privateDotnetScratch
                ? { schema: 'fsusblog.private-dotnet-scratch.v1', path: '/tmp/.dotnet/shm', ...preparedPlan.envelopeIdentity } : null,
            linuxOwnedPrivateTmp: fragments.networkSandbox.linuxOwnedPrivateTmp };
        const { linuxOwnedPrivateTmp: privateCapability, ...publicExecution } = execution;
        if (privateCapability !== fragments.directoryEnvelope.privateTmpCapability)
        {
            throw new Error('authenticated preparation lost the original retained directory capability');
        }
        const publicEnvelope = { temporalContext: inputs.temporalContext, runId, producerId,
            consumerId: preparedPlan.consumerId, cwd, commit: preparedPlan.commit, worktreeFingerprint: preparedPlan.worktreeFingerprint,
            inputDigest: preparedPlan.inputDigest, environmentDigest: preparedPlan.environmentDigest,
            envelopeIdentity: preparedPlan.envelopeIdentity, plan: preparedPlan.plan,
            executionEnvelopePlanFile: preparedPlan.executionEnvelopePlanFile,
            executionEnvelopeReceiptFile: preparedPlan.executionEnvelopeReceiptFile,
            correctnessEnvironment: { fragment: fragments.correctnessEnvironment.fragment, fragmentDigest: fragments.correctnessEnvironment.fragmentDigest },
            directoryFragment: fragments.directoryEnvelope.fragment, networkFragment: fragments.networkSandbox.fragment,
            publicExecution, executionDigest: executionEnvelopeDigest(publicExecution).slice(7) };
        return { publicEnvelope, execution,
            finalize: async ({ physicalStarted, physicalExecution }) =>
            {
                if (typeof physicalStarted !== 'boolean')
                {
                    throw new Error('nested finalization requires the actual original start state');
                }
                const executionEnvelopeBinding = await finalizer.finalize({ physicalStarted, physicalExecution });
                return { executionEnvelopeBinding, directoryFragment: finalizer.directoryFragment,
                    networkFragment: finalizer.networkFragment, physicalExecution };
            } };
    }
    catch (error)
    {
        if (fragments)
        {
            try
            {
                const state = await fragments.assertPreparationFinalizable();
                finalizeRunOwnedDirectoriesAfterPhysical(fragments.directoryEnvelope, state);
            }
            catch (cleanupError)
            {
                error.cleanupError ??= cleanupError;
                error.recoveryObligation ??= cleanupError.recoveryObligation;
            }
        }
        throw error;
    }
}

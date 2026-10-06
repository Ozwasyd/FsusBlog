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
import { prepareCorrectnessEnvironmentAsync, observeExecutableIdentityAsync, verifyExecutableIdentity } from './execution-envelope-environment.mjs';
import {
    finalizeNetworkSandbox,
    loadExecutionNetworkPolicy,
    prepareNetworkSandboxAsync,
    projectPlannedEndpoints
} from './execution-envelope-network.mjs';
import {
    buildExecutionEnvelope,
    observeExecutionEnvelopeHostFacts,
    sealExecutionEnvelopeReceipt,
    verifyExecutionEnvelopeReceipt
} from './execution-envelope-receipt.mjs';
import { formatExecutionFailure, createExecutionFailureOwner, observeExecutionFailure, retainExecutionFailure, retainExecutionRecovery, throwExecutionFailure, executionFailureDataProperty, retainExecutionFailureCompatibility } from './execution-failure-diagnostic.mjs';
import { runPhysicalExecution, observePhysicalExecutionFailure } from './physical-execution-process-tree.mjs';
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
const {loadExecutionEnvelopeApplicability, loadExecutionEnvelopePolicy, resolveExecutionEnvelopeProducer} = await import(new URL('../test-matrix/execution-envelope-policy.mjs', import.meta.url));
import { readPreparedNuget, revalidatePreparedNuget, assertPreparedNugetCurrent, requireNugetResourceChannel } from './behavior-doc-nuget-preparation.mjs';
import { bindMatrixNugetDiskDemand, buildProductionDiskDemandPlan, defaultProductionDiskRoots, readProductionDiskDemandCatalog } from '../test-matrix/production-disk-demand.mjs';
import { acquireProductionFreshExclusiveLease } from '../test-matrix/production-fresh-exclusive-lease.mjs';
import { acquireProductionCapacityReservation } from '../test-matrix/production-capacity-reservation.mjs';
import { snapshotSourceState } from '../test-matrix/scheduler.mjs';
import { resolveTemporalRolesForProducerIfBound } from './temporal-role-resolver.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const physicalExecutionPolicy = 'config/testing/physical-execution-process-policy.json';
const temporalChildObserver = path.join(
    repoRoot,
    'tools/test-fixtures/producers/temporal-child-observer.mjs'
);

/** Original preparation diagnostic helpers; descriptor inspection never executes an accessor. */
export function preparationFailureProperty(owner, reason, field)
{
    return executionFailureDataProperty(reason, field) ?? null;
}

export function preparationFailureText(owner, reason)
{
    const message = preparationFailureProperty(owner, reason, 'message');
    if (typeof message === 'string') return formatExecutionFailure(reason).split('\n')[0];
    if (reason === null || !['object', 'function'].includes(typeof reason)) return String(reason);
    return 'unprintable execution failure';
}

export function retainPreparationCleanupFailure(owner, firstReason, cleanupReason)
{
    const recoveryObligation = preparationFailureProperty(owner, cleanupReason, 'recoveryObligation');
    const failure = Object.freeze({ failed: true, reason: firstReason, cleanupFailed: true,
        cleanupReason, recoveryObligation });
    owner.cleanupFailures ??= [];
    owner.cleanupFailures.push(failure);
    retainExecutionFailureCompatibility(firstReason, 'cleanupError', cleanupReason);
    if (recoveryObligation !== null) retainExecutionFailureCompatibility(firstReason, 'recoveryObligation', recoveryObligation);
    return failure;
}

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
    executionEnvelopeBinding,
    preparedNuget = null,
    parentGuard = null
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

    if (preparedNuget) assertPreparedNugetCurrent(preparedNuget, repoRoot);
    parentGuard?.();
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
    if (preparedNuget) assertPreparedNugetCurrent(preparedNuget, repoRoot);
    parentGuard?.();
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    if (preparedNuget) assertPreparedNugetCurrent(preparedNuget, repoRoot);
    parentGuard?.();
    fs.renameSync(temporary, outputFile);
    if (preparedNuget) assertPreparedNugetCurrent(preparedNuget, repoRoot);
    parentGuard?.();
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
    return await runPhysicalExecution({ ...options, command, cwd, signal, env });
}

async function executeCommand(argv, preparedNuget = null, parentOwner = null, failureOwner = createExecutionFailureOwner())
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
    const parentModule = parentOwner ? await import('./nuget-preparation-owner.mjs') : null;
    const parentExecution = parentOwner ? parentModule.requireNugetPreparationExecution(parentOwner,
        { root: repoRoot, runId, purpose: preparedNuget?.purpose, producerId }) : null;
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
        if (options.preparedNuget) throw new Error('Diagnostic execution cannot admit prepared NuGet');
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
    let directoryEnvelope = null;
    let physicalStarted = false;
    let terminalEvidence = null;
    let preparationOwner = null;
    const controller = new AbortController();
    const executionSignal = parentExecution ? AbortSignal.any([controller.signal, parentExecution.physicalOptions.signal]) : controller.signal;
    const publicationGuard = () =>
    {
        executionSignal.throwIfAborted();
        if (parentOwner) parentModule.assertNugetManagedPreparationAdmission(parentOwner,
            { root: repoRoot, runId, purpose: preparedNuget.purpose, producerId });
    };
    const abort = (signal) => controller.abort(Object.assign(new Error(`received ${signal}`), { name: 'AbortError', signal }));
    const onSigint = () => abort('SIGINT');
    const onSigterm = () => abort('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    try
    {
    if (!parentExecution)
        throw new Error('Correctness preparation requires its complete original held-managed owner; nested preparation activation is pending');
    publicationGuard();
    directoryEnvelope = prepareRunOwnedDirectories({
        repositoryRoot: repoRoot,
        cwd,
        runId,
        producerId,
        attemptId: options.key,
        outputs: options.outputs,
        preparedNuget, assertPreparationAdmission: publicationGuard
    });
    preparationOwner = parentModule.createNugetManagedPreparationOwner(parentOwner, {
        expected: { root: repoRoot, runId, purpose: preparedNuget.purpose, producerId },
        directories: directoryEnvelope, signal: executionSignal });
    let correctnessEnvironment;
    let networkSandbox;
    try
    {
        correctnessEnvironment = await prepareCorrectnessEnvironmentAsync({
            command, cwd,
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
            policy, catalog, ...preparationOwner
        });
        publicationGuard();
        const networkPolicy = loadExecutionNetworkPolicy();
        networkSandbox = await prepareNetworkSandboxAsync({
            command: [
                process.execPath,
                temporalChildObserver,
                '--',
                ...correctnessEnvironment.command
            ],
            cwd,
            directories: directoryEnvelope.fragment.directories,
            ownedDirectoryEnvelope: directoryEnvelope,
            writableRoots: directoryEnvelope.fragment.writableRoots,
            plannedEndpoints: projectPlannedEndpoints({
                services: producerEnvelope.requiredServices,
                serviceEnvelope,
                policy: networkPolicy
            }),
            environment: correctnessEnvironment.environment,
            policy: networkPolicy,
            producerId,
            attemptId: options.key, signal: executionSignal, ...preparationOwner
        });
        publicationGuard();
    }
    catch (error)
    {
        retainExecutionFailure(failureOwner, error);
        try { preparationOwner.assertFinalizablePreparation();
            const observed = observePhysicalExecutionFailure(failureOwner);
            finalizeRunOwnedDirectoriesAfterPhysical(directoryEnvelope,
                { physicalStarted: observed.physicalStarted, physicalExecution: observed.physicalTerminal === 'zero-members' ? observed.physicalExecution : null }); }
        catch (cleanupError) { retainExecutionFailure(failureOwner, cleanupError); }
        throwExecutionFailure(failureOwner);
    }
    const observedCommand = [
        ...networkSandbox.command
    ];
    const commit = git(['rev-parse', 'HEAD']);
    const inputPaths = [...new Set([
        ...options.paths,
        ...(preparedNuget?.inputPaths ?? []),
        ...(preparedNuget?.closure.sourceClosureDigests.map((entry) => entry.path) ?? []),
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
        'tools/test/execution-envelope-environment.mjs',
        'tools/test/execution-envelope-network.mjs',
        'tools/test/physical-execution-private-dotnet-scratch.mjs',
        'tools/test/physical-execution-linux-systemd-adapter.mjs',
        'tools/test/physical-execution-linux-systemd-bootstrap.mjs',
        'tools/test/execution-envelope-receipt.mjs',
        'tools/test/execution-failure-diagnostic.mjs',
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
            digest(networkSandbox.fragment),
            preparedNuget?.bindingDigest ?? null
        ]
    });
    if (preparedNuget) assertPreparedNugetCurrent(preparedNuget, repoRoot);
        if (parentOwner) parentModule.requireNugetPreparationExecution(parentOwner,
            { root: repoRoot, runId, purpose: preparedNuget.purpose, producerId });
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
    publicationGuard();
    writePrivateJson(executionEnvelopePlanFile, plan);
    let postflightAttempted = false;
    let executionEnvelopeBinding = null;
    const finalizeEnvelope = () =>
    {
        preparationOwner.assertFinalizablePreparation();
        const observed = observePhysicalExecutionFailure(failureOwner);
        const cleanupStarted = observed.physicalStarted;
        const cleanupEvidence = observed.physicalTerminal === 'zero-members' ? observed.physicalExecution : null;
        if (postflightAttempted)
        {
            return executionEnvelopeBinding;
        }
        if (cleanupStarted && cleanupEvidence?.postObservation !== 'zero-members')
            finalizeRunOwnedDirectoriesAfterPhysical(directoryEnvelope, { physicalStarted: cleanupStarted, physicalExecution: cleanupEvidence });
        postflightAttempted = true;
        const postflightOwner = createExecutionFailureOwner();
        let networkFragment = networkSandbox.fragment;
        let directoryFragment = directoryEnvelope.fragment;
        let actualHostFacts = null;
        try
        {
            networkFragment = finalizeNetworkSandbox(networkSandbox);
        }
        catch (error)
        {
            retainExecutionFailure(postflightOwner, error);
        }
        try
        {
            actualHostFacts = observeExecutionEnvelopeHostFacts({
                directory: directoryEnvelope.fragment.ownedRoot
            });
        }
        catch (error)
        {
            retainExecutionFailure(postflightOwner, error);
        }
        try
        {
            directoryFragment = finalizeRunOwnedDirectoriesAfterPhysical(directoryEnvelope, { physicalStarted: cleanupStarted, physicalExecution: cleanupEvidence });
        }
        catch (error)
        {
            retainExecutionFailure(postflightOwner, error);
        }
        if (observeExecutionFailure(postflightOwner).failed)
        {
            try { writePrivateJson(executionEnvelopeReceiptFile, {
                schema: 'fsusblog.test-execution-envelope-rejection.v1',
                qualificationEligible: false,
                producerId,
                schedulerRunId: runId,
                attemptId: options.key,
                planDigest: plan.envelopeDigest,
                reason: observeExecutionFailure(postflightOwner).diagnostic.primary.message,
                fragments: {
                    environment: correctnessEnvironment.fragment,
                    directories: directoryFragment,
                    network: networkFragment
                }
            });
            } catch (receiptError) { retainExecutionFailure(postflightOwner, receiptError); }
            throwExecutionFailure(postflightOwner);
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
        publicationGuard();
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
            signal: executionSignal,
            failureOwner
        }, async () =>
        {
            let physicalExecution;
            const attemptFailure = createExecutionFailureOwner();
            try
            {
                if (preparedNuget)
                {
                    await revalidatePreparedNuget(preparedNuget, repoRoot);
                    assertPreparedNugetCurrent(preparedNuget, repoRoot);
                }
                if (parentOwner) parentModule.requireNugetPreparationExecution(parentOwner,
                    { root: repoRoot, runId, purpose: preparedNuget.purpose, producerId });
                physicalStarted = true;
                physicalExecution = await spawnCommand(
                    observedCommand,
                    cwd,
                    executionSignal,
                    correctnessEnvironment.environment,
                    {
                        ...(parentExecution ? parentExecution.physicalOptions : {}),
                        failureOwner,
                        linuxPrivateNetwork: networkSandbox.linuxPrivateNetwork,
                        linuxNetworkPolicy: networkSandbox.linuxNetworkPolicy,
                        linuxReadWritePaths: networkSandbox.linuxReadWritePaths,
                        linuxOwnedPrivateTmp: networkSandbox.linuxOwnedPrivateTmp,
                        privateDotnetScratch: networkSandbox.privateDotnetScratch
                            ? {
                                schema: 'fsusblog.private-dotnet-scratch.v1',
                                path: '/tmp/.dotnet/shm',
                                ...envelopeIdentity
                            } : null
                    }
                );
            }
            catch (error)
            {
                retainExecutionFailure(attemptFailure, error);
                physicalExecution = observePhysicalExecutionFailure(failureOwner).physicalExecution;
            }
            terminalEvidence = physicalExecution;
            if (!observeExecutionFailure(attemptFailure).failed)
            {
                try
                {
                    const executable = await observeExecutableIdentityAsync(correctnessEnvironment.command[0], {
                        cwd, environment: correctnessEnvironment.environment, pathValue: correctnessEnvironment.environment.PATH, ...preparationOwner });
                    publicationGuard();
                    verifyExecutableIdentity(correctnessEnvironment.fragment.actualExecutable, executable);
                }
                catch (reason) { retainExecutionFailure(attemptFailure, reason); }
            }

            try
            {
                finalizeEnvelope();
            }
            catch (error)
            {
                retainExecutionFailure(attemptFailure, error);
            }
            if (observeExecutionFailure(attemptFailure).failed)
            {
                retainExecutionFailure(failureOwner, observeExecutionFailure(attemptFailure).reason);
                throwExecutionFailure(attemptFailure);
            }
            if (preparedNuget) assertPreparedNugetCurrent(preparedNuget, repoRoot);
            publicationGuard();
            return physicalExecution;
        });
        if (!executionEnvelopeBinding)
        {
            throw new Error('correctness producer completed without an execution envelope receipt');
        }
        if (preparedNuget)
        {
            await revalidatePreparedNuget(preparedNuget, repoRoot);
            publicationGuard();
            assertPreparedNugetCurrent(preparedNuget, repoRoot);
        }
        const consumerEvidenceFile = options.projectionDirectory
            ? await publishConsumerProjection({
          result,
          directory: options.projectionDirectory,
          cwd,
          runId,
          key: options.key,
          consumerId,
          executionEnvelopeBinding,
          preparedNuget,
          parentGuard: publicationGuard
        })
            : null;
        if (preparedNuget) assertPreparedNugetCurrent(preparedNuget, repoRoot);
        publicationGuard();
        const temporalFiles = publishRunnerTemporalArtifacts({
            context: temporalContext,
            result,
            key: options.key,
            executionEnvelopeBinding
        });
        if (preparedNuget) assertPreparedNugetCurrent(preparedNuget, repoRoot);
        publicationGuard();
        console.log(`[physical-execution] ${result.status} key=${options.key} receipt=${result.receiptFile} projection=${result.projectionFile}${consumerEvidenceFile ? ` consumer-evidence=${consumerEvidenceFile}` : ''} temporal-receipt=${temporalFiles.receipt} execution-envelope=${executionEnvelopeReceiptFile}`);
        return { result, physicalExecution: terminalEvidence };
    }
    catch (error)
    {
        retainExecutionFailure(failureOwner, error);
        throwExecutionFailure(failureOwner);
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
                retainExecutionFailure(failureOwner, error);
            }
        }
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
        // eslint-disable-next-line no-unsafe-finally
        throwExecutionFailure(failureOwner);
    }
    }
    catch (error)
    {
        retainExecutionFailure(failureOwner, error);
        throwExecutionFailure(failureOwner);
    }
    finally
    {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
        if (directoryEnvelope && !directoryEnvelope.fragment.cleanup.removedOwnedRoot)
        {
            try { preparationOwner?.assertFinalizablePreparation();
                const observed = observePhysicalExecutionFailure(failureOwner);
                physicalStarted = observed.physicalStarted;
                terminalEvidence = observed.physicalTerminal === 'zero-members' ? observed.physicalExecution : null;
                finalizeRunOwnedDirectoriesAfterPhysical(directoryEnvelope, { physicalStarted, physicalExecution: terminalEvidence }); }
            catch (error) { retainExecutionFailure(failureOwner, error); }
        }
        // eslint-disable-next-line no-unsafe-finally
        throwExecutionFailure(failureOwner);
    }

}

export async function runDeterministicCommand(argv, parentOwner = null, failureOwner = createExecutionFailureOwner())
{
    const { options } = parse(argv);
    const producerId = String(options.producerId ?? '').trim();
    const required = ['behavior-doc-static-admission', 'matrix-governance', 'validate-matrix'].includes(producerId);
    if (!required && !options.preparedNuget) return executeCommand(argv, null, null, failureOwner);
    if (options.executionClass !== 'correctness') throw new Error('Prepared NuGet requires correctness execution');
    if (!parentOwner)
        throw new Error('Prepared correctness requires its complete original held-managed owner; nested preparation activation is pending');
    const runId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    const prepared = await readPreparedNuget({ repositoryRoot: repoRoot, runId,
        producerId, file: options.preparedNuget });
    if (prepared.preparation.schedulerSource.commit !== process.env.FSUSBLOG_TEST_SOURCE_COMMIT
        || prepared.preparation.schedulerSource.worktreeFingerprint !== process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT)
        throw new Error('Prepared NuGet is foreign to the declared scheduler source identity');
    if (parentOwner)
    {
        const { requireNugetPreparationExecution } = await import('./nuget-preparation-owner.mjs');
        requireNugetPreparationExecution(parentOwner, { root: repoRoot, runId,
            purpose: prepared.purpose, producerId });
        return executeCommand(argv, prepared, parentOwner, failureOwner);
    }
    if (prepared.purpose === 'behavior-doc') return executeCommand(argv, prepared, null, failureOwner);
    const sourceState = await snapshotSourceState(repoRoot);
    assertPreparedNugetCurrent(prepared, repoRoot);
    await requireNugetResourceChannel({ root: repoRoot, runId, sourceState });
    assertPreparedNugetCurrent(prepared, repoRoot);
    let lease, reservation;
    try
    {
        lease = acquireProductionFreshExclusiveLease({ root: repoRoot, runId,
            targetTierId: 'production-correctness', sourceState });
        const catalog = bindMatrixNugetDiskDemand(readProductionDiskDemandCatalog(repoRoot), prepared, producerId);
        const plan = buildProductionDiskDemandPlan({ root: repoRoot,
            tiers: [{ id: producerId, executionDependsOn: [], exclusiveResources: [] }], maxParallel: 1,
            catalog, roots: { ...defaultProductionDiskRoots(repoRoot, { includeDockerStorage: false }),
                matrixNugetArtifactRoot: path.join(repoRoot, '.tmp') } });
        reservation = acquireProductionCapacityReservation({ plan, runId,
            candidateIdentityDigest: lease.owner.candidateIdentityDigest, repositoryRoot: repoRoot,
            repositoryLeaseOwner: lease.owner });
        reservation.guardProducer(producerId);
        assertPreparedNugetCurrent(prepared, repoRoot);
        await executeCommand(argv, prepared, null, failureOwner);
        reservation.completeProducer(producerId);
    }
    catch (error) { retainExecutionFailure(failureOwner, error); throwExecutionFailure(failureOwner); }
    finally
    {
        const observation = observeExecutionFailure(failureOwner);
        const physical = observePhysicalExecutionFailure(failureOwner);
        const safe = !physical.physicalStarted || physical.physicalTerminal === 'zero-members';
        if (safe)
        {
            let capacityReleased = true;
            try { reservation?.release(observation.failed ? 'recovery-required' : 'released'); }
            catch (error) { capacityReleased = false; retainExecutionFailure(failureOwner, error); }
            if (capacityReleased)
                try { lease?.release(observation.failed ? 'failed' : 'complete'); }
                catch (error) { capacityReleased = false; retainExecutionFailure(failureOwner, error); }
            if (!capacityReleased) retainExecutionRecovery(failureOwner, { repositoryLeasePath: lease?.leasePath,
                capacityReservationFile: reservation?.activeFile, reason: 'original owner release unverified; recovery records retained' });
        }
        else retainExecutionRecovery(failureOwner, { repositoryLeasePath: lease?.leasePath,
            capacityReservationFile: reservation?.activeFile, reason: 'unknown physical terminal; original resources retained' });
        // eslint-disable-next-line no-unsafe-finally
        throwExecutionFailure(failureOwner);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const failureOwner = createExecutionFailureOwner();
    runDeterministicCommand(process.argv.slice(2), null, failureOwner).catch((error) =>
    {
        console.error(`[physical-execution] ${formatExecutionFailure(error, failureOwner)}`);
        const exitCode = executionFailureDataProperty(error, 'exitCode');
        process.exitCode = Number.isInteger(exitCode) && exitCode > 0 && exitCode <= 255 ? exitCode : 1;
    });
}

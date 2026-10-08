#!/usr/bin/env node
// fixture-catalog: consumer browser-contract-fixture acceptance-representative

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
    closePublicShellLocaleSceneBindings,
    preparePublicShellLocaleSceneBinding,
    transitionPublicShellLocaleSceneBinding
} from './fixture-lifecycle.mjs';
import { originalCaptureLimits } from './public-shell-locale-lifecycle-evidence.mjs';
import { createPublicShellLocaleMatrix } from './public-shell-locale-matrix.mjs';

const { releaseProductionBuildConsumer } = await import(new URL('../../tools/ci/production-build-artifacts.mjs', import.meta.url));
const { executionServiceImageReference } = await import(new URL('../../tools/test/execution-envelope-services.mjs', import.meta.url));
const { loadTemporalContext } = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const { cleanupLocalRuntime } = await import(new URL('../../tools/test-matrix/local-runtime-cleanup.mjs', import.meta.url));
const { readFixtureReceipt } = await import(new URL('../../tools/test-fixtures/receipt/fixture-receipt.mjs', import.meta.url));
const { readPrivateJson, writePrivateJson: retainPrivateJson } = await import(new URL('../../tools/test-fixtures/receipt/private-io.mjs', import.meta.url));
const responseSchema = 'fsusblog.browser-contract-fixture-provider-response.v1';
const requestSchema = 'fsusblog.browser-contract-fixture-provider-request.v1';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const postgresImageReference = executionServiceImageReference('postgres');
const redisImageReference = executionServiceImageReference('redis');

function temporalEnvironment(env = process.env)
{
    const context = loadTemporalContext(env);
    if (process.env.TZ !== context.nodeTimezone)
    {
        fail('browser contract Node timezone does not exact-match temporal context');
    }
    return {
        context,
        businessEpochUtc: context.businessEpochUtc,
        postgresTimezone: context.postgresTimezone,
        backendCulture: context.backendCulture,
        nodeTimezone: context.nodeTimezone
    };
}

export function resolveDedicatedRuntimeRunId(context, env = process.env)
{
    const plannedRunId = String(context?.schedulerRunId ?? '').trim();
    const ingressRunId = String(env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    if (!plannedRunId || ingressRunId !== plannedRunId)
    {
        fail('browser contract target run ingress does not exact-match temporal context');
    }
    return plannedRunId;
}

export function deriveLocalPublicContentFixtureSecret(request, runtimeRunId)
{
    return createHash('sha256')
        .update([
            'fsusblog.browser-contract.local-public-content-fixture-secret.v1',
            request.identity.namespace,
            request.preparation.id,
            request.sourceState.worktreeFingerprint,
            runtimeRunId
        ].join('\0'))
        .digest('base64url');
}

function fail(message)
{
    throw new Error(message);
}

function assertInside(root, value, label)
{
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(value);
    if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`))
    {
        fail(`${label} is outside its owned root`);
    }
    return resolved;
}

function parseEnvFile(file)
{
    return readFile(file, 'utf8').then((raw) => Object.fromEntries(raw
        .split(/\r?\n/u)
        .map((line) =>
        {
            const separator = line.indexOf('=');
            return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : null;
        })
        .filter(Boolean)));
}

async function readRequest()
{
    const chunks = [];
    for await (const chunk of process.stdin)
    {
        chunks.push(chunk);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request?.schema !== requestSchema)
    {
        fail('fixture provider request schema mismatch');
    }
    const namespace = String(request.identity?.namespace ?? '');
    if (!/^bc-[a-f0-9]{8}-[a-f0-9]{10}-[a-f0-9]{6}$/u.test(namespace))
    {
        fail('fixture provider namespace is invalid');
    }
    if (request.identity?.laneId !== 'browser-contract')
    {
        fail('fixture provider lane identity mismatch');
    }
    if (!/^[0-9a-f-]{36}$/u.test(String(request.preparation?.id ?? ''))
    || !Number.isFinite(Date.parse(String(request.preparation?.startedAt ?? ''))))
    {
        fail('fixture provider preparation identity is invalid');
    }
    if (request.resources?.databaseSchema !== 'public'
    || request.resources?.databaseInstance !== `fsusblog-test-postgres-${namespace}`
    || request.resources?.redisNamespace !== `FsusBlog_${namespace}_`
    || request.resources?.redisInstance !== `fsusblog-test-redis-${namespace}`)
    {
        fail('fixture provider resource identity mismatch');
    }
    const fixtureRoot = assertInside(
        path.join(repoRoot, '.tmp', 'browser-contract', 'fixtures'),
        request.resources.fixtureRoot,
        'fixture root'
    );
    if (path.basename(fixtureRoot) !== namespace)
    {
        fail('fixture root namespace mismatch');
    }
    return { ...request, resources: { ...request.resources, fixtureRoot } };
}

function providerStateFile(request)
{
    return path.join(request.resources.fixtureRoot, 'provider-state.json');
}

async function writePrivateJson(file, value)
{
    const temporary = `${file}.next-${process.pid}-${randomUUID()}`;
    try
    {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, file);
        await chmod(file, 0o600);
    }
    catch (error)
    {
        await rm(temporary, { force: true }).catch(() =>
        {});
        throw error;
    }
}

async function readProviderState(request)
{
    const state = await readProviderStateOptional(request);
    if (!state)
    {
        fail('fixture provider state is missing or unsafe');
    }
    return state;
}

async function readProviderStateOptional(request)
{
    const file = providerStateFile(request);
    let stat;
    try
    {
        stat = await lstat(file);
    }
    catch (error)
    {
        if (error?.code === 'ENOENT')
        {
            return null;
        }
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600)
    {
        fail('fixture provider state is unsafe');
    }
    return validateDefaultFixtureProviderState(JSON.parse(await readFile(file, 'utf8')), request);
}

export function validateDefaultFixtureProviderState(state, request)
{
    const preparing = state?.phase === 'preparing';
    const prepared = state?.phase === 'prepared';
    const validContainerId = (value) => preparing
        ? value === null
        : /^[a-f0-9]{64}$/u.test(String(value ?? ''));
    if (state?.schema !== 'fsusblog.browser-contract-default-provider-state.v1'
    || (!preparing && !prepared)
    || state.namespace !== request.identity.namespace
    || state.preparation?.id !== request.preparation?.id
    || state.preparation?.startedAt !== request.preparation?.startedAt
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(String(state.runtimeRunId ?? ''))
    || state.sourceState?.commit !== request.sourceState?.commit
    || state.sourceState?.worktreeFingerprint !== request.sourceState?.worktreeFingerprint
    || state.buildIdentity?.receiptContentDigest !== request.build?.receiptContentDigest
    || state.containers?.postgres?.name !== request.resources.databaseInstance
    || state.containers?.redis?.name !== request.resources.redisInstance
    || !validContainerId(state.containers?.postgres?.id)
    || !validContainerId(state.containers?.redis?.id)
    || (prepared && state.runtime?.isolatedDatabase !== true)
    || (prepared && state.runtime?.testSessionHeader !== false)
    || (preparing && state.runtime !== null))
    {
        fail('fixture provider state identity or ownership mismatch');
    }
    return state;
}

async function readPreparedProviderState(request)
{
    const state = await readProviderState(request);
    if (state.phase !== 'prepared')
    {
        fail('fixture provider state is not prepared');
    }
    return state;
}

function run(command, args, { env = process.env, timeoutMs = 0 } = {})
{
    return new Promise((resolve, reject) =>
    {
        const child = spawn(command, args, {
            cwd: repoRoot,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        const limit = 256 * 1024;
        const timer = timeoutMs > 0
            ? setTimeout(() => child.kill('SIGTERM'), timeoutMs)
            : null;
        timer?.unref();
        child.stdout.on('data', (chunk) =>
        {
            if (stdout.length < limit)
            {
                stdout += chunk;
            }
        });
        child.stderr.on('data', (chunk) =>
        {
            if (stderr.length < limit)
            {
                stderr += chunk;
            }
        });
        child.once('error', reject);
        child.once('close', (code, signal) =>
        {
            if (timer)
            {
                clearTimeout(timer);
            }
            if (code !== 0 || signal)
            {
                const diagnosticsFile = String(process.env.FSUSBLOG_BROWSER_CONTRACT_PROVIDER_DIAGNOSTICS_FILE ?? '').trim();
                if (diagnosticsFile)
                {
                    writeFileSync(
                        diagnosticsFile,
                        `command=${path.basename(command)}\n${stdout}\n--- stderr ---\n${stderr}`,
                        { mode: 0o600 });
                }
                reject(new Error(`${path.basename(command)} failed with ${signal || `exit ${code}`}`));
            }
            else
            {
                resolve({ stdout, stderr });
            }
        });
    });
}

const containerInspectionFormat = [
    '{{.Id}}',
    '{{.Name}}',
    '{{.Config.Image}}',
    '{{index .Config.Labels "io.fsusblog.test.run-id"}}',
    '{{index .Config.Labels "io.fsusblog.test.bundle-id"}}',
    '{{index .Config.Labels "io.fsusblog.test.step-id"}}',
    '{{index .Config.Labels "io.fsusblog.test.namespace"}}',
    '{{index .Config.Labels "io.fsusblog.test.preparation-id"}}'
].join('|');

function normalizedLabel(value)
{
    return value === '<no value>' ? '' : String(value ?? '');
}

async function inspectContainer(name)
{
    const result = await run('docker', ['inspect', '--format', containerInspectionFormat, name]);
    const [id, rawName, image, runId, bundleId, stepId, namespace, preparationId] = result.stdout.trim().split('|');
    if (!/^[a-f0-9]{64}$/u.test(id) || rawName !== `/${name}`)
    {
        fail(`owned container inspection failed: ${name}`);
    }
    return {
        name,
        id,
        image,
        labels: {
            runId: normalizedLabel(runId),
            bundleId: normalizedLabel(bundleId),
            stepId: normalizedLabel(stepId),
            namespace: normalizedLabel(namespace),
            preparationId: normalizedLabel(preparationId)
        }
    };
}

async function inspectContainerOptional(name)
{
    try
    {
        return await inspectContainer(name);
    }
    catch (inspectionError)
    {
        const inventory = await run('docker', ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}']);
        const names = inventory.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
        if (names.includes(name))
        {
            throw inspectionError;
        }
        return null;
    }
}

async function inspectContainerIdOptional(id)
{
    try
    {
        const result = await run('docker', ['inspect', '--format', containerInspectionFormat, id]);
        const [observedId, rawName, image, runId, bundleId, stepId, namespace, preparationId] = result.stdout.trim().split('|');
        if (observedId !== id || !rawName.startsWith('/'))
        {
            fail(`owned container id inspection failed: ${id}`);
        }
        return {
            name: rawName.slice(1),
            id: observedId,
            image,
            labels: {
                runId: normalizedLabel(runId),
                bundleId: normalizedLabel(bundleId),
                stepId: normalizedLabel(stepId),
                namespace: normalizedLabel(namespace),
                preparationId: normalizedLabel(preparationId)
            }
        };
    }
    catch (inspectionError)
    {
        const inventory = await run('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}}']);
        const ids = inventory.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
        if (ids.includes(id))
        {
            throw inspectionError;
        }
        return null;
    }
}

function containerIdentity(container)
{
    const id = String(container?.id ?? container?.Id ?? '');
    const rawName = String(container?.name ?? container?.Name ?? '');
    return {
        id,
        name: rawName.startsWith('/') ? rawName.slice(1) : rawName
    };
}

function inspectDockerContainerSync(reference)
{
    const result = spawnSync('docker', ['inspect', reference], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error)
    {
        throw result.error;
    }
    if (result.status !== 0)
    {
        const detail = String(result.stderr ?? result.stdout ?? '').trim();
        if (/no such (?:object|container)/iu.test(detail))
        {
            return null;
        }
        fail(`docker inspect failed for ${reference}: ${detail || `exit ${result.status}`}`);
    }
    try
    {
        return JSON.parse(String(result.stdout ?? ''))?.[0] ?? null;
    }
    catch
    {
        fail(`docker inspect returned invalid JSON for ${reference}`);
    }
}

function removeDockerContainerByIdSync(containerId)
{
    const result = spawnSync('docker', ['rm', '--force', '--volumes', containerId], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error)
    {
        throw result.error;
    }
    return result;
}

function removalFailure(reason, exitCode = null)
{
    return { removed: false, exitCode, reason };
}

export function removeVerifiedContainerById(containerId, {
    name,
    inspected,
    expected,
    removeById = removeDockerContainerByIdSync,
    inspectById = inspectDockerContainerSync,
    inspectByName = inspectDockerContainerSync
} = {})
{
    if (!/^[a-f0-9]{64}$/u.test(String(containerId ?? '')))
    {
        return removalFailure('container-id-is-not-full');
    }
    const expectedIdentity = containerIdentity(expected);
    const inspectedIdentity = containerIdentity(inspected);
    if (expectedIdentity.id !== containerId
    || expectedIdentity.name !== name
    || inspectedIdentity.id !== containerId
    || (inspectedIdentity.name && inspectedIdentity.name !== name))
    {
        return removalFailure('container-removal-identity-mismatch');
    }

    const observedById = inspectById(containerId);
    if (observedById === null)
    {
        return inspectByName(name) === null
            ? { removed: true, exitCode: 0, reason: null }
            : removalFailure('container-name-replaced-before-removal');
    }
    const observedIdentity = containerIdentity(observedById);
    if (observedIdentity.id !== containerId || observedIdentity.name !== name)
    {
        return removalFailure('container-removal-precondition-changed');
    }

    let removal;
    try
    {
        removal = removeById(containerId);
    }
    catch (error)
    {
        return removalFailure(error instanceof Error ? error.message : String(error));
    }
    const exitCode = Number.isInteger(removal?.status)
        ? removal.status
        : Number.isInteger(removal?.exitCode) ? removal.exitCode : null;
    const commandSucceeded = exitCode === null
        ? removal === true || removal?.removed === true
        : exitCode === 0;
    if (inspectById(containerId) !== null)
    {
        return removalFailure('container-id-survived-removal', exitCode);
    }
    if (inspectByName(name) !== null)
    {
        return removalFailure('container-name-replaced-after-removal', exitCode);
    }
    if (!commandSucceeded)
    {
        return removalFailure('container-remove-command-failed', exitCode);
    }
    return { removed: true, exitCode, reason: null };
}

export function compensateVerifiedContainerCleanup(observedContainers, {
    removeById = removeDockerContainerByIdSync,
    inspectById = inspectDockerContainerSync,
    inspectByName = inspectDockerContainerSync
} = {})
{
    return [...observedContainers].map((observed) =>
    {
        const identity = containerIdentity(observed);
        const outcome = removeVerifiedContainerById(identity.id, {
            name: identity.name,
            inspected: observed,
            expected: observed,
            removeById,
            inspectById,
            inspectByName
        });
        return { ...identity, ...outcome };
    });
}

function expectedContainerBinding(request, runtimeRunId)
{
    return {
        runId: runtimeRunId,
        bundleId: 'browser-contract',
        stepId: 'browser-contract-fixture',
        namespace: request.identity.namespace,
        preparationId: request.preparation.id
    };
}

function assertOwnedContainer(container, request, expectedId = null, runtimeRunId = null)
{
    const expected = expectedContainerBinding(request, runtimeRunId);
    if ((expectedId && container.id !== expectedId)
    || Object.entries(expected).some(([key, value]) => container.labels?.[key] !== value))
    {
        fail(`refusing cleanup after ${container.name} ownership changed`);
    }
    const expectedImage = container.name === request.resources.databaseInstance
        ? postgresImageReference
        : container.name === request.resources.redisInstance ? redisImageReference : null;
    if (!expectedImage || container.image !== expectedImage)
    {
        fail(`refusing cleanup after ${container.name} image changed`);
    }
    return container;
}

async function pathExists(value)
{
    try
    {
        await lstat(value);
        return true;
    }
    catch (error)
    {
        if (error?.code === 'ENOENT')
        {
            return false;
        }
        throw error;
    }
}

export async function retryLocalRuntimeCleanup(operation, {
    attempts = 5,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {})
{
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1)
    {
        try
        {
            return operation();
        }
        catch (error)
        {
            lastError = error;
            if (!['EBUSY', 'ENOTEMPTY', 'ENOENT'].includes(error?.code) || attempt + 1 >= attempts)
            {
                throw error;
            }
            await delay(50 * (attempt + 1));
        }
    }
    throw lastError;
}

async function waitForOwnedContainersAbsent(observedBefore, expectedContainers, timeoutMs = 8_000)
{
    const deadline = performance.now() + timeoutMs;
    while (true)
    {
        const observations = await Promise.all([
            ...[...observedBefore.values()].flatMap((observed) => [
                inspectContainerIdOptional(observed.id),
                inspectContainerOptional(observed.name)
            ]),
            ...expectedContainers
                .filter((expected) => !observedBefore.has(expected.name))
                .map((expected) => inspectContainerOptional(expected.name))
        ]);
        if (observations.every((observation) => !observation))
        {
            return true;
        }
        if (performance.now() >= deadline)
        {
            return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

function runtimeRecoveryPaths(request)
{
    const namespace = request.identity.namespace;
    return [
        path.join(repoRoot, '.tmp', 'env', `${namespace}.env`),
        path.join(repoRoot, '.tmp', 'acceptance', namespace),
        path.join(repoRoot, '.tmp', 'fixtures', namespace),
        path.join(repoRoot, '.tmp', 'data', namespace),
        path.join(repoRoot, '.tmp', 'run-once', namespace)
    ];
}

async function assertNamespaceVacant(request)
{
    for (const name of [request.resources.databaseInstance, request.resources.redisInstance])
    {
        if (await inspectContainerOptional(name))
        {
            fail(`browser contract namespace already owns container ${name}; cleanup requires its sealed provider state`);
        }
    }
    for (const recoveryPath of runtimeRecoveryPaths(request))
    {
        if (await pathExists(recoveryPath))
        {
            fail(`browser contract namespace has stale runtime state: ${path.relative(repoRoot, recoveryPath)}`);
        }
    }
}

async function immutableBuildEnvironment(request)
{
    const relativeReceipt = String(request.build?.receipt ?? '').trim();
    if (!relativeReceipt)
    {
        fail('immutable build receipt path is missing from provider request');
    }
    const receiptFile = assertInside(repoRoot, path.resolve(repoRoot, relativeReceipt), 'immutable build receipt');
    const artifactRoot = path.dirname(receiptFile);
    if (artifactRoot !== path.join(repoRoot, '.tmp', 'ci-production-build'))
    {
        fail('immutable build artifact root is not the canonical run-bound root');
    }
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    if (receipt?.schema !== 'fsusblog.ci-production-build-receipt.v1'
    || receipt.status !== 'complete'
    || receipt.contentDigest !== request.build.receiptContentDigest
    || receipt.sourceState?.commit !== request.sourceState?.commit
    || receipt.sourceState?.worktreeFingerprint !== request.sourceState?.worktreeFingerprint)
    {
        fail('immutable build receipt identity mismatch');
    }
    const domains = new Set((receipt.domains ?? []).map((domain) => domain.name));
    for (const domain of ['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm'])
    {
        if (!domains.has(domain))
        {
            fail(`immutable build receipt is missing ${domain}`);
        }
    }
    const producer = receipt.producer ?? {};
    const localProducer = producer.workflow === 'Local production';
    return {
        FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT: artifactRoot,
        FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: receipt.contentDigest,
        FSUSBLOG_TEST_SOURCE_COMMIT: receipt.sourceState.commit,
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: receipt.sourceState.worktreeFingerprint,
        ...(localProducer
            ? {
                FSUSBLOG_CI_PRODUCTION_PRODUCER_WORKFLOW: String(producer.workflow),
                FSUSBLOG_CI_PRODUCTION_PRODUCER_RUN_ID: String(producer.runId),
                FSUSBLOG_CI_PRODUCTION_PRODUCER_RUN_ATTEMPT: String(producer.runAttempt ?? 1),
                FSUSBLOG_CI_PRODUCTION_PRODUCER_JOB: String(producer.job)
            }
            : {
                GITHUB_WORKFLOW: String(producer.workflow),
                GITHUB_RUN_ID: String(producer.runId),
                GITHUB_RUN_ATTEMPT: String(producer.runAttempt ?? 1)
            })
    };
}

async function cleanupOwnedRuntime(request, state = null)
{
    const expectedContainers = [
        state?.containers?.postgres ?? { name: request.resources.databaseInstance, id: null },
        state?.containers?.redis ?? { name: request.resources.redisInstance, id: null }
    ];
    const observedBefore = new Map();
    for (const expected of expectedContainers)
    {
        const observed = await inspectContainerOptional(expected.name);
        if (observed)
        {
            if (!state)
            {
                fail(`refusing cleanup of ${expected.name} without sealed provider state`);
            }
            assertOwnedContainer(observed, request, expected.id, state.runtimeRunId);
            observedBefore.set(expected.name, observed);
        }
    }
    if (!state)
    {
        for (const recoveryPath of runtimeRecoveryPaths(request))
        {
            if (await pathExists(recoveryPath))
            {
                fail(`refusing cleanup without sealed provider state: ${path.relative(repoRoot, recoveryPath)}`);
            }
        }
    }
    const cleanupRuntime = () => cleanupLocalRuntime({
        root: repoRoot,
        namespace: request.identity.namespace,
        dedicatedTerminationGraceMs: 8_000,
        removeContainer: (containerId, { name, inspected } = {}) => removeVerifiedContainerById(containerId, {
            name,
            inspected,
            expected: observedBefore.get(name)
        })
    });
    let result = await retryLocalRuntimeCleanup(cleanupRuntime);
    // The local runtime manifest is recovery evidence, not the ownership source.
    // It may be absent or only partially written after bootstrap fails. Always
    // compensate from the full IDs whose state, labels, image, and name were
    // verified above; the helper refuses to touch a same-name replacement.
    const compensation = compensateVerifiedContainerCleanup(observedBefore.values());
    const compensationFailures = compensation.filter((entry) => entry.removed !== true);
    if (!await waitForOwnedContainersAbsent(observedBefore, expectedContainers))
    {
        for (const observed of observedBefore.values())
        {
            if (await inspectContainerIdOptional(observed.id))
            {
                fail(`owned container id survived cleanup: ${observed.id}`);
            }
            if (await inspectContainerOptional(observed.name))
            {
                fail(`owned container name survived cleanup: ${observed.name}`);
            }
        }
        for (const expected of expectedContainers)
        {
            if (!observedBefore.has(expected.name) && await inspectContainerOptional(expected.name))
            {
                fail(`owned container name appeared during cleanup: ${expected.name}`);
            }
        }
        fail('owned containers survived cleanup without an attributable identity');
    }
    if (result.retainedRuntimeState
    || result.skippedContainers.length > 0
    || result.containerCleanupFailures.length > 0
    || result.cleanupStatus !== 'complete'
    || compensationFailures.length > 0)
    {
        const terminatedPids = new Set(result.terminatedPids ?? []);
        for (let attempt = 0; attempt < 4; attempt += 1)
        {
            await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
            result = await retryLocalRuntimeCleanup(cleanupRuntime);
            for (const pid of result.terminatedPids ?? [])
            {
                terminatedPids.add(pid);
            }
            if (!result.retainedRuntimeState)
            {
                break;
            }
        }
        result.terminatedPids = [...terminatedPids];
    }
    const skippedProcesses = result.skippedProcesses ?? [];
    const skippedPids = skippedProcesses
        .map((entry) => entry?.pid)
        .filter((pid) => Number.isInteger(pid) && pid > 1);
    const filePaths = runtimeRecoveryPaths(request);
    const retainedFilePaths = [];
    for (const filePath of filePaths)
    {
        if (await pathExists(filePath))
        {
            retainedFilePaths.push(filePath);
        }
    }
    const files = {
        status: retainedFilePaths.length === 0 ? 'success' : 'failure',
        paths: filePaths.map((filePath) => path.relative(repoRoot, filePath).replaceAll(path.sep, '/')),
        retainedPaths: retainedFilePaths.map((filePath) => path.relative(repoRoot, filePath).replaceAll(path.sep, '/')),
        confirmedAbsent: retainedFilePaths.length === 0
    };
    const success = result.skippedContainers.length === 0
    && skippedProcesses.length === 0
    && result.containerCleanupFailures.length === 0
    && result.cleanupStatus === 'complete'
    && files.status === 'success';
    let buildConsumer = {
        status: 'retained',
        runId: state?.runtimeRunId ?? null,
        consumerId: request.identity.namespace
    };
    if (success && state?.runtimeRunId)
    {
        const relativeReceipt = String(request.build?.receipt ?? '').trim();
        const receiptFile = assertInside(
            repoRoot,
            path.resolve(repoRoot, relativeReceipt),
            'immutable build receipt');
        const artifactRoot = path.dirname(receiptFile);
        const leaseIdentity = `${state.runtimeRunId}--${request.identity.namespace}`;
        if (!/^[A-Za-z0-9._-]+--[A-Za-z0-9._-]+$/u.test(leaseIdentity))
        {
            fail('production build consumer lease identity is unsafe');
        }
        const leaseFile = path.join(`${artifactRoot}.state`, 'consumers', `${leaseIdentity}.json`);
        if (await pathExists(leaseFile))
        {
            const lease = JSON.parse(await readFile(leaseFile, 'utf8'));
            if (lease.status === 'active')
            {
                releaseProductionBuildConsumer({
                    artifactRoot,
                    runId: state.runtimeRunId,
                    consumerId: request.identity.namespace,
                    reason: 'browser-contract-cleanup'
                });
                buildConsumer = {
                    status: 'success',
                    runId: state.runtimeRunId,
                    consumerId: request.identity.namespace
                };
            }
            else if (lease.status === 'released')
            {
                buildConsumer = {
                    status: 'already-released',
                    runId: state.runtimeRunId,
                    consumerId: request.identity.namespace
                };
            }
            else
            {
                fail('production build consumer lease has invalid status');
            }
        }
        else
        {
            buildConsumer = {
                status: 'already-absent',
                runId: state.runtimeRunId,
                consumerId: request.identity.namespace
            };
        }
    }
    return {
        status: success ? 'success' : 'failure',
        resources: {
            database: {
                status: observedBefore.has(request.resources.databaseInstance) ? 'success' : 'already-absent',
                instance: request.resources.databaseInstance,
                id: state?.containers?.postgres?.id ?? null
            },
            redis: {
                status: observedBefore.has(request.resources.redisInstance) ? 'success' : 'already-absent',
                instance: request.resources.redisInstance,
                id: state?.containers?.redis?.id ?? null
            },
            processes: {
                status: success ? 'success' : 'failure',
                terminatedPids: result.terminatedPids,
                skippedPids,
                skippedProcesses,
                retainedRuntimeState: result.retainedRuntimeState === true
            },
            files,
            buildConsumer
        }
    };
}

async function bootstrapDedicatedRuntime(request)
{
    const temporal = temporalEnvironment();
    const runtimeRunId = resolveDedicatedRuntimeRunId(temporal.context);
    const localPublicContentFixtureSecret =
        deriveLocalPublicContentFixtureSecret(request, runtimeRunId);
    const buildEnvironment = await immutableBuildEnvironment(request);
    await assertNamespaceVacant(request);
    await mkdir(request.resources.fixtureRoot, { recursive: true, mode: 0o700 });
    await chmod(request.resources.fixtureRoot, 0o700);
    const state = {
        schema: 'fsusblog.browser-contract-default-provider-state.v1',
        phase: 'preparing',
        namespace: request.identity.namespace,
        preparation: request.preparation,
        runtimeRunId,
        runtime: null,
        containers: {
            postgres: { name: request.resources.databaseInstance, id: null, image: postgresImageReference },
            redis: { name: request.resources.redisInstance, id: null, image: redisImageReference }
        },
        sourceState: request.sourceState,
        buildIdentity: {
            receiptContentDigest: request.build?.receiptContentDigest ?? null
        }
    };
    await writePrivateJson(providerStateFile(request), state);
    const staticWebAssetsManifest = path.join(
        request.resources.fixtureRoot,
        'empty-staticwebassets.runtime.json');
    await writePrivateJson(staticWebAssetsManifest, {
        ContentRoots: [],
        Root: {
            Children: null,
            Asset: null,
            Patterns: null
        }
    });
    const env = { ...process.env };
    const inheritedBuildRoot = String(env.FSUSBLOG_PRODUCTION_BUILD_ROOT ?? '').trim();
    const consumerBuildRoot = path.join(request.resources.fixtureRoot, 'production-build');
    const consumerBuildEnvironment = {};
    if (path.isAbsolute(inheritedBuildRoot))
    {
        for (const [key, value] of Object.entries(env))
        {
            if (typeof value === 'string'
            && (value === inheritedBuildRoot || value.startsWith(`${inheritedBuildRoot}${path.sep}`)))
            {
                consumerBuildEnvironment[key] = `${consumerBuildRoot}${value.slice(inheritedBuildRoot.length)}`;
            }
        }
    }
    for (const key of [
        'FSUSBLOG_POSTGRES_PORT',
        'FSUSBLOG_REDIS_PORT',
        'FSUSBLOG_DEBUG_BACKEND_PORT',
        'FSUSBLOG_DEBUG_FRONTEND_PORT',
        'FSUSBLOG_RELEASE_PREVIEW_PORT',
        'FSUSBLOG_DEBUG_BACKEND_URL',
        'FSUSBLOG_DEBUG_FRONTEND_URL',
        'FSUSBLOG_RELEASE_PREVIEW_URL',
        'CORS_ALLOWED_HOSTS',
        'FSUSBLOG_POSTGRES_CONTAINER_NAME',
        'FSUSBLOG_REDIS_CONTAINER_NAME',
        'FSUSBLOG_PG_CONTAINER',
        'FSUSBLOG_REDIS_CONTAINER',
        'FSUSBLOG_DATA_ROOT',
        'FSUSBLOG_PRODUCTION_BUILD_ROOT',
        'FSUSBLOG_FRONTEND_DIST_ROOT',
        'FSUSBLOG_FRONTEND_CACHE_ROOT',
        'FSUSBLOG_WEB_ROOT',
        'FSUSBLOG_BACKEND_WEBROOT',
        'ASPNETCORE_WEBROOT',
        'ASPNETCORE_STATICWEBASSETS',
        'FSUSBLOG_RETENTION_WEBROOT_DIR',
        'PublicAot__SsrClientRoot',
        'PublicAot__SsrWorkerScript',
        'FSUSBLOG_TEST_SESSION',
        'FSUSBLOG_TEMPORAL_CONTEXT_FILE',
        'FSUSBLOG_TEMPORAL_CONTEXT_JSON',
        'FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET',
        'FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET'
    ])
    {
        delete env[key];
    }
    const consumerWebRoot = path.join(consumerBuildRoot, 'frontend', 'wwwroot');
    if (!consumerWebRoot.startsWith(`${consumerBuildRoot}${path.sep}`))
    {
        fail('dedicated acceptance runtime web root is outside its consumer build root');
    }
    Object.assign(env, {
        ...buildEnvironment,
        ...consumerBuildEnvironment,
        FSUSBLOG_TEST_NAMESPACE: request.identity.namespace,
        FSUSBLOG_TEST_RUN_ID: runtimeRunId,
        FSUSBLOG_PHYSICAL_BUNDLE_ID: 'browser-contract',
        FSUSBLOG_STEP_ID: 'browser-contract-fixture',
        FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID: request.preparation.id,
        FSUSBLOG_FIXTURE_ROOT: request.resources.fixtureRoot,
        FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT: path.dirname(request.resources.fixtureRoot),
        FSUSBLOG_PRODUCTION_BUILD_ROOT: consumerBuildRoot,
        FSUSBLOG_WEB_ROOT: consumerWebRoot,
        FSUSBLOG_BACKEND_WEBROOT: consumerWebRoot,
        ASPNETCORE_WEBROOT: consumerWebRoot,
        ASPNETCORE_STATICWEBASSETS: staticWebAssetsManifest,
        FSUSBLOG_RETENTION_WEBROOT_DIR: consumerWebRoot,
        FSUSBLOG_PUBLIC_AOT_SSR_CLIENT_ROOT: consumerWebRoot,
        FSUSBLOG_PUBLIC_AOT_SSR_WORKER_SCRIPT:
            './server/server-public-ssr.bundle.mjs',
        PublicAot__SsrClientRoot: consumerWebRoot,
        PublicAot__SsrWorkerScript: './server/server-public-ssr.bundle.mjs',
        FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'legacy-parallel',
        FSUSBLOG_PLAYWRIGHT_WORKERS: '1',
        FSUSBLOG_PLAYWRIGHT_SESSION_PREP_CONCURRENCY: '1',
        FSUSBLOG_TEST_SESSION_ISOLATION: '0',
        FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME: '1',
        FSUSBLOG_PUBLIC_AOT_BACKFILL_CONCURRENCY: '1',
        FSUSBLOG_PUBLIC_AOT_SSR_WORKER_COUNT: '1',
        FSUSBLOG_FORCE_BOOTSTRAP: '1',
        FSUSBLOG_PERSIST_AUTH_FIXTURES: '1',
        FSUSBLOG_TEST_BUSINESS_EPOCH_UTC: temporal.businessEpochUtc,
        FSUSBLOG_TEST_POSTGRES_TIMEZONE: temporal.postgresTimezone,
        FSUSBLOG_TEST_BACKEND_CULTURE: temporal.backendCulture,
        FSUSBLOG_TEST_NODE_TIMEZONE: temporal.nodeTimezone,
        FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET: localPublicContentFixtureSecret,
        TZ: temporal.nodeTimezone,
        FSUSBLOG_TEMPORAL_CONTEXT_JSON: JSON.stringify(temporal.context)
    });
    if (!String(env.GITHUB_WORKFLOW ?? '').trim())
    {
        delete env.GITHUB_RUN_ID;
        delete env.GITHUB_RUN_ATTEMPT;
        delete env.GITHUB_JOB;
    }
    await run('bash', [path.join(repoRoot, 'tools', 'bootstrap-acceptance-env.sh')], { env });
    const environment = await parseEnvFile(path.join(repoRoot, '.tmp', 'env', `${request.identity.namespace}.env`));
    if (environment.FSUSBLOG_TEST_NAMESPACE !== request.identity.namespace
    || environment.FSUSBLOG_POSTGRES_CONTAINER_NAME !== request.resources.databaseInstance
    || environment.FSUSBLOG_REDIS_CONTAINER_NAME !== request.resources.redisInstance)
    {
        fail('dedicated acceptance runtime ownership manifest mismatch');
    }
    const postgres = await inspectContainer(request.resources.databaseInstance);
    const redis = await inspectContainer(request.resources.redisInstance);
    assertOwnedContainer(postgres, request, null, runtimeRunId);
    assertOwnedContainer(redis, request, null, runtimeRunId);
    const runtime = {
        backendUrl: environment.FSUSBLOG_DEBUG_BACKEND_URL,
        frontendUrl: environment.FSUSBLOG_RELEASE_PREVIEW_URL || environment.FSUSBLOG_DEBUG_FRONTEND_URL,
        debugFrontendUrl: environment.FSUSBLOG_DEBUG_FRONTEND_URL,
        isolatedDatabase: true,
        testSessionHeader: false,
        temporalObservation: await fetch(
            `${environment.FSUSBLOG_DEBUG_BACKEND_URL}/__local/temporal-observation`,
            {
                headers: {
                    'X-Fsus-Local-Temporal-Fixture-Secret':
            localPublicContentFixtureSecret
                }
            }
        ).then(async (response) =>
        {
            if (!response.ok)
            {
                fail(`backend temporal observation failed HTTP ${response.status}`);
            }
            return response.json();
        })
    };
    for (const [label, value] of Object.entries(runtime))
    {
        if (label.endsWith('Url') && !/^http:\/\/127\.0\.0\.1:\d+$/u.test(String(value ?? '')))
        {
            fail(`dedicated acceptance runtime ${label} is invalid`);
        }
    }
    const preparedState = {
        ...state,
        phase: 'prepared',
        runtime,
        containers: { postgres, redis },
        preparedAt: new Date().toISOString()
    };
    await writePrivateJson(providerStateFile(request), preparedState);
    return preparedState;
}

async function publishedArticle(request)
{
    const state = await readPreparedProviderState(request);
    const prepareState = JSON.parse(await readFile(path.join(request.resources.fixtureRoot, 'prepare-state.json'), 'utf8'));
    const fixture = prepareState.producerOutputs?.['public-content']?.projection ?? {};
    if (!/^\d+$/u.test(fixture.articleId) || !/^\d+$/u.test(fixture.categoryId) || !fixture.articleTitle)
    {
        fail('dedicated public fixture is incomplete');
    }
    return {
        id: fixture.articleId,
        title: fixture.articleTitle,
        url: `${state.runtime.frontendUrl}/article/${fixture.articleId}`,
        category: {
            id: fixture.categoryId,
            name: process.env.FSUSBLOG_PLAYWRIGHT_CATEGORY_NAME || 'Acceptance Category'
        }
    };
}

async function sessionEntity(request, role)
{
    const state = await readPreparedProviderState(request);
    const authRoot = path.join(request.resources.fixtureRoot, 'auth');
    const auth = JSON.parse(await readFile(path.join(authRoot, 'auth-fixtures.json'), 'utf8'));
    const descriptor = auth[role];
    if (!Number.isInteger(Number(descriptor?.id)) || Number(descriptor.id) <= 0)
    {
        fail(`${role} auth fixture is invalid`);
    }
    const source = assertInside(authRoot, path.join(authRoot, String(descriptor.storageStateFile ?? '')), `${role} storage state`);
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || (sourceStat.mode & 0o777) !== 0o600)
    {
        fail(`${role} storage state is unsafe`);
    }
    const destinationName = `${role}.storage-state.json`;
    const destination = path.join(request.resources.fixtureRoot, destinationName);
    const temporary = `${destination}.next-${process.pid}-${randomUUID()}`;
    try
    {
        await copyFile(source, temporary);
        await chmod(temporary, 0o600);
        await rename(temporary, destination);
        await chmod(destination, 0o600);
    }
    catch (error)
    {
        await rm(temporary, { force: true }).catch(() =>
        {});
        throw error;
    }
    return {
        id: Number(descriptor.id),
        storageStateFile: destinationName,
        ...(role === 'user' ? { capabilities: { webAuthnRegistration: false } } : {}),
        runtime: state.runtime
    };
}

async function pendingComment(request)
{
    const state = await readPreparedProviderState(request);
    const article = await publishedArticle(request);
    const receipt = readFixtureReceipt(path.join(request.resources.fixtureRoot, 'fixture-receipt.json'), {
        requireVerified: true
    });
    if (receipt.executionIdentity?.namespace !== request.identity.namespace
        || receipt.executionIdentity?.runId !== state.runtimeRunId)
    {
        fail('canonical comment FixtureReceipt is stale or cross-run');
    }
    const producer = receipt.producerReceipts?.find((item) => item.producerId === 'comment-moderation');
    const pending = producer?.observations?.database?.entities?.filter((item) =>
        item?.kind === 'comment' && item?.fields?.semanticRole === 'pending') ?? [];
    if (producer?.producerId !== 'comment-moderation'
        || producer?.strategy !== 'transaction-fixture'
        || producer?.structuralOnly === true
        || pending.length !== 1
        || pending[0].owned !== true
        || !/^[1-9][0-9]*$/u.test(String(pending[0].id ?? ''))
        || String(pending[0].fields?.articleId ?? '') !== String(article.id)
        || pending[0].fields?.moderationStatus !== 'pending'
        || pending[0].fields?.publicVisible !== false
        || pending[0].fields?.queueMember !== true)
    {
        fail('canonical comment fixture pending projection is incomplete');
    }
    return {
        id: String(pending[0].id),
        articleId: article.id,
        url: `${state.runtime.frontendUrl}/article/${article.id}#comment-${pending[0].id}`
    };
}

/** Resolve scene inputs only from the current matrix and already verified official preparation. */
export async function resolvePublicShellLocaleSceneAuthority(request)
{
    const state = await readPreparedProviderState(request);
    const matrix = await createPublicShellLocaleMatrix(repoRoot);
    const scene = matrix.scenes.find((item) => item.id === request.sceneId);
    if (!scene || matrix.identity.sourceCommit !== request.sourceState?.commit
        || matrix.identity.worktreeFingerprint !== request.sourceState?.worktreeFingerprint)
    {
        fail('PublicShell scene is absent from the current matrix or source identity is stale');
    }
    const root = request.resources.fixtureRoot;
    const rawRefs = ['provider-state.json', 'contract-fixture.json', 'prepare-state.json', 'fixture-receipt.json']
        .map((name) =>
        {
            const loaded = readPrivateJson(path.join(root, name), { label: `PublicShell ${name}` });
            return { path: name, digest: loaded.contentDigest, document: loaded.document };
        });
    const manifest = rawRefs.find((item) => item.path === 'contract-fixture.json').document;
    const receipt = readFixtureReceipt(path.join(root, 'fixture-receipt.json'), { requireVerified: true });
    if (manifest.sealed !== true || manifest.schema !== 'fsusblog.browser-contract-fixture.v2'
        || !isDeepStrictEqual(manifest.identity, request.identity)
        || !isDeepStrictEqual(manifest.preparation, request.preparation)
        || !isDeepStrictEqual(manifest.sourceState, request.sourceState)
        || manifest.buildIdentity?.receiptContentDigest !== request.build?.receiptContentDigest
        || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(String(request.build?.receiptContentDigest ?? ''))
        || manifest.baseUrl !== state.runtime.frontendUrl || manifest.backendUrl !== state.runtime.backendUrl
        || manifest.transport?.testSessionHeader !== false
        || receipt.executionIdentity?.runId !== state.runtimeRunId
        || receipt.executionIdentity?.namespace !== request.identity.namespace
        || !isDeepStrictEqual(receipt.executionIdentity?.source, request.sourceState)
        || receipt.serviceIdentity?.databaseInstance !== request.resources.databaseInstance
        || receipt.serviceIdentity?.redisInstance !== request.resources.redisInstance
        || receipt.serviceIdentity?.redisNamespace !== request.resources.redisNamespace)
    {
        fail('PublicShell scene official fixture receipt/source/build/runtime owner mismatch');
    }
    for (const value of [state.runtime.frontendUrl, state.runtime.backendUrl])
    {
        if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u.test(value))
        {
            fail('PublicShell scene requires the dedicated canonical runtime URLs');
        }
    }
    const cookieRef = 'src/backend/Infrastructure/PublicAot/LocalePreferenceCookieService.cs';
    const cookieBytes = await readFile(path.join(repoRoot, cookieRef));
    const cookieNames = [...cookieBytes.toString('utf8').matchAll(/public const string CookieName = "([^"]+)";/gu)];
    const negotiation = matrix.negotiationCases.find((item) => item.id === scene.negotiationId);
    if (cookieNames.length !== 1 || !negotiation)
    {
        fail('PublicShell scene negotiation/cookie production authority is ambiguous');
    }
    if (negotiation.preferencePreparation !== null)
    {
        fail('PublicShell account/device preference requires verified login/refresh or explicit-auto cookie preparation');
    }
    return {
        scene,
        authority: {
            matrixDigest: matrix.contentDigest,
            runtimeRunId: state.runtimeRunId,
            runtime: { frontendUrl: state.runtime.frontendUrl, backendUrl: state.runtime.backendUrl },
            fixtureReceiptDigest: receipt.receiptDigest,
            inputs: {
                viewport: scene.viewport, javaScriptEnabled: scene.issue !== 2083,
                acceptLanguage: negotiation.header, cookie: negotiation.cookie,
                cookieName: cookieNames[0][1]
            },
            rawRefs: [
                ...rawRefs.map(({ path: refPath, digest }) => ({ path: refPath, digest })),
                { path: cookieRef, digest: `sha256:${createHash('sha256').update(cookieBytes).digest('hex')}` }
            ]
        }
    };
}

/** Build the local read request from already-verified fixture authority, not an observed response. */
export function publicShellLocalePublishedArtifactRequest(request, authority)
{
    let base;
    let selected;
    try
    {
        base = new URL(authority.runtime.backendUrl);
        selected = new URL(request.path, authority.runtime.frontendUrl);
    }
    catch
    {
        fail('published artifact read requires canonical owned runtime and route');
    }
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port
        || base.username || base.password || base.pathname !== '/' || base.search || base.hash
        || typeof request.path !== 'string' || !request.path.startsWith('/')
        || request.path !== selected.pathname || selected.origin !== authority.runtime.frontendUrl)
    {
        fail('published artifact read requires canonical owned runtime and route');
    }
    return {
        url: new URL('/__local/public-content-fixture/published-artifact', base).href,
        body: {
            namespace: request.identity.namespace, runtimeRunId: authority.runtimeRunId,
            sourceCommit: request.sourceState.commit, worktreeFingerprint: request.sourceState.worktreeFingerprint,
            buildDigest: request.build.receiptContentDigest, path: request.path, locale: request.locale
        },
        headers: {
            'Content-Type': 'application/json',
            'X-Fsus-Local-Public-Content-Fixture-Secret': deriveLocalPublicContentFixtureSecret(request, authority.runtimeRunId),
            'X-Fsus-Test-Namespace': request.identity.namespace,
            'X-Fsus-Test-Run-Id': authority.runtimeRunId
        }
    };
}

/** Check this local producer's exact embedded JSON bytes; never reserialize the digest input. */
export function validatePublicShellLocalePublishedArtifactResponse(bytes, selection, scene)
{
    if (!Buffer.isBuffer(bytes) || bytes.length > originalCaptureLimits.totalBytes)
    {
        fail('published artifact response exceeds original capture budget');
    }
    const raw = bytes.toString('utf8');
    const marker = ',"contentDigest":"';
    const boundary = raw.lastIndexOf(marker);
    if (!Buffer.from(raw).equals(bytes) || !raw.startsWith('{"observation":') || boundary < 15)
    {
        fail('published artifact response differs from producer encoding');
    }
    const embedded = raw.slice('{"observation":'.length, boundary);
    const digest = createHash('sha256').update(embedded).digest('hex');
    if (raw.slice(boundary) !== `${marker}${digest}"}`)
    {
        fail('published artifact response embedded digest mismatch');
    }
    const observation = JSON.parse(embedded);
    const owner = observation?.owner;
    if (observation?.schema !== 'fsusblog.public-content-published-artifact-observation.v1'
        || !owner || ['namespace', 'runtimeRunId', 'sourceCommit', 'worktreeFingerprint', 'buildDigest']
        .some((key) => owner[key] !== selection.body[key])
        || observation.route?.path !== selection.body.path || observation.route?.locale !== scene.locale
        || observation.route?.kind !== scene.route || selection.body.locale !== scene.locale
        || observation.publication?.source !== 'server-ssr'
        || !Number.isSafeInteger(observation.publication?.generation) || observation.publication.generation < 0
        || observation.originals?.length !== 1)
    {
        fail('published artifact response does not bind the selected current fixture');
    }
    const original = observation.originals[0];
    if (original?.role !== 'published-artifact' || original.encoding !== 'base64'
        || typeof original.content !== 'string' || !Number.isSafeInteger(original.bytes)
        || original.bytes <= 0 || original.bytes > originalCaptureLimits.totalBytes)
    {
        fail('published artifact original is unavailable');
    }
    const body = Buffer.from(original.content, 'base64');
    if (body.toString('base64') !== original.content || body.length !== original.bytes
        || createHash('sha256').update(body).digest('hex') !== original.sha256)
    {
        fail('published artifact original bytes mismatch');
    }
    return observation;
}

/** Retain the independent cache read privately; provider stdout carries only its byte ref. */
export async function readPublicShellLocalePublishedArtifact(request)
{
    const { scene, authority } = await resolvePublicShellLocaleSceneAuthority(request);
    if (scene.issue !== 2083 || scene.stage !== 'first-response')
    {
        fail('published artifact read requires a current first-response scene');
    }
    const selection = publicShellLocalePublishedArtifactRequest({ ...request, locale: scene.locale }, authority);
    const response = await fetch(selection.url, {
        method: 'POST', headers: selection.headers, body: JSON.stringify(selection.body), redirect: 'error'
    });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json'
        || response.headers.get('cache-control') !== 'private,no-store')
    {
        fail('published artifact local read was unavailable');
    }
    const chunks = [];
    let byteLength = 0;
    for await (const chunk of response.body)
    {
        byteLength += chunk.length;
        if (byteLength > originalCaptureLimits.totalBytes)
        {
            fail('published artifact response exceeds original capture budget');
        }
        chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, byteLength);
    validatePublicShellLocalePublishedArtifactResponse(bytes, selection, scene);
    const name = `published-artifact-${randomUUID()}.json`;
    const retained = retainPrivateJson(path.join(request.resources.fixtureRoot, name), bytes.toString('utf8'), {
        overwrite: false, label: 'published artifact original'
    });
    return {
        sceneId: scene.id, matrixDigest: authority.matrixDigest, runtimeRunId: authority.runtimeRunId,
        artifact: { path: name, digest: retained.contentDigest }
    };
}

export async function retryVerifiedCleanup(operation, {
    attempts = 4,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {})
{
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1)
    {
        try
        {
            return await operation();
        }
        catch (error)
        {
            lastError = error;
            if (attempt + 1 >= attempts)
            {
                throw error;
            }
            await delay(100 * (attempt + 1));
        }
    }
    throw lastError;
}

async function respond(request)
{
    switch (request.operation)
    {
        case 'resetContractNamespace': {
            if (request.phase === 'prepare')
            {
                const state = await bootstrapDedicatedRuntime(request);
                return { runtime: state.runtime, ownership: { containers: state.containers } };
            }
            if (request.phase === 'cleanup')
            {
                await closePublicShellLocaleSceneBindings(request.resources.fixtureRoot, request);
                return {
                    cleanup: await retryVerifiedCleanup(async () =>
                    {
                        const state = await readProviderStateOptional(request);
                        return await cleanupOwnedRuntime(request, state);
                    })
                };
            }
            fail('resetContractNamespace phase is invalid');
            break;
        }
        case 'createPublishedArticle':
            return { entity: await publishedArticle(request) };
        case 'createPendingComment':
            return { entity: await pendingComment(request) };
        case 'createUserSession':
            return { entity: await sessionEntity(request, 'user') };
        case 'createAdminSession':
            return { entity: await sessionEntity(request, 'admin') };
        case 'preparePublicShellLocaleScene': {
            const { scene, authority } = await resolvePublicShellLocaleSceneAuthority(request);
            return { entity: await preparePublicShellLocaleSceneBinding(request, scene, authority) };
        }
        case 'readPublicShellLocaleAuthority': {
            const { authority } = await resolvePublicShellLocaleSceneAuthority(request);
            return { entity: authority };
        }
        case 'readPublicShellLocalePublishedArtifact':
            return { entity: await readPublicShellLocalePublishedArtifact(request) };
        case 'transitionPublicShellLocaleScene': {
            const { authority } = await resolvePublicShellLocaleSceneAuthority(request);
            return { entity: await transitionPublicShellLocaleSceneBinding(request, authority) };
        }
        default:
            fail('fixture provider operation is unsupported');
    }
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain)
{
    try
    {
        const request = await readRequest();
        const payload = await respond(request);
        process.stdout.write(`${JSON.stringify({
            schema: responseSchema,
            operation: request.operation,
            status: 'ok',
            ...payload
        })}\n`);
    }
    catch (error)
    {
        process.stderr.write(`[browser-contract-provider] ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

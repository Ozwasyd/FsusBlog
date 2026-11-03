import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, promisify } from 'node:util';

import { readVerifiedSecurityCleanupReceipt } from './security-cleanup-barrier.mjs';

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
let activeDispatchSession = null;
export const repositoryRoot = path.resolve(moduleDirectory, '../..');
export const defaultCatalogPath = path.join(repositoryRoot, 'config/testing/runtime-scenario-catalog.json');

function stable(value)
{
    if (Array.isArray(value))
    {
        return value.map(stable);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

function digest(value)
{
    return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex');
}

function atomicJson(target, document)
{
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
    fs.renameSync(temporary, target);
}

function readCatalog(catalogPath = defaultCatalogPath)
{
    return JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
}

function runGit(argumentsList)
{
    return execFileAsync('git', argumentsList, { cwd: repositoryRoot, encoding: 'utf8' })
        .then(({ stdout }) => stdout.trim());
}

export async function resolveRuntimeScenarioIdentity(env = process.env)
{
    const commit = String(env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim()
        || await runGit(['rev-parse', 'HEAD']);
    const worktreeFingerprint = String(env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim()
        || digest(await runGit(['status', '--porcelain=v1', '--untracked-files=all']));
    const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? '').trim()
        || `direct-${commit.slice(0, 12)}-${process.pid}-${Date.now()}`;
    return { commit, worktreeFingerprint, runId };
}

export function validateRuntimeScenarioCatalog(catalog)
{
    const errors = [];
    if (catalog?.schema !== 'fsusblog.runtime-scenario-catalog.v1')
    {
        errors.push('catalog schema mismatch');
    }
    if (!Array.isArray(catalog?.scenarios) || catalog.scenarios.length === 0)
    {
        errors.push('catalog scenarios must be non-empty');
        return errors;
    }
    const ids = new Set();
    for (const scenario of catalog.scenarios)
    {
        if (!scenario.id || ids.has(scenario.id))
        {
            errors.push(`scenario id is missing or duplicated: ${scenario.id ?? '<missing>'}`);
        }
        ids.add(scenario.id);
        for (const required of [
            'phase',
            'executor',
            'identity',
            'fixture',
            'resetBarrier',
            'evidencePath'
        ])
        {
            if (!scenario[required])
            {
                errors.push(`${scenario.id ?? '<missing>'} is missing ${required}`);
            }
        }
        for (const requiredArray of ['requiredPreconditions', 'expectedAssertions', 'coverageIds'])
        {
            if (!Array.isArray(scenario[requiredArray]) || scenario[requiredArray].length === 0)
            {
                errors.push(`${scenario.id ?? '<missing>'} requires non-empty ${requiredArray}`);
            }
        }
        if (scenario.executor === 'resident' && (!scenario.module || !scenario.export))
        {
            errors.push(`${scenario.id} resident executor requires module and export`);
        }
        if (scenario.executor === 'retained-cli' && !scenario.command)
        {
            errors.push(`${scenario.id} retained-cli executor requires command`);
        }
    }
    const coverageIds = new Set(catalog.scenarios.flatMap(({ coverageIds }) => coverageIds ?? []));
    for (const negativeId of catalog.migrationBaseline?.negativeCapabilityIds ?? [])
    {
        if (!coverageIds.has(negativeId))
        {
            errors.push(`negative capability is absent from catalog: ${negativeId}`);
        }
    }
    if (catalog.migrationBaseline?.catalogScenarioCount !== catalog.scenarios.length)
    {
        errors.push(
            `catalog scenario count mismatch: expected=${catalog.migrationBaseline?.catalogScenarioCount}`
            + ` current=${catalog.scenarios.length}`
        );
    }
    const baselineScenarioIds = catalog.migrationBaseline?.scenarioIds ?? [];
    if (baselineScenarioIds.length !== catalog.migrationBaseline?.scenarioCount)
    {
        errors.push('migration baseline scenario IDs do not match baseline count');
    }
    for (const baselineId of baselineScenarioIds)
    {
        if (!ids.has(baselineId))
        {
            errors.push(`migration baseline scenario is absent from catalog: ${baselineId}`);
        }
    }
    for (const requiredId of [
        'resilience.post-notification-contract',
        'resilience.post-notification-live',
        'resilience.post-binary-smoke',
        'resilience.post-binary-contract'
    ])
    {
        if (!ids.has(requiredId))
        {
            errors.push(`required post-resilience recheck is missing: ${requiredId}`);
        }
    }
    return errors;
}

function serializeError(error)
{
    return {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack ?? null : null
    };
}

/** Original result evidence projection shared by grouped and atomic dispatch. */
export function writeRuntimeScenarioResultEvidence({ scenario, result, identity, evidenceRoot })
{
    const document = {
        schema: 'fsusblog.runtime-scenario-result-evidence.v1',
        source: { commit: identity.commit, worktreeFingerprint: identity.worktreeFingerprint },
        runId: identity.runId,
        phase: scenario.phase,
        scenario: {
            id: scenario.id, identity: scenario.identity, fixture: scenario.fixture,
            resetBarrier: scenario.resetBarrier,
            expectedAssertions: scenario.expectedAssertions, coverageIds: scenario.coverageIds
        },
        result
    };
    const file = path.join(evidenceRoot, scenario.evidencePath);
    atomicJson(file, document);
    return { file, document };
}

function waitForScenario(promise, signal)
{
    if (!signal)
    {
        return promise;
    }
    if (signal.aborted)
    {
        return Promise.reject(new Error(String(signal.reason ?? 'user-cancelled')));
    }
    return Promise.race([
        promise,
        new Promise((resolve, reject) =>
        {
            signal.addEventListener('abort', () =>
            {
                reject(new Error(String(signal.reason ?? 'user-cancelled')));
            }, { once: true });
        })
    ]);
}

function coverageSnapshot(scenarios)
{
    return {
        scenarioIds: scenarios.map(({ id }) => id),
        coverageIds: [...new Set(scenarios.flatMap(({ coverageIds }) => coverageIds))].sort(),
        negativeCapabilityIds: [...new Set(scenarios
            .flatMap(({ coverageIds }) => coverageIds)
            .filter((id) => /denied|attack|pollution/u.test(id)))].sort()
    };
}

export async function defaultResetBarrier({ barrier, scenario, identity })
{
    const startedAt = new Date().toISOString();
    const startedNs = process.hrtime.bigint();
    const cleanupReceipt = readVerifiedSecurityCleanupReceipt(
        process.env.FSUSBLOG_SECURITY_FIXTURE_CLEANUP_RECEIPT_FILE,
        digest
    );
    return {
        schema: 'fsusblog.runtime-scenario-reset-receipt.v1',
        barrier,
        scenarioId: scenario.id,
        status: 'pass',
        source: identity,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Number(process.hrtime.bigint() - startedNs) / 1e6,
        cleanupReceiptDigest: cleanupReceipt.contentDigest,
        identityBefore: null,
        identityAfter: null,
        pollutionDetected: false
    };
}

async function defaultLoadRunner(scenario)
{
    const moduleUrl = pathToFileURL(path.join(repositoryRoot, scenario.module)).href;
    const loaded = await import(moduleUrl);
    const runner = loaded[scenario.export];
    if (typeof runner !== 'function')
    {
        throw new Error(`${scenario.id} module does not export ${scenario.export}`);
    }
    return runner;
}

async function initializeSharedRuntime()
{
    const [aedsContract, authHelpers, httpHelpers, fixtureHelpers] = await Promise.all([
        import(pathToFileURL(path.join(repositoryRoot, 'tests/frontend/support/aeds-envelope.mjs')).href),
        import(pathToFileURL(path.join(repositoryRoot, 'tests/frontend/support/auth-helpers.mjs')).href),
        import(pathToFileURL(path.join(repositoryRoot, 'tests/frontend/support/http.mjs')).href),
        import(pathToFileURL(path.join(repositoryRoot, 'tests/frontend/support/public-fixtures.mjs')).href)
    ]);
    return { aedsContract, authHelpers, httpHelpers, fixtureHelpers };
}

function makeProgressDocument({ identity, phase, status, initialization, scenarios, results, resets, cancellation })
{
    const coverage = coverageSnapshot(scenarios);
    return {
        schema: 'fsusblog.runtime-scenario-host-evidence.v1',
        source: {
            commit: identity.commit,
            worktreeFingerprint: identity.worktreeFingerprint
        },
        runId: identity.runId,
        phase,
        status,
        correctness: {
            wallTimeGate: false,
            timeoutGate: false,
            failedScenarioIds: results.filter(({ status: resultStatus }) => resultStatus === 'failure')
                .map(({ scenarioId }) => scenarioId),
            cancelledScenarioIds: results.filter(({ status: resultStatus }) => resultStatus === 'cancelled')
                .map(({ scenarioId }) => scenarioId)
        },
        initialization,
        coverage,
        results,
        resetReceipts: resets,
        cancellation
    };
}

function applyScenarioEnvironment(scenario)
{
    const suffix = scenario.id.replaceAll(/[^A-Za-z0-9_.-]/gu, '-');
    const keys = ['FSUSBLOG_USER_USERNAME', 'FSUSBLOG_ADMIN_USERNAME', 'FSUSBLOG_DEVICE_FP'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    if (scenario.phase === 'security')
    {
        process.env.FSUSBLOG_USER_USERNAME = `${process.env.FSUSBLOG_USER_USERNAME || 'binaryuser'}-${suffix}`;
        process.env.FSUSBLOG_ADMIN_USERNAME = `${process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin'}-${suffix}`;
    }
    process.env.FSUSBLOG_DEVICE_FP = `${process.env.FSUSBLOG_DEVICE_FP || 'runtime-scenario-host'}-${suffix}`;
    return () =>
    {
        for (const key of keys)
        {
            if (previous[key] === undefined)
            {
                delete process.env[key];
            }
            else
            {
                process.env[key] = previous[key];
            }
        }
    };
}

/**
 * A resident service seam for atomic producers. Admission and reset belong to
 * the caller's canonical owners; this session never runs a grouped phase or a
 * hidden reset. Process-global scenario environment requires exclusive dispatch.
 */
export function createRuntimeScenarioDispatchSession({
    catalog = readCatalog(),
    identity,
    admitScenario,
    loadRunner = defaultLoadRunner,
    initializeRuntime = initializeSharedRuntime
} = {})
{
    const errors = validateRuntimeScenarioCatalog(catalog);
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    if (!identity || !/^[0-9a-f]{40}$/u.test(identity.commit)
        || !identity.worktreeFingerprint || !identity.runId
        || typeof admitScenario !== 'function')
    {
        throw new Error('dispatch requires explicit source/run identity and canonical admission');
    }
    // Keep the selected source stable even if a caller later mutates its input.
    const selectedCatalog = structuredClone(catalog);
    const source = Object.freeze({ ...identity });
    const attempts = new Map();
    let runtime;
    let active = false;
    let closed = false;
    const lease = Symbol('runtime-scenario-dispatch');
    const snapshot = () => Object.freeze([...attempts.values()]);

    return Object.freeze({
        identity: source,
        attempts: snapshot,
        writeResult({ scenarioId, evidenceRoot })
        {
            const scenario = selectedCatalog.scenarios.find((item) => item.id === scenarioId);
            const attempt = attempts.get(scenarioId);
            if (!attempt?.scenarioResult || typeof evidenceRoot !== 'string' || !evidenceRoot)
            {
                throw new Error('original result output requires a settled dispatched scenario and owned evidence root');
            }
            return writeRuntimeScenarioResultEvidence({ scenario, result: attempt.scenarioResult,
                identity: source, evidenceRoot });
        },
        close()
        {
            if (active)
            {
                throw new Error('cannot close a dispatch session with an active producer');
            }
            closed = true;
        },
        async dispatch({ scenarioId, attemptNumber, signal } = {})
        {
            if (closed || active || activeDispatchSession !== null)
            {
                throw new Error('resident dispatch requires an open exclusive host lease');
            }
            const scenario = selectedCatalog.scenarios.find((item) => item.id === scenarioId);
            if (!scenario || scenario.executor !== 'resident' || attemptNumber !== 1
                || attempts.has(scenarioId))
            {
                throw new Error('dispatch requires one catalog resident scenario and exact-one attempt');
            }
            active = true;
            activeDispatchSession = lease;
            let restoreEnvironment;
            const originalFetch = globalThis.fetch;
            let startedAt;
            let startedNs;
            const scenarioResult = (status, fields) => ({
                schema: 'fsusblog.runtime-scenario-result.v1', scenarioId: scenario.id, status,
                identity: scenario.identity, fixture: scenario.fixture,
                assertions: scenario.expectedAssertions, coverageIds: scenario.coverageIds,
                startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
                diagnostics: { durationMs: Number(process.hrtime.bigint() - startedNs) / 1e6,
                    timingAffectsCorrectness: false, ...(status === 'pass' ? { runner: fields ?? null } : {}) },
                ...(status === 'pass' ? {} : { error: serializeError(fields) })
            });
            try
            {
                signal?.throwIfAborted();
                // The full local ledger is always supplied. A failed attempt
                // cannot be hidden by an empty caller-provided failure list.
                if (await admitScenario({ scenario: structuredClone(scenario), identity: source,
                    attemptNumber, previousAttempts: snapshot(), signal }) !== scenario.id)
                {
                    throw new Error('canonical scenario admission rejected dispatch');
                }
                signal?.throwIfAborted();
                startedAt = new Date();
                startedNs = process.hrtime.bigint();
                attempts.set(scenarioId, Object.freeze({ scenarioId, attemptNumber, status: 'running' }));
                // A rejected initialization stays rejected; no implicit host restart.
                runtime ??= Promise.resolve().then(initializeRuntime);
                const sharedRuntime = await runtime;
                const runner = await loadRunner(scenario);
                if (typeof runner !== 'function')
                {
                    throw new Error(`${scenario.id} runner is unavailable`);
                }
                signal?.throwIfAborted();
                restoreEnvironment = applyScenarioEnvironment(scenario);
                if (signal && typeof originalFetch === 'function')
                {
                    globalThis.fetch = (input, init = {}) => originalFetch(input, {
                        ...init,
                        signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal
                    });
                }
                // Await actual settlement before restoring process globals or
                // releasing the lease, including when the signal is aborted.
                const result = await runner({ scenarioId: scenario.id, identity: scenario.identity,
                    fixture: scenario.fixture, signal,
                    shared: { ...sharedRuntime, fetch: globalThis.fetch, processId: process.pid, source } });
                signal?.throwIfAborted();
                attempts.set(scenarioId, Object.freeze({ scenarioId, attemptNumber, status: 'success', result,
                    scenarioResult: scenarioResult('pass', result) }));
                return result;
            }
            catch (error)
            {
                if (attempts.has(scenarioId))
                {
                    attempts.set(scenarioId, Object.freeze({ scenarioId, attemptNumber,
                        status: signal?.aborted ? 'cancelled' : 'failed', error,
                        scenarioResult: scenarioResult(signal?.aborted ? 'cancelled' : 'failure', error) }));
                }
                throw error;
            }
            finally
            {
                restoreEnvironment?.();
                globalThis.fetch = originalFetch;
                active = false;
                activeDispatchSession = null;
            }
        }
    });
}

export async function executeRuntimeScenarioHost({
    phase,
    catalog = readCatalog(),
    evidenceRoot,
    identity: suppliedIdentity,
    loadRunner = defaultLoadRunner,
    resetBarrier = defaultResetBarrier,
    signal,
    includeScenario = (scenario) => scenario.executor === 'resident',
    clock = () => new Date(),
    hrtime = () => process.hrtime.bigint()
} = {})
{
    const catalogErrors = validateRuntimeScenarioCatalog(catalog);
    if (catalogErrors.length > 0)
    {
        throw new Error(catalogErrors.join('; '));
    }
    if (!['integration', 'security', 'resilience'].includes(phase))
    {
        throw new Error(`unsupported runtime scenario phase: ${phase ?? '<missing>'}`);
    }
    const identity = suppliedIdentity ?? await resolveRuntimeScenarioIdentity();
    const scenarios = catalog.scenarios.filter((scenario) => scenario.phase === phase && includeScenario(scenario));
    if (scenarios.length === 0)
    {
        throw new Error(`phase ${phase} has no resident scenarios`);
    }
    const originalFetch = globalThis.fetch;
    if (signal && typeof originalFetch === 'function')
    {
        globalThis.fetch = (input, init = {}) =>
        {
            const signals = [signal, init.signal].filter(Boolean);
            return originalFetch(input, {
                ...init,
                signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0]
            });
        };
    }
    const sharedRuntime = await initializeSharedRuntime();
    const evidenceBase = evidenceRoot
        ?? process.env.FSUSBLOG_RUNTIME_SCENARIO_OUTPUT_ROOT
        ?? path.join(repositoryRoot, '.tmp/runtime-scenario-host', identity.runId);
    const outputRoot = path.join(evidenceBase, phase);
    const progressFile = path.join(outputRoot, 'partial.json');
    const summaryFile = path.join(outputRoot, 'summary.json');
    const hostStartedNs = hrtime();
    const hostCpuStart = process.cpuUsage();
    let connectionSetupCount = 0;
    const connectionChannel = diagnosticsChannel.channel('undici:client:connected');
    const observeConnection = () =>
    {
        connectionSetupCount += 1;
    };
    connectionChannel.subscribe(observeConnection);
    const initialization = {
        nodeProcessCount: 1,
        httpKeepAliveClientCount: 1,
        aedsContractInitializationCount: 1,
        urlConfigInitializationCount: 1,
        fixtureHelperInitializationCount: 1,
        metricsWriterInitializationCount: 1,
        processId: process.pid,
        moduleCacheScope: 'resident-host-process'
    };
    const results = [];
    const resets = [];
    const hostState = { activeIdentity: null, lastBarrier: null };
    let cancellation = null;
    let lastBarrier = null;

    const writeProgress = (status) =>
    {
        atomicJson(progressFile, makeProgressDocument({
            identity,
            phase,
            status,
            initialization,
            scenarios,
            results,
            resets,
            cancellation
        }));
    };
    const writeScenarioResult = (scenario, result) =>
    {
        return writeRuntimeScenarioResultEvidence({ scenario, result, identity, evidenceRoot: evidenceBase }).file;
    };
    writeProgress('running');

    for (const scenario of scenarios)
    {
        if (signal?.aborted)
        {
            cancellation = {
                requested: true,
                reason: String(signal.reason ?? 'user-cancelled'),
                observedAt: clock().toISOString()
            };
            results.push({
                scenarioId: scenario.id,
                status: 'cancelled',
                assertions: scenario.expectedAssertions,
                coverageIds: scenario.coverageIds,
                diagnostics: { durationMs: 0 }
            });
            writeScenarioResult(scenario, results.at(-1));
            continue;
        }
        if (scenario.resetBarrier !== lastBarrier)
        {
            const resetStarted = hrtime();
            let rejectedReceipt = null;
            try
            {
                if (hostState.activeIdentity !== null)
                {
                    throw new Error(
                        `identity leakage before ${scenario.resetBarrier}: ${hostState.activeIdentity}`
                    );
                }
                const receipt = await resetBarrier({
                    barrier: scenario.resetBarrier,
                    scenario,
                    identity,
                    hostState
                });
                if (receipt?.status !== 'pass' || receipt?.identityAfter != null || receipt?.pollutionDetected === true)
                {
                    rejectedReceipt = receipt;
                    throw new Error(`reset barrier ${scenario.resetBarrier} did not produce a clean pass receipt`);
                }
                resets.push({
                    ...receipt,
                    durationMs: receipt.durationMs ?? Number(hrtime() - resetStarted) / 1e6
                });
                lastBarrier = scenario.resetBarrier;
                hostState.lastBarrier = lastBarrier;
            }
            catch (error)
            {
                resets.push({
                    ...rejectedReceipt,
                    schema: 'fsusblog.runtime-scenario-reset-receipt.v1',
                    barrier: scenario.resetBarrier,
                    scenarioId: scenario.id,
                    status: 'failure',
                    source: identity,
                    durationMs: Number(hrtime() - resetStarted) / 1e6,
                    identityBefore: rejectedReceipt?.identityBefore ?? hostState.activeIdentity,
                    identityAfter: rejectedReceipt?.identityAfter ?? hostState.activeIdentity,
                    pollutionDetected: rejectedReceipt?.pollutionDetected === true
                        || hostState.activeIdentity !== null,
                    error: serializeError(error)
                });
                results.push({
                    scenarioId: scenario.id,
                    status: 'failure',
                    identity: scenario.identity,
                    fixture: scenario.fixture,
                    assertions: scenario.expectedAssertions,
                    coverageIds: scenario.coverageIds,
                    diagnostics: { durationMs: 0 },
                    error: serializeError(error)
                });
                writeScenarioResult(scenario, results.at(-1));
                writeProgress('running-with-failures');
                continue;
            }
        }

        const startedAt = clock();
        const startedNs = hrtime();
        hostState.activeIdentity = scenario.identity;
        const restoreEnvironment = applyScenarioEnvironment(scenario);
        const scenarioLogs = [];
        const originalConsole = Object.fromEntries(
            ['log', 'warn', 'error'].map((level) => [level, console[level]])
        );
        for (const level of Object.keys(originalConsole))
        {
            console[level] = (...argumentsList) =>
            {
                scenarioLogs.push({ level, message: format(...argumentsList) });
                originalConsole[level](...argumentsList);
            };
        }
        try
        {
            const runner = await loadRunner(scenario);
            const returned = await waitForScenario(Promise.resolve(runner({
                scenarioId: scenario.id,
                identity: scenario.identity,
                fixture: scenario.fixture,
                signal,
                shared: {
                    fetch: globalThis.fetch,
                    processId: process.pid,
                    source: identity,
                    ...sharedRuntime
                }
            })), signal);
            results.push({
                schema: 'fsusblog.runtime-scenario-result.v1',
                scenarioId: scenario.id,
                status: 'pass',
                identity: scenario.identity,
                fixture: scenario.fixture,
                assertions: scenario.expectedAssertions,
                coverageIds: scenario.coverageIds,
                startedAt: startedAt.toISOString(),
                finishedAt: clock().toISOString(),
                diagnostics: {
                    durationMs: Number(hrtime() - startedNs) / 1e6,
                    timingAffectsCorrectness: false,
                    logLineCount: scenarioLogs.length,
                    logDigest: digest(scenarioLogs),
                    runner: returned ?? null
                }
            });
        }
        catch (error)
        {
            results.push({
                schema: 'fsusblog.runtime-scenario-result.v1',
                scenarioId: scenario.id,
                status: signal?.aborted ? 'cancelled' : 'failure',
                identity: scenario.identity,
                fixture: scenario.fixture,
                assertions: scenario.expectedAssertions,
                coverageIds: scenario.coverageIds,
                startedAt: startedAt.toISOString(),
                finishedAt: clock().toISOString(),
                diagnostics: {
                    durationMs: Number(hrtime() - startedNs) / 1e6,
                    timingAffectsCorrectness: false,
                    logLineCount: scenarioLogs.length,
                    logDigest: digest(scenarioLogs)
                },
                error: serializeError(error)
            });
        }
        finally
        {
            for (const [level, logger] of Object.entries(originalConsole))
            {
                console[level] = logger;
            }
            restoreEnvironment();
            hostState.activeIdentity = null;
        }
        writeScenarioResult(scenario, results.at(-1));
        writeProgress('running');
    }

    const failed = results.some(({ status }) => status === 'failure');
    const cancelled = results.some(({ status }) => status === 'cancelled') || signal?.aborted;
    const status = cancelled ? 'cancelled' : failed ? 'failure' : 'success';
    const summary = makeProgressDocument({
        identity,
        phase,
        status,
        initialization,
        scenarios,
        results,
        resets,
        cancellation
    });
    const cpu = process.cpuUsage(hostCpuStart);
    summary.performance = {
        wallTimeMs: Number(hrtime() - hostStartedNs) / 1e6,
        cpuSeconds: (cpu.user + cpu.system) / 1e6,
        nodeProcessCount: 1,
        connectionSetupCount,
        machineFingerprint: digest({
            hostname: os.hostname(),
            platform: os.platform(),
            architecture: os.arch(),
            cpuModels: os.cpus().map(({ model }) => model),
            totalMemory: os.totalmem()
        }),
        affectsCorrectness: false
    };
    const baselineScenarios = catalog.migrationBaseline.scenarioIds
        .map((scenarioId) => catalog.scenarios.find(({ id }) => id === scenarioId));
    const baselineCoverageIds = [...new Set(
        baselineScenarios.flatMap(({ coverageIds }) => coverageIds)
    )].sort();
    const afterCoverageIds = [...new Set(
        catalog.scenarios.flatMap(({ coverageIds }) => coverageIds)
    )].sort();
    summary.migration = {
        before: {
            scenarioCount: catalog.migrationBaseline.scenarioCount,
            scenarioIds: catalog.migrationBaseline.scenarioIds,
            coverageIds: baselineCoverageIds,
            negativeCapabilityIds: catalog.migrationBaseline.negativeCapabilityIds
        },
        after: {
            scenarioCount: catalog.scenarios.length,
            scenarioIds: catalog.scenarios.map(({ id }) => id),
            coverageIds: afterCoverageIds,
            negativeCapabilityIds: afterCoverageIds.filter((id) => /denied|attack|pollution/u.test(id))
        },
        scenarioCountRegressed: catalog.scenarios.length < catalog.migrationBaseline.scenarioCount,
        coverageRegressed: baselineCoverageIds.some((id) => !afterCoverageIds.includes(id)),
        negativeCapabilityRegressed: catalog.migrationBaseline.negativeCapabilityIds
            .some((id) => !afterCoverageIds.includes(id))
    };
    if (status === 'success')
    {
        atomicJson(summaryFile, summary);
        fs.rmSync(progressFile, { force: true });
    }
    else
    {
        atomicJson(progressFile, summary);
        fs.rmSync(summaryFile, { force: true });
    }
    connectionChannel.unsubscribe(observeConnection);
    globalThis.fetch = originalFetch;
    return { summary, outputRoot, summaryFile, progressFile };
}

export { readCatalog };

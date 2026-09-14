#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { readRolloutState } from './release-rollout-lib.mjs';

const planSchema = 'fsusblog.release-worker-drill-plan.v1';
const ledgerSchema = 'fsusblog.release-worker-event-ledger.v1';
const requiredKinds = Object.freeze([
    'scheduled-publish',
    'article-mutation-outbox',
    'audit-writer',
    'visit-view-projection',
    'public-hot-aot',
    'upload-cleanup',
    'active-singleton-control',
    'multi-consumer-safe-control',
    'forced-source-recovery'
]);
const durableReplaySources = new Set([
    'postgres-outbox',
    'postgres-row-lock',
    'redis-stream',
    'durable-upload-session'
]);
const externalCommandAllowlist = new Set(['docker', 'psql']);
const builtInSqlTables = new Set([
    'article',
    'article_body',
    'article_mutation_outbox',
    'article_mutation_outbox_edge',
    'article_public_taxonomy_projection',
    'article_view_projection_watermark',
    'asset_library_item',
    'category_public_article_count',
    'sys_audit_log',
    'sys_visit_log',
    'tag_public_article_count'
]);
const requiredLedgerBindings = Object.freeze([
    'observedLogicalEventId',
    'observedKind',
    'attemptCount',
    'finalEffectCount',
    'finalEffectKey',
    'finalReleaseId',
    'finalGeneration',
    'staleGenerationCommitCount',
    'pendingLogicalEventId',
    'pendingCountAtDrain',
    'durableReplaySource'
]);
const optionalLedgerBindings = new Set([
    'expectedAuditCount',
    'actualAuditCount',
    'expectedProjectionCount',
    'actualProjectionCount',
    'sourceAttemptCount',
    'targetAttemptCount',
    'recoveredByTarget',
    'workerIdentity',
    'workerSlot'
]);
const sensitiveHeaders = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-fsus-admin-secret']);
const safeIdPattern = /^[0-9A-Za-z][0-9A-Za-z._:-]{1,127}$/u;
const safeLogicalEventIdPattern = /^[0-9A-Za-z][0-9A-Za-z._:-]{7,127}$/u;
const safeContainerPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const safeEnvironmentNamePattern = /^[A-Z][A-Z0-9_]{1,127}$/u;
const safeInputNamePattern = /^[a-z][A-Za-z0-9]{0,63}$/u;
const safeHeaderNamePattern = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,96}$/u;
const safeSqlIdentifierPattern = /^[a-z][a-z0-9_]{0,62}$/u;

export async function main(argv = process.argv.slice(2), environment = process.env)
{
    let options;
    try
    {
        options = parseArgs(argv, environment);
        const plan = readJson(options.plan);
        const rollout = readRolloutState(options.rolloutState);
        const inputResult = resolveInputs(plan.inputs, environment);
        const variables = buildVariables(options.runId, rollout, inputResult.values);
        const validation = validatePlan(plan, rollout, variables, environment);
        const validationErrors = [...inputResult.errors, ...validation.errors];
        if (validationErrors.length > 0)
        {
            throw new Error(`worker drill plan rejected:\n${validationErrors.map(error => `- ${error}`).join('\n')}`);
        }

        fs.mkdirSync(options.workDir, { recursive: true, mode: 0o700 });
        assertNoSymlinkTraversal(options.trustedRoot, options.workDir, 'work directory');
        assertWritablePath(options.workDir, options.out, 'ledger output');

        const ledger = await executeDrill({
            plan,
            rollout,
            variables,
            options,
            environment,
            events: validation.events
        });
        writeJsonExclusive(options.out, ledger);
        process.stdout.write(`${JSON.stringify(ledger)}\n`);
        return ledger.status === 'pass' ? 0 : 1;
    }
    catch (error)
    {
        process.stderr.write(`[release-worker-drill] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
}

async function executeDrill(context)
{
    const { plan, rollout, variables, options, environment, events } = context;
    const startedAtUtc = new Date().toISOString();
    const errors = [];
    const globalProbes = new Map();
    const eventStates = events.map(event => ({
        definition: event,
        logicalEventId: event.logicalEventId,
        variables: { ...variables },
        actions: [],
        probes: new Map(),
        errors: []
    }));

    const readiness = await pollProbe(
        { ...plan.target.readinessProbe, id: 'target-readiness' },
        variables,
        plan,
        options,
        environment);
    globalProbes.set('target-readiness', readiness);
    if (readiness.status !== 'pass')
    {
        errors.push(...readiness.errors.map(error => `target readiness: ${error}`));
    }

    if (readiness.status === 'pass')
    {
        for (const state of eventStates)
        {
            await executeEventBeforeTermination(state, plan, options, environment);
            errors.push(...state.errors.map(error => `${state.definition.kind}: ${error}`));
        }
    }
    else
    {
        for (const state of eventStates)
        {
            state.errors.push('actions skipped because target readiness was not proven');
        }
    }

    const identityErrors = resolveObservedEventIdentities(eventStates);
    errors.push(...identityErrors);
    for (const state of eventStates)
    {
        state.variables = withObservedEventVariables(state.variables, state);
    }
    const sourceTerminationPreconditionsPassed = readiness.status === 'pass'
    && errors.length === 0
    && eventStates.every(state => state.errors.length === 0);

    let coordination = {
        mode: plan.coordination.mode,
        status: 'skipped',
        armed: null,
        authorization: null,
        terminated: null,
        errors: ['source termination coordination skipped because one or more preconditions failed']
    };
    if (sourceTerminationPreconditionsPassed)
    {
        coordination = await coordinateSourceTermination(plan.coordination, rollout, options);
        if (coordination.status !== 'pass')
        {
            errors.push(...coordination.errors.map(error => `source termination coordination: ${error}`));
        }
    }

    let terminationBoundary = {
        status: 'skipped',
        targetReadiness: null,
        eventPendingChecks: [],
        observedAtUtc: null,
        errors: ['termination boundary was not revalidated because coordination did not pass']
    };
    if (coordination.status === 'pass')
    {
        terminationBoundary = await revalidateTerminationBoundary(eventStates, plan, options, environment, variables);
        if (terminationBoundary.status !== 'pass')
        {
            coordination.status = 'fail';
            coordination.errors.push(...terminationBoundary.errors);
            errors.push(...terminationBoundary.errors.map(error => `termination boundary: ${error}`));
        }
    }

    let sourceTermination = {
        type: plan.sourceTermination.type,
        status: 'skipped',
        forced: false,
        startedAtUtc: null,
        completedAtUtc: null,
        observation: null,
        errors: ['source termination skipped because one or more preconditions failed']
    };
    if (sourceTerminationPreconditionsPassed && coordination.status === 'pass')
    {
        sourceTermination = await terminateSource(plan.sourceTermination, plan, options, environment);
        if (sourceTermination.status !== 'pass')
        {
            errors.push(...sourceTermination.errors.map(error => `source termination: ${error}`));
        }
        if (sourceTermination.status === 'pass')
        {
            try
            {
                coordination = completeSourceTerminationCoordination(coordination, plan.coordination, rollout, options, sourceTermination);
            }
            catch (error)
            {
                const message = error instanceof Error ? error.message : String(error);
                coordination.status = 'fail';
                coordination.errors.push(message);
                errors.push(`source termination coordination: ${message}`);
            }
        }
    }
    else
    {
        errors.push(...sourceTermination.errors);
    }

    let takeover = skippedProbe('target-takeover', 'target takeover was not observed because source termination did not pass');
    if (sourceTermination.status === 'pass')
    {
        takeover = await pollProbe(
            { ...plan.target.takeoverProbe, id: 'target-takeover' },
            variables,
            plan,
            options,
            environment);
        if (takeover.status !== 'pass')
        {
            errors.push(...takeover.errors.map(error => `target takeover: ${error}`));
        }
    }
    globalProbes.set('target-takeover', takeover);

    if (sourceTermination.status === 'pass')
    {
        for (const state of eventStates)
        {
            state.variables = withObservedEventVariables(state.variables, state);
            await executeEventAfterTermination(state, plan, options, environment);
            errors.push(...state.errors
                .filter(error => !errors.includes(`${state.definition.kind}: ${error}`))
                .map(error => `${state.definition.kind}: ${error}`));
        }
    }
    else
    {
        for (const state of eventStates)
        {
            state.errors.push('final observations skipped because source termination was not proven');
        }
    }

    const ledgerEvents = [];
    for (const state of eventStates)
    {
        const result = materializeLedgerEvent(state, globalProbes, sourceTermination, takeover, rollout);
        ledgerEvents.push(result.event);
        errors.push(...result.errors.map(error => `${state.definition.kind}: ${error}`));
    }
    const effectKeys = new Set();
    for (const event of ledgerEvents)
    {
        if (typeof event.finalEffectKey !== 'string')
        {
            continue;
        }
        if (effectKeys.has(event.finalEffectKey))
        {
            errors.push(`${event.kind}: final effect key is shared by more than one logical event`);
        }
        effectKeys.add(event.finalEffectKey);
    }

    const uniqueErrors = unique(errors);
    return {
        schema: ledgerSchema,
        status: uniqueErrors.length === 0 ? 'pass' : 'fail',
        rolloutId: rollout.rolloutId,
        source: {
            releaseId: rollout.source.releaseId,
            slot: rollout.source.slot,
            generation: rollout.source.runtimeGeneration,
            container: plan.source.container ?? null
        },
        target: {
            releaseId: rollout.target.releaseId,
            slot: rollout.target.slot,
            generation: rollout.target.runtimeGeneration,
            container: plan.target.container ?? null
        },
        drill: {
            schema: planSchema,
            runId: options.runId,
            startedAtUtc,
            completedAtUtc: new Date().toISOString(),
            sourceTermination,
            coordination,
            terminationBoundary,
            targetReadiness: readiness,
            targetTakeover: takeover,
            externalCommandAllowlist: [...externalCommandAllowlist]
        },
        events: ledgerEvents,
        errors: uniqueErrors
    };
}

async function revalidateTerminationBoundary(eventStates, plan, options, environment, variables)
{
    const errors = [];
    const targetReadiness = await pollProbe(
        { ...plan.target.readinessProbe, id: 'target-readiness-at-termination' },
        variables,
        plan,
        options,
        environment);
    if (targetReadiness.status !== 'pass')
    {
        errors.push(...targetReadiness.errors.map(error => `target readiness: ${error}`));
    }
    const eventPendingChecks = [];
    for (const state of eventStates)
    {
        for (const definition of state.definition.beforeTermination)
        {
            const boundaryDefinition = { ...definition, id: `${definition.id}-at-termination` };
            const result = await pollProbe(boundaryDefinition, state.variables, plan, options, environment);
            eventPendingChecks.push({ kind: state.definition.kind, probe: definition.id, result });
            if (result.status !== 'pass')
            {
                errors.push(...result.errors.map(error => `${state.definition.kind}/${definition.id}: ${error}`));
            }
            const previous = state.probes.get(definition.id);
            state.probes.set(definition.id, {
                ...result,
                id: definition.id,
                initialObservation: previous,
                terminationBoundaryRevalidated: true
            });
        }
    }
    return {
        status: errors.length === 0 ? 'pass' : 'fail',
        targetReadiness,
        eventPendingChecks,
        observedAtUtc: new Date().toISOString(),
        errors
    };
}

async function coordinateSourceTermination(definition, rollout, options)
{
    if (definition.mode === 'immediate-destructive')
    {
        return {
            mode: definition.mode,
            status: 'pass',
            armed: null,
            authorization: { mode: 'explicit-immediate-destructive', observedAtUtc: new Date().toISOString() },
            terminated: null,
            errors: []
        };
    }
    const armedFile = resolveInside(options.workDir, definition.armedFile, 'coordination armed file');
    const authorizeFile = resolveInside(options.workDir, definition.authorizeFile, 'coordination authorization file');
    const terminatedFile = resolveInside(options.workDir, definition.terminatedFile, 'coordination terminated file');
    for (const file of [armedFile, authorizeFile, terminatedFile])
    {
        assertWritablePath(options.workDir, file, 'coordination file');
    }
    fs.rmSync(armedFile, { force: true });
    fs.rmSync(terminatedFile, { force: true });
    const armed = {
        schema: 'fsusblog.release-worker-drill-signal.v1',
        rolloutId: rollout.rolloutId,
        runId: options.runId,
        stage: 'armed',
        observedAtUtc: new Date().toISOString()
    };
    writeJsonAtomic(armedFile, armed);
    const timeoutMs = boundedInteger(definition.timeoutMs ?? 300_000, 1_000, 900_000, 'coordination.timeoutMs');
    const pollMs = boundedInteger(definition.pollMs ?? 250, 100, 10_000, 'coordination.pollMs');
    const deadline = Date.now() + timeoutMs;
    const attempts = [];
    do
    {
        const attemptedAtUtc = new Date().toISOString();
        try
        {
            const currentAuthorizeFile = resolveReadableDrillFile(options.workDir, definition.authorizeFile, 'coordination authorization file');
            const signal = readJson(currentAuthorizeFile);
            const signalErrors = validateCoordinationSignal(signal, rollout.rolloutId, options.runId, 'terminate-source');
            attempts.push({ attemptedAtUtc, status: signalErrors.length === 0 ? 'pass' : 'ignored', errors: signalErrors });
            if (signalErrors.length === 0)
            {
                return {
                    mode: definition.mode,
                    status: 'pass',
                    armed: { file: armedFile, signal: armed },
                    authorization: { file: authorizeFile, signal, attempts },
                    terminated: null,
                    errors: []
                };
            }
        }
        catch (error)
        {
            const code = error?.code;
            attempts.push({ attemptedAtUtc, status: 'waiting', errors: code === 'ENOENT' ? [] : [error instanceof Error ? error.message : String(error)] });
        }
        await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    return {
        mode: definition.mode,
        status: 'fail',
        armed: { file: armedFile, signal: armed },
        authorization: { file: authorizeFile, signal: null, attempts },
        terminated: null,
        errors: ['timed out waiting for the exact terminate-source authorization signal']
    };
}

function completeSourceTerminationCoordination(coordination, definition, rollout, options, sourceTermination)
{
    if (definition.mode === 'immediate-destructive')
    {
        return coordination;
    }
    const terminatedFile = resolveInside(options.workDir, definition.terminatedFile, 'coordination terminated file');
    const signal = {
        schema: 'fsusblog.release-worker-drill-signal.v1',
        rolloutId: rollout.rolloutId,
        runId: options.runId,
        stage: 'source-terminated',
        forced: sourceTermination.forced === true,
        observedAtUtc: new Date().toISOString()
    };
    writeJsonAtomic(terminatedFile, signal);
    return { ...coordination, terminated: { file: terminatedFile, signal } };
}

function validateCoordinationSignal(signal, rolloutId, runId, stage)
{
    const errors = [];
    if (signal?.schema !== 'fsusblog.release-worker-drill-signal.v1')
    {
        errors.push('signal schema mismatch');
    }
    if (signal?.rolloutId !== rolloutId)
    {
        errors.push('signal rolloutId mismatch');
    }
    if (signal?.runId !== runId)
    {
        errors.push('signal runId mismatch');
    }
    if (signal?.stage !== stage)
    {
        errors.push(`signal stage must be ${stage}`);
    }
    const observed = Date.parse(signal?.observedAtUtc ?? '');
    if (!Number.isFinite(observed) || Math.abs(Date.now() - observed) > 15 * 60_000)
    {
        errors.push('signal timestamp is missing or stale');
    }
    return errors;
}

async function executeEventBeforeTermination(state, plan, options, environment)
{
    const prepare = await runActionList(state.definition.prepare, state.variables, plan, options, environment, 'prepare');
    state.actions.push(...prepare.receipts);
    state.errors.push(...prepare.errors);

    if (prepare.errors.length === 0)
    {
        const trigger = await runActionList(state.definition.trigger, state.variables, plan, options, environment, 'trigger');
        state.actions.push(...trigger.receipts);
        state.errors.push(...trigger.errors);
    }
    else
    {
        state.errors.push('trigger skipped because prepare actions failed');
    }

    for (const definition of state.definition.beforeTermination)
    {
        const result = await pollProbe(definition, state.variables, plan, options, environment);
        state.probes.set(definition.id, result);
        if (result.status !== 'pass')
        {
            state.errors.push(...result.errors.map(error => `${definition.id}: ${error}`));
        }
    }
}

async function executeEventAfterTermination(state, plan, options, environment)
{
    const after = await runActionList(state.definition.afterTermination, state.variables, plan, options, environment, 'after-termination');
    state.actions.push(...after.receipts);
    state.errors.push(...after.errors);
    for (const definition of state.definition.observations)
    {
        const result = await pollProbe(definition, state.variables, plan, options, environment);
        state.probes.set(definition.id, result);
        if (result.status !== 'pass')
        {
            state.errors.push(...result.errors.map(error => `${definition.id}: ${error}`));
        }
    }
}

async function runActionList(actions, variables, plan, options, environment, phase)
{
    const receipts = [];
    const errors = [];
    for (const action of actions)
    {
        const startedAtUtc = new Date().toISOString();
        try
        {
            const observation = await executeAction(action, variables, plan, options, environment);
            receipts.push({
                id: action.id,
                type: action.type,
                phase,
                status: 'pass',
                startedAtUtc,
                completedAtUtc: new Date().toISOString(),
                observation,
                errors: []
            });
        }
        catch (error)
        {
            const message = error instanceof Error ? error.message : String(error);
            receipts.push({
                id: action.id,
                type: action.type,
                phase,
                status: 'fail',
                startedAtUtc,
                completedAtUtc: new Date().toISOString(),
                observation: null,
                errors: [message]
            });
            errors.push(`${phase} action ${action.id}: ${message}`);
        }
    }
    return { receipts, errors };
}

async function executeAction(action, variables, plan, options, environment)
{
    if (action.type === 'sql-exec')
    {
        const sql = compileSqlTemplate(action.sql, variables);
        validateWriteSqlOrThrow(sql.text, new Set(plan.security.allowedWriteTables), `action ${action.id}`);
        const observation = runPsqlJson(sql, plan.database, environment, false);
        assertObservation(observation, action.assertions, variables, `action ${action.id}`);
        return observation;
    }
    if (action.type === 'http-request')
    {
        const observation = await runHttpJson(action, variables, plan.security.allowedHttpOrigins, environment);
        assertObservation(observation, action.assertions ?? [], variables, `action ${action.id}`);
        return observation;
    }
    throw new Error(`unsupported action type: ${action.type}`);
}

async function pollProbe(definition, variables, plan, options, environment)
{
    const startedAtUtc = new Date().toISOString();
    const attempts = [];
    const timeoutMs = boundedInteger(definition.timeoutMs ?? 60_000, 1_000, 900_000, `${definition.id}.timeoutMs`);
    const pollMs = boundedInteger(definition.pollMs ?? 500, 100, 30_000, `${definition.id}.pollMs`);
    const deadline = Date.now() + timeoutMs;
    let lastError = 'probe did not run';
    do
    {
        const attemptedAtUtc = new Date().toISOString();
        try
        {
            const observation = await executeProbe(definition, variables, plan, options, environment);
            assertObservation(observation, definition.assertions, variables, `probe ${definition.id}`);
            attempts.push({ attemptedAtUtc, status: 'pass', observation, error: null });
            return {
                id: definition.id,
                type: definition.type,
                status: 'pass',
                startedAtUtc,
                completedAtUtc: new Date().toISOString(),
                attempts,
                observation,
                errors: []
            };
        }
        catch (error)
        {
            lastError = error instanceof Error ? error.message : String(error);
            attempts.push({ attemptedAtUtc, status: 'fail', observation: null, error: lastError });
        }
        if (Date.now() < deadline)
        {
            await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
        }
    } while (Date.now() < deadline);
    return {
        id: definition.id,
        type: definition.type,
        status: 'fail',
        startedAtUtc,
        completedAtUtc: new Date().toISOString(),
        attempts,
        observation: null,
        errors: [lastError]
    };
}

async function executeProbe(definition, variables, plan, options, environment)
{
    if (definition.type === 'sql-json')
    {
        const sql = compileSqlTemplate(definition.sql, variables);
        validateReadSqlOrThrow(sql.text, new Set(plan.security.allowedReadTables), `probe ${definition.id}`);
        return runPsqlJson(sql, plan.database, environment, true);
    }
    if (definition.type === 'http-json')
    {
        return await runHttpJson(definition, variables, plan.security.allowedHttpOrigins, environment);
    }
    if (definition.type === 'docker-inspect-json')
    {
        const container = safeContainer(renderTemplate(definition.container, variables));
        if (![plan.source.container, plan.target.container].includes(container))
        {
            throw new Error('docker probe container is outside the source/target boundary');
        }
        return dockerInspect(container, definition.timeoutMs ?? 10_000, environment);
    }
    if (definition.type === 'process-status-json')
    {
        return inspectProcess(definition.process, variables, options);
    }
    throw new Error(`unsupported probe type: ${definition.type}`);
}

async function terminateSource(definition, plan, options, environment)
{
    const startedAtUtc = new Date().toISOString();
    try
    {
        let observation;
        if (definition.type === 'docker-kill')
        {
            const container = safeContainer(definition.container);
            if (container !== plan.source.container)
            {
                throw new Error('source termination container does not match source.container');
            }
            const before = dockerInspect(container, definition.timeoutMs ?? 15_000, environment);
            if (before.running !== true)
            {
                throw new Error('source container was not running before forced termination');
            }
            const result = runExternal('docker', ['kill', '--signal', 'SIGKILL', container], {
                environment,
                timeoutMs: definition.timeoutMs ?? 15_000
            });
            if (result.stdout.trim() !== container)
            {
                throw new Error('docker kill did not acknowledge the exact source container');
            }
            const after = await waitForContainerStopped(container, definition.timeoutMs ?? 30_000, environment);
            observation = { container, signal: 'SIGKILL', before, command: result, after };
        }
        else if (definition.type === 'process-signal')
        {
            observation = await terminateBoundProcess(definition, options);
        }
        else
        {
            throw new Error(`unsupported source termination type: ${definition.type}`);
        }
        return {
            type: definition.type,
            status: 'pass',
            forced: true,
            startedAtUtc,
            completedAtUtc: new Date().toISOString(),
            observation,
            errors: []
        };
    }
    catch (error)
    {
        return {
            type: definition.type,
            status: 'fail',
            forced: false,
            startedAtUtc,
            completedAtUtc: new Date().toISOString(),
            observation: null,
            errors: [error instanceof Error ? error.message : String(error)]
        };
    }
}

async function terminateBoundProcess(definition, options)
{
    const pidFile = resolveReadableDrillFile(options.workDir, definition.pidFile, 'source pid file');
    const pid = readPid(pidFile);
    const commandLine = readProcessCommandLine(pid);
    if (!commandLine.includes(definition.commandContains))
    {
        throw new Error('source pid command line did not match commandContains');
    }
    process.kill(pid, 'SIGKILL');
    const deadline = Date.now() + boundedInteger(definition.timeoutMs ?? 30_000, 1_000, 120_000, 'sourceTermination.timeoutMs');
    while (isProcessAlive(pid) && Date.now() < deadline)
    {
        await delay(100);
    }
    if (isProcessAlive(pid))
    {
        throw new Error('source process remained alive after SIGKILL');
    }
    return { pid, signal: 'SIGKILL', commandLineSha256: sha256(commandLine), exited: true };
}

function materializeLedgerEvent(state, globalProbes, sourceTermination, takeover, rollout)
{
    const errors = [];
    const event = {
        logicalEventId: state.logicalEventId ?? null,
        kind: state.definition.kind
    };
    const provenance = {};
    for (const [field, binding] of Object.entries(state.definition.ledger))
    {
        const result = globalProbes.get(binding.probe) ?? state.probes.get(binding.probe);
        if (!result || result.status !== 'pass' || result.observation === null)
        {
            event[field] = null;
            errors.push(`${field} has no passing observation from ${binding.probe}`);
            continue;
        }
        const pointer = readJsonPointer(result.observation, binding.pointer);
        if (!pointer.found)
        {
            event[field] = null;
            errors.push(`${field} pointer ${binding.pointer} was missing from ${binding.probe}`);
            continue;
        }
        if (!matchesType(pointer.value, binding.type))
        {
            event[field] = null;
            errors.push(`${field} from ${binding.probe}${binding.pointer} was not ${binding.type}`);
            continue;
        }
        event[field] = pointer.value;
        provenance[field] = {
            probe: binding.probe,
            pointer: binding.pointer,
            observedAtUtc: result.completedAtUtc,
            valueSha256: sha256(JSON.stringify(pointer.value))
        };
    }

    if (event.observedLogicalEventId !== state.logicalEventId)
    {
        errors.push('observed logical event id does not match the bound event identity');
    }
    if (event.observedKind !== state.definition.kind)
    {
        errors.push('observed event kind does not match the planned worker kind');
    }
    if (!Number.isSafeInteger(event.attemptCount) || event.attemptCount < 1)
    {
        errors.push('attempt count must be a positive observed integer');
    }
    if (event.finalEffectCount !== 1)
    {
        errors.push('exactly one durable final effect must be observed');
    }
    if (typeof event.finalEffectKey !== 'string' || !safeLogicalEventIdPattern.test(event.finalEffectKey))
    {
        errors.push('final effect key must be a bounded durable identity');
    }
    if (event.finalReleaseId !== rollout.target.releaseId)
    {
        errors.push('final release identity is not the target release');
    }
    if (event.finalGeneration !== rollout.target.runtimeGeneration)
    {
        errors.push('final generation is not the target generation');
    }
    if (event.staleGenerationCommitCount !== 0)
    {
        errors.push('one or more stale-generation commits were observed');
    }
    if (event.pendingLogicalEventId !== state.logicalEventId)
    {
        errors.push('pending work identity at the termination boundary does not match the logical event');
    }
    if (!Number.isSafeInteger(event.pendingCountAtDrain) || event.pendingCountAtDrain < 1)
    {
        errors.push('durable pending work was not observed at the termination boundary');
    }
    if (!durableReplaySources.has(event.durableReplaySource))
    {
        errors.push('durable replay source is unsupported or missing');
    }
    if (state.definition.kind === 'audit-writer'
    && (!Number.isSafeInteger(event.expectedAuditCount)
      || event.expectedAuditCount < 1
      || event.actualAuditCount !== event.expectedAuditCount))
    {
        errors.push('audit writer expected/actual durable counts do not reconcile');
    }
    if (state.definition.kind === 'visit-view-projection'
    && (!Number.isSafeInteger(event.expectedProjectionCount)
      || event.expectedProjectionCount < 1
      || event.actualProjectionCount !== event.expectedProjectionCount))
    {
        errors.push('visit/view expected/actual projection counts do not reconcile');
    }
    if (state.definition.kind === 'forced-source-recovery')
    {
        event.forcedSourceTermination = sourceTermination.status === 'pass' && sourceTermination.forced === true;
        event.recoveredByTarget = event.recoveredByTarget === true && takeover.status === 'pass';
        if (!event.recoveredByTarget)
        {
            errors.push('forced source work was not recovered by the target');
        }
    }
    event.observationBindings = provenance;
    event.actions = state.actions;
    event.observations = Object.fromEntries(state.probes);
    event.errors = unique([...state.errors, ...errors]);
    return { event, errors: event.errors };
}

function resolveObservedEventIdentities(states)
{
    const errors = [];
    const identities = new Set();
    for (const state of states)
    {
        if (state.definition.identity.mode === 'observed')
        {
            const result = state.probes.get(state.definition.identity.probe);
            const pointer = result?.status === 'pass'
                ? readJsonPointer(result.observation, state.definition.identity.pointer)
                : { found: false };
            if (!pointer.found || typeof pointer.value !== 'string')
            {
                state.errors.push('observed logical event identity was unavailable');
                errors.push(`${state.definition.kind}: observed logical event identity was unavailable`);
                continue;
            }
            state.logicalEventId = pointer.value;
        }
        if (!safeLogicalEventIdPattern.test(state.logicalEventId ?? ''))
        {
            state.errors.push(`logical event id is invalid: ${state.logicalEventId ?? '<missing>'}`);
            errors.push(`${state.definition.kind}: logical event id is invalid`);
            continue;
        }
        if (identities.has(state.logicalEventId))
        {
            state.errors.push(`logical event id is duplicated: ${state.logicalEventId}`);
            errors.push(`${state.definition.kind}: logical event id is duplicated`);
            continue;
        }
        identities.add(state.logicalEventId);
    }
    return errors;
}

function withObservedEventVariables(variables, state)
{
    return {
        ...variables,
        logicalEventId: state.logicalEventId,
        [`event.${state.definition.kind}.logicalEventId`]: state.logicalEventId
    };
}

export function validatePlan(plan, rollout, variables, environment)
{
    const errors = [];
    const events = [];
    if (!isObject(plan))
    {
        return { errors: ['plan must be a JSON object'], events };
    }
    if (plan.schema !== planSchema)
    {
        errors.push(`schema must be ${planSchema}`);
    }
    if (plan.rolloutId !== rollout.rolloutId)
    {
        errors.push('rolloutId does not match rollout state');
    }
    validateDatabase(plan.database, environment, errors);
    validateSecurity(plan.security, errors);
    validateSourceAndTarget(plan, rollout, variables, errors, environment);
    validateSourceTermination(plan.sourceTermination, plan.source, errors);
    validateCoordination(plan.coordination, errors);

    if (!Array.isArray(plan.events))
    {
        errors.push('events must be an array');
        return { errors, events };
    }
    const kinds = new Set();
    const generatedIdentities = new Set();
    for (let index = 0; index < plan.events.length; index++)
    {
        const definition = plan.events[index];
        const prefix = `events[${index}]`;
        if (!isObject(definition))
        {
            errors.push(`${prefix} must be an object`);
            continue;
        }
        if (!requiredKinds.includes(definition.kind))
        {
            errors.push(`${prefix}.kind is unsupported: ${definition.kind ?? '<missing>'}`);
        }
        if (kinds.has(definition.kind))
        {
            errors.push(`${prefix}.kind is duplicated: ${definition.kind}`);
        }
        kinds.add(definition.kind);
        const normalized = validateEvent(definition, prefix, plan, variables, errors, environment);
        if (normalized)
        {
            if (normalized.logicalEventId && generatedIdentities.has(normalized.logicalEventId))
            {
                errors.push(`${prefix} generated a duplicate logical event id`);
            }
            if (normalized.logicalEventId)
            {
                generatedIdentities.add(normalized.logicalEventId);
            }
            events.push(normalized);
        }
    }
    for (const kind of requiredKinds)
    {
        if (!kinds.has(kind))
        {
            errors.push(`required worker kind is missing: ${kind}`);
        }
    }
    if (plan.events.length !== requiredKinds.length)
    {
        errors.push(`events must contain exactly ${requiredKinds.length} definitions`);
    }
    return { errors, events };
}

function validateCoordination(definition, errors)
{
    if (!isObject(definition))
    {
        errors.push('coordination is required');
        return;
    }
    if (definition.mode === 'immediate-destructive')
    {
        if (definition.explicitlyAuthorized !== true)
        {
            errors.push('immediate-destructive coordination requires explicitlyAuthorized=true');
        }
        return;
    }
    if (definition.mode !== 'file-handshake')
    {
        errors.push('coordination.mode must be file-handshake or immediate-destructive');
        return;
    }
    const paths = [];
    for (const key of ['armedFile', 'authorizeFile', 'terminatedFile'])
    {
        const value = definition[key];
        if (!isSafeRelativeDrillFile(value))
        {
            errors.push(`coordination.${key} must be a relative work-directory path`);
        }
        else
        {
            paths.push(value);
        }
    }
    if (new Set(paths).size !== paths.length)
    {
        errors.push('coordination signal paths must be distinct');
    }
    try
    {
        boundedInteger(definition.timeoutMs ?? 300_000, 1_000, 900_000, 'coordination.timeoutMs');
        boundedInteger(definition.pollMs ?? 250, 100, 10_000, 'coordination.pollMs');
    }
    catch (error)
    {
        errors.push(error.message);
    }
}

function validateEvent(definition, prefix, plan, variables, errors, environment)
{
    const identity = definition.identity;
    let logicalEventId = null;
    if (!isObject(identity) || !['generated', 'observed'].includes(identity.mode))
    {
        errors.push(`${prefix}.identity.mode must be generated or observed`);
    }
    else if (identity.mode === 'generated')
    {
        if (typeof identity.template !== 'string')
        {
            errors.push(`${prefix}.identity.template is required`);
        }
        else
        {
            try
            {
                logicalEventId = renderTemplate(identity.template, variables);
                if (!safeLogicalEventIdPattern.test(logicalEventId))
                {
                    errors.push(`${prefix}.identity.template produced an invalid logical event id`);
                }
            }
            catch (error)
            {
                errors.push(`${prefix}.identity.template: ${error.message}`);
            }
        }
    }
    else
    {
        if (!safeIdPattern.test(identity.probe ?? ''))
        {
            errors.push(`${prefix}.identity.probe is invalid`);
        }
        if (!validJsonPointer(identity.pointer))
        {
            errors.push(`${prefix}.identity.pointer is invalid`);
        }
    }

    const plannedVariables = {
        ...variables,
        logicalEventId: logicalEventId ?? `observed-${definition.kind}-pending`,
        [`event.${definition.kind}.logicalEventId`]: logicalEventId ?? `observed-${definition.kind}-pending`
    };
    const prepare = validateActions(definition.prepare, `${prefix}.prepare`, plan, plannedVariables, errors, environment);
    const trigger = validateActions(definition.trigger, `${prefix}.trigger`, plan, plannedVariables, errors, environment);
    const afterTermination = validateActions(definition.afterTermination ?? [], `${prefix}.afterTermination`, plan, plannedVariables, errors, environment);
    const beforeTermination = validateProbes(definition.beforeTermination, `${prefix}.beforeTermination`, plan, plannedVariables, errors, environment);
    const observations = validateProbes(definition.observations, `${prefix}.observations`, plan, plannedVariables, errors, environment);
    const probeIds = new Set([...beforeTermination, ...observations].map(probe => probe.id));
    if (probeIds.size !== beforeTermination.length + observations.length)
    {
        errors.push(`${prefix} has duplicate probe ids`);
    }
    if (identity?.mode === 'observed' && !beforeTermination.some(probe => probe.id === identity.probe))
    {
        errors.push(`${prefix}.identity.probe must reference a beforeTermination probe`);
    }
    if (![...prepare, ...trigger].some(isMutatingAction))
    {
        errors.push(`${prefix} must drive at least one real mutation action`);
    }
    if (beforeTermination.length === 0)
    {
        errors.push(`${prefix}.beforeTermination must prove durable pending work before source termination`);
    }
    if (observations.length === 0)
    {
        errors.push(`${prefix}.observations must query final state after source termination`);
    }
    validateLedgerBindings(definition, prefix, probeIds, errors);
    return {
        ...definition,
        identity,
        logicalEventId,
        prepare,
        trigger,
        afterTermination,
        beforeTermination,
        observations
    };
}

function validateActions(value, prefix, plan, variables, errors, environment)
{
    if (!Array.isArray(value))
    {
        errors.push(`${prefix} must be an array`);
        return [];
    }
    const ids = new Set();
    for (let index = 0; index < value.length; index++)
    {
        const action = value[index];
        const label = `${prefix}[${index}]`;
        if (!isObject(action))
        {
            errors.push(`${label} must be an object`);
            continue;
        }
        if (!safeIdPattern.test(action.id ?? ''))
        {
            errors.push(`${label}.id is invalid`);
        }
        if (ids.has(action.id))
        {
            errors.push(`${label}.id is duplicated`);
        }
        ids.add(action.id);
        if (action.type === 'sql-exec')
        {
            if (typeof action.sql !== 'string')
            {
                errors.push(`${label}.sql is required`);
            }
            else
            {
                validateSqlTemplate(action.sql, variables, false, new Set(plan.security?.allowedWriteTables ?? []), label, errors);
            }
            validateAssertions(action.assertions, `${label}.assertions`, variables, errors, true);
        }
        else if (action.type === 'http-request')
        {
            validateHttpDefinition(action, label, variables, plan.security?.allowedHttpOrigins ?? [], errors, environment);
            validateAssertions(action.assertions ?? [], `${label}.assertions`, variables, errors, false);
        }
        else
        {
            errors.push(`${label}.type must be sql-exec or http-request`);
        }
    }
    return value.filter(isObject);
}

function validateProbes(value, prefix, plan, variables, errors, environment)
{
    if (!Array.isArray(value))
    {
        errors.push(`${prefix} must be an array`);
        return [];
    }
    const ids = new Set();
    for (let index = 0; index < value.length; index++)
    {
        const probe = value[index];
        const label = `${prefix}[${index}]`;
        if (!isObject(probe))
        {
            errors.push(`${label} must be an object`);
            continue;
        }
        if (!safeIdPattern.test(probe.id ?? ''))
        {
            errors.push(`${label}.id is invalid`);
        }
        if (ids.has(probe.id))
        {
            errors.push(`${label}.id is duplicated`);
        }
        ids.add(probe.id);
        if (probe.type === 'sql-json')
        {
            if (typeof probe.sql !== 'string')
            {
                errors.push(`${label}.sql is required`);
            }
            else
            {
                validateSqlTemplate(probe.sql, variables, true, new Set(plan.security?.allowedReadTables ?? []), label, errors);
            }
        }
        else if (probe.type === 'http-json')
        {
            validateHttpDefinition(probe, label, variables, plan.security?.allowedHttpOrigins ?? [], errors, environment);
        }
        else if (probe.type === 'docker-inspect-json')
        {
            try
            {
                const container = safeContainer(renderTemplate(probe.container, variables));
                if (![plan.source?.container, plan.target?.container].includes(container))
                {
                    errors.push(`${label}.container is outside source/target boundary`);
                }
            }
            catch (error)
            {
                errors.push(`${label}.container: ${error.message}`);
            }
        }
        else if (probe.type === 'process-status-json')
        {
            validateProcessDefinition(probe.process, `${label}.process`, errors);
        }
        else
        {
            errors.push(`${label}.type is unsupported`);
        }
        validateAssertions(probe.assertions, `${label}.assertions`, variables, errors, true);
        validatePolling(probe, label, errors);
    }
    return value.filter(isObject);
}

function validateLedgerBindings(definition, prefix, probeIds, errors)
{
    if (!isObject(definition.ledger))
    {
        errors.push(`${prefix}.ledger must be an object of observation bindings`);
        return;
    }
    const required = [...requiredLedgerBindings];
    if (definition.kind === 'audit-writer')
    {
        required.push('expectedAuditCount', 'actualAuditCount');
    }
    if (definition.kind === 'visit-view-projection')
    {
        required.push('expectedProjectionCount', 'actualProjectionCount');
    }
    if (definition.kind === 'forced-source-recovery')
    {
        required.push('recoveredByTarget');
    }
    for (const field of required)
    {
        if (!isObject(definition.ledger[field]))
        {
            errors.push(`${prefix}.ledger.${field} observation binding is required`);
        }
    }
    for (const [field, binding] of Object.entries(definition.ledger))
    {
        if (![...requiredLedgerBindings, ...optionalLedgerBindings].includes(field))
        {
            errors.push(`${prefix}.ledger.${field} is not a supported reconciliation field`);
            continue;
        }
        if (!isObject(binding))
        {
            continue;
        }
        const keys = Object.keys(binding);
        if (keys.some(key => !['probe', 'pointer', 'type'].includes(key)))
        {
            errors.push(`${prefix}.ledger.${field} may only contain probe, pointer and type`);
        }
        if (!probeIds.has(binding.probe) && !['target-readiness', 'target-takeover'].includes(binding.probe))
        {
            errors.push(`${prefix}.ledger.${field}.probe does not reference a real observation`);
        }
        if (!validJsonPointer(binding.pointer))
        {
            errors.push(`${prefix}.ledger.${field}.pointer is invalid`);
        }
        if (!['string', 'integer', 'boolean'].includes(binding.type))
        {
            errors.push(`${prefix}.ledger.${field}.type is invalid`);
        }
    }
}

function validateDatabase(database, environment, errors)
{
    if (!isObject(database))
    {
        errors.push('database must be an object');
        return;
    }
    if (!safeEnvironmentNamePattern.test(database.connectionEnv ?? ''))
    {
        errors.push('database.connectionEnv is invalid');
    }
    const connection = environment[database.connectionEnv];
    if (typeof connection !== 'string' || !/^postgres(?:ql)?:\/\//u.test(connection))
    {
        errors.push(`database connection env ${database.connectionEnv ?? '<missing>'} must contain a PostgreSQL URL`);
    }
    try
    {
        boundedInteger(database.timeoutMs ?? 15_000, 1_000, 120_000, 'database.timeoutMs');
    }
    catch (error)
    {
        errors.push(error.message);
    }
}

function validateSecurity(security, errors)
{
    if (!isObject(security))
    {
        errors.push('security must be an object');
        return;
    }
    if (!Array.isArray(security.allowedHttpOrigins) || security.allowedHttpOrigins.length === 0)
    {
        errors.push('security.allowedHttpOrigins must be non-empty');
    }
    else
    {
        for (const [index, origin] of security.allowedHttpOrigins.entries())
        {
            try
            {
                validateAllowedOrigin(origin);
            }
            catch (error)
            {
                errors.push(`security.allowedHttpOrigins[${index}]: ${error.message}`);
            }
        }
    }
    for (const key of ['allowedReadTables', 'allowedWriteTables'])
    {
        if (!Array.isArray(security[key]) || security[key].length === 0)
        {
            errors.push(`security.${key} must be non-empty`);
            continue;
        }
        const seen = new Set();
        for (const table of security[key])
        {
            if (!safeSqlIdentifierPattern.test(table ?? '') || !builtInSqlTables.has(table))
            {
                errors.push(`security.${key} contains unsupported table: ${table}`);
            }
            if (seen.has(table))
            {
                errors.push(`security.${key} contains duplicate table: ${table}`);
            }
            seen.add(table);
        }
    }
    const writes = new Set(security.allowedWriteTables ?? []);
    const reads = new Set(security.allowedReadTables ?? []);
    for (const table of writes)
    {
        if (!reads.has(table))
        {
            errors.push(`write table must also be readable for reconciliation: ${table}`);
        }
    }
}

function validateSourceAndTarget(plan, rollout, variables, errors, environment)
{
    if (!isObject(plan.source))
    {
        errors.push('source must be an object');
    }
    else if (!safeContainerPattern.test(plan.source.container ?? '') && !isObject(plan.source.process))
    {
        errors.push('source must define a safe container or bounded process');
    }
    if (!isObject(plan.target))
    {
        errors.push('target must be an object');
        return;
    }
    if (!safeContainerPattern.test(plan.target.container ?? ''))
    {
        errors.push('target.container is invalid');
    }
    if (plan.target.releaseId !== rollout.target.releaseId)
    {
        errors.push('target.releaseId does not match rollout state');
    }
    if (plan.target.generation !== rollout.target.runtimeGeneration)
    {
        errors.push('target.generation does not match rollout state');
    }
    for (const [key, id] of [['readinessProbe', 'target-readiness'], ['takeoverProbe', 'target-takeover']])
    {
        const probe = plan.target[key];
        if (!isObject(probe))
        {
            errors.push(`target.${key} is required`);
            continue;
        }
        if (probe.type !== 'http-json' && probe.type !== 'sql-json')
        {
            errors.push(`target.${key} must use a real HTTP or SQL observation`);
        }
        validateProbes([{ ...probe, id }], `target.${key}`, plan, variables, errors, environment);
    }
}

function validateSourceTermination(definition, source, errors)
{
    if (!isObject(definition))
    {
        errors.push('sourceTermination is required');
        return;
    }
    if (definition.type === 'docker-kill')
    {
        if (definition.signal !== 'SIGKILL')
        {
            errors.push('sourceTermination.signal must be SIGKILL');
        }
        if (!safeContainerPattern.test(definition.container ?? '') || definition.container !== source?.container)
        {
            errors.push('sourceTermination.container must exactly match source.container');
        }
    }
    else if (definition.type === 'process-signal')
    {
        if (definition.signal !== 'SIGKILL')
        {
            errors.push('sourceTermination.signal must be SIGKILL');
        }
        validateProcessDefinition(definition, 'sourceTermination', errors);
    }
    else
    {
        errors.push('sourceTermination.type must be docker-kill or process-signal');
    }
}

function validateProcessDefinition(definition, label, errors)
{
    if (!isObject(definition))
    {
        errors.push(`${label} is required`);
        return;
    }
    if (!isSafeRelativeDrillFile(definition.pidFile))
    {
        errors.push(`${label}.pidFile must be a relative work-directory path`);
    }
    if (typeof definition.commandContains !== 'string'
    || definition.commandContains.length < 8
    || definition.commandContains.length > 512
    || /[\r\n\0]/u.test(definition.commandContains))
    {
        errors.push(`${label}.commandContains must bind the expected source command`);
    }
}

function isSafeRelativeDrillFile(value)
{
    if (typeof value !== 'string' || value.length === 0 || value.length > 512 || path.isAbsolute(value) || /[\0\r\n]/u.test(value))
    {
        return false;
    }
    const segments = value.split(/[\\/]/u);
    if (segments.some(segment => segment === '' || segment === '.' || segment === '..'))
    {
        return false;
    }
    return /^[0-9A-Za-z._/-]+$/u.test(value);
}

function validateHttpDefinition(definition, label, variables, allowedOrigins, errors, environment)
{
    try
    {
        const rendered = renderTemplate(definition.url, variables);
        const url = new URL(rendered);
        assertAllowedHttpUrl(url, allowedOrigins);
    }
    catch (error)
    {
        errors.push(`${label}.url: ${error.message}`);
    }
    const method = String(definition.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
    {
        errors.push(`${label}.method is invalid`);
    }
    if (!Array.isArray(definition.expectedStatuses) || definition.expectedStatuses.length === 0 || definition.expectedStatuses.some(status => !Number.isInteger(status) || status < 100 || status > 599))
    {
        errors.push(`${label}.expectedStatuses must be a non-empty HTTP status array`);
    }
    validateHeaders(definition.headers ?? {}, `${label}.headers`, errors, environment, variables);
    if (Object.hasOwn(definition, 'body'))
    {
        try
        {
            const rendered = JSON.stringify(renderJson(definition.body, variables));
            if (Buffer.byteLength(rendered) > 1_048_576)
            {
                errors.push(`${label}.body exceeds 1 MiB`);
            }
        }
        catch (error)
        {
            errors.push(`${label}.body: ${error.message}`);
        }
    }
    try
    {
        boundedInteger(definition.requestTimeoutMs ?? 10_000, 500, 120_000, `${label}.requestTimeoutMs`);
    }
    catch (error)
    {
        errors.push(error.message);
    }
}

function validateHeaders(headers, label, errors, environment, variables)
{
    if (!isObject(headers))
    {
        errors.push(`${label} must be an object`);
        return;
    }
    for (const [name, descriptor] of Object.entries(headers))
    {
        if (!safeHeaderNamePattern.test(name))
        {
            errors.push(`${label}.${name} has an invalid header name`);
        }
        if (!isObject(descriptor))
        {
            errors.push(`${label}.${name} must use an env or value descriptor`);
            continue;
        }
        const hasEnv = typeof descriptor.env === 'string';
        const hasValue = typeof descriptor.value === 'string';
        if (hasEnv === hasValue)
        {
            errors.push(`${label}.${name} must specify exactly one of env or value`);
        }
        if (hasEnv && !safeEnvironmentNamePattern.test(descriptor.env))
        {
            errors.push(`${label}.${name}.env is invalid`);
        }
        if (hasValue && sensitiveHeaders.has(name.toLowerCase()))
        {
            errors.push(`${label}.${name} must be read from an environment variable`);
        }
        if (hasEnv)
        {
            const value = environment[descriptor.env];
            if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/u.test(value))
            {
                errors.push(`${label}.${name} environment value is missing or unsafe`);
            }
        }
        if (hasValue)
        {
            try
            {
                const value = renderTemplate(descriptor.value, variables);
                if (value.length === 0 || /[\r\n\0]/u.test(value))
                {
                    errors.push(`${label}.${name} literal value is empty or unsafe`);
                }
            }
            catch (error)
            {
                errors.push(`${label}.${name}.value: ${error.message}`);
            }
        }
    }
}

function validateAssertions(assertions, label, variables, errors, requireNonEmpty)
{
    if (!Array.isArray(assertions) || (requireNonEmpty && assertions.length === 0))
    {
        errors.push(`${label} must be ${requireNonEmpty ? 'a non-empty' : 'an'} array`);
        return;
    }
    for (let index = 0; index < assertions.length; index++)
    {
        const assertion = assertions[index];
        const prefix = `${label}[${index}]`;
        if (!isObject(assertion) || !validJsonPointer(assertion.pointer))
        {
            errors.push(`${prefix}.pointer is invalid`);
            continue;
        }
        const operators = ['equals', 'equalsVariable', 'minimum', 'maximum'].filter(key => Object.hasOwn(assertion, key));
        if (operators.length === 0)
        {
            errors.push(`${prefix} must define at least one bounded comparison`);
        }
        if (Object.hasOwn(assertion, 'equalsVariable') && !Object.hasOwn(variables, assertion.equalsVariable))
        {
            errors.push(`${prefix}.equalsVariable is unknown`);
        }
        if (Object.hasOwn(assertion, 'minimum') && !Number.isFinite(assertion.minimum))
        {
            errors.push(`${prefix}.minimum must be finite`);
        }
        if (Object.hasOwn(assertion, 'maximum') && !Number.isFinite(assertion.maximum))
        {
            errors.push(`${prefix}.maximum must be finite`);
        }
    }
}

function validatePolling(definition, label, errors)
{
    try
    {
        boundedInteger(definition.timeoutMs ?? 60_000, 1_000, 900_000, `${label}.timeoutMs`);
        boundedInteger(definition.pollMs ?? 500, 100, 30_000, `${label}.pollMs`);
    }
    catch (error)
    {
        errors.push(error.message);
    }
}

function validateSqlTemplate(template, variables, readOnly, allowedTables, label, errors)
{
    try
    {
        const compiled = compileSqlTemplate(template, variables);
        if (readOnly)
        {
            validateReadSqlOrThrow(compiled.text, allowedTables, label);
        }
        else
        {
            validateWriteSqlOrThrow(compiled.text, allowedTables, label);
        }
    }
    catch (error)
    {
        errors.push(`${label}.sql: ${error.message}`);
    }
}

export function validateReadSqlOrThrow(sql, allowedTables, label = 'SQL query')
{
    const statement = normalizeSql(sql);
    if (!/^select\b/iu.test(statement))
    {
        throw new Error(`${label} must start with SELECT`);
    }
    if (/\b(insert|update|delete|merge|copy|call|do|create|alter|drop|truncate|grant|revoke|refresh|vacuum|analyze|set|reset|listen|notify|lock)\b/iu.test(statement))
    {
        throw new Error(`${label} contains a mutating or administrative keyword`);
    }
    rejectPrivilegedSqlFunctions(statement, label);
    validateSqlRelations(statement, allowedTables, label, true);
    return statement;
}

export function validateWriteSqlOrThrow(sql, allowedTables, label = 'SQL action')
{
    const statement = normalizeSql(sql);
    const target = /^(insert\s+into|update)\s+"?([a-z][a-z0-9_]*)"?\b/iu.exec(statement);
    if (!target)
    {
        throw new Error(`${label} must be a single INSERT or UPDATE`);
    }
    if (/\b(delete|merge|copy|call|do|create|alter|drop|truncate|grant|revoke|refresh|vacuum|analyze|reset|listen|notify|lock)\b/iu.test(statement))
    {
        throw new Error(`${label} contains a forbidden mutating or administrative keyword`);
    }
    rejectPrivilegedSqlFunctions(statement, label);
    if (!/\breturning\s+json_build_object\s*\(/iu.test(statement))
    {
        throw new Error(`${label} must RETURNING one json_build_object receipt`);
    }
    const table = target[2].toLowerCase();
    if (!allowedTables.has(table))
    {
        throw new Error(`${label} writes outside the declared table boundary: ${table}`);
    }
    validateSqlRelations(statement, allowedTables, label, false);
    return statement;
}

function normalizeSql(sql)
{
    if (typeof sql !== 'string' || sql.trim().length === 0 || sql.length > 100_000)
    {
        throw new Error('SQL must be a non-empty bounded string');
    }
    if (sql.includes('\0') || /--|\/\*|\*\/|\\[A-Za-z]/u.test(sql))
    {
        throw new Error('SQL comments, NUL and psql meta commands are forbidden');
    }
    const trimmed = sql.trim();
    const withoutTerminal = trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed;
    if (withoutTerminal.includes(';'))
    {
        throw new Error('multiple SQL statements are forbidden');
    }
    return withoutTerminal;
}

function validateSqlRelations(statement, allowedTables, label, requireRelation)
{
    const relations = [];
    const pattern = /\b(?:from|join)\s+"?([a-z][a-z0-9_]*)"?(?!\s*\()/giu;
    for (const match of statement.matchAll(pattern))
    {
        relations.push(match[1].toLowerCase());
    }
    if (requireRelation && relations.length === 0)
    {
        throw new Error(`${label} must read at least one declared table`);
    }
    for (const table of relations)
    {
        if (!allowedTables.has(table))
        {
            throw new Error(`${label} reads outside the declared table boundary: ${table}`);
        }
    }
    for (const match of statement.matchAll(/\bfrom\b([\s\S]*?)(?=\bwhere\b|\bgroup\b|\border\b|\blimit\b|\breturning\b|$)/giu))
    {
        if (match[1].includes(','))
        {
            throw new Error(`${label} may not use comma joins`);
        }
    }
}

function rejectPrivilegedSqlFunctions(statement, label)
{
    if (/\b(?:pg_[a-z0-9_]+|lo_[a-z0-9_]+|dblink[a-z0-9_]*|set_config)\s*\(/iu.test(statement))
    {
        throw new Error(`${label} calls a forbidden PostgreSQL function`);
    }
}

function compileSqlTemplate(template, variables)
{
    const values = [];
    const text = String(template).replace(/\{\{([a-zA-Z][a-zA-Z0-9.-]{0,127})\}\}/gu, (_match, name) =>
    {
        if (!Object.hasOwn(variables, name))
        {
            throw new Error(`unknown template variable: ${name}`);
        }
        const variable = `worker_drill_v${values.length}`;
        values.push({ name: variable, value: String(variables[name]) });
        return `:'${variable}'`;
    });
    if (/\{\{|\}\}/u.test(text))
    {
        throw new Error('malformed or unsupported SQL template variable');
    }
    return { text, values };
}

function runPsqlJson(compiled, database, environment, readOnly)
{
    const connection = environment[database.connectionEnv];
    const args = [
        '--no-psqlrc',
        '--set=ON_ERROR_STOP=1',
        '--tuples-only',
        '--no-align',
        '--quiet'
    ];
    for (const item of compiled.values)
    {
        args.push(`--set=${item.name}=${item.value}`);
    }
    args.push('--command', compiled.text);
    const pgOptions = [
        `-c statement_timeout=${boundedInteger(database.timeoutMs ?? 15_000, 1_000, 120_000, 'database.timeoutMs')}`,
    readOnly ? '-c default_transaction_read_only=on' : '-c default_transaction_read_only=off'
    ].join(' ');
    const result = runExternal('psql', args, {
        environment: { ...environment, PGDATABASE: connection, PGOPTIONS: pgOptions },
        timeoutMs: database.timeoutMs ?? 15_000
    });
    const rows = result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    if (rows.length !== 1)
    {
        throw new Error(`psql must return exactly one JSON row, observed ${rows.length}`);
    }
    let value;
    try
    {
        value = JSON.parse(rows[0]);
    }
    catch (error)
    {
        throw new Error(`psql returned invalid JSON: ${error.message}`);
    }
    if (!isObject(value))
    {
        throw new Error('psql JSON receipt must be an object');
    }
    return value;
}

async function runHttpJson(definition, variables, allowedOrigins, environment)
{
    const url = new URL(renderTemplate(definition.url, variables));
    assertAllowedHttpUrl(url, allowedOrigins);
    const method = String(definition.method ?? 'GET').toUpperCase();
    const headers = resolveHeaders(definition.headers ?? {}, environment, variables);
    let body;
    if (Object.hasOwn(definition, 'body'))
    {
        body = JSON.stringify(renderJson(definition.body, variables));
        if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type'))
        {
            headers['content-type'] = 'application/json';
        }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), boundedInteger(definition.requestTimeoutMs ?? 10_000, 500, 120_000, 'requestTimeoutMs'));
    let response;
    try
    {
        response = await fetch(url, {
            method,
            headers,
            body,
            redirect: 'error',
            signal: controller.signal
        });
    }
    finally
    {
        clearTimeout(timeout);
    }
    if (!definition.expectedStatuses.includes(response.status))
    {
        throw new Error(`HTTP ${method} ${url.origin}${url.pathname} returned ${response.status}`);
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(length) && length > 1_048_576)
    {
        throw new Error('HTTP observation body exceeds 1 MiB');
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 1_048_576)
    {
        throw new Error('HTTP observation body exceeds 1 MiB');
    }
    let parsed = null;
    if (text.trim().length > 0)
    {
        try
        {
            parsed = JSON.parse(text);
        }
        catch (error)
        {
            throw new Error(`HTTP observation body is not JSON: ${error.message}`);
        }
    }
    return {
        statusCode: response.status,
        releaseId: response.headers.get('x-fsus-release-id'),
        runtimeGeneration: parseOptionalInteger(response.headers.get('x-fsus-runtime-generation')),
        body: parsed,
        bodySha256: sha256(text)
    };
}

function assertObservation(observation, assertions, variables, label)
{
    const failures = [];
    for (const [index, assertion] of assertions.entries())
    {
        const value = readJsonPointer(observation, assertion.pointer);
        if (!value.found)
        {
            failures.push(`${label} assertion[${index}] pointer ${assertion.pointer} is missing`);
            continue;
        }
        if (Object.hasOwn(assertion, 'equals') && !deepEqual(value.value, assertion.equals))
        {
            failures.push(`${assertion.pointer} did not equal the required value`);
        }
        if (Object.hasOwn(assertion, 'equalsVariable') && !deepEqual(value.value, variables[assertion.equalsVariable]))
        {
            failures.push(`${assertion.pointer} did not equal ${assertion.equalsVariable}`);
        }
        if (Object.hasOwn(assertion, 'minimum') && !(typeof value.value === 'number' && value.value >= assertion.minimum))
        {
            failures.push(`${assertion.pointer} was below ${assertion.minimum}`);
        }
        if (Object.hasOwn(assertion, 'maximum') && !(typeof value.value === 'number' && value.value <= assertion.maximum))
        {
            failures.push(`${assertion.pointer} exceeded ${assertion.maximum}`);
        }
    }
    if (failures.length > 0)
    {
        throw new Error(failures.join('; '));
    }
}

function dockerInspect(container, timeoutMs, environment)
{
    const result = runExternal('docker', ['inspect', '--format', '{{json .State}}', container], { environment, timeoutMs });
    let state;
    try
    {
        state = JSON.parse(result.stdout.trim());
    }
    catch (error)
    {
        throw new Error(`docker inspect returned invalid JSON: ${error.message}`);
    }
    return {
        container,
        running: state.Running === true,
        status: state.Status ?? null,
        exitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null,
        pid: Number.isInteger(state.Pid) ? state.Pid : null,
        startedAt: state.StartedAt ?? null,
        finishedAt: state.FinishedAt ?? null
    };
}

async function waitForContainerStopped(container, timeoutMs, environment)
{
    const deadline = Date.now() + boundedInteger(timeoutMs, 1_000, 120_000, 'source termination timeout');
    let observation;
    do
    {
        observation = dockerInspect(container, Math.min(10_000, timeoutMs), environment);
        if (observation.running === false)
        {
            return observation;
        }
        await delay(100);
    } while (Date.now() < deadline);
    throw new Error('source container remained running after SIGKILL');
}

function runExternal(executable, args, { environment, timeoutMs })
{
    if (!externalCommandAllowlist.has(executable))
    {
        throw new Error(`external command is not allowlisted: ${executable}`);
    }
    if (!Array.isArray(args) || args.length > 256 || args.some(argument => typeof argument !== 'string' || argument.includes('\0') || Buffer.byteLength(argument) > 100_000))
    {
        throw new Error(`${executable} arguments violate the bounded command contract`);
    }
    const result = spawnSync(executable, args, {
        encoding: 'utf8',
        env: environment,
        shell: false,
        timeout: boundedInteger(timeoutMs, 500, 120_000, `${executable} timeout`),
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true
    });
    if (result.error)
    {
        throw new Error(`${executable} failed to start: ${result.error.message}`);
    }
    if (result.status !== 0)
    {
        throw new Error(`${executable} exited ${result.status}: ${cleanProcessError(result)}`);
    }
    return {
        executable,
        exitCode: result.status,
        stdout: String(result.stdout ?? '').trim(),
        stderr: String(result.stderr ?? '').trim()
    };
}

function inspectProcess(definition, variables, options)
{
    if (!isObject(definition))
    {
        throw new Error('process probe definition is missing');
    }
    const pidFile = resolveReadableDrillFile(options.workDir, renderTemplate(definition.pidFile, variables), 'process probe pid file');
    const pid = readPid(pidFile);
    const commandLine = readProcessCommandLine(pid);
    if (typeof definition.commandContains !== 'string' || !commandLine.includes(definition.commandContains))
    {
        throw new Error('process command line did not match the bounded marker');
    }
    return { pid, running: isProcessAlive(pid), commandLineSha256: sha256(commandLine) };
}

function readPid(file)
{
    const text = fs.readFileSync(file, 'utf8').trim();
    const pid = Number(text);
    if (!Number.isSafeInteger(pid) || pid <= 1)
    {
        throw new Error('pid file did not contain a safe process id');
    }
    return pid;
}

function readProcessCommandLine(pid)
{
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
}

function isProcessAlive(pid)
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch (error)
    {
        if (error?.code === 'ESRCH')
        {
            return false;
        }
        throw error;
    }
}

function parseArgs(argv, environment)
{
    const parsed = {};
    const known = new Set(['plan', 'rollout-state', 'out', 'work-dir', 'run-id']);
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value === undefined)
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        const key = name.slice(2);
        if (!known.has(key))
        {
            throw new Error(`unknown argument: --${key}`);
        }
        if (Object.hasOwn(parsed, key))
        {
            throw new Error(`duplicate argument: --${key}`);
        }
        parsed[key] = value;
    }
    for (const key of ['plan', 'rollout-state', 'out', 'work-dir'])
    {
        if (!parsed[key])
        {
            throw new Error(`--${key} is required`);
        }
    }
    const repositoryRoot = fs.realpathSync(process.cwd());
    const configuredRoot = environment.FSUSBLOG_WORKER_DRILL_ROOT
        ? path.resolve(environment.FSUSBLOG_WORKER_DRILL_ROOT)
        : path.join(repositoryRoot, '.tmp');
    fs.mkdirSync(configuredRoot, { recursive: true, mode: 0o700 });
    const trustedRoot = fs.realpathSync(configuredRoot);
    const plan = resolveReadableInsideAny([repositoryRoot, trustedRoot], parsed.plan, 'plan');
    const rolloutState = resolveReadableInsideAny([trustedRoot], parsed['rollout-state'], 'rollout state');
    const workDir = resolveInside(trustedRoot, parsed['work-dir'], 'work directory');
    const out = resolveInside(workDir, parsed.out, 'ledger output');
    const runId = parsed['run-id'] ?? `worker-drill-${crypto.randomUUID().replaceAll('-', '')}`;
    if (!safeLogicalEventIdPattern.test(runId))
    {
        throw new Error('--run-id is invalid');
    }
    return { plan, rolloutState, out, workDir, trustedRoot, repositoryRoot, runId };
}

function resolveInputs(inputs, environment)
{
    const errors = [];
    const values = {};
    if (!isObject(inputs))
    {
        return { errors: ['inputs must be an object'], values };
    }
    for (const [name, descriptor] of Object.entries(inputs))
    {
        if (!safeInputNamePattern.test(name))
        {
            errors.push(`input name is invalid: ${name}`);
            continue;
        }
        if (!isObject(descriptor) || !safeEnvironmentNamePattern.test(descriptor.env ?? ''))
        {
            errors.push(`input ${name} must name a safe environment variable`);
            continue;
        }
        const raw = environment[descriptor.env];
        if (typeof raw !== 'string' || raw.length === 0 || Buffer.byteLength(raw) > 512)
        {
            errors.push(`input ${name} environment value is missing or too large`);
            continue;
        }
        if (descriptor.pattern !== undefined)
        {
            if (typeof descriptor.pattern !== 'string'
        || descriptor.pattern.length > 128
        || !descriptor.pattern.startsWith('^')
        || !descriptor.pattern.endsWith('$')
        || /[()|\\]/u.test(descriptor.pattern)
        || /(?:[*+?}]\s*){2}/u.test(descriptor.pattern))
            {
                errors.push(`input ${name} pattern must be an anchored bounded regular expression`);
                continue;
            }
            let pattern;
            try
            {
                pattern = new RegExp(descriptor.pattern, 'u');
            }
            catch (error)
            {
                errors.push(`input ${name} pattern is invalid: ${error.message}`);
                continue;
            }
            if (!pattern.test(raw))
            {
                errors.push(`input ${name} did not match its declared pattern`);
                continue;
            }
        }
        if (descriptor.type === 'integer')
        {
            const parsed = Number(raw);
            if (!Number.isSafeInteger(parsed))
            {
                errors.push(`input ${name} is not a safe integer`);
            }
            else
            {
                values[`input.${name}`] = parsed;
            }
        }
        else if (descriptor.type === 'string')
        {
            if (!/^[0-9A-Za-z][0-9A-Za-z._:@/-]{0,511}$/u.test(raw))
            {
                errors.push(`input ${name} contains characters outside the drill value boundary`);
            }
            else
            {
                values[`input.${name}`] = raw;
            }
        }
        else
        {
            errors.push(`input ${name} type must be integer or string`);
        }
    }
    return { errors, values };
}

function buildVariables(runId, rollout, inputs)
{
    return {
        runId,
        rolloutId: rollout.rolloutId,
        'source.releaseId': rollout.source.releaseId,
        'source.slot': rollout.source.slot,
        'source.generation': rollout.source.runtimeGeneration,
        'target.releaseId': rollout.target.releaseId,
        'target.slot': rollout.target.slot,
        'target.generation': rollout.target.runtimeGeneration,
        ...inputs
    };
}

function renderTemplate(value, variables)
{
    if (typeof value !== 'string')
    {
        throw new Error('template must be a string');
    }
    const rendered = value.replace(/\{\{([a-zA-Z][a-zA-Z0-9.-]{0,127})\}\}/gu, (_match, name) =>
    {
        if (!Object.hasOwn(variables, name))
        {
            throw new Error(`unknown template variable: ${name}`);
        }
        return String(variables[name]);
    });
    if (/\{\{|\}\}/u.test(rendered))
    {
        throw new Error('malformed or unsupported template variable');
    }
    return rendered;
}

function renderJson(value, variables)
{
    if (typeof value === 'string')
    {
        return renderTemplate(value, variables);
    }
    if (Array.isArray(value))
    {
        return value.map(item => renderJson(item, variables));
    }
    if (isObject(value))
    {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderJson(item, variables)]));
    }
    return value;
}

function resolveHeaders(headers, environment, variables)
{
    const result = {};
    for (const [name, descriptor] of Object.entries(headers))
    {
        if (!safeHeaderNamePattern.test(name))
        {
            throw new Error(`invalid HTTP header name: ${name}`);
        }
        const value = descriptor.env ? environment[descriptor.env] : renderTemplate(descriptor.value, variables);
        if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/u.test(value))
        {
            throw new Error(`HTTP header ${name} is missing or unsafe`);
        }
        result[name] = value;
    }
    return result;
}

function validateAllowedOrigin(value)
{
    const url = new URL(value);
    if (url.origin !== value || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))))
    {
        throw new Error('origin must be HTTPS or loopback HTTP and contain no path');
    }
}

function assertAllowedHttpUrl(url, allowedOrigins)
{
    if (url.username || url.password || url.hash)
    {
        throw new Error('HTTP observation URL may not contain credentials or a fragment');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
    {
        throw new Error('plain HTTP is allowed only for loopback rehearsal endpoints');
    }
    if (!allowedOrigins.includes(url.origin))
    {
        throw new Error(`HTTP origin is outside the plan allowlist: ${url.origin}`);
    }
}

function isLoopback(hostname)
{
    return ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(hostname);
}

function readJsonPointer(value, pointer)
{
    if (!validJsonPointer(pointer))
    {
        return { found: false, value: undefined };
    }
    if (pointer === '')
    {
        return { found: true, value };
    }
    let current = value;
    for (const raw of pointer.slice(1).split('/'))
    {
        const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
        if ((isObject(current) || Array.isArray(current)) && Object.hasOwn(current, key))
        {
            current = current[key];
        }
        else
        {
            return { found: false, value: undefined };
        }
    }
    return { found: true, value: current };
}

function validJsonPointer(value)
{
    return typeof value === 'string' && (value === '' || (value.startsWith('/') && !/~(?:[^01]|$)/u.test(value)));
}

function matchesType(value, type)
{
    if (type === 'integer')
    {
        return Number.isSafeInteger(value);
    }
    if (type === 'boolean')
    {
        return typeof value === 'boolean';
    }
    if (type === 'string')
    {
        return typeof value === 'string';
    }
    return false;
}

function isMutatingAction(action)
{
    return action.type === 'sql-exec' || (action.type === 'http-request' && String(action.method ?? 'GET').toUpperCase() !== 'GET');
}

function skippedProbe(id, reason)
{
    const now = new Date().toISOString();
    return { id, type: 'skipped', status: 'skipped', startedAtUtc: now, completedAtUtc: now, attempts: [], observation: null, errors: [reason] };
}

function safeContainer(value)
{
    if (!safeContainerPattern.test(value ?? ''))
    {
        throw new Error('container name is invalid');
    }
    return value;
}

function resolveReadableInsideAny(roots, candidate, label)
{
    const resolved = path.resolve(candidate);
    const real = fs.realpathSync(resolved);
    if (!roots.some(root => isInside(root, real)))
    {
        throw new Error(`${label} is outside its trusted root`);
    }
    if (!fs.statSync(real).isFile())
    {
        throw new Error(`${label} must be a file`);
    }
    return real;
}

function resolveInside(root, candidate, label)
{
    const resolved = path.resolve(root, candidate);
    if (!isInside(root, resolved))
    {
        throw new Error(`${label} is outside its trusted root`);
    }
    return resolved;
}

function resolveReadableDrillFile(root, candidate, label)
{
    const resolved = resolveInside(root, candidate, label);
    assertNoSymlinkTraversal(root, resolved, label);
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`${label} must be a regular file`);
    }
    return resolved;
}

function assertWritablePath(root, candidate, label)
{
    if (!isInside(root, candidate))
    {
        throw new Error(`${label} is outside its trusted root`);
    }
    const parent = path.dirname(candidate);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertNoSymlinkTraversal(root, parent, `${label} parent`);
    const existing = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink())
    {
        throw new Error(`${label} may not be a symbolic link`);
    }
}

function assertNoSymlinkTraversal(root, candidate, label)
{
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative))
    {
        throw new Error(`${label} is outside its trusted root`);
    }
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean))
    {
        current = path.join(current, segment);
        const stat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (stat?.isSymbolicLink())
        {
            throw new Error(`${label} traverses a symbolic link`);
        }
    }
}

function isInside(root, candidate)
{
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function writeJsonAtomic(file, value)
{
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
}

function writeJsonExclusive(file, value)
{
    const handle = fs.openSync(file, 'wx', 0o600);
    try
    {
        fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`);
        fs.fsyncSync(handle);
    }
    finally
    {
        fs.closeSync(handle);
    }
}

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function deepEqual(left, right)
{
    return JSON.stringify(left) === JSON.stringify(right);
}

function parseOptionalInteger(value)
{
    if (value === null || value === undefined || value === '')
    {
        return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function boundedInteger(value, minimum, maximum, label)
{
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    {
        throw new Error(`${label} must be an integer in [${minimum}, ${maximum}]`);
    }
    return parsed;
}

function cleanProcessError(result)
{
    return String(result.stderr || result.stdout || result.signal || 'unknown external command failure').trim();
}

function sha256(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function unique(values)
{
    return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))];
}

function isObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function delay(milliseconds)
{
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
{
    process.exitCode = await main();
}

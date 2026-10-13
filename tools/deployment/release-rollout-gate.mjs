#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { validateRolloutState } from './release-rollout-lib.mjs';

const schema = 'fsusblog.release-rollout-gate.v1';

try
{
    const { command, options } = parseArgs(process.argv.slice(2));
    const errors = [];
    const observations = evaluate(command, options, errors);
    const report = {
        schema,
        gate: command,
        status: errors.length === 0 ? 'pass' : 'fail',
        observedAtUtc: new Date().toISOString(),
        observations,
        ...(Number.isFinite(observations?.durationMs) ? { durationMs: observations.durationMs } : {}),
        errors
    };
    writeJsonAtomic(requiredPath(options, 'out'), report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (errors.length > 0)
    {
        process.exitCode = 1;
    }
}
catch (error)
{
    process.stderr.write(`[release-rollout-gate] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}

function evaluate(command, options, errors)
{
    if (command === 'backup-restore')
    {
        return backupRestore(options, errors);
    }
    if (command === 'candidate-readiness')
    {
        return candidateReadiness(options, errors);
    }
    if (command === 'compatibility')
    {
        return compatibility(options, errors);
    }
    if (command === 'traffic-checkpoint')
    {
        return trafficCheckpoint(options, errors);
    }
    if (command === 'source-drain')
    {
        return sourceDrain(options, errors);
    }
    if (command === 'target-health')
    {
        return targetHealth(options, errors);
    }
    throw new Error('usage: release-rollout-gate.mjs <backup-restore|candidate-readiness|compatibility|traffic-checkpoint|source-drain|target-health> [options]');
}

function backupRestore(options, errors)
{
    const input = readJson(requiredPath(options, 'input'));
    const requiredChecks = [
        'postgres-restore:ok', 'redis-restore:ok', 'webroot-artifact-restore:ok',
        'restored-backend-start:ok', 'public-page:ok', 'binary-api:ok', 'search-index:ok',
        'notification-stream-live:ok', 'admin-login:ok'
    ];
    if (input.status !== 'ok' || input.mode !== 'real')
    {
        errors.push('backup/restore evidence must be a successful real drill');
    }
    if (!Array.isArray(input.blockers) || input.blockers.length !== 0)
    {
        errors.push('backup/restore evidence contains blockers');
    }
    if (!Number.isFinite(input.timings?.rpoSeconds) || input.timings.rpoSeconds < 0)
    {
        errors.push('backup/restore RPO is missing');
    }
    if (!Number.isFinite(input.timings?.rtoSeconds) || input.timings.rtoSeconds < 0)
    {
        errors.push('backup/restore RTO is missing');
    }
    for (const check of requiredChecks)
    {
        if (!input.checks?.includes(check))
        {
            errors.push(`backup/restore check is missing: ${check}`);
        }
    }
    const generatedAt = input.generatedAt ?? input.completedAtUtc;
    const maxAgeSeconds = boundedInteger(options['max-age-seconds'] ?? 604800, 1, 31_536_000, 'max-age-seconds');
    if (!isIsoUtc(generatedAt))
    {
        errors.push('backup/restore completion timestamp is invalid');
    }
    else if ((Date.now() - Date.parse(generatedAt)) / 1000 > maxAgeSeconds)
    {
        errors.push('backup/restore evidence is stale');
    }
    return { input: path.resolve(options.input), maxAgeSeconds, requiredChecks, generatedAt: generatedAt ?? null };
}

function candidateReadiness(options, errors)
{
    const input = readJson(requiredPath(options, 'input'));
    const slot = required(options, 'slot');
    const releaseId = required(options, 'release');
    const digest = required(options, 'digest');
    const generation = boundedInteger(options.generation, 1, Number.MAX_SAFE_INTEGER, 'generation');
    const runtime = input.slot ?? input;
    if (runtime.exists !== true || runtime.running !== true || runtime.identityMatchesSlot !== true || runtime.loopbackOnly !== true)
    {
        errors.push('candidate runtime identity/binding is invalid');
    }
    if (runtime.liveness !== 'ok' || runtime.readiness !== 'ok')
    {
        errors.push('candidate runtime is not live and ready');
    }
    if (runtime.release?.releaseId !== releaseId || runtime.release?.imageDigest !== digest)
    {
        errors.push('candidate release identity does not match');
    }
    if (runtime.release?.deploymentGeneration !== generation)
    {
        errors.push('candidate runtime generation does not match');
    }
    if (runtime.release?.deploymentMode !== 'candidate')
    {
        errors.push('candidate runtime is not isolated in candidate mode');
    }
    if (runtime.slot !== undefined && runtime.slot !== slot)
    {
        errors.push('candidate slot does not match');
    }
    return { input: path.resolve(options.input), slot, releaseId, digest, generation };
}

function compatibility(options, errors)
{
    const input = readJson(requiredPath(options, 'input'));
    if (input.schema !== 'fsusblog.release-compatibility-matrix.v1' || input.status !== 'pass')
    {
        errors.push('release compatibility matrix did not pass');
    }
    if (!Array.isArray(input.scenarios) || input.scenarios.length < 2 || input.scenarios.some(item => item.status !== 'pass'))
    {
        errors.push('N/N-1 compatibility scenarios are incomplete');
    }
    if (Array.isArray(input.errors) && input.errors.length > 0)
    {
        errors.push('release compatibility matrix contains errors');
    }
    return { input: path.resolve(options.input), scenarioCount: input.scenarios?.length ?? 0 };
}

function trafficCheckpoint(options, errors)
{
    const input = readJson(requiredPath(options, 'input'));
    const targetReleaseId = required(options, 'target-release');
    const minRequests = boundedInteger(options['min-requests'] ?? 100, 1, 10_000_000, 'min-requests');
    if (input.schema !== 'fsusblog.release-traffic-evidence.v1' || !['running', 'pass'].includes(input.status))
    {
        errors.push('traffic probe is not live/passing');
    }
    if (Number(input.totalRequests) < minRequests)
    {
        errors.push(`traffic probe has fewer than ${minRequests} requests`);
    }
    for (const field of ['deploymentFailureCount', 'connectionErrorCount', 'gatewayErrorCount', 'unhandled5xxCount', 'inFlightAbortedCount'])
    {
        if (Number(input[field]) !== 0)
        {
            errors.push(`traffic probe ${field} must be zero`);
        }
    }
    if (Number(input.releaseDistribution?.byReleaseId?.[targetReleaseId] ?? 0) < 1)
    {
        errors.push('public traffic has not observed the target release');
    }
    return { input: path.resolve(options.input), targetReleaseId, minRequests, totalRequests: input.totalRequests ?? 0 };
}

function sourceDrain(options, errors)
{
    const deployment = readJson(requiredPath(options, 'input'));
    const notification = readJson(requiredPath(options, 'notification'));
    const snapshot = deployment.snapshot ?? deployment;
    if (snapshot.mode !== 'draining' || snapshot.state !== 'draining')
    {
        errors.push('source runtime is not in draining state');
    }
    if (snapshot.drain?.requested !== true || snapshot.drain?.drained !== true || snapshot.drain?.timedOut !== false)
    {
        errors.push('source drain did not finish cleanly');
    }
    if (!Array.isArray(snapshot.drain?.blockers) || snapshot.drain.blockers.length !== 0)
    {
        errors.push('source drain has blockers');
    }
    if (Number(snapshot.inFlightHttpRequests) !== 0 || Number(snapshot.notificationStreamConnections) !== 0 || Number(snapshot.activeBackgroundClaims) !== 0)
    {
        errors.push('source runtime still has active requests, streams or background claims');
    }
    if (notification.result?.accepted !== true || ![1012, 4009].includes(Number(notification.result?.closeCode ?? notification.result?.protocol?.closeCode)))
    {
        errors.push('notification stream restart protocol evidence is missing');
    }
    return {
        input: path.resolve(options.input),
        notification: path.resolve(options.notification),
        blockers: snapshot.drain?.blockers ?? null,
        durationMs: elapsed(snapshot.drainStartedAtUtc ?? snapshot.drain?.startedAtUtc, new Date().toISOString())
    };
}

function targetHealth(options, errors)
{
    const rollout = readJson(requiredPath(options, 'rollout-state'));
    const slotStatus = readJson(requiredPath(options, 'slot-status'));
    const fence = readJson(requiredPath(options, 'active-fence'));
    const sourceRevoke = readJson(requiredPath(options, 'source-revoke'));
    const fenceVerify = readJson(requiredPath(options, 'fence-verify'));
    const traffic = readJson(requiredPath(options, 'traffic-checkpoint'));
    const runtime = slotStatus.slot ?? slotStatus;
    const target = rollout.target ?? {};
    try { validateRolloutState(rollout); }
    catch (error) { errors.push(`target health rollout state is invalid: ${error.message}`); }
    if (runtime.exists !== true || runtime.running !== true || runtime.identityMatchesSlot !== true || runtime.loopbackOnly !== true)
    {
        errors.push('target health runtime identity/binding is invalid');
    }
    if (runtime.liveness !== 'ok' || runtime.readiness !== 'ok')
    {
        errors.push('target runtime is not live and ready after active fence acquisition');
    }
    if (runtime.release?.releaseId !== target.releaseId
    || runtime.release?.imageDigest !== target.imageDigest
    || runtime.release?.deploymentGeneration !== target.runtimeGeneration
    || runtime.release?.deploymentMode !== 'active')
    {
        errors.push('target health runtime release/digest/generation/mode mismatch');
    }
    const fenceSnapshot = fence.result?.snapshot;
    if (fence.schemaVersion !== 'fsus.active-release-fence-evidence.v1'
    || fence.operation !== 'acquire' || fence.dryRun !== false || fence.httpStatus !== 200
    || fence.result?.accepted !== true
    || fenceSnapshot?.status !== 'active'
    || fenceSnapshot?.releaseId !== target.releaseId
    || fenceSnapshot?.slot !== target.slot
    || Number(fenceSnapshot?.generation) !== target.runtimeGeneration
    || fenceSnapshot?.imageDigest !== target.imageDigest)
    {
        errors.push('target health active release fence evidence mismatch');
    }
    if (sourceRevoke.schemaVersion !== 'fsus.active-release-fence-evidence.v1'
    || sourceRevoke.operation !== 'revoke' || sourceRevoke.result?.accepted !== true
    || !['revoked', 'already-revoked', 'already-superseded'].includes(sourceRevoke.result?.status)
    || sourceRevoke.request?.body?.releaseId !== rollout.source?.releaseId
    || sourceRevoke.request?.body?.slot !== rollout.source?.slot
    || Number(sourceRevoke.request?.body?.generation) !== rollout.source?.runtimeGeneration)
    {
        errors.push('target health source fence revoke/supersession evidence mismatch');
    }
    const verifiedSnapshot = fenceVerify.result?.snapshot;
    if (fenceVerify.schemaVersion !== 'fsus.active-release-fence-evidence.v1'
    || fenceVerify.operation !== 'status' || fenceVerify.result?.accepted !== true
    || fenceVerify.result?.status !== 'verified'
    || verifiedSnapshot?.status !== 'active'
    || verifiedSnapshot?.releaseId !== target.releaseId
    || verifiedSnapshot?.slot !== target.slot
    || Number(verifiedSnapshot?.generation) !== target.runtimeGeneration
    || verifiedSnapshot?.imageDigest !== target.imageDigest)
    {
        errors.push('target health final active fence verification mismatch');
    }
    if (traffic.schema !== schema || traffic.gate !== 'traffic-checkpoint' || traffic.status !== 'pass'
    || traffic.observations?.targetReleaseId !== target.releaseId)
    {
        errors.push('target health public traffic checkpoint mismatch');
    }
    return {
        rolloutId: rollout.rolloutId,
        releaseId: target.releaseId ?? null,
        slot: target.slot ?? null,
        generation: target.runtimeGeneration ?? null,
        imageDigest: target.imageDigest ?? null,
        release: {
            releaseId: target.releaseId ?? null,
            slot: target.slot ?? null,
            imageDigest: target.imageDigest ?? null
        },
        deployment: { slot: target.slot ?? null, generation: target.runtimeGeneration ?? null },
        readiness: { status: runtime.readiness === 'ok' ? 'pass' : 'fail' },
        activeFence: {
            accepted: fence.result?.accepted === true,
            sourceRevokedOrSuperseded: sourceRevoke.result?.accepted === true,
            verified: fenceVerify.result?.status === 'verified',
            status: verifiedSnapshot?.status ?? null
        },
        trafficCheckpoint: { status: traffic.status ?? null, targetReleaseId: traffic.observations?.targetReleaseId ?? null }
    };
}

function elapsed(start, end)
{
    const left = Date.parse(start ?? '');
    const right = Date.parse(end ?? '');
    return Number.isFinite(left) && Number.isFinite(right) && right >= left ? right - left : null;
}

function parseArgs(argv)
{
    const command = argv.shift();
    const options = {};
    while (argv.length > 0)
    {
        const name = argv.shift();
        const value = argv.shift();
        if (!name?.startsWith('--') || value === undefined || value.startsWith('--'))
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        options[name.slice(2)] = value;
    }
    return { command, options };
}

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value)
{
    const resolved = path.resolve(file);
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${Date.now().toString(36)}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, resolved);
}

function required(options, name)
{
    if (typeof options[name] !== 'string' || options[name].length === 0)
    {
        throw new Error(`--${name} is required`);
    }
    return options[name];
}

function requiredPath(options, name)
{
    return path.resolve(required(options, name));
}

function boundedInteger(value, minimum, maximum, label)
{
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    {
        throw new Error(`--${label} must be ${minimum}..${maximum}`);
    }
    return parsed;
}

function isIsoUtc(value)
{
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(String(value ?? '')) && Number.isFinite(Date.parse(value));
}

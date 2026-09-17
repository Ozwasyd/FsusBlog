#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { readRolloutState } from './release-rollout-lib.mjs';

const schema = 'fsusblog.release-resource-budget-evidence.v1';

let options;
try
{
    options = parseArgs(process.argv.slice(2));
    const policy = readPolicy(options.policy);
    const rollout = readRolloutState(options.rolloutState);
    const state = {
        rolloutId: rollout.rolloutId,
        startedAtUtc: new Date().toISOString(),
        hostCapacity: {
            cpuCores: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
            memoryMiB: os.totalmem() / (1024 * 1024)
        },
        samples: [],
        errors: [],
        stopping: false,
        stopReason: null
    };
    const stop = reason =>
    {
        state.stopping = true;
        state.stopReason ??= reason;
    };
    process.once('SIGINT', () => stop('signal:SIGINT'));
    process.once('SIGTERM', () => stop('signal:SIGTERM'));
    process.once('SIGHUP', () => stop('signal:SIGHUP'));
    fs.rmSync(options.stopFile, { force: true });
    while (!state.stopping)
    {
        if (fs.existsSync(options.stopFile))
        {
            stop('stop-file');
        }
        if (state.stopping)
        {
            break;
        }
        sample(state, options);
        writeJsonAtomic(options.snapshot, buildReport(state, options, policy, false));
        await delay(policy.sampling.intervalMs);
    }
    const report = buildReport(state, options, policy, true);
    writeJsonAtomic(options.out, report);
    writeJsonAtomic(options.snapshot, report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== 'pass')
    {
        process.exitCode = 1;
    }
}
catch (error)
{
    process.stderr.write(`[release-resource-probe] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}

function parseArgs(argv)
{
    const parsed = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value === undefined)
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        parsed[name.slice(2)] = value;
    }
    for (const name of ['rollout-state', 'source-container', 'target-container', 'policy', 'snapshot', 'out', 'stop-file'])
    {
        if (!parsed[name])
        {
            throw new Error(`--${name} is required`);
        }
    }
    return {
        rolloutState: path.resolve(parsed['rollout-state']),
        sourceContainer: safeContainer(parsed['source-container']),
        targetContainer: safeContainer(parsed['target-container']),
        policy: path.resolve(parsed.policy),
        snapshot: path.resolve(parsed.snapshot),
        out: path.resolve(parsed.out),
        stopFile: path.resolve(parsed['stop-file']),
        diskPath: path.resolve(parsed['disk-path'] ?? '/var/lib/docker'),
        gatewayEvidence: optionalPath(parsed['gateway-evidence']),
        drainEvidence: optionalPath(parsed['drain-evidence']),
        notificationEvidence: optionalPath(parsed['notification-evidence']),
        trafficEvidence: optionalPath(parsed['traffic-evidence'])
    };
}

function readPolicy(file)
{
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.schema !== 'fsusblog.zero-downtime-resource-policy.v1')
    {
        throw new Error('resource policy schema is invalid');
    }
    for (const field of ['cpuCores', 'memoryMiB', 'freeDiskMiB'])
    {
        positive(value.minimumSupported?.[field], `minimumSupported.${field}`);
    }
    for (const field of ['dualSlotCpuPercent', 'dualSlotMemoryMiB', 'temporaryDiskMiB', 'activeTrafficP95ImpactPercent', 'activeTrafficP99ImpactPercent', 'openRestyReloadMs', 'drainMs', 'notificationReconnectMs'])
    {
        positive(value.budgets?.[field], `budgets.${field}`);
    }
    value.sampling.intervalMs = bounded(value.sampling?.intervalMs, 250, 60_000, 'sampling.intervalMs');
    value.sampling.minimumOverlapSamples = bounded(value.sampling?.minimumOverlapSamples, 1, 100_000, 'sampling.minimumOverlapSamples');
    return value;
}

function sample(state, options)
{
    const rollout = readRolloutState(options.rolloutState);
    const source = dockerStats(options.sourceContainer);
    const target = dockerStats(options.targetContainer);
    const disk = diskStats(options.diskPath);
    if (source.error && !rollout.completedStages.includes('source-stop'))
    {
        state.errors.push({ component: 'source', error: source.error, observedAtUtc: new Date().toISOString() });
    }
    if (target.error && rollout.completedStages.includes('candidate-start'))
    {
        state.errors.push({ component: 'target', error: target.error, observedAtUtc: new Date().toISOString() });
    }
    if (disk.error)
    {
        state.errors.push({ component: 'disk', error: disk.error, observedAtUtc: new Date().toISOString() });
    }
    state.samples.push({
        observedAtUtc: new Date().toISOString(),
        rolloutStage: rollout.currentStage ?? `status:${rollout.status}`,
        source,
        target,
        disk
    });
}

function dockerStats(container)
{
    const result = spawnSync('docker', [
        'stats', '--no-stream', '--format', '{{json .}}', container
    ], { encoding: 'utf8', timeout: 15_000 });
    if (result.status !== 0)
    {
        return { available: false, cpuPercent: 0, memoryMiB: 0, pids: 0, error: cleanError(result) };
    }
    let value;
    try
    {
        value = JSON.parse(result.stdout.trim());
    }
    catch (error)
    {
        return { available: false, cpuPercent: 0, memoryMiB: 0, pids: 0, error: `invalid docker stats JSON: ${error.message}` };
    }
    return {
        available: true,
        cpuPercent: parsePercent(value.CPUPerc),
        memoryMiB: parseBytes(String(value.MemUsage ?? '').split('/')[0].trim()) / (1024 * 1024),
        memoryPercent: parsePercent(value.MemPerc),
        pids: Number.parseInt(value.PIDs, 10) || 0,
        error: null
    };
}

function diskStats(target)
{
    const result = spawnSync('df', ['-Pk', target], { encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0)
    {
        return { available: false, usedMiB: 0, freeMiB: 0, error: cleanError(result) };
    }
    const row = result.stdout.trim().split(/\r?\n/u).at(-1)?.trim().split(/\s+/u) ?? [];
    const usedKiB = Number(row[2]);
    const freeKiB = Number(row[3]);
    if (!Number.isFinite(usedKiB) || !Number.isFinite(freeKiB))
    {
        return { available: false, usedMiB: 0, freeMiB: 0, error: 'df output is invalid' };
    }
    return { available: true, usedMiB: usedKiB / 1024, freeMiB: freeKiB / 1024, error: null };
}

function buildReport(state, options, policy, final)
{
    const overlap = state.samples.filter(item => item.source.available && item.target.available);
    const cpuPeak = max(overlap.map(item => item.source.cpuPercent + item.target.cpuPercent));
    const memoryPeak = max(overlap.map(item => item.source.memoryMiB + item.target.memoryMiB));
    const diskValues = state.samples.filter(item => item.disk.available).map(item => item.disk.usedMiB);
    const diskGrowth = diskValues.length > 0 ? Math.max(0, max(diskValues) - diskValues[0]) : null;
    const initialFreeDiskMiB = state.samples.find(item => item.disk.available)?.disk.freeMiB ?? null;
    const gateway = optionalJson(options.gatewayEvidence);
    const drain = optionalJson(options.drainEvidence);
    const notification = optionalJson(options.notificationEvidence);
    const traffic = optionalJson(options.trafficEvidence);
    const checks = {
        minimumCpuCores: state.hostCapacity.cpuCores >= policy.minimumSupported.cpuCores,
        minimumMemory: state.hostCapacity.memoryMiB >= policy.minimumSupported.memoryMiB,
        minimumFreeDisk: initialFreeDiskMiB !== null && initialFreeDiskMiB >= policy.minimumSupported.freeDiskMiB,
        overlapSamples: overlap.length >= policy.sampling.minimumOverlapSamples,
        dualSlotCpu: cpuPeak !== null && cpuPeak <= policy.budgets.dualSlotCpuPercent,
        dualSlotMemory: memoryPeak !== null && memoryPeak <= policy.budgets.dualSlotMemoryMiB,
        temporaryDisk: diskGrowth !== null && diskGrowth <= policy.budgets.temporaryDiskMiB,
        openRestyReload: metricWithin(gateway?.durationMs, policy.budgets.openRestyReloadMs),
        drain: metricWithin(durationFrom(drain), policy.budgets.drainMs),
        notificationReconnect: metricWithin(notification?.reconnectDurationMs, policy.budgets.notificationReconnectMs),
        trafficP95Impact: metricWithin(traffic?.impactPercent?.p95, policy.budgets.activeTrafficP95ImpactPercent),
        trafficP99Impact: metricWithin(traffic?.impactPercent?.p99, policy.budgets.activeTrafficP99ImpactPercent)
    };
    const errors = [...state.errors];
    if (final)
    {
        for (const [name, pass] of Object.entries(checks))
        {
            if (!pass)
            {
                errors.push({ component: name, error: 'resource budget evidence missing or exceeded' });
            }
        }
    }
    return {
        schema,
        status: final ? (errors.length === 0 ? 'pass' : 'fail') : 'running',
        rolloutId: state.rolloutId,
        startedAtUtc: state.startedAtUtc,
        completedAtUtc: final ? new Date().toISOString() : null,
        stopReason: state.stopReason,
        withinBudget: final && errors.length === 0,
        minimumSupported: policy.minimumSupported,
        observedHostCapacity: {
            ...state.hostCapacity,
            initialFreeDiskMiB
        },
        budgets: policy.budgets,
        measurements: {
            sampleCount: state.samples.length,
            overlapSampleCount: overlap.length,
            dualSlotCpuPeakPercent: cpuPeak,
            dualSlotMemoryPeakMiB: memoryPeak,
            temporaryDiskPeakMiB: diskGrowth,
            openRestyReloadMs: gateway?.durationMs ?? null,
            drainMs: durationFrom(drain),
            notificationReconnectMs: notification?.reconnectDurationMs ?? null,
            activeTrafficP95ImpactPercent: traffic?.impactPercent?.p95 ?? null,
            activeTrafficP99ImpactPercent: traffic?.impactPercent?.p99 ?? null
        },
        checks,
        errors,
        samples: final ? state.samples : state.samples.slice(-10)
    };
}

function durationFrom(value)
{
    if (Number.isFinite(value?.durationMs))
    {
        return value.durationMs;
    }
    const started = Date.parse(value?.startedAtUtc ?? value?.snapshot?.drain?.startedAtUtc ?? '');
    const completed = Date.parse(value?.completedAtUtc ?? value?.snapshot?.drain?.completedAtUtc ?? '');
    return Number.isFinite(started) && Number.isFinite(completed) && completed >= started ? completed - started : null;
}

function optionalJson(file)
{
    if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile())
    {
        return null;
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function metricWithin(value, budget)
{
    return Number.isFinite(value) && value >= 0 && value <= budget;
}

function parsePercent(value)
{
    const parsed = Number.parseFloat(String(value ?? '').replace('%', ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function parseBytes(value)
{
    const match = /^([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?i?B)$/iu.exec(value);
    if (!match)
    {
        return 0;
    }
    const powers = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4 };
    return Number(match[1]) * (1024 ** powers[match[2].toUpperCase()]);
}

function cleanError(result)
{
    return String(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 500);
}

function safeContainer(value)
{
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(String(value ?? '')))
    {
        throw new Error('container name is invalid');
    }
    return value;
}

function optionalPath(value)
{
    return value ? path.resolve(value) : null;
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
}

function positive(value, label)
{
    if (!(Number(value) > 0))
    {
        throw new Error(`${label} must be positive`);
    }
}

function bounded(value, minimum, maximum, label)
{
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    {
        throw new Error(`${label} is invalid`);
    }
    return parsed;
}

function max(values)
{
    return values.length > 0 ? Math.max(...values) : null;
}

function delay(milliseconds)
{
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

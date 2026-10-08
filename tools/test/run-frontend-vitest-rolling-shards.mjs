#!/usr/bin/env node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
    invalidateTransformCache,
    prepareTransformCache,
    sealTransformCache,
    transformCacheEnvironment
} from './frontend-vitest-transform-cache.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontendRoot = path.join(root, 'src/frontend');
const testResultsRoot = path.resolve(process.env.FSUSBLOG_TEST_RESULTS_ROOT
    ?? path.join(root, '.tmp/test-results'));
const coverageRoot = path.resolve(process.env.FSUSBLOG_COVERAGE_ROOT
    ?? path.join(root, '.tmp/coverage'));
const outputRoot = path.join(testResultsRoot, 'vitest/production-rolling');
const blobRoot = path.join(outputRoot, 'blobs');
const coverageShardRoot = path.join(coverageRoot, 'frontend-vitest-shards');
const rawCatalogFile = path.join(outputRoot, 'catalog.raw.json');
const catalogFile = path.join(outputRoot, 'catalog.json');
const mergedJson = path.join(outputRoot, 'merged.json');
const mergedJunit = path.join(outputRoot, 'merged.xml');
const frontendRequire = createRequire(path.join(frontendRoot, 'package.json'));
const vitestEntry = path.join(path.dirname(frontendRequire.resolve('vitest/package.json')), 'vitest.mjs');
const catalogSchema = 'fsusblog.frontend-vitest-catalog.v1';
const summarySchema = 'fsusblog.frontend-vitest-rolling.v2';
const activeChildren = new Set();

function stable(value)
{
    if (Array.isArray(value))
    {
        return value.map(stable);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]));
}

function digest(value)
{
    return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function canonicalVitestName(name)
{
    return String(name ?? '').replace(/\s*>\s*/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function canonicalVitestId(file, name)
{
    const normalizedFile = path.relative(root, path.resolve(file)).replaceAll(path.sep, '/');
    return `vitest:${normalizedFile}#${canonicalVitestName(name)}`;
}

function canonicalVitestFile(file)
{
    return path.relative(root, path.resolve(file)).replaceAll(path.sep, '/');
}

function catalogFiles(catalog)
{
    if (Array.isArray(catalog))
    {
        const grouped = new Map();
        for (const entry of catalog)
        {
            const key = path.resolve(entry.file);
            const file = grouped.get(key) ?? { file: key, projectName: entry.projectName ?? null, tests: [] };
            if (entry.name)
            {
                file.tests.push(entry.name);
            }
            grouped.set(key, file);
        }
        return [...grouped.values()];
    }
    return catalog?.files ?? [];
}

function assertionName(assertion)
{
    if (Array.isArray(assertion.ancestorTitles) && assertion.title)
    {
        return [...assertion.ancestorTitles, assertion.title].join(' ');
    }
    return assertion.fullName || assertion.title;
}

export function validateExactVitestExecution(catalog, reports)
{
    const files = catalogFiles(catalog);
    const expectedFiles = files.map((entry) => canonicalVitestFile(entry.file));
    const expectedTests = files.flatMap((entry) => entry.tests.map((name) => canonicalVitestId(entry.file, name)));
    const reportedFiles = reports.flatMap((report) => (report.testResults ?? []).map((testFile) => ({
        file: canonicalVitestFile(testFile.name),
        assertions: testFile.assertionResults ?? []
    })));
    const expectedFileSet = new Set(expectedFiles);
    const reportedFileSet = new Set(reportedFiles.map((entry) => entry.file));
    const expectedTestSet = new Set(expectedTests);
    const duplicateFiles = reportedFiles.filter((entry, index) =>
        reportedFiles.findIndex((candidate) => candidate.file === entry.file) !== index);
    const missingFiles = [...expectedFileSet].filter((file) => !reportedFileSet.has(file));
    const unexpectedFiles = [...reportedFileSet].filter((file) => !expectedFileSet.has(file));
    const emptyFiles = reportedFiles.filter((entry) => entry.assertions.length === 0).map((entry) => entry.file);
    const tests = reportedFiles.flatMap((entry) => entry.assertions.map((assertion) => ({
        id: canonicalVitestId(entry.file, assertionName(assertion)),
        status: assertion.status
    })));
    const reportedTestSet = new Set(tests.map((entry) => entry.id));
    const duplicateTests = tests.filter((entry, index) => tests.findIndex((candidate) => candidate.id === entry.id) !== index);
    const missingTests = [...expectedTestSet].filter((id) => !reportedTestSet.has(id));
    const unexpectedTests = [...reportedTestSet].filter((id) => !expectedTestSet.has(id));
    const failedTests = tests.filter((entry) => entry.status !== 'passed');
    if (expectedFileSet.size !== expectedFiles.length || expectedTestSet.size !== expectedTests.length
    || duplicateFiles.length || missingFiles.length || unexpectedFiles.length || emptyFiles.length
    || duplicateTests.length || missingTests.length || unexpectedTests.length || failedTests.length)
    {
        throw new Error('Vitest exact execution failed:'
      + ` duplicateFiles=${duplicateFiles.length} missingFiles=${missingFiles.length}`
      + ` unexpectedFiles=${unexpectedFiles.length} emptyFiles=${emptyFiles.length}`
      + ` duplicateTests=${duplicateTests.length} missingTests=${missingTests.length}`
      + ` unexpectedTests=${unexpectedTests.length} failedTests=${failedTests.length}`);
    }
    return {
        catalogFileCount: expectedFiles.length,
        catalogTestIdCount: expectedTests.length,
        executedFileCount: reportedFiles.length,
        executedTestIdCount: tests.length,
        exactOnce: true
    };
}

function readPositive(value)
{
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readPositiveInteger(value)
{
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveSingleHostWorkers(env = process.env, hostCpu = os.availableParallelism?.() ?? os.cpus().length)
{
    const granted = readPositive(env.FSUSBLOG_VITEST_TARGET_WORKERS)
    ?? readPositive(env.FSUSBLOG_STEP_CPU_BUDGET)
    ?? readPositive(env.FSUSBLOG_BUNDLE_CPU_UNITS)
    ?? readPositive(env.FSUSBLOG_BUNDLE_CPU_BUDGET)
    ?? hostCpu;
    return Math.max(1, Math.min(Math.floor(hostCpu), Math.floor(granted)));
}

export function resolveRollingVitestTopology({
    machineCpu = os.availableParallelism?.() ?? os.cpus().length,
    machineMemoryGiB = os.totalmem() / 1024 ** 3,
    fileCount,
    explicitHostLimit = readPositiveInteger(process.env.FSUSBLOG_VITEST_HOST_LIMIT)
} = {})
{
    const cpu = Math.max(1, Math.floor(readPositive(machineCpu) ?? 1));
    const memoryGiB = Math.max(0.25, readPositive(machineMemoryGiB) ?? 0.25);
    const files = Math.max(1, Math.floor(readPositive(fileCount) ?? 1));
    const preferredWorkersPerHost = cpu <= Math.sqrt(cpu * 16) ? Math.min(2, cpu) : Math.min(4, cpu);
    const baseMemoryGiB = Math.max(0.125, Math.min(0.75, memoryGiB / Math.max(2, cpu * 2)));
    const memoryPerWorkerGiB = Math.max(0.125, baseMemoryGiB / 2);
    const derivedHostLimit = Math.max(1, Math.ceil(Math.sqrt(cpu * 2)));
    const memoryHostLimit = Math.max(1, Math.floor(memoryGiB / (baseMemoryGiB + memoryPerWorkerGiB)));
    const hostLimit = Math.max(1, Math.min(
        files,
        derivedHostLimit,
        memoryHostLimit,
        explicitHostLimit ?? Number.POSITIVE_INFINITY
    ));
    const partitionCount = Math.min(files, Math.max(
        hostLimit + (files > hostLimit ? 1 : 0),
        Math.ceil(hostLimit * 1.5)
    ));
    return {
        machineCpu: cpu,
        machineMemoryGiB: memoryGiB,
        preferredWorkersPerHost,
        hostLimit,
        partitionCount,
        baseMemoryGiB,
        memoryPerWorkerGiB
    };
}

function fileFallbackWeight(entry)
{
    const bytes = (() =>
    {
        try
        {
            return fs.statSync(entry.file).size;
        }
        catch
        {
            return 0;
        }
    })();
    return Math.max(1, entry.tests.length * 4 + Math.ceil(bytes / 1024));
}

export function planRollingVitestPartitions(catalog, topology)
{
    const files = catalogFiles(catalog).map((entry) => ({
        ...entry,
        weight: fileFallbackWeight(entry),
        weightSource: 'deterministic-file-size-and-test-count'
    })).sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));
    const isolatedFiles = files.filter((entry) => entry.hostMaxWorkers === 1);
    const ordinaryFiles = files.filter((entry) => entry.hostMaxWorkers !== 1);
    const minimumCount = isolatedFiles.length + (ordinaryFiles.length > 0 ? 1 : 0);
    const count = Math.max(1, Math.min(files.length, Math.max(topology.partitionCount, minimumCount)));
    const partitions = Array.from({ length: count }, (_, index) => ({
        id: `partition-${String(index + 1).padStart(String(count).length, '0')}`,
        files: [],
        weight: 0,
        coverageUniverseOwner: false,
        hostMaxWorkers: null,
        exclusiveHost: false
    }));
    isolatedFiles.forEach((file, index) =>
    {
        partitions[index].files.push(file);
        partitions[index].weight += file.weight;
        partitions[index].hostMaxWorkers = 1;
        partitions[index].exclusiveHost = true;
    });
    const ordinaryPartitions = partitions.slice(isolatedFiles.length);
    for (const file of ordinaryFiles)
    {
        const selected = [...ordinaryPartitions].sort((left, right) => left.weight - right.weight || left.id.localeCompare(right.id))[0];
        selected.files.push(file);
        selected.weight += file.weight;
    }
    for (const partition of partitions)
    {
        partition.files.sort((left, right) => left.file.localeCompare(right.file));
        partition.identityDigest = digest({
            catalogIdentityDigest: catalog.identityDigest,
            id: partition.id,
            hostMaxWorkers: partition.hostMaxWorkers,
            exclusiveHost: partition.exclusiveHost,
            files: partition.files.map((entry) => ({ file: canonicalVitestFile(entry.file), projectName: entry.projectName }))
        });
    }
    return partitions.sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id));
}

export function readLiveVitestGrant(env = process.env, readFile = (file) => fs.readFileSync(file, 'utf8'))
{
    const grantFile = String(env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE ?? '').trim();
    const tierId = String(env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID ?? '').trim();
    if (Boolean(grantFile) !== Boolean(tierId))
    {
        throw new Error('rolling Vitest live grant requires both grant file and tier id');
    }
    if (grantFile)
    {
        const document = JSON.parse(readFile(grantFile));
        if (document?.schema !== 'fsusblog.test-matrix.resource-grants.v1')
        {
            throw new Error('rolling Vitest grant schema is invalid');
        }
        if (String(document.runId) !== String(env.FSUSBLOG_TEST_RUN_ID))
        {
            throw new Error('rolling Vitest grant runId mismatch');
        }
        const grant = document.grants?.[tierId];
        const cpuUnits = readPositive(grant?.cpuUnits);
        const memoryGiB = readPositive(grant?.memoryGiB);
        if (!cpuUnits || !memoryGiB)
        {
            throw new Error(`rolling Vitest grant is missing or invalid for ${tierId}`);
        }
        const budgetCpuUnits = readPositive(document.resourceBudget?.cpuUnits);
        const budgetMemoryGiB = readPositive(document.resourceBudget?.memoryGiB);
        if (!Number.isInteger(cpuUnits) || !Number.isInteger(budgetCpuUnits)
            || !budgetMemoryGiB || cpuUnits > budgetCpuUnits || memoryGiB > budgetMemoryGiB)
        {
            throw new Error(`rolling Vitest grant exceeds or has an invalid parent resource budget for ${tierId}`);
        }
        return { cpuUnits, memoryGiB, source: 'scheduler-resource-grants' };
    }
    const cpuUnits = readPositive(env.FSUSBLOG_STEP_CPU_BUDGET)
    ?? readPositive(env.FSUSBLOG_BUNDLE_CPU_UNITS)
    ?? readPositive(env.FSUSBLOG_BUNDLE_CPU_BUDGET)
    ?? os.availableParallelism?.() ?? os.cpus().length;
    const memoryGiB = readPositive(env.FSUSBLOG_STEP_MEMORY_GIB)
    ?? readPositive(env.FSUSBLOG_BUNDLE_MEMORY_GIB)
    ?? os.freemem() / 1024 ** 3;
    return { cpuUnits, memoryGiB, source: 'inherited-step-grant' };
}

function nextHostShape(grant, topology, active, maxWorkers = topology.preferredWorkersPerHost)
{
    if (active.size >= topology.hostLimit)
    {
        return null;
    }
    const usedWorkers = [...active.values()].reduce((total, entry) => total + entry.workers, 0);
    const usedMemoryGiB = [...active.values()].reduce((total, entry) => total + entry.memoryGiB, 0);
    const availableWorkers = Math.max(0, Math.floor(grant.cpuUnits) - usedWorkers);
    const availableMemoryGiB = Math.max(0, grant.memoryGiB - usedMemoryGiB);
    for (let workers = Math.min(topology.preferredWorkersPerHost, maxWorkers, availableWorkers); workers >= 1; workers -= 1)
    {
        const memoryGiB = topology.baseMemoryGiB + workers * topology.memoryPerWorkerGiB;
        if (memoryGiB <= availableMemoryGiB + Number.EPSILON)
        {
            return { workers, memoryGiB };
        }
    }
    return null;
}

function compactGrant(grant)
{
    return { cpuUnits: Number(grant.cpuUnits), memoryGiB: Number(grant.memoryGiB), source: grant.source ?? null };
}

export async function runRollingVitestCoordinator({
    partitions,
    topology,
    readGrant,
    launchHost,
    pollIntervalMs = Math.max(25, Math.round(200 / Math.sqrt(Math.max(1, topology.machineCpu)))),
    deadlineAtMs = null,
    signal = null,
    cancelActive = null,
    cancellationGraceMs = 2000
})
{
    const pending = [...partitions];
    const active = new Map();
    const results = [];
    const grantHistory = [];
    let hostSequence = 0;
    let initialHostCount = null;
    let peakHostCount = 0;
    const abortPromise = signal ? new Promise((resolve) =>
{
    if (signal.aborted)
{
resolve({ aborted: true });
}
    else
{
signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true });
}
  }) : null;

    const drainActiveHosts = async () =>
    {
        if (active.size === 0)
        {
            return;
        }
        cancelActive?.('SIGTERM');
        const settlement = Promise.allSettled([...active.values()].map((entry) => entry.promise));
        let settled = false;
        const observedSettlement = settlement.then(() =>
        {
            settled = true;
        });
        await Promise.race([
            observedSettlement,
            delay(Math.max(1, cancellationGraceMs), undefined, { ref: false })
        ]);
        if (!settled)
        {
            cancelActive?.('SIGKILL');
            await settlement;
        }
    };

    try
    {
        while (pending.length > 0 || active.size > 0)
        {
            if (signal?.aborted)
            {
                throw Object.assign(new Error('rolling Vitest coordinator cancelled'), { code: 'ABORT_ERR' });
            }
            if (deadlineAtMs !== null && Date.now() >= deadlineAtMs)
            {
                throw new Error('rolling Vitest coordinator exceeded its step deadline');
            }
            const grant = compactGrant(await readGrant());
            const previousGrant = grantHistory.at(-1);
            if (!previousGrant || previousGrant.cpuUnits !== grant.cpuUnits || previousGrant.memoryGiB !== grant.memoryGiB)
            {
                grantHistory.push({ ...grant, observedAtMs: Date.now(), activeHosts: active.size, pendingPartitions: pending.length });
            }
            let admitted = 0;
            while (pending.length > 0)
            {
                const partition = pending[0];
                const activeHasExclusiveHost = [...active.values()].some((entry) => entry.partition.exclusiveHost);
                if (activeHasExclusiveHost || (partition.exclusiveHost && active.size > 0))
                {
                    break;
                }
                const shape = nextHostShape(grant, topology, active, partition.hostMaxWorkers ?? topology.preferredWorkersPerHost);
                if (!shape)
                {
                    break;
                }
                pending.shift();
                const hostId = `host-${String(++hostSequence).padStart(2, '0')}`;
                const entry = {
                    hostId,
                    partition,
                    ...shape,
                    promise: Promise.resolve().then(() => launchHost({ hostId, partition, ...shape }))
                        .then((result) => ({ hostId, result }), (error) => ({ hostId, result: { code: 1, error } }))
                };
                active.set(hostId, entry);
                admitted += 1;
                peakHostCount = Math.max(peakHostCount, active.size);
            }
            if (initialHostCount === null)
            {
                initialHostCount = active.size;
            }
            if (pending.length > 0 && active.size === 0 && admitted === 0)
            {
                throw new Error(`rolling Vitest grant cannot admit one host: cpu=${grant.cpuUnits} memoryGiB=${grant.memoryGiB}`);
            }
            if (active.size === 0)
            {
                continue;
            }
            const races = [...active.values()].map((entry) => entry.promise);
            races.push(delay(pollIntervalMs).then(() => ({ poll: true })));
            if (abortPromise)
            {
                races.push(abortPromise);
            }
            const outcome = await Promise.race(races);
            if (outcome.aborted)
            {
                throw Object.assign(new Error('rolling Vitest coordinator cancelled'), { code: 'ABORT_ERR' });
            }
            if (outcome.poll)
            {
                continue;
            }
            const entry = active.get(outcome.hostId);
            active.delete(outcome.hostId);
            results.push({
                hostId: outcome.hostId,
                partitionId: entry.partition.id,
                workers: entry.workers,
                memoryGiB: entry.memoryGiB,
                ...outcome.result
            });
        }
    }
    catch (error)
    {
        await drainActiveHosts();
        throw error;
    }
    return { results, grantHistory, initialHostCount: initialHostCount ?? 0, peakHostCount };
}

function terminateAllChildren(signal = 'SIGTERM')
{
    for (const child of activeChildren)
    {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        {
            continue;
        }
        try
        {
            process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
        }
        catch
        {
            // The child may have exited between the status check and signal.
        }
    }
}

function transformCacheFiles(directory, { followSymlinks = false } = {})
{
    if (!fs.existsSync(directory))
    {
        return [];
    }
    const files = [];
    const visit = (current) =>
    {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)))
        {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory())
            {
                visit(absolute);
            }
            else if (entry.isFile() || (followSymlinks && entry.isSymbolicLink()))
            {
                files.push(absolute);
            }
        }
    };
    visit(directory);
    return files;
}

function fileDigest(file)
{
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function createImmutableTransformBase(cachePath)
{
    const entries = transformCacheFiles(cachePath).map((file) => ({
        relative: path.relative(cachePath, file).replaceAll(path.sep, '/'),
        byteCount: fs.statSync(file).size,
        digest: fileDigest(file)
    }));
    return {
        cachePath,
        entries,
        fileCount: entries.length,
        byteCount: entries.reduce((total, entry) => total + entry.byteCount, 0),
        manifestDigest: digest(entries)
    };
}

export function verifyImmutableTransformBase(base)
{
    const current = createImmutableTransformBase(base.cachePath);
    if (current.manifestDigest !== base.manifestDigest)
    {
        throw new Error('immutable Vitest transform base was polluted during rolling execution');
    }
    return current;
}

export function createTransformDeltaForHost(cache, hostId, base)
{
    const hostRoot = path.join(cache.runRoot, 'host-caches', hostId);
    const hostCachePath = path.join(hostRoot, 'view');
    fs.rmSync(hostRoot, { recursive: true, force: true });
    fs.mkdirSync(hostCachePath, { recursive: true });
    let cloneMode = 'symlink-immutable-base';
    let linkedBaseEntries = 0;
    try
    {
        for (const entry of base.entries)
        {
            const target = path.join(hostCachePath, entry.relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.symlinkSync(path.join(base.cachePath, entry.relative), target, 'file');
            linkedBaseEntries += 1;
        }
    }
    catch (error)
    {
        fs.rmSync(hostCachePath, { recursive: true, force: true });
        fs.mkdirSync(hostCachePath, { recursive: true });
        try
        {
            fs.cpSync(base.cachePath, hostCachePath, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
            cloneMode = 'reflink-full-view-fallback';
            linkedBaseEntries = 0;
        }
        catch (fallbackError)
        {
            throw new Error(`Vitest transform base view failed in symlink and reflink modes: ${error.message}; ${fallbackError.message}`, { cause: fallbackError });
        }
    }
    return { hostRoot, hostCachePath, cloneMode, linkedBaseEntries, recordedPaths: new Set(), journalErrors: [] };
}

function startTransformDeltaJournal(host, base)
{
    const directories = new Set(['.']);
    for (const entry of base.entries)
    {
        directories.add(path.dirname(entry.relative));
    }
    const watchers = [...directories].map((relativeDirectory) =>
    {
        const directory = path.resolve(host.hostCachePath, relativeDirectory);
        return fs.watch(directory, (eventType, fileName) =>
        {
            if (!fileName)
            {
                host.journalErrors.push(`missing filename for ${eventType} in ${relativeDirectory}`);
                return;
            }
            const relative = path.join(relativeDirectory, String(fileName)).replaceAll(path.sep, '/');
            host.recordedPaths.add(relative);
        });
    });
    for (const watcher of watchers)
    {
        watcher.on('error', (error) => host.journalErrors.push(error.message));
    }
    return () => watchers.forEach((watcher) => watcher.close());
}

export function collectTransformDelta(base, host)
{
    if (host.journalErrors.length > 0)
    {
        throw new Error(`Vitest transform delta journal failed: ${host.journalErrors.join('; ')}`);
    }
    let viewTraversalCount = 0;
    let deltaBytes = 0;
    let deltaFiles = 0;
    const deltaEntries = [];
    const baseEntries = new Map(base.entries.map((entry) => [entry.relative, entry]));
    const pending = [...host.recordedPaths].sort();
    const observed = new Set();
    for (let index = 0; index < pending.length; index += 1)
    {
        const relative = pending[index];
        if (observed.has(relative))
        {
            continue;
        }
        observed.add(relative);
        viewTraversalCount += 1;
        const source = path.resolve(host.hostCachePath, relative);
        if (!isPathInside(host.hostCachePath, source))
        {
            throw new Error(`Vitest host cache journal escaped its view: ${relative}`);
        }
        const expectedBase = baseEntries.get(relative);
        let stat;
        try
        {
            stat = fs.lstatSync(source);
        }
        catch (error)
        {
            if (error.code === 'ENOENT' && expectedBase)
            {
                throw new Error(`Vitest host cache base view is incomplete: ${relative}`, { cause: error });
            }
            if (error.code === 'ENOENT')
            {
                continue;
            }
            throw error;
        }
        if (stat.isSymbolicLink())
        {
            const resolved = path.resolve(path.dirname(source), fs.readlinkSync(source));
            const expected = path.resolve(base.cachePath, relative);
            if (!expectedBase || resolved !== expected)
            {
                throw new Error(`Vitest host cache contains a polluted base link: ${relative}`);
            }
            continue;
        }
        if (stat.isDirectory())
        {
            for (const nested of transformCacheFiles(source))
            {
                const nestedRelative = path.relative(host.hostCachePath, nested).replaceAll(path.sep, '/');
                pending.push(nestedRelative);
            }
            continue;
        }
        if (!stat.isFile())
        {
            throw new Error(`Vitest host cache contains unsupported entry: ${relative}`);
        }
        if (host.cloneMode === 'reflink-full-view-fallback' && expectedBase
      && stat.size === expectedBase.byteCount && fileDigest(source) === expectedBase.digest)
        {
            continue;
        }
        deltaEntries.push({ relative, source });
        deltaFiles += 1;
        deltaBytes += stat.size;
    }
    return {
        deltaEntries,
        cloneMode: host.cloneMode,
        baseBytes: base.byteCount,
        deltaBytes,
        deltaFiles,
        viewTraversalCount,
        mergeTraversalCount: deltaFiles
    };
}

export function mergeIsolatedTransformCaches(baseCachePath, hostDeltas)
{
    let addedFiles = 0;
    let identicalFiles = 0;
    let metadataVariants = 0;
    const cachePayload = (buffer) =>
    {
        const marker = Buffer.from('\n//# vitestCache=');
        const index = buffer.lastIndexOf(marker);
        return index < 0 ? { executable: buffer, metadata: Buffer.alloc(0) } : {
      executable: buffer.subarray(0, index),
      metadata: buffer.subarray(index + marker.length)
    };
    };
    let mergeTraversalCount = 0;
    for (const hostDelta of hostDeltas)
    {
        const entries = Array.isArray(hostDelta)
            ? [...hostDelta].sort((left, right) => left.relative.localeCompare(right.relative))
            : transformCacheFiles(hostDelta).map((source) => ({
          relative: path.relative(hostDelta, source),
          source
        }));
        for (const { relative, source } of entries)
        {
            mergeTraversalCount += 1;
            const target = path.join(baseCachePath, relative);
            if (fs.existsSync(target))
            {
                const sourceBuffer = fs.readFileSync(source);
                const targetBuffer = fs.readFileSync(target);
                if (!sourceBuffer.equals(targetBuffer))
                {
                    const sourcePayload = cachePayload(sourceBuffer);
                    const targetPayload = cachePayload(targetBuffer);
                    if (!sourcePayload.executable.equals(targetPayload.executable))
                    {
                        throw new Error(`isolated Vitest transform cache executable conflict: ${relative}`);
                    }
                    // Vitest may serialize equivalent imported URLs as a bare or absolute
                    // value depending on which partition first reached the module. Keep
                    // the longer (more explicit) metadata deterministically; executable
                    // transformed code must remain byte-identical.
                    const sourcePreferred = sourcePayload.metadata.length > targetPayload.metadata.length
            || (sourcePayload.metadata.length === targetPayload.metadata.length
              && Buffer.compare(sourcePayload.metadata, targetPayload.metadata) < 0);
                    if (sourcePreferred)
                    {
                        fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
                    }
                    metadataVariants += 1;
                    continue;
                }
                identicalFiles += 1;
                continue;
            }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
            addedFiles += 1;
        }
    }
    return { hostCacheCount: hostDeltas.length, addedFiles, identicalFiles, metadataVariants, mergeTraversalCount };
}

function run(args, { env = process.env, logFile } = {})
{
    return new Promise((resolve) =>
    {
        const startedAtMs = Date.now();
        const child = spawn(process.execPath, [vitestEntry, ...args], {
            cwd: frontendRoot,
            env,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe']
        });
        activeChildren.add(child);
        const log = logFile ? fs.createWriteStream(logFile, { flags: 'w' }) : null;
        let settled = false;
        const finish = (result) =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            activeChildren.delete(child);
            log?.end();
            resolve({ ...result, startedAtMs, finishedAtMs: Date.now() });
        };
        for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]])
        {
            stream.on('data', (chunk) =>
            {
                log?.write(chunk);
                target.write(chunk);
            });
        }
        child.once('error', (error) => finish({ code: 1, signal: null, error }));
        child.once('close', (code, signal) => finish({ code: code ?? 1, signal }));
    });
}

async function requireSuccess(args, options)
{
    const result = await run(args, options);
    if (result.code !== 0 || result.signal || result.error)
    {
        throw result.error ?? new Error(`command failed (${result.signal ?? result.code}): ${process.execPath} ${vitestEntry} ${args.join(' ')}`);
    }
    return result;
}

function commonArguments()
{
    return [
        'run', '--config', 'vitest.production.config.ts',
        '--project=unit', '--project=property', '--project=model'
    ];
}

async function discoverCatalog(cache, cacheEnv)
{
    const startedAtMs = Date.now();
    await requireSuccess([
        'list', '--config', 'vitest.production.config.ts',
        '--project=unit', '--project=property', '--project=model', `--json=${rawCatalogFile}`
    ], { env: { ...process.env, ...cacheEnv }, logFile: path.join(outputRoot, 'catalog.log') });
    const raw = JSON.parse(fs.readFileSync(rawCatalogFile, 'utf8'));
    if (!Array.isArray(raw) || raw.length === 0)
    {
        throw new Error('Vitest authoritative test catalog is empty');
    }
    const files = catalogFiles(raw).map((entry) => ({
        file: path.resolve(entry.file),
        projectName: entry.projectName,
        tests: [...entry.tests].sort(),
        hostMaxWorkers: /@fsusblog-vitest-host\s+max-workers=1\b/u.test(fs.readFileSync(entry.file, 'utf8')) ? 1 : null
    })).sort((left, right) => left.file.localeCompare(right.file));
    const identity = {
        source: cache.identity.source,
        configDigest: cache.identity.configDigest,
        tools: cache.identity.tools,
        environment: cache.identity.environment,
        transformCacheIdentityDigest: cache.identity.identityDigest,
        projects: ['unit', 'property', 'model']
    };
    const catalog = {
        schema: catalogSchema,
        identity,
        identityDigest: digest(identity),
        discoveredAtMs: startedAtMs,
        discoveryDurationMs: Date.now() - startedAtMs,
        files,
        fileCount: files.length,
        testIdCount: files.reduce((total, entry) => total + entry.tests.length, 0)
    };
    const ids = files.flatMap((entry) => entry.tests.map((name) => canonicalVitestId(entry.file, name)));
    if (new Set(ids).size !== ids.length)
    {
        throw new Error('Vitest authoritative catalog contains duplicate canonical test IDs');
    }
    fs.writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
    return catalog;
}

function rollingHostEnvironment({ hostId, partition, workers, cacheEnv })
{
    return {
        ...process.env,
        ...cacheEnv,
        FSUSBLOG_VITEST_LANE: 'production-rolling-host',
        FSUSBLOG_VITEST_ROLLING_HOST: '1',
        FSUSBLOG_VITEST_COVERAGE_UNIVERSE_OWNER: partition.coverageUniverseOwner ? '1' : '0',
        FSUSBLOG_VITEST_REPORT_ID: hostId,
        FSUSBLOG_VITEST_PARTITION_ID: partition.id,
        FSUSBLOG_VITEST_PARTITION_IDENTITY: partition.identityDigest,
        FSUSBLOG_VITEST_MAX_WORKERS: String(workers),
        FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD: '0',
        FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD: '0',
        FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD: '0',
        FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD: '0'
    };
}

function reportMetrics(report, execution)
{
    const testFiles = report.testResults ?? [];
    const firstTestAtMs = Math.min(...testFiles.map((entry) => Number(entry.startTime)).filter(Number.isFinite));
    return {
        hostStartupMs: Number.isFinite(firstTestAtMs) ? Math.max(0, firstTestAtMs - execution.startedAtMs) : null,
        timeToFirstTestMs: Number.isFinite(firstTestAtMs) ? Math.max(0, firstTestAtMs - execution.startedAtMs) : null,
        fileRuntimeMs: Object.fromEntries(testFiles.map((entry) => [
            canonicalVitestFile(entry.name),
            Math.max(0, Number(entry.endTime) - Number(entry.startTime))
        ]))
    };
}

async function runPartitionHost({ hostId, partition, workers, cacheEnv, cache })
{
    const json = path.join(outputRoot, `${hostId}-${partition.id}.json`);
    const junit = path.join(outputRoot, `${hostId}-${partition.id}.xml`);
    const blob = path.join(blobRoot, `${hostId}-${partition.id}.blob`);
    const coverage = path.join(coverageShardRoot, `${hostId}-${partition.id}`);
    const host = createTransformDeltaForHost(cache, hostId, cache.immutableBase);
    const stopDeltaJournal = startTransformDeltaJournal(host, cache.immutableBase);
    const hostCachePath = host.hostCachePath;
    const hostCacheEnv = {
        ...cacheEnv,
        FSUSBLOG_VITEST_TRANSFORM_CACHE_PATH: hostCachePath
    };
    let execution;
    try
    {
        execution = await run([
            ...commonArguments(), ...partition.files.map((entry) => entry.file), '--coverage',
            '--coverage.all=false',
            '--coverage.reporter=json', `--maxWorkers=${workers}`,
            '--reporter=default', '--reporter=json', '--reporter=junit', '--reporter=blob',
            `--outputFile.json=${json}`, `--outputFile.junit=${junit}`, `--outputFile.blob=${blob}`,
            `--coverage.reportsDirectory=${coverage}`
        ], {
            env: rollingHostEnvironment({ hostId, partition, workers, cacheEnv: hostCacheEnv }),
            logFile: path.join(outputRoot, `${hostId}-${partition.id}.log`)
        });
        await delay(10);
    }
    finally
    {
        stopDeltaJournal();
    }
    const transformDelta = collectTransformDelta(cache.immutableBase, host);
    const report = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : null;
    return {
        code: execution.code,
        signal: execution.signal,
        error: execution.error ? String(execution.error.message ?? execution.error) : null,
        status: execution.code === 0 && !execution.signal && report?.success === true ? 'success' : 'failure',
        durationMs: execution.finishedAtMs - execution.startedAtMs,
        startedAtMs: execution.startedAtMs,
        finishedAtMs: execution.finishedAtMs,
        json,
        junit,
        blob,
        coverage,
        coverageUniverseOwner: partition.coverageUniverseOwner,
        partitionIdentityDigest: partition.identityDigest,
        hostCachePath,
        transformCache: {
            observedWarmFileCount: cache.immutableBase.fileCount,
            observedWarmByteCount: cache.immutableBase.byteCount,
            growthFileCount: transformDelta.deltaFiles,
            growthByteCount: transformDelta.deltaBytes,
            ...transformDelta
        },
        metrics: report ? reportMetrics(report, execution) : null
    };
}

function coverageCountersAreZero(fileCoverage)
{
    return Object.values(fileCoverage.s ?? {}).every((value) => Number(value) === 0)
    && Object.values(fileCoverage.f ?? {}).every((value) => Number(value) === 0)
    && Object.values(fileCoverage.b ?? {}).flat().every((value) => Number(value) === 0);
}

export function validateZeroHitCoverageUniverse(universeFile)
{
    const universe = JSON.parse(fs.readFileSync(universeFile, 'utf8'));
    const files = Object.keys(universe);
    if (files.length === 0)
    {
        throw new Error('frontend zero-hit coverage universe is empty');
    }
    const hitFiles = files.filter((file) => !coverageCountersAreZero(universe[file]));
    if (hitFiles.length > 0)
    {
        throw new Error(`frontend coverage universe contains execution hits: ${hitFiles.length}`);
    }
    return { fileCount: files.length, zeroHit: true, digest: digest(universe) };
}

async function buildZeroHitCoverageUniverse(cacheEnv, workers)
{
    const reportsDirectory = path.join(coverageShardRoot, 'universe');
    const universeFile = path.join(reportsDirectory, 'coverage-final.json');
    const execution = await requireSuccess([
        ...commonArguments(), path.join(outputRoot, '__coverage-universe-no-tests__.test.ts'),
        '--passWithNoTests', '--coverage', '--coverage.all=true', '--coverage.reporter=json',
        `--coverage.reportsDirectory=${reportsDirectory}`, `--maxWorkers=${Math.max(1, workers)}`,
        '--reporter=default'
    ], {
        env: {
            ...process.env,
            ...cacheEnv,
            FSUSBLOG_VITEST_LANE: 'production-coverage-universe',
            FSUSBLOG_VITEST_ROLLING_HOST: '1',
            FSUSBLOG_VITEST_COVERAGE_UNIVERSE_OWNER: '1',
            FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD: '0',
            FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD: '0',
            FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD: '0',
            FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD: '0'
        },
        logFile: path.join(outputRoot, 'coverage-universe.log')
    });
    return {
        universeFile,
        executionDurationMs: execution.finishedAtMs - execution.startedAtMs,
        processStartupCount: 1,
        ...validateZeroHitCoverageUniverse(universeFile)
    };
}

export function mergeCoordinatorReports(reports, junitFiles, { jsonFile = mergedJson, junitFile = mergedJunit } = {})
{
    if (reports.length === 0 || reports.length !== junitFiles.length)
    {
        throw new Error('coordinator report merge requires matching non-empty JSON and JUnit inputs');
    }
    const testResults = reports.flatMap((report) => report.testResults ?? []);
    const sum = (key) => reports.reduce((total, report) => total + Number(report[key] ?? 0), 0);
    const merged = {
        numTotalTestSuites: sum('numTotalTestSuites'),
        numPassedTestSuites: sum('numPassedTestSuites'),
        numFailedTestSuites: sum('numFailedTestSuites'),
        numPendingTestSuites: sum('numPendingTestSuites'),
        numTotalTests: sum('numTotalTests'),
        numPassedTests: sum('numPassedTests'),
        numFailedTests: sum('numFailedTests'),
        numPendingTests: sum('numPendingTests'),
        numTodoTests: sum('numTodoTests'),
        snapshot: reports[0].snapshot,
        startTime: Math.min(...reports.map((report) => Number(report.startTime)).filter(Number.isFinite)),
        success: reports.every((report) => report.success === true),
        testResults
    };
    const suites = junitFiles.map((file) =>
    {
        const xml = fs.readFileSync(file, 'utf8');
        const match = xml.match(/<testsuites\b[^>]*>([\s\S]*)<\/testsuites>\s*$/u);
        if (!match)
        {
            throw new Error(`coordinator JUnit input is invalid: ${file}`);
        }
        return match[1].trim();
    });
    fs.writeFileSync(jsonFile, `${JSON.stringify(merged, null, 2)}\n`);
    fs.writeFileSync(junitFile,
        `<?xml version="1.0" encoding="UTF-8" ?>\n<testsuites name="vitest production rolling" tests="${merged.numTotalTests}" failures="${merged.numFailedTests}">\n${suites.join('\n')}\n</testsuites>\n`);
    return { jsonReportCount: reports.length, junitReportCount: junitFiles.length, testResultCount: testResults.length, processStartupCount: 0 };
}

function isPathInside(parent, candidate)
{
    const relativePath = path.relative(parent, candidate);
    return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

export function isFrontendCoverageOwnedFile(file, {
    repositoryRoot = root,
    frontendDirectory = frontendRoot
} = {})
{
    const absoluteFile = path.resolve(file);
    return isPathInside(path.join(frontendDirectory, 'src'), absoluteFile)
    || absoluteFile === path.join(repositoryRoot, 'tests/frontend/support/playwright/testSession.ts');
}

export function canonicalCoverageHitMap(coverage)
{
    const hit = (value) => Number(value) > 0 ? 1 : 0;
    return Object.fromEntries(Object.entries(coverage).sort(([left], [right]) => left.localeCompare(right))
        .map(([file, entry]) => [file, {
            path: entry.path,
            statementMap: stable(entry.statementMap ?? {}),
            fnMap: stable(entry.fnMap ?? {}),
            branchMap: stable(entry.branchMap ?? {}),
            s: Object.fromEntries(Object.entries(entry.s ?? {}).map(([id, value]) => [id, hit(value)])),
            f: Object.fromEntries(Object.entries(entry.f ?? {}).map(([id, value]) => [id, hit(value)])),
            b: Object.fromEntries(Object.entries(entry.b ?? {}).map(([id, values]) => [id, values.map(hit)]))
        }]));
}

export function mergeAuthoritativeCoverageMaps(universeFile, shardFiles, {
    reportsDirectory = process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT
        ? path.join(coverageRoot, 'vitest/unit')
        : path.join(frontendRoot, 'coverage/unit'),
    repositoryRoot = root,
    frontendDirectory = frontendRoot
} = {})
{
    const { createCoverageMap } = frontendRequire('istanbul-lib-coverage');
    const { createContext } = frontendRequire('istanbul-lib-report');
    const reports = frontendRequire('istanbul-reports');
    const universe = JSON.parse(fs.readFileSync(universeFile, 'utf8'));
    const universeEntries = Object.entries(universe);
    const authoritativeEntries = universeEntries.filter(([file]) => isFrontendCoverageOwnedFile(file, {
        repositoryRoot,
        frontendDirectory
    }));
    const authoritativeFiles = new Set(authoritativeEntries.map(([file]) => file));
    if (authoritativeFiles.size === 0)
    {
        throw new Error('frontend full coverage universe is empty');
    }
    const merged = createCoverageMap(Object.fromEntries(authoritativeEntries));
    let emptyOwnedShardCount = 0;
    for (const shardFile of shardFiles)
    {
        const shard = JSON.parse(fs.readFileSync(shardFile, 'utf8'));
        if (Object.keys(shard).length === 0)
        {
            throw new Error(`frontend coverage shard is empty: ${shardFile}`);
        }
        const projected = Object.fromEntries(Object.entries(shard).filter(([file]) => authoritativeFiles.has(file)));
        if (Object.keys(projected).length === 0)
        {
            emptyOwnedShardCount += 1;
        }
        else
        {
            merged.merge(projected);
        }
    }
    fs.rmSync(reportsDirectory, { recursive: true, force: true });
    fs.mkdirSync(reportsDirectory, { recursive: true });
    const context = createContext({ dir: reportsDirectory, coverageMap: merged });
    for (const reporter of ['text', 'json', 'json-summary', 'html', 'lcov'])
    {
        reports.create(reporter).execute(context);
    }
    const hitMapFile = path.join(reportsDirectory, 'coverage-hit-map.json');
    const hitMap = canonicalCoverageHitMap(merged.toJSON());
    fs.writeFileSync(hitMapFile, `${JSON.stringify(hitMap)}\n`);
    const summaryFile = path.join(reportsDirectory, 'coverage-summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8')).total;
    const thresholds = {
        lines: Number(process.env.FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD ?? 0),
        branches: Number(process.env.FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD ?? 0),
        functions: Number(process.env.FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD ?? 0),
        statements: Number(process.env.FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD ?? 0)
    };
    const failures = Object.entries(thresholds).filter(([key, threshold]) =>
        !Number.isFinite(threshold) || Number(summary?.[key]?.pct) < threshold);
    if (failures.length > 0)
    {
        throw new Error(`frontend coverage threshold failed: ${failures.map(([key, threshold]) => `${key}=${summary?.[key]?.pct ?? 'missing'}<${threshold}`).join(' ')}`);
    }
    return {
        authoritativeFileCount: authoritativeFiles.size,
        excludedExternalFileCount: universeEntries.length - authoritativeEntries.length,
        emptyOwnedShardCount,
        hitMap: {
            file: path.relative(root, hitMapFile).replaceAll(path.sep, '/'),
            fileCount: Object.keys(hitMap).length,
            digest: digest(hitMap)
        },
        summary,
        thresholds
    };
}

function readPreviousSummary()
{
    try
    {
        return JSON.parse(fs.readFileSync(path.join(outputRoot, 'summary.json'), 'utf8'));
    }
    catch
    {
        return null;
    }
}

function coefficientOfVariation(values)
{
    const valid = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0);
    if (valid.length === 0)
    {
        return null;
    }
    const mean = valid.reduce((total, value) => total + value, 0) / valid.length;
    if (mean === 0)
    {
        return 0;
    }
    const variance = valid.reduce((total, value) => total + (value - mean) ** 2, 0) / valid.length;
    return Math.sqrt(variance) / mean;
}

function mergeTimingHistory(previous, catalog, hostResults)
{
    const history = previous?.catalogIdentityDigest === catalog.identityDigest ? previous.fileTimingHistory ?? {} : {};
    const next = Object.fromEntries(Object.entries(history).map(([file, values]) => [file, values.slice(-7)]));
    for (const result of hostResults)
    {
        for (const [file, durationMs] of Object.entries(result.metrics?.fileRuntimeMs ?? {}))
        {
            next[file] = [...(next[file] ?? []), durationMs].filter((value) => Number.isFinite(Number(value))).slice(-8);
        }
    }
    return next;
}

async function main()
{
    const mainStartedAtMs = Date.now();
    const previousSummary = readPreviousSummary();
    const cache = prepareTransformCache();
    const cacheEnv = transformCacheEnvironment(cache);
    const abortController = new AbortController();
    let sealed = false;
    let interruptedSignal = null;
    const interrupt = (signal) =>
    {
        if (interruptedSignal)
        {
            return;
        }
        interruptedSignal = signal;
        abortController.abort();
        terminateAllChildren('SIGTERM');
        const killTimer = setTimeout(() => terminateAllChildren('SIGKILL'), 2000);
        killTimer.unref?.();
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    try
    {
        fs.rmSync(outputRoot, { recursive: true, force: true });
        fs.rmSync(coverageShardRoot, { recursive: true, force: true });
        fs.rmSync(path.join(frontendRoot, 'coverage/unit'), { recursive: true, force: true });
        fs.mkdirSync(blobRoot, { recursive: true });
        fs.mkdirSync(coverageShardRoot, { recursive: true });
        const catalog = await discoverCatalog(cache, cacheEnv);
        const initialGrant = readLiveVitestGrant();
        const topology = resolveRollingVitestTopology({
            machineCpu: os.availableParallelism?.() ?? os.cpus().length,
            machineMemoryGiB: os.totalmem() / 1024 ** 3,
            fileCount: catalog.fileCount
        });
        const coverageUniverse = await buildZeroHitCoverageUniverse(
            cacheEnv,
            Math.min(topology.preferredWorkersPerHost, Math.max(1, Math.floor(initialGrant.cpuUnits)))
        );
        cache.immutableBase = createImmutableTransformBase(cache.cachePath);
        const partitions = planRollingVitestPartitions(catalog, topology);
        const stepDeadlineMs = readPositive(process.env.FSUSBLOG_STEP_DEADLINE_MS);
        const coordinator = await runRollingVitestCoordinator({
            partitions,
            topology,
            readGrant: () => readLiveVitestGrant(),
            launchHost: (request) => runPartitionHost({ ...request, cacheEnv, cache }),
            deadlineAtMs: stepDeadlineMs ? mainStartedAtMs + stepDeadlineMs : null,
            signal: abortController.signal,
            cancelActive: terminateAllChildren
        });
        const hostResults = coordinator.results;
        const failures = hostResults.filter((result) => result.status !== 'success' || result.code !== 0 || result.signal);
        const reports = hostResults.filter((result) => fs.existsSync(result.json))
            .map((result) => JSON.parse(fs.readFileSync(result.json, 'utf8')));
        let exact = null;
        let coverageEvidence = null;
        let transformCacheMerge = null;
        if (failures.length === 0)
        {
            verifyImmutableTransformBase(cache.immutableBase);
            transformCacheMerge = mergeIsolatedTransformCaches(
                cache.cachePath,
                hostResults.map((result) => result.transformCache.deltaEntries)
            );
            exact = validateExactVitestExecution(catalog, reports);
            const reportMerge = mergeCoordinatorReports(reports, hostResults.map((result) => result.junit));
            coverageEvidence = mergeAuthoritativeCoverageMaps(
                coverageUniverse.universeFile,
                hostResults.map((result) => path.join(result.coverage, 'coverage-final.json'))
            );
            coverageEvidence = {
                ...coverageEvidence,
                universe: {
                    ...coverageUniverse,
                    universeFile: path.relative(root, coverageUniverse.universeFile).replaceAll(path.sep, '/')
                },
                reportMerge
            };
        }
        const fileTimingHistory = mergeTimingHistory(previousSummary, catalog, hostResults);
        const summaryFinishedAtMs = Date.now();
        const transformCacheEvidence = hostResults.map((result) => result.transformCache);
        const summary = {
            schema: summarySchema,
            status: failures.length === 0 ? 'success' : 'failure',
            startedAtMs: mainStartedAtMs,
            finishedAtMs: summaryFinishedAtMs,
            durationMs: summaryFinishedAtMs - mainStartedAtMs,
            schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
            catalogIdentityDigest: catalog.identityDigest,
            catalogFileCount: catalog.fileCount,
            catalogTestIdCount: catalog.testIdCount,
            catalogDiscoveryDurationMs: catalog.discoveryDurationMs,
            initialGrant,
            topology,
            partitionCount: partitions.length,
            initialHostCount: coordinator.initialHostCount,
            peakHostCount: coordinator.peakHostCount,
            workersPerHost: hostResults.map((result) => ({ hostId: result.hostId, workers: result.workers })),
            grantHistory: coordinator.grantHistory,
            hostResults: hostResults.map((result) =>
            {
                const { hostCachePath, ...publicResult } = result;
                const { deltaEntries, ...publicTransformCache } = result.transformCache;
                return {
                    ...publicResult,
                    json: path.relative(root, result.json).replaceAll(path.sep, '/'),
                    junit: path.relative(root, result.junit).replaceAll(path.sep, '/'),
                    blob: path.relative(root, result.blob).replaceAll(path.sep, '/'),
                    coverage: path.relative(root, result.coverage).replaceAll(path.sep, '/'),
                    transformCachePath: path.relative(root, hostCachePath).replaceAll(path.sep, '/'),
                    transformCache: {
                        ...publicTransformCache,
                        deltaManifestDigest: digest(deltaEntries.map(({ relative }) => relative))
                    }
                };
            }),
            loadDispersion: {
                partitionDurationCoefficientOfVariation: coefficientOfVariation(hostResults.map((result) => result.durationMs)),
                partitionWeightCoefficientOfVariation: coefficientOfVariation(partitions.map((partition) => partition.weight))
            },
            fileTimingHistory,
            transformCacheMerge,
            transformCacheBase: {
                fileCount: cache.immutableBase.fileCount,
                byteCount: cache.immutableBase.byteCount,
                manifestDigest: cache.immutableBase.manifestDigest
            },
            failures: failures.map((result) => ({ hostId: result.hostId, partitionId: result.partitionId, code: result.code, signal: result.signal, error: result.error })),
            processEvidence: {
                vitestProcessStartupCount: 2 + hostResults.length,
                catalogProcessStartupCount: 1,
                coverageUniverseProcessStartupCount: 1,
                partitionProcessStartupCount: hostResults.length,
                reportMergeProcessStartupCount: coverageEvidence?.reportMerge?.processStartupCount ?? 0
            },
            cacheEvidence: {
                copiedBytes: transformCacheEvidence.reduce((total, entry) => total
          + (entry.cloneMode === 'reflink-full-view-fallback' ? entry.baseBytes : 0), 0),
                deltaBytes: transformCacheEvidence.reduce((total, entry) => total + entry.deltaBytes, 0),
                journalTraversalCount: transformCacheEvidence.reduce((total, entry) => total + entry.viewTraversalCount, 0),
                mergeTraversalCount: transformCacheMerge?.mergeTraversalCount ?? 0
            },
            criticalPathTailMs: hostResults.length === 0 ? null : Math.max(...hostResults.map((result) => result.finishedAtMs))
        - Math.min(...hostResults.map((result) => result.finishedAtMs)),
            resourceEvidence: {
                schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
                checkpoint: process.env.FSUSBLOG_TEST_RUN_ID
                    ? `.tmp/test-runs/${process.env.FSUSBLOG_TEST_RUN_ID}/checkpoint.json`
                    : null
            },
            ...(exact ?? {}),
            coverage: coverageEvidence,
            artifacts: {
                catalog: path.relative(root, catalogFile).replaceAll(path.sep, '/'),
                mergedJson: path.relative(root, mergedJson).replaceAll(path.sep, '/'),
                mergedJunit: path.relative(root, mergedJunit).replaceAll(path.sep, '/'),
                coverageSummary: path.relative(root,
                    path.join(coverageRoot, 'vitest/unit/coverage-summary.json')).replaceAll(path.sep, '/')
            }
        };
        if (failures.length > 0)
        {
            fs.writeFileSync(path.join(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
            throw new Error(`rolling Vitest failed in ${failures.length} independent host(s)`);
        }
        summary.transformCache = {
            identityDigest: cache.identity.identityDigest,
            configDigest: cache.identity.configDigest,
            inventory: sealTransformCache(cache)
        };
        fs.writeFileSync(path.join(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
        sealed = true;
        console.log(`[frontend-vitest-rolling] exactOnce=${exact.executedTestIdCount} files=${exact.executedFileCount} hosts=${coordinator.peakHostCount} partitions=${partitions.length}`);
    }
    catch (error)
    {
        terminateAllChildren('SIGTERM');
        if (!sealed)
        {
            invalidateTransformCache(cache, interruptedSignal ? `ordinary-${interruptedSignal.toLowerCase()}` : 'ordinary-failed');
        }
        if (interruptedSignal)
        {
            error.exitCode = 128 + (interruptedSignal === 'SIGINT' ? 2 : 15);
        }
        throw error;
    }
    finally
    {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch((error) =>
    {
        console.error(error);
        process.exitCode = error.exitCode ?? 1;
    });
}

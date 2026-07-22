#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(args)
{
    const options = { repeat: 3 };
    for (let index = 0; index < args.length; index += 1)
    {
        const argument = args[index];
        if (argument === '--fresh')
        {
            options.fresh = true;
        }
        else if (argument === '--root')
        {
            options.root = args[++index];
        }
        else if (argument === '--repeat')
        {
            options.repeat = Number(args[++index]);
        }
        else if (argument === '--output')
        {
            options.output = args[++index];
        }
        else
        {
            throw new Error(`unknown argument ${argument}`);
        }
    }
    if (!options.fresh)
    {
        throw new Error('backend build authority measurement requires --fresh');
    }
    if (!options.root || !options.output)
    {
        throw new Error('backend build authority measurement requires --root and --output');
    }
    if (!Number.isInteger(options.repeat) || options.repeat < 3)
    {
        throw new Error('backend build authority measurement requires at least three repeats');
    }
    return options;
}

function directoryBytes(directory)
{
    if (!fs.existsSync(directory))
    {
        return 0;
    }
    return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) =>
    {
        const child = path.join(directory, entry.name);
        if (entry.isSymbolicLink())
        {
            return total;
        }
        return total + (entry.isDirectory() ? directoryBytes(child) : fs.statSync(child).size);
    }, 0);
}

function parseTime(file)
{
    const values = Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => line.split('=')));
    return {
        userSeconds: Number(values.user_seconds),
        systemSeconds: Number(values.system_seconds),
        wallSeconds: Number(values.wall_seconds)
    };
}

function runTimed(root, sampleRoot, id, command, args, env)
{
    const timeFile = path.join(sampleRoot, `${id}.time`);
    const result = spawnSync('/usr/bin/time', [
        '-f', 'user_seconds=%U\nsystem_seconds=%S\nwall_seconds=%e',
        '-o', timeFile,
        command,
        ...args
    ], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(path.join(sampleRoot, `${id}.stdout.log`), result.stdout ?? '');
    fs.writeFileSync(path.join(sampleRoot, `${id}.stderr.log`), result.stderr ?? '');
    if (result.status !== 0 || result.signal)
    {
        throw new Error(`${id} failed: ${result.signal ?? `exit ${result.status}`}\n${String(result.stderr ?? '').slice(-4000)}`);
    }
    return parseTime(timeFile);
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

function freshOutputs(root)
{
    for (const relative of [
        'src/backend/bin', 'src/backend/obj',
        'src/core/bin', 'src/core/obj',
        'src/shared/bin', 'src/shared/obj',
        'tests/backend/bin', 'tests/backend/obj',
        'tools/architecture/FsusBlog.DiLifetimeAnalyzer/bin',
        'tools/architecture/FsusBlog.DiLifetimeAnalyzer/obj',
        '.tmp/test-results/backend/production',
        '.tmp/coverage/backend/production'
    ])
    {
        fs.rmSync(path.join(root, relative), { recursive: true, force: true });
    }
}

function sourceState(root)
{
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const diff = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, encoding: 'buffer' }).stdout;
    return {
        commit,
        worktreeDigest: `sha256:${crypto.createHash('sha256').update(diff).digest('hex')}`
    };
}

export function summarizeBackendBuildAuthoritySamples(samples)
{
    if (!Array.isArray(samples) || samples.length < 3 || samples.some((sample) => sample.status !== 'success'))
    {
        throw new Error('backend build authority evidence requires at least three successful samples');
    }
    const invariant = (field) => new Set(samples.map((sample) => sample[field])).size === 1;
    for (const field of ['buildRequestCount', 'testhostStartupCount', 'executedTestCaseCount', 'executedMethodCount'])
    {
        if (!invariant(field))
        {
            throw new Error(`backend build authority samples disagree on ${field}`);
        }
    }
    return {
        status: 'success',
        sampleCount: samples.length,
        conclusionStable: true,
        buildRequestCount: samples[0].buildRequestCount,
        testhostStartupCount: samples[0].testhostStartupCount,
        executedTestCaseCount: samples[0].executedTestCaseCount,
        executedMethodCount: samples[0].executedMethodCount
    };
}

function median(values)
{
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.floor(ordered.length / 2)];
}

function summarizeMeasuredMetrics(samples)
{
    return {
        buildCpuSecondsMedian: median(samples.map((sample) => sample.buildCpuSeconds)),
        unionCpuSecondsMedian: median(samples.map((sample) => sample.unionCpuSeconds)),
        wallSecondsMedian: median(samples.map((sample) => sample.wallSeconds)),
        binObjBytesMedian: median(samples.map((sample) => sample.binObjBytes))
    };
}

export function validateBackendBuildAuthorityComparison(document)
{
    if (document?.schema !== 'fsusblog.backend-production-build-authority-comparison.v1')
    {
        throw new Error('backend build authority comparison schema is invalid');
    }
    const before = document.before;
    const after = document.after;
    for (const [label, side] of [['before', before], ['after', after]])
    {
        if (!side?.sourceState?.commit || !side.sourceState.worktreeDigest)
        {
            throw new Error(`${label} source state is incomplete`);
        }
        if (!Array.isArray(side.samples) || side.samples.length !== 3)
        {
            throw new Error(`${label} comparison must retain exactly three samples`);
        }
        const summary = summarizeBackendBuildAuthoritySamples(side.samples);
        if (JSON.stringify(summary) !== JSON.stringify(side.summary))
        {
            throw new Error(`${label} retained samples disagree with summary`);
        }
        if (side.samples.some((sample) => !sample.exactOnce || !sample.allPassed))
        {
            throw new Error(`${label} samples must remain exact-once and all-passed`);
        }
    }
    if (before.machine.cpu !== after.machine.cpu || before.machine.memoryBytes !== after.machine.memoryBytes)
    {
        throw new Error('before and after evidence must come from the same machine');
    }
    if (before.summary.executedTestCaseCount !== after.summary.executedTestCaseCount
        || before.summary.executedMethodCount !== after.summary.executedMethodCount)
    {
        throw new Error('authoritative backend execution universe changed');
    }
    if (before.summary.testhostStartupCount !== 2 || after.summary.testhostStartupCount !== 1)
    {
        throw new Error('governance postlude testhost retirement is not proven');
    }
    if (before.samples.some((sample) => sample.executionMode !== 'single-testhost-with-governance-postlude')
        || after.samples.some((sample) => sample.executionMode !== 'single-testhost-exact-union'))
    {
        throw new Error('backend execution modes do not prove the topology migration');
    }
    if (before.summary.buildRequestCount !== 2 || after.summary.buildRequestCount !== 2)
    {
        throw new Error('focused server and test build request scope changed');
    }
    return {
        status: 'success',
        executedTestCaseCount: after.summary.executedTestCaseCount,
        executedMethodCount: after.summary.executedMethodCount,
        testhostStartupDelta: after.summary.testhostStartupCount - before.summary.testhostStartupCount,
        beforeMetrics: summarizeMeasuredMetrics(before.samples),
        afterMetrics: summarizeMeasuredMetrics(after.samples)
    };
}

async function main()
{
    const options = parseArgs(process.argv.slice(2));
    const root = path.resolve(options.root);
    const output = path.resolve(root, options.output);
    const evidenceRoot = path.join(root, '.tmp/issue-1389-backend-build-authority');
    const env = {
        ...process.env,
        FSUSBLOG_BACKEND_CPU_BUDGET: String(Math.max(2, Math.min(4, os.availableParallelism()))),
        FSUSBLOG_BUNDLE_MEMORY_GIB: '4',
        FSUSBLOG_STEP_MEMORY_GIB: '4'
    };
    for (const key of [
        'FSUSBLOG_TEST_RUN_ID', 'FSUSBLOG_TEST_SOURCE_COMMIT', 'FSUSBLOG_TEST_SOURCE_FINGERPRINT',
        'FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE', 'FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID'
    ])
    {
        delete env[key];
    }
    const samples = [];
    for (let index = 0; index < options.repeat; index += 1)
    {
        freshOutputs(root);
        const sampleRoot = path.join(evidenceRoot, `sample-${index + 1}`);
        fs.rmSync(sampleRoot, { recursive: true, force: true });
        fs.mkdirSync(sampleRoot, { recursive: true });
        const startedAt = Date.now();
        const restore = runTimed(root, sampleRoot, 'restore', 'dotnet', [
            'restore', 'tests/FsusBlog.ProductionBackend.slnx', '--locked-mode', '-v', 'minimal', '/p:NuGetAudit=false'
        ], env);
        const serverBuild = runTimed(root, sampleRoot, 'server-build', 'dotnet', [
            'build', 'src/backend/FsusBlog.Server.csproj', '-c', 'Release', '--no-restore', '-warnaserror', '-v', 'minimal', '/p:NuGetAudit=false'
        ], env);
        const testBuild = runTimed(root, sampleRoot, 'test-build', 'dotnet', [
            'build', 'tests/backend/FsusBlog.Server.Tests.csproj', '-c', 'Release', '--no-restore', '--no-dependencies', '--no-incremental', '-warnaserror', '-v', 'minimal', '/p:NuGetAudit=false'
        ], env);
        const union = runTimed(root, sampleRoot, 'production-union', process.execPath, [
            'tools/test/run-backend-production-shards.mjs'
        ], env);
        const summary = JSON.parse(fs.readFileSync(path.join(root, '.tmp/test-results/backend/production/summary.json'), 'utf8'));
        const buildRoots = ['src/backend', 'src/core', 'src/shared', 'tests/backend', 'tools/architecture/FsusBlog.DiLifetimeAnalyzer'];
        samples.push({
            repeat: index + 1,
            status: summary.status,
            buildRequestCount: 2,
            testhostStartupCount: summary.partitions.length,
            executedTestCaseCount: summary.execution.executedTestCaseCount,
            executedMethodCount: summary.execution.executedMethodCount,
            exactOnce: summary.execution.exactOnce,
            allPassed: summary.execution.allPassed,
            buildCpuSeconds: serverBuild.userSeconds + serverBuild.systemSeconds + testBuild.userSeconds + testBuild.systemSeconds,
            unionCpuSeconds: union.userSeconds + union.systemSeconds,
            wallSeconds: (Date.now() - startedAt) / 1000,
            timedWallSeconds: restore.wallSeconds + serverBuild.wallSeconds + testBuild.wallSeconds + union.wallSeconds,
            binObjBytes: buildRoots.reduce((total, relative) => total
                + directoryBytes(path.join(root, relative, 'bin'))
                + directoryBytes(path.join(root, relative, 'obj')), 0),
            executionMode: summary.executionMode
        });
        process.stdout.write(`[backend-build-authority-measure] sample=${index + 1} tests=${summary.execution.executedTestCaseCount} testhosts=${summary.partitions.length}\n`);
    }
    const document = {
        schema: 'fsusblog.backend-production-build-authority-measurement.v1',
        sourceState: sourceState(root),
        machine: { cpu: os.availableParallelism(), memoryBytes: os.totalmem() },
        summary: summarizeBackendBuildAuthoritySamples(samples),
        samples
    };
    writeJsonAtomic(output, document);
    process.stdout.write(`[backend-build-authority-measure] ok samples=${samples.length} output=${path.relative(root, output)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain)
{
    main().catch((error) =>
    {
        process.stderr.write(`[backend-build-authority-measure] ${error instanceof Error ? error.stack : String(error)}\n`);
        process.exitCode = 1;
    });
}

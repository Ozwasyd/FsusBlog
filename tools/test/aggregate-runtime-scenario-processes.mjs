#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function digest(value)
{
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseArguments(argumentsList)
{
    const options = {};
    for (let index = 0; index < argumentsList.length; index += 1)
    {
        const key = argumentsList[index];
        if (['--phase', '--input', '--output', '--status', '--started-at-ms'].includes(key))
        {
            options[key.slice(2).replaceAll(/-([a-z])/gu, (_, character) => character.toUpperCase())]
                = argumentsList[++index];
        }
        else
        {
            throw new Error(`unknown legacy runtime observation argument: ${key}`);
        }
    }
    return options;
}

export function aggregateRuntimeScenarioProcesses({
    phase,
    input,
    output,
    status,
    startedAtMs,
    env = process.env,
    now = Date.now()
})
{
    if (!['integration', 'security', 'resilience'].includes(phase))
    {
        throw new Error(`invalid legacy runtime phase: ${phase ?? '<missing>'}`);
    }
    if (!['success', 'failure', 'cancelled'].includes(status))
    {
        throw new Error(`invalid legacy runtime status: ${status ?? '<missing>'}`);
    }
    const source = {
        commit: String(env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim(),
        worktreeFingerprint: String(env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim()
    };
    const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    if (!source.commit || !source.worktreeFingerprint || !runId)
    {
        throw new Error('legacy runtime observation requires source and run identity');
    }
    const observations = fs.readdirSync(input)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(fs.readFileSync(path.join(input, name), 'utf8')));
    if (observations.length === 0)
    {
        throw new Error('legacy runtime observation contains no Node process evidence');
    }
    for (const observation of observations)
    {
        if (observation.runId !== runId
            || observation.source?.commit !== source.commit
            || observation.source?.worktreeFingerprint !== source.worktreeFingerprint)
        {
            throw new Error(`legacy runtime process ${observation.processId} has mismatched source/run identity`);
        }
    }
    const started = Number(startedAtMs);
    if (!Number.isFinite(started) || started <= 0 || now < started)
    {
        throw new Error('legacy runtime observation has invalid wall-time boundary');
    }
    const document = {
        schema: 'fsusblog.runtime-scenario-host-evidence.v1',
        source,
        runId,
        phase,
        status,
        variant: 'per-cli-before',
        correctness: {
            wallTimeGate: false,
            timeoutGate: false,
            performanceAffectsCorrectness: false
        },
        performance: {
            wallTimeMs: now - started,
            cpuSeconds: observations.reduce((sum, item) => sum + item.cpuSeconds, 0),
            nodeProcessCount: observations.length,
            connectionSetupCount: observations.reduce(
                (sum, item) => sum + item.connectionSetupCount,
                0
            ),
            machineFingerprint: digest({
                architecture: os.arch(),
                cpuModels: os.cpus().map(({ model }) => model),
                hostname: os.hostname(),
                platform: os.platform(),
                totalMemory: os.totalmem()
            }),
            affectsCorrectness: false
        },
        processObservations: observations
            .sort((left, right) => left.processId - right.processId)
            .map((item) => ({
                processId: item.processId,
                parentProcessId: item.parentProcessId,
                executableDigest: item.executableDigest,
                argvDigest: item.argvDigest,
                exitCode: item.exitCode,
                cpuSeconds: item.cpuSeconds,
                connectionSetupCount: item.connectionSetupCount
            }))
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
    fs.renameSync(temporary, output);
    return document;
}

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
{
    const options = parseArguments(process.argv.slice(2));
    try
    {
        const document = aggregateRuntimeScenarioProcesses(options);
        console.log(
            `[runtime-scenario-before] phase=${document.phase} status=${document.status}`
            + ` processes=${document.performance.nodeProcessCount}`
            + ` output=${options.output}`
        );
    }
    catch (error)
    {
        console.error(`[runtime-scenario-before] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const metricNames = ['wallTimeMs', 'cpuSeconds', 'nodeProcessCount', 'connectionSetupCount'];

function average(values)
{
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function validateRound(round, label, index)
{
    const errors = [];
    if (round?.status !== 'success')
    {
        errors.push(`${label} round ${index + 1} is not successful`);
    }
    if (!round?.source?.commit || !round?.source?.worktreeFingerprint || !round?.runId)
    {
        errors.push(`${label} round ${index + 1} is not source/run-bound`);
    }
    if (!round?.performance?.machineFingerprint)
    {
        errors.push(`${label} round ${index + 1} has no machine fingerprint`);
    }
    for (const metric of metricNames)
    {
        if (!Number.isFinite(round?.performance?.[metric]) || round.performance[metric] < 0)
        {
            errors.push(`${label} round ${index + 1} has invalid ${metric}`);
        }
    }
    return errors;
}

export function compareRuntimeScenarioRounds({ before, after })
{
    const errors = [];
    if (before?.length !== 3 || after?.length !== 3)
    {
        errors.push(`three before and three after rounds are required; got ${before?.length ?? 0}/${after?.length ?? 0}`);
    }
    for (const [label, rounds] of [['before', before ?? []], ['after', after ?? []]])
    {
        rounds.forEach((round, index) => errors.push(...validateRound(round, label, index)));
    }
    const rounds = [...(before ?? []), ...(after ?? [])];
    const sourceIdentities = new Set(rounds.map(({ source }) =>
        `${source?.commit ?? ''}:${source?.worktreeFingerprint ?? ''}`));
    if (sourceIdentities.size > 1)
    {
        errors.push('before/after rounds do not share one source identity');
    }
    const machines = new Set(rounds.map(({ performance }) => performance?.machineFingerprint ?? ''));
    if (machines.size > 1)
    {
        errors.push('before/after rounds do not share one machine fingerprint');
    }
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }

    const metrics = Object.fromEntries(metricNames.map((metric) =>
    {
        const beforeValues = before.map(({ performance }) => performance[metric]);
        const afterValues = after.map(({ performance }) => performance[metric]);
        const beforeAverage = average(beforeValues);
        const afterAverage = average(afterValues);
        return [metric, {
            before: beforeValues,
            after: afterValues,
            beforeAverage,
            afterAverage,
            delta: afterAverage - beforeAverage,
            deltaPercent: beforeAverage === 0 ? null : ((afterAverage - beforeAverage) / beforeAverage) * 100
        }];
    }));
    return {
        schema: 'fsusblog.runtime-scenario-before-after.v1',
        status: 'comparison-complete',
        source: before[0].source,
        machineFingerprint: before[0].performance.machineFingerprint,
        roundCount: { before: 3, after: 3 },
        correctness: {
            allRoundsSuccessful: true,
            performanceAffectsCorrectness: false,
            slowerAfterFailsCorrectness: false
        },
        metrics
    };
}

function parseArguments(argumentsList)
{
    const options = { before: [], after: [] };
    for (let index = 0; index < argumentsList.length; index += 1)
    {
        const argument = argumentsList[index];
        if (argument === '--before' || argument === '--after')
        {
            options[argument.slice(2)].push(path.resolve(argumentsList[++index]));
        }
        else if (argument === '--output')
        {
            options.output = path.resolve(argumentsList[++index]);
        }
        else
        {
            throw new Error(`unknown runtime scenario benchmark argument: ${argument}`);
        }
    }
    return options;
}

export function runRuntimeScenarioBenchmark(argumentsList = process.argv.slice(2))
{
    const options = parseArguments(argumentsList);
    if (!options.output)
    {
        throw new Error('--output is required');
    }
    const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    const document = compareRuntimeScenarioRounds({
        before: options.before.map(read),
        after: options.after.map(read)
    });
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    const temporary = `${options.output}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
    fs.renameSync(temporary, options.output);
    console.log(`[runtime-scenario-benchmark] ok output=${options.output}`);
    return document;
}

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
{
    try
    {
        runRuntimeScenarioBenchmark();
    }
    catch (error)
    {
        console.error(`[runtime-scenario-benchmark] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

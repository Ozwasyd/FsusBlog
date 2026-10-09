#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    readCatalog,
    repositoryRoot,
    resolveRuntimeScenarioIdentity,
    validateRuntimeScenarioCatalog
} from './runtime-scenario-host.mjs';

function atomicJson(target, document)
{
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
    fs.renameSync(temporary, target);
}

export function writeRetainedRuntimeResult(outputFile, document, rawResultFile = null)
{
    if (rawResultFile && path.resolve(rawResultFile) === path.resolve(outputFile))
    {
        throw new Error('raw result input must differ from the retained result output');
    }
    // Retain the original command outcome even if optional raw transport fails.
    atomicJson(outputFile, document);
    if (rawResultFile)
    {
        const bytes = fs.readFileSync(rawResultFile);
        // Copy actual bytes without parsing vendor reports or claiming freshness,
        // executed assertions, canonical IDs, artifact custody or admission.
        document.result.diagnostics.rawResultFile = {
            path: path.resolve(rawResultFile),
            bytesBase64: bytes.toString('base64')
        };
        atomicJson(outputFile, document);
    }
    return document;
}

function parseArguments(argumentsList)
{
    const separator = argumentsList.indexOf('--');
    if (separator < 0 || separator === argumentsList.length - 1)
    {
        throw new Error('retained runtime scenario requires -- followed by a command');
    }
    const options = { command: argumentsList.slice(separator + 1) };
    for (let index = 0; index < separator; index += 1)
    {
        if (argumentsList[index] === '--scenario')
        {
            options.scenarioId = argumentsList[++index];
        }
        else if (argumentsList[index] === '--cwd')
        {
            options.cwd = path.resolve(repositoryRoot, argumentsList[++index]);
        }
        else if (argumentsList[index] === '--raw-result-file')
        {
            if (index + 1 >= separator || !argumentsList[index + 1])
            {
                throw new Error('raw result input requires an explicit file path');
            }
            options.rawResultFile = argumentsList[++index];
        }
        else
        {
            throw new Error(`unknown retained runtime scenario argument: ${argumentsList[index]}`);
        }
    }
    return options;
}

function runCommand(command, { cwd, signal })
{
    return new Promise((resolve, reject) =>
    {
        const child = spawn(command[0], command.slice(1), {
            cwd,
            env: process.env,
            stdio: 'inherit'
        });
        const cancel = () =>
        {
            child.kill('SIGTERM');
        };
        signal.addEventListener('abort', cancel, { once: true });
        child.once('error', reject);
        child.once('exit', (code, childSignal) =>
        {
            signal.removeEventListener('abort', cancel);
            resolve({ exitCode: code, signal: childSignal });
        });
    });
}

export async function runRetainedRuntimeScenario(argumentsList = process.argv.slice(2))
{
    const options = parseArguments(argumentsList);
    const catalog = readCatalog();
    const errors = validateRuntimeScenarioCatalog(catalog);
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    const scenario = catalog.scenarios.find(({ id }) => id === options.scenarioId);
    if (!scenario || scenario.executor !== 'retained-cli')
    {
        throw new Error(`unknown retained runtime scenario: ${options.scenarioId ?? '<missing>'}`);
    }
    const identity = await resolveRuntimeScenarioIdentity();
    const outputRoot = path.join(
        repositoryRoot,
        '.tmp/runtime-scenario-host',
        identity.runId
    );
    const outputFile = path.join(outputRoot, scenario.evidencePath);
    const controller = new AbortController();
    const cancel = (name) =>
    {
        if (!controller.signal.aborted)
        {
            controller.abort(`user-cancelled:${name}`);
        }
    };
    process.once('SIGINT', () => cancel('SIGINT'));
    process.once('SIGTERM', () => cancel('SIGTERM'));
    const startedAt = new Date();
    const startedNs = process.hrtime.bigint();
    const result = await runCommand(options.command, {
        cwd: options.cwd ?? repositoryRoot,
        signal: controller.signal
    });
    const status = controller.signal.aborted
        ? 'cancelled'
        : result.exitCode === 0 ? 'pass' : 'failure';
    const document = {
        schema: 'fsusblog.runtime-scenario-result-evidence.v1',
        source: {
            commit: identity.commit,
            worktreeFingerprint: identity.worktreeFingerprint
        },
        runId: identity.runId,
        phase: scenario.phase,
        scenario: {
            id: scenario.id,
            identity: scenario.identity,
            fixture: scenario.fixture,
            resetBarrier: scenario.resetBarrier,
            expectedAssertions: scenario.expectedAssertions,
            coverageIds: scenario.coverageIds
        },
        result: {
            schema: 'fsusblog.runtime-scenario-result.v1',
            scenarioId: scenario.id,
            status,
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            assertions: scenario.expectedAssertions,
            coverageIds: scenario.coverageIds,
            diagnostics: {
                durationMs: Number(process.hrtime.bigint() - startedNs) / 1e6,
                timingAffectsCorrectness: false,
                command: options.command,
                exitCode: result.exitCode,
                signal: result.signal
            },
            cancellation: controller.signal.aborted
                ? { reason: String(controller.signal.reason) }
                : null
        }
    };
    writeRetainedRuntimeResult(outputFile, document, options.rawResultFile
        ? path.resolve(options.cwd ?? repositoryRoot, options.rawResultFile) : null);
    console.log(
        `[retained-runtime-scenario] id=${scenario.id} status=${status}`
        + ` evidence=${path.relative(repositoryRoot, outputFile)}`
    );
    return document;
}

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
{
    runRetainedRuntimeScenario()
        .then((document) =>
        {
            if (document.result.status !== 'pass')
            {
                process.exitCode = document.result.status === 'cancelled'
                    ? 130
                    : document.result.diagnostics.exitCode || 1;
            }
        })
        .catch((error) =>
        {
            console.error(`[retained-runtime-scenario] fatal: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
        });
}

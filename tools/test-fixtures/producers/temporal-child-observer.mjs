#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const { loadTemporalContext, validateTemporalObservations } = await import(new URL("../../test/temporal-context.mjs", import.meta.url));

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeHandshake = path.join(here, 'temporal-child-handshake.cjs');
const bashHandshake = path.join(here, 'temporal-child-handshake.bash');
const bashEmitter = path.join(here, 'temporal-child-handshake-emitter.cjs');

const separator = process.argv.indexOf('--');
if (separator < 0 || separator === process.argv.length - 1)
{
    throw new Error('temporal child observer requires a command after --');
}

const context = loadTemporalContext();
const command = process.argv[separator + 1];
const args = process.argv.slice(separator + 2);
const nonce = randomBytes(24).toString('hex');
const launch = observedLaunch(command, args, {
    ...process.env,
    FSUSBLOG_TEMPORAL_HANDSHAKE_NONCE: nonce,
    FSUSBLOG_TEMPORAL_HANDSHAKE_EMITTER: bashEmitter
});
const child = spawn(launch.command, launch.args, {
    cwd: process.cwd(),
    env: launch.env,
    stdio: ['inherit', 'pipe', 'pipe']
});

let stdout = '';
child.stdout.on('data', (chunk) =>
{
    stdout += String(chunk);
    process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

const result = await new Promise((resolve, reject) =>
{
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
});
if (result.code !== 0 || result.signal)
{
    process.exitCode = result.code || 1;
}
else
{
    const handshakes = [...stdout.matchAll(
        /^FSUSBLOG_TEMPORAL_CHILD_HANDSHAKE_JSON=([A-Za-z0-9_-]+)$/gmu
    )].map((match) => decodeHandshake(match[1]))
        .filter((handshake) => handshake.nonce === nonce);
    if (handshakes.length !== 1)
    {
        throw new Error(
            `target child must return exactly one temporal exit handshake; received ${handshakes.length}`
        );
    }
    const handshake = handshakes[0];
    if (handshake.observedProcessPid !== child.pid)
    {
        throw new Error(
            `temporal exit handshake PID mismatch: expected ${child.pid}, got ${handshake.observedProcessPid}`
        );
    }
    const observation = validateTemporalObservations(
        context,
        handshake.observation
    );
    process.stdout.write(
        `FSUSBLOG_TEMPORAL_ACTUAL_JSON=${Buffer.from(JSON.stringify({
            ...observation,
            observedProcessPid: handshake.observedProcessPid,
            emitterPid: handshake.emitterPid,
            childExitCode: result.code
        })).toString('base64url')}\n`
    );
}

function decodeHandshake(encoded)
{
    try
    {
        const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (!value || typeof value !== 'object'
        || !value.observation || typeof value.observation !== 'object')
        {
            throw new Error('handshake payload is not an object');
        }
        return value;
    }
    catch (error)
    {
        throw new Error(
            `target child returned an invalid temporal exit handshake: ${
        error instanceof Error ? error.message : String(error)
            }`,
            { cause: error }
        );
    }
}

function observedLaunch(targetCommand, targetArgs, targetEnv)
{
    const executable = path.basename(targetCommand).toLowerCase();
    if (executable === 'env')
    {
        return observedEnvLaunch(targetCommand, targetArgs, targetEnv);
    }
    if (isNodeExecutable(executable))
    {
        return {
            command: targetCommand,
            args: targetArgs,
            env: {
                ...targetEnv,
                NODE_OPTIONS: appendNodeHandshake(targetEnv.NODE_OPTIONS)
            }
        };
    }
    if (isBashExecutable(executable))
    {
        if (targetEnv.BASH_ENV)
        {
            throw new Error('temporal child handshake refuses a pre-existing BASH_ENV');
        }
        return {
            command: targetCommand,
            args: targetArgs,
            env: { ...targetEnv, BASH_ENV: bashHandshake }
        };
    }
    throw new Error(
        `correctness target does not support an in-process temporal handshake: ${targetCommand}`
    );
}

function observedEnvLaunch(targetCommand, targetArgs, targetEnv)
{
    const commandIndex = targetArgs.findIndex((argument, index) =>
    index > 0 || !argument.startsWith('-')
        ? !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument)
        && !argument.startsWith('-')
        : false
    );
    if (commandIndex < 0)
    {
        throw new Error('env correctness target is missing its executable');
    }
    const executable = path.basename(targetArgs[commandIndex]).toLowerCase();
    const assignments = targetArgs.slice(0, commandIndex);
    const remainder = targetArgs.slice(commandIndex);
    if (isNodeExecutable(executable))
    {
        setAssignment(
            assignments,
            'NODE_OPTIONS',
            appendNodeHandshake(assignmentValue(assignments, 'NODE_OPTIONS')
        ?? targetEnv.NODE_OPTIONS)
        );
    }
    else if (isBashExecutable(executable))
    {
        if (assignmentValue(assignments, 'BASH_ENV') || targetEnv.BASH_ENV)
        {
            throw new Error('temporal child handshake refuses a pre-existing BASH_ENV');
        }
        setAssignment(assignments, 'BASH_ENV', bashHandshake);
    }
    else
    {
        throw new Error(
            `env correctness target does not support an in-process temporal handshake: ${remainder[0]}`
        );
    }
    for (const [name, value] of Object.entries({
        FSUSBLOG_TEMPORAL_HANDSHAKE_NONCE:
      targetEnv.FSUSBLOG_TEMPORAL_HANDSHAKE_NONCE,
        FSUSBLOG_TEMPORAL_HANDSHAKE_EMITTER:
      targetEnv.FSUSBLOG_TEMPORAL_HANDSHAKE_EMITTER
    }))
    {
        setAssignment(assignments, name, value);
    }
    return {
        command: targetCommand,
        args: [...assignments, ...remainder],
        env: targetEnv
    };
}

function assignmentValue(assignments, name)
{
    const prefix = `${name}=`;
    return assignments.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function setAssignment(assignments, name, value)
{
    const prefix = `${name}=`;
    const index = assignments.findIndex((entry) => entry.startsWith(prefix));
    const assignment = `${name}=${value ?? ''}`;
    if (index >= 0)
    {
        assignments[index] = assignment;
    }
    else
    {
        assignments.push(assignment);
    }
}

function appendNodeHandshake(existing)
{
    const option = `--require=${nodeHandshake}`;
    const normalized = String(existing ?? '').trim();
    return normalized ? `${normalized} ${option}` : option;
}

function isNodeExecutable(executable)
{
    return executable === 'node' || executable === 'nodejs';
}

function isBashExecutable(executable)
{
    return executable === 'bash';
}

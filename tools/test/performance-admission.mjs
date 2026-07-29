#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    createLinuxMeasurementCollector,
    createMeasurementNoiseEnvelope,
    noisyMeasurementClassification,
    readMeasurementNoiseAuthoritySequence,
    readMeasurementNoisePolicy
} from './measurement-noise-envelope.mjs';
import {
    collectMeasurementQualificationRequests,
    finalizeMeasurementQualificationRequests,
    measurementQualificationRequestEnvironment
} from './measurement-product-conclusion.mjs';

export const measurementEnvelopeOwnerEnvironment = 'FSUSBLOG_MEASUREMENT_ENVELOPE_OWNER';

export async function runWithPerformanceAdmission({
    windowId,
    evidenceFile,
    env = process.env,
    envelopeFactory = createMeasurementNoiseEnvelope,
    execute
} = {})
{
    if (typeof execute !== 'function')
    {
        throw new Error('performance admission requires an execute callback');
    }
    const inheritedOwner = String(env[measurementEnvelopeOwnerEnvironment] ?? '').trim();
    if (inheritedOwner)
    {
        if (evidenceFile)
        {
            fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
            const receipt = {
                schema: 'fsusblog.measurement-noise-envelope-delegation.v1',
                status: 'delegated-to-outer-owner',
                windowId,
                owner: inheritedOwner,
                nested: true,
                collectorStarted: false,
                qualificationAuthority: 'outer-owner'
            };
            const temporary = `${evidenceFile}.next-${process.pid}`;
            fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
            fs.renameSync(temporary, evidenceFile);
        }
        return {
            status: 'nested-execution',
            owner: inheritedOwner,
            nested: true,
            result: await execute({ ...env, [measurementEnvelopeOwnerEnvironment]: inheritedOwner })
        };
    }
    const owner = `${windowId}:${process.pid}`;
    const envelope = envelopeFactory({ windowId, evidenceFile });
    const preflight = await envelope.preflight();
    envelope.start(preflight);
    let productOutcome;
    let executionError;
    try
    {
        productOutcome = await execute({ ...env, [measurementEnvelopeOwnerEnvironment]: owner });
    }
    catch (error)
    {
        executionError = error;
    }
    const evidence = await envelope.finish({
        preflight,
        productOutcome: executionError
            ? { status: 'failed', error: executionError.message }
            : { status: 'completed', result: productOutcome ?? null }
    });
    if (!evidence.qualificationEligible)
    {
        const error = new Error(`${windowId} failed measurement qualification: ${evidence.classification ?? noisyMeasurementClassification}`);
        error.classification = evidence.classification ?? noisyMeasurementClassification;
        error.evidence = evidence;
        throw error;
    }
    if (executionError)
    {
        throw executionError;
    }
    return { status: 'completed', owner, nested: false, result: productOutcome, evidence };
}

function parseCli(args)
{
    const separator = args.indexOf('--');
    if (separator < 0 || separator === args.length - 1)
    {
        throw new Error('usage: performance-admission.mjs --window-id ID --evidence FILE -- COMMAND [ARG...]');
    }
    const options = {};
    const repeatableOptions = new Set(['--prior-authority-root']);
    for (let index = 0; index < separator; index += 2)
    {
        const flag = args[index];
        const value = args[index + 1];
        if (![
            '--window-id',
            '--evidence',
            '--run-id',
            '--attempt-sequence',
            '--authority-root',
            '--authority-manifest-root',
            '--prior-authority-root',
            '--policy',
            '--product-evidence'
        ].includes(flag) || !value)
        {
            throw new Error(`invalid performance admission option: ${flag}`);
        }
        const name = flag.slice(2);
        if (repeatableOptions.has(flag))
        {
            options[name] = [...(options[name] ?? []), value];
        }
        else if (Object.hasOwn(options, name))
        {
            throw new Error(`duplicate performance admission option: ${flag}`);
        }
        else
        {
            options[name] = value;
        }
    }
    if (!options['window-id'] || !options.evidence)
    {
        throw new Error('performance admission requires --window-id and --evidence');
    }
    return {
        windowId: options['window-id'],
        evidenceFile: path.resolve(options.evidence),
        command: args.slice(separator + 1),
        ...(options['run-id'] ? { runId: options['run-id'] } : {}),
        ...(options['attempt-sequence'] ? { attemptSequence: Number(options['attempt-sequence']) } : {}),
        ...(options['authority-root'] ? { authorityRoot: path.resolve(options['authority-root']) } : {}),
        ...(options['authority-manifest-root']
            ? { authorityManifestRoot: path.resolve(options['authority-manifest-root']) }
            : {}),
        ...(options['prior-authority-root']
            ? { priorAuthorityRoots: options['prior-authority-root'].map((candidate) => path.resolve(candidate)) }
            : {}),
        ...(options.policy ? { policy: readMeasurementNoisePolicy(path.resolve(options.policy)) } : {}),
        ...(options['product-evidence']
            ? { productEvidenceFile: path.resolve(options['product-evidence']) }
            : {})
    };
}

function executeCommand(command, env)
{
    return new Promise((resolve, reject) =>
    {
        const child = spawn(command[0], command.slice(1), {
            cwd: process.cwd(),
            env,
            stdio: 'inherit',
            shell: false
        });
        child.once('error', reject);
        child.once('close', (code, signal) =>
        {
            if (code === 0)
            {
                resolve({ exitCode: 0, signal: null });
            }
            else
            {
                const error = new Error(`measurement command failed (${signal ? `signal ${signal}` : `exit ${code}`})`);
                error.exitCode = code ?? 1;
                error.signal = signal;
                reject(error);
            }
        });
    });
}

const bootstrap = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'physical-execution-linux-systemd-bootstrap.mjs'
);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function systemctl(args)
{
    return spawnSync('systemctl', ['--user', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function unitAuthority(unitName)
{
    const result = systemctl([
        'show',
        unitName,
        '--property=ControlGroup',
        '--property=MainPID',
        '--property=ActiveState',
        '--no-pager'
    ]);
    if (result.status !== 0)
    {
        throw new Error(`measurement task cgroup query failed: ${String(result.stderr ?? '').trim()}`);
    }
    return Object.fromEntries(String(result.stdout).trim().split(/\r?\n/u)
        .map((line) => line.split(/=(.*)/su).slice(0, 2)));
}

async function waitForFile(file, child, deadlineAt)
{
    while (Date.now() < deadlineAt)
    {
        if (fs.existsSync(file))
        {
            return;
        }
        if (child.exitCode !== null || child.signalCode !== null)
        {
            throw new Error('measurement task supervisor exited before its handshake completed');
        }
        await delay(10);
    }
    throw new Error(`measurement task handshake timed out: ${path.basename(file)}`);
}

function waitForExit(child)
{
    if (child.exitCode !== null || child.signalCode !== null)
    {
        return Promise.resolve({ exitCode: child.exitCode, signal: child.signalCode });
    }
    return new Promise((resolve, reject) =>
    {
        child.once('error', reject);
        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    });
}

function bindProductEvidence(file)
{
    const absolute = path.resolve(file);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`measurement product evidence must be a regular file: ${absolute}`);
    }
    const bytes = fs.readFileSync(absolute);
    return {
        path: absolute,
        size: bytes.length,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    };
}

export async function runTaskScopedPerformanceAdmission({
    windowId,
    evidenceFile,
    command,
    env = process.env,
    runId = env.FSUSBLOG_MEASUREMENT_RUN_ID
    || env.FSUSBLOG_TEST_RUN_ID
    || `standalone-${randomUUID()}`,
    attemptSequence = env.FSUSBLOG_MEASUREMENT_ATTEMPT_SEQUENCE
        ? Number(env.FSUSBLOG_MEASUREMENT_ATTEMPT_SEQUENCE)
        : null,
    authorityRoot = env.FSUSBLOG_MEASUREMENT_AUTHORITY_ROOT
    || `${path.resolve(evidenceFile)}.authority`,
    authorityManifestRoot = env.FSUSBLOG_MEASUREMENT_AUTHORITY_MANIFEST_ROOT
    || `${path.resolve(authorityRoot)}.manifest`,
    priorAuthorityRoots = [],
    productEvidenceFile = null,
    policy,
    envelopeFactory = createMeasurementNoiseEnvelope,
    onMeasurementStarted = null
} = {})
{
    if (process.platform !== 'linux')
    {
        throw new Error(`task-scoped performance qualification is unsupported on ${process.platform}`);
    }
    const owner = `${windowId}:${process.pid}:${randomUUID()}`;
    const unitName = `fsusblog-measurement-${randomUUID().replaceAll('-', '')}`;
    const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-measurement-task-'));
    const readyFile = path.join(controlRoot, 'ready');
    const startFile = path.join(controlRoot, 'start');
    const resultFile = path.join(controlRoot, 'result.json');
    const finalizeFile = path.join(controlRoot, 'finalize');
    const qualificationRequestDirectory = path.join(controlRoot, 'qualification-requests');
    fs.mkdirSync(qualificationRequestDirectory, { mode: 0o700 });
    const childEnv = {
        ...env,
        [measurementEnvelopeOwnerEnvironment]: owner,
        [measurementQualificationRequestEnvironment]: qualificationRequestDirectory
    };
    fs.writeFileSync(path.join(controlRoot, 'command.json'), `${JSON.stringify(command)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(controlRoot, 'environment.json'), `${JSON.stringify(childEnv)}\n`, { mode: 0o600 });
    const supervisor = spawn('systemd-run', [
        '--user',
        '--quiet',
        '--wait',
        '--pipe',
        '--collect',
        '--service-type=exec',
        '--property=KillMode=control-group',
        '--property=ExitType=cgroup',
        '--property=CPUAccounting=yes',
        '--property=MemoryAccounting=yes',
        '--property=IOAccounting=yes',
        '--property=TasksAccounting=yes',
        `--working-directory=${process.cwd()}`,
        `--unit=${unitName}`,
        process.execPath,
        bootstrap,
        controlRoot
    ], {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'inherit', 'inherit']
    });
    const terminateSupervisor = () =>
    {
        systemctl(['kill', '--kill-who=all', '--signal=SIGTERM', unitName]);
        supervisor.kill('SIGTERM');
    };
    process.once('SIGINT', terminateSupervisor);
    process.once('SIGTERM', terminateSupervisor);
    let finalized = false;
    try
    {
        await waitForFile(readyFile, supervisor, Date.now() + 10_000);
        const authority = unitAuthority(unitName);
        const rootPid = Number(fs.readFileSync(readyFile, 'utf8').trim());
        if (!authority.ControlGroup || Number(authority.MainPID) !== rootPid)
        {
            throw new Error('measurement task cgroup identity does not match its supervisor');
        }
        const cgroupPath = path.join('/sys/fs/cgroup', authority.ControlGroup.replace(/^\/+/u, ''));
        const envelope = envelopeFactory({
            windowId,
            evidenceFile,
            runId,
            attemptSequence,
            authorityRoot,
            authorityManifestRoot,
            priorAuthorityRoots,
            ...(policy ? { policy } : {}),
            collector: createLinuxMeasurementCollector({ rootPid, cgroupPath })
        });
        const preflight = await envelope.preflight();
        envelope.start(preflight);
        if (onMeasurementStarted)
        {
            await onMeasurementStarted({ supervisorArgv: [...supervisor.spawnargs] });
        }
        fs.writeFileSync(startFile, 'start\n', { mode: 0o600 });
        await waitForFile(resultFile, supervisor, Date.now() + 24 * 60 * 60 * 1000);
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        let productEvidence = null;
        let productEvidenceError = null;
        if (result.exitCode === 0 && !result.signal && productEvidenceFile)
        {
            try
            {
                productEvidence = bindProductEvidence(productEvidenceFile);
            }
            catch (error)
            {
                productEvidenceError = error;
            }
        }
        let qualificationRequests = [];
        let qualificationRequestError = null;
        try
        {
            qualificationRequests = collectMeasurementQualificationRequests(
                qualificationRequestDirectory,
                owner
            );
        }
        catch (error)
        {
            qualificationRequestError = error;
        }
        const evidence = await envelope.finish({
            preflight,
            productOutcome: result.exitCode === 0
        && !result.signal
        && !productEvidenceError
        && !qualificationRequestError
                ? {
            status: 'completed',
            exitCode: 0,
            ...(productEvidence ? { productEvidence } : {}),
            qualificationRequests: qualificationRequests.map(({ request, productEvidence: binding }) => ({
              requestId: request.requestId,
              kind: request.kind,
              productEvidence: binding
            }))
          }
                : { status: 'failed', exitCode: result.exitCode, signal: result.signal }
        });
        const authoritySequence = readMeasurementNoiseAuthoritySequence(evidenceFile, {
            authorityRoot,
            authorityManifestRoot,
            priorAuthorityRoots,
            expectedRunId: runId,
            expectedWindowId: windowId,
            ...(policy ? { policy } : {})
        });
        finalizeMeasurementQualificationRequests(qualificationRequests, evidence, {
            error: qualificationRequestError?.message ?? null,
            authoritySequence
        });
        fs.writeFileSync(finalizeFile, 'finalize\n', { mode: 0o600 });
        finalized = true;
        const supervisorExit = await waitForExit(supervisor);
        if (!evidence.qualificationEligible)
        {
            const error = new Error(`${windowId} failed measurement qualification: ${evidence.classification}`);
            error.classification = evidence.classification;
            error.evidence = evidence;
            throw error;
        }
        if (productEvidenceError)
        {
            throw productEvidenceError;
        }
        if (qualificationRequestError)
        {
            throw qualificationRequestError;
        }
        if (result.exitCode !== 0 || result.signal || supervisorExit.exitCode !== 0)
        {
            const error = new Error(`measurement command failed (${result.signal ? `signal ${result.signal}` : `exit ${result.exitCode}`})`);
            error.exitCode = result.exitCode ?? supervisorExit.exitCode ?? 1;
            throw error;
        }
        return { status: 'completed', owner, nested: false, result, evidence };
    }
    finally
    {
        process.removeListener('SIGINT', terminateSupervisor);
        process.removeListener('SIGTERM', terminateSupervisor);
        if (!finalized)
        {
            systemctl(['kill', '--kill-who=all', '--signal=SIGKILL', unitName]);
            systemctl(['stop', unitName]);
            if (fs.existsSync(finalizeFile) === false)
            {
                try
                {
                    fs.writeFileSync(finalizeFile, 'finalize\n', { mode: 0o600 });
                }
                catch
                {
                    // Finalization is best-effort after the supervisor has already failed.
                }
            }
            await waitForExit(supervisor).catch(() =>
            {});
        }
        fs.rmSync(controlRoot, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const options = parseCli(process.argv.slice(2));
        fs.mkdirSync(path.dirname(options.evidenceFile), { recursive: true });
        if (String(process.env[measurementEnvelopeOwnerEnvironment] ?? '').trim())
        {
            await runWithPerformanceAdmission({
                ...options,
                execute: (env) => executeCommand(options.command, env)
            });
        }
        else
        {
            await runTaskScopedPerformanceAdmission(options);
        }
    }
    catch (error)
    {
        console.error(`[performance-admission] ${error.message}`);
        process.exitCode = error.exitCode || 1;
    }
}

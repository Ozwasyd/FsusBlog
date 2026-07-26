#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = path.join(root, 'config/testing/release-reliability-scenario-catalog.json');
const canonicalScenarioIds = [
    'release-soak-min',
    'release-load-peak',
    'release-load-burst',
    'release-data-scale-m',
    'release-mutation-critical-slice',
    'release-memory-leak-budget',
    'release-open-handle-budget'
];

function sha256(bytes)
{
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function relativePath(repositoryRoot, value)
{
    const resolved = path.resolve(repositoryRoot, value);
    if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error(`Path resolves outside the repository: ${value}`);
    }
    return resolved;
}

function requireNonEmptyString(value, description, errors)
{
    if (typeof value !== 'string' || value.trim() === '')
    {
        errors.push(`${description} must be a non-empty string`);
    }
}

export function validateCatalog(catalog)
{
    const errors = [];
    if (catalog?.schema !== 'fsusblog.release-reliability-scenario-catalog.v2')
    {
        errors.push(`catalog schema must be fsusblog.release-reliability-scenario-catalog.v2, found: ${catalog?.schema ?? '<missing>'}`);
    }
    if (catalog?.catalogScenarioCount !== canonicalScenarioIds.length)
    {
        errors.push(`catalogScenarioCount must be ${canonicalScenarioIds.length}`);
    }
    if (!Array.isArray(catalog?.scenarios) || catalog.scenarios.length !== canonicalScenarioIds.length)
    {
        errors.push(`catalog must contain exactly ${canonicalScenarioIds.length} scenarios`);
        return errors;
    }

    const ids = catalog.scenarios.map((scenario) => scenario?.id);
    if (new Set(ids).size !== ids.length)
    {
        errors.push('catalog scenario IDs must be unique');
    }
    if (JSON.stringify(ids) !== JSON.stringify(canonicalScenarioIds))
    {
        errors.push('catalog scenario IDs must exactly match the canonical release reliability set in canonical order');
    }

    for (const scenario of catalog.scenarios)
    {
        const prefix = `scenario ${scenario?.id ?? '<missing>'}`;
        requireNonEmptyString(scenario?.id, `${prefix}.id`, errors);
        requireNonEmptyString(scenario?.owner, `${prefix}.owner`, errors);
        if (typeof scenario?.command === 'string')
        {
            errors.push(`${prefix}.command is forbidden; use command.executable and command.args`);
        }
        requireNonEmptyString(scenario?.command?.executable, `${prefix}.command.executable`, errors);
        if (!Array.isArray(scenario?.command?.args) || scenario.command.args.some((argument) => typeof argument !== 'string'))
        {
            errors.push(`${prefix}.command.args must be an array of strings`);
        }
        if (scenario?.command?.env !== undefined
            && (scenario.command.env === null
                || Array.isArray(scenario.command.env)
                || Object.values(scenario.command.env).some((value) => typeof value !== 'string')))
        {
            errors.push(`${prefix}.command.env must be an object containing only string overrides`);
        }
        requireNonEmptyString(scenario?.command?.cwd, `${prefix}.command.cwd`, errors);
        requireNonEmptyString(scenario?.resourceClass, `${prefix}.resourceClass`, errors);
        requireNonEmptyString(scenario?.authoritativeEvidence?.path, `${prefix}.authoritativeEvidence.path`, errors);
        const expectedSchema = scenario?.authoritativeEvidence?.expectedSchema;
        if (!expectedSchema || typeof expectedSchema !== 'object' || Array.isArray(expectedSchema))
        {
            errors.push(`${prefix}.authoritativeEvidence.expectedSchema must be an object`);
        }
        else
        {
            if (!Array.isArray(expectedSchema.required) || expectedSchema.required.length === 0
                || expectedSchema.required.some((field) => typeof field !== 'string' || field.trim() === ''))
            {
                errors.push(`${prefix}.authoritativeEvidence.expectedSchema.required must be a non-empty string array`);
            }
            if (!Array.isArray(expectedSchema.passStatusValues) || expectedSchema.passStatusValues.length === 0
                || expectedSchema.passStatusValues.some((value) => typeof value !== 'string' || value.trim() === ''))
            {
                errors.push(`${prefix}.authoritativeEvidence.expectedSchema.passStatusValues must be a non-empty string array`);
            }
        }
    }
    return errors;
}

export function loadCatalog({ catalogFile = catalogPath } = {})
{
    const raw = fs.readFileSync(catalogFile, 'utf8');
    const catalog = JSON.parse(raw);
    const errors = validateCatalog(catalog);
    if (errors.length > 0)
    {
        throw new Error(`Invalid release reliability catalog:\n- ${errors.join('\n- ')}`);
    }
    return catalog;
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
}

function validateEvidence(document, expectedSchema)
{
    if (document === null || typeof document !== 'object' || Array.isArray(document))
    {
        throw new Error('authoritative evidence must be a JSON object');
    }
    for (const field of expectedSchema.required)
    {
        if (!(field in document))
        {
            throw new Error(`authoritative evidence is missing required field: ${field}`);
        }
    }
    if (!expectedSchema.passStatusValues.includes(document.status))
    {
        throw new Error(`authoritative evidence has non-passing status: ${document.status ?? '<missing>'}`);
    }
    if (expectedSchema.schema !== undefined && document.schema !== expectedSchema.schema)
    {
        throw new Error(`authoritative evidence schema mismatch: expected ${expectedSchema.schema}, found ${document.schema ?? '<missing>'}`);
    }
}

function runProcess({ executable, args, cwd, env, stdoutLog, stderrLog, spawnProcess })
{
    return new Promise((resolve) =>
    {
        let child;
        const startedAtMs = Date.now();
        try
        {
            child = spawnProcess(executable, args, {
                cwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        }
        catch (error)
        {
            resolve({
                startedAtMs,
                finishedAtMs: Date.now(),
                exitCode: null,
                signal: null,
                spawnError: error instanceof Error ? error.message : String(error)
            });
            return;
        }
        if (!child || typeof child.once !== 'function' || !child.stdout || !child.stderr)
        {
            resolve({
                startedAtMs,
                finishedAtMs: Date.now(),
                exitCode: null,
                signal: null,
                spawnError: 'producer spawn did not return a child process with stdout and stderr streams'
            });
            return;
        }

        const stdout = fs.createWriteStream(stdoutLog, { flags: 'w' });
        const stderr = fs.createWriteStream(stderrLog, { flags: 'w' });
        child.stdout.pipe(stdout);
        child.stderr.pipe(stderr);
        let completed = false;
        const complete = (outcome) =>
        {
            if (completed)
            {
                return;
            }
            completed = true;
            stdout.end();
            stderr.end();
            resolve({ startedAtMs, finishedAtMs: Date.now(), ...outcome });
        };
        child.once('error', (error) => complete({
            exitCode: null,
            signal: null,
            spawnError: error instanceof Error ? error.message : String(error)
        }));
        child.once('exit', (exitCode, signal) => complete({
            exitCode,
            signal,
            spawnError: null
        }));
    });
}

function resultPath(repositoryRoot, invocationId, scenarioId)
{
    return path.join(repositoryRoot, '.tmp', 'release-reliability', invocationId, 'scenario-results', `${scenarioId}.json`);
}

export async function executeScenario({
    catalog,
    scenarioId,
    repositoryRoot = root,
    invocationId = randomUUID(),
    spawnProcess = spawn,
    now = () => new Date().toISOString()
})
{
    const scenario = catalog.scenarios.find((candidate) => candidate.id === scenarioId);
    if (!scenario)
    {
        throw new Error(`Unknown scenario: ${scenarioId}`);
    }
    const commandCwd = relativePath(repositoryRoot, scenario.command.cwd);
    const evidenceFile = relativePath(repositoryRoot, scenario.authoritativeEvidence.path);
    const invocationRoot = path.join(repositoryRoot, '.tmp', 'release-reliability', invocationId);
    const stdoutLog = path.join(invocationRoot, 'logs', `${scenario.id}.stdout.log`);
    const stderrLog = path.join(invocationRoot, 'logs', `${scenario.id}.stderr.log`);
    const relativeEvidencePath = path.relative(repositoryRoot, evidenceFile).replaceAll(path.sep, '/');
    const commandIdentity = sha256(JSON.stringify({
        executable: scenario.command.executable,
        args: scenario.command.args,
        env: scenario.command.env ?? {},
        cwd: scenario.command.cwd
    }));

    fs.mkdirSync(path.dirname(stdoutLog), { recursive: true });
    fs.rmSync(evidenceFile, { force: true });

    const outcome = await runProcess({
        executable: scenario.command.executable,
        args: scenario.command.args,
        cwd: commandCwd,
        env: { ...process.env, ...(scenario.command.env ?? {}) },
        stdoutLog,
        stderrLog,
        spawnProcess
    });

    let failure = null;
    let evidence = null;
    if (outcome.spawnError)
    {
        failure = `producer spawn failed: ${outcome.spawnError}`;
    }
    else if (outcome.signal)
    {
        failure = `producer terminated by signal: ${outcome.signal}`;
    }
    else if (outcome.exitCode !== 0)
    {
        failure = `producer exited with code: ${outcome.exitCode}`;
    }
    else if (!fs.existsSync(evidenceFile))
    {
        failure = `authoritative evidence was not produced: ${relativeEvidencePath}`;
    }
    else
    {
        try
        {
            const bytes = fs.readFileSync(evidenceFile);
            const document = JSON.parse(bytes.toString('utf8'));
            validateEvidence(document, scenario.authoritativeEvidence.expectedSchema);
            evidence = {
                path: relativeEvidencePath,
                digest: sha256(bytes),
                schema: document.schema ?? null,
                status: document.status
            };
        }
        catch (error)
        {
            failure = error instanceof Error ? error.message : String(error);
        }
    }

    const result = {
        schema: 'fsusblog.release-reliability-scenario-result.v1',
        invocationId,
        scenarioId: scenario.id,
        owner: scenario.owner,
        resourceClass: scenario.resourceClass,
        status: failure === null ? 'passed' : 'failed',
        startedAt: new Date(outcome.startedAtMs).toISOString(),
        finishedAt: new Date(outcome.finishedAtMs).toISOString(),
        durationMs: outcome.finishedAtMs - outcome.startedAtMs,
        producer: {
            executable: scenario.command.executable,
            args: scenario.command.args,
            env: scenario.command.env ?? {},
            cwd: scenario.command.cwd,
            commandIdentity,
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            stdoutLog: path.relative(repositoryRoot, stdoutLog).replaceAll(path.sep, '/'),
            stderrLog: path.relative(repositoryRoot, stderrLog).replaceAll(path.sep, '/')
        },
        authoritativeEvidence: evidence,
        failure,
        recordedAt: now()
    };
    writeJsonAtomic(resultPath(repositoryRoot, invocationId, scenario.id), result);
    return result;
}

export async function executeScenarios({
    catalog,
    scenarioId = null,
    repositoryRoot = root,
    invocationId = randomUUID(),
    spawnProcess = spawn,
    now = () => new Date().toISOString()
})
{
    const scenarios = scenarioId === null
        ? catalog.scenarios
        : catalog.scenarios.filter((scenario) => scenario.id === scenarioId);
    if (scenarios.length === 0)
    {
        throw new Error(`Unknown scenario: ${scenarioId}`);
    }
    const results = [];
    for (const scenario of scenarios)
    {
        results.push(await executeScenario({
            catalog,
            scenarioId: scenario.id,
            repositoryRoot,
            invocationId,
            spawnProcess,
            now
        }));
    }
    return results;
}

function parseArgs(argumentsList)
{
    let scenario = null;
    let validateCatalogOnly = false;
    for (let index = 0; index < argumentsList.length; index += 1)
    {
        const argument = argumentsList[index];
        if (argument === '--scenario' && index + 1 < argumentsList.length)
        {
            scenario = argumentsList[++index];
        }
        else if (argument === '--validate-catalog')
        {
            validateCatalogOnly = true;
        }
        else
        {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    return { scenario, validateCatalogOnly };
}

async function main()
{
    const { scenario, validateCatalogOnly } = parseArgs(process.argv.slice(2));
    const catalog = loadCatalog();
    if (validateCatalogOnly)
    {
        console.log(`[release-reliability-catalog] valid catalog schema=${catalog.schema} count=${catalog.scenarios.length}`);
        return;
    }
    const invocationId = randomUUID();
    const results = await executeScenarios({ catalog, scenarioId: scenario, invocationId });
    for (const result of results)
    {
        console.log(`[release-reliability:${result.scenarioId}] status=${result.status} result=${path.relative(root, resultPath(root, invocationId, result.scenarioId))}`);
    }
    if (results.some((result) => result.status !== 'passed'))
    {
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch((error) =>
    {
        console.error(`[release-reliability] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}

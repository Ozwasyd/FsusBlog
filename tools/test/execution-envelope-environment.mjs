import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const {createExecutionEnvelopePolicyIdentity, executionEnvelopeDigest} = await import(new URL('../test-matrix/execution-envelope-policy.mjs', import.meta.url));
export const executionEnvelopeEnvironmentSchema =
    'fsusblog.test-execution-envelope-environment.v1';
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const sensitiveNamePattern = /(?:AUTH|COOKIE|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/iu;
const fixedEnvironment = Object.freeze({
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC'
});

function sha256(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function executableCandidates(name, pathValue, platform)
{
    if (path.isAbsolute(name))
    {
        return [name];
    }
    const extensions = platform === 'win32'
        ? String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
        : [''];
    return String(pathValue ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .flatMap((entry) => extensions.map((extension) =>
            path.resolve(entry, platform === 'win32' ? `${name}${extension}` : name)));
}

export function resolveExecutablePath(name, {
    pathValue,
    platform = process.platform,
    access = fs.accessSync,
    stat = fs.statSync
} = {})
{
    if (!String(name ?? '').trim())
    {
        throw new Error('execution envelope executable name is missing');
    }
    for (const candidate of executableCandidates(name, pathValue, platform))
    {
        try
        {
            access(candidate, fs.constants.X_OK);
            if (!stat(candidate).isFile())
            {
                continue;
            }
            return path.resolve(candidate);
        }
        catch
        {
            // Continue through the declared ordered PATH without shell lookup.
        }
    }
    throw new Error(`execution envelope executable is missing or not executable: ${name}`);
}

export function versionArguments(name)
{
    const base = path.basename(name).toLowerCase().replace(/\.exe$/u, '');
    if (base === 'msbuild')
    {
        return ['-version', '-nologo'];
    }
    return ['--version'];
}

export function observeExecutableIdentity(name, {
    pathValue,
    platform = process.platform,
    resolve = resolveExecutablePath,
    readFile = fs.readFileSync,
    realpath = fs.realpathSync,
    observeVersion = (file) => spawnSync(file, versionArguments(file), {
        encoding: 'utf8',
        env: fixedEnvironment,
        shell: false,
        windowsHide: true
    })
} = {})
{
    const absolutePath = resolve(name, { pathValue, platform });
    const realPath = realpath(absolutePath);
    const versionObservation = observeVersion(realPath);
    return executableIdentityFromObservation(name, absolutePath, realPath, versionObservation, readFile);
}

function executableIdentityFromObservation(name, absolutePath, realPath, versionObservation, readFile)
{
    if (versionObservation?.error || versionObservation?.status !== 0)
    {
        throw new Error(
            `execution envelope executable version is unobservable: ${name}`
        );
    }
    const version = String(versionObservation.stdout || versionObservation.stderr)
        .trim()
        .split(/\r?\n/u)[0];
    if (!version)
    {
        throw new Error(`execution envelope executable version is empty: ${name}`);
    }
    return Object.freeze({
        requestedName: name,
        absolutePath,
        realPath,
        version,
        sha256: sha256(readFile(realPath))
    });
}

// This is a consumer of an original held-managed execution port, not a capability issuer.
// The owner assertion must consult its private admission/terminal state; wire evidence is not authority.
export async function executeManagedPreparation(request, {
    executePreparation,
    assertPreparationExecution
})
{
    if (typeof executePreparation !== 'function' || typeof assertPreparationExecution !== 'function')
    {
        throw new Error('execution preparation requires an actual held-managed execution and owner assertion');
    }
    if (!['executable-version', 'landlock-helper-build'].includes(request?.purpose)
        || !Array.isArray(request.command) || request.command.length === 0
        || request.command.some((part) => typeof part !== 'string' || part.includes('\0'))
        || typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd)
        || !request.environment || typeof request.environment !== 'object' || Array.isArray(request.environment)
        || Object.values(request.environment).some((value) => typeof value !== 'string'))
    {
        throw new Error('execution preparation requires an explicit original derived tool tuple');
    }
    const ownedRequest = Object.freeze({
        purpose: request.purpose, command: Object.freeze([...request.command]), cwd: request.cwd,
        environment: Object.freeze({ ...request.environment })
    });
    await assertPreparationExecution({ request: ownedRequest, phase: 'before', physicalExecution: null });
    let physicalExecution = null;
    let firstFailure = null;
    try
    {
        physicalExecution = await executePreparation(ownedRequest);
    }
    catch (error)
    {
        firstFailure = error;
        physicalExecution = error?.physicalExecution ?? null;
    }
    try
    {
        await assertPreparationExecution({ request: ownedRequest, phase: 'after', physicalExecution });
    }
    catch (error)
    {
        if (firstFailure)
        {
            firstFailure.preparationOwnerAssertionError = error;
        }
        else
        {
            firstFailure = error;
        }
    }
    if (firstFailure)
    {
        firstFailure.physicalExecution ??= physicalExecution;
        throw firstFailure;
    }
    try
    {
        validatePreparationOutput(physicalExecution);
    }
    catch (error)
    {
        error.physicalExecution = physicalExecution;
        throw error;
    }
    return physicalExecution;
}

function validatePreparationOutput(physicalExecution)
{
    const child = physicalExecution?.processInventory?.filter((entry) => entry.role === 'direct-child');
    const capture = physicalExecution?.outputCapture;
    if (physicalExecution?.schema !== 'fsusblog.physical-execution-process-tree.v1'
        || physicalExecution.platform !== 'linux'
        || physicalExecution.authority?.kind !== 'linux-cgroup-process-group'
        || physicalExecution.authority.established !== true
        || physicalExecution.postObservation !== 'zero-members'
        || physicalExecution.logComplete !== true
        || physicalExecution.logTruncationReason !== null
        || physicalExecution.forcedPipeClose !== false
        || !physicalExecution.lifecycle?.includes('post-observe-zero-members')
        || !physicalExecution.lifecycle?.includes('bounded-pipe-close')
        || !physicalExecution.lifecycle?.includes('seal-completed-receipt')
        || !Array.isArray(physicalExecution.termination) || physicalExecution.termination.length !== 0
        || child?.length !== 1 || !Number.isSafeInteger(child[0].pid) || child[0].pid <= 0
        || !child[0].startIdentity || child[0].exitCode !== 0 || child[0].signal !== null
        || typeof physicalExecution.stdout !== 'string' || typeof physicalExecution.stderr !== 'string'
        || capture?.maximumBytesPerStream !== physicalExecution.policy?.maximumCapturedOutputBytesPerStream
        || !Number.isSafeInteger(capture?.maximumBytesPerStream) || capture.maximumBytesPerStream <= 0)
    {
        throw new Error('execution preparation returned incomplete or failed physical execution evidence');
    }
    for (const stream of ['stdout', 'stderr'])
    {
        if (capture[`${stream}Truncated`] !== false
            || !Number.isSafeInteger(capture[`${stream}Bytes`]) || capture[`${stream}Bytes`] < 0
            || capture[`${stream}Bytes`] !== capture[`${stream}CapturedBytes`]
            || capture[`${stream}Bytes`] > capture.maximumBytesPerStream
            || Buffer.byteLength(physicalExecution[stream], 'utf8') > capture.maximumBytesPerStream)
        {
            throw new Error(`execution preparation ${stream} capture is incomplete or unbounded`);
        }
    }
}

export async function observeExecutableIdentityAsync(name, {
    pathValue,
    environment,
    cwd,
    executePreparation,
    assertPreparationExecution,
    versionArgs = null,
    platform = process.platform,
    resolve = resolveExecutablePath,
    readFile = fs.readFileSync,
    realpath = fs.realpathSync
})
{
    if (typeof executePreparation !== 'function' || typeof assertPreparationExecution !== 'function')
    {
        throw new Error('asynchronous executable observation requires the original held-managed owner port');
    }
    const absolutePath = resolve(name, { pathValue, platform });
    const realPath = realpath(absolutePath);
    if (versionArgs !== null && (path.basename(realPath) !== 'ip'
        || !Array.isArray(versionArgs) || versionArgs.length !== 1 || versionArgs[0] !== '-Version'))
    {
        throw new Error('executable version arguments must use the original tool observation rule');
    }
    const observation = await executeManagedPreparation({
        purpose: 'executable-version', command: [realPath, ...(versionArgs ?? versionArguments(realPath))],
        cwd, environment
    }, { executePreparation, assertPreparationExecution });
    return executableIdentityFromObservation(name, absolutePath, realPath, {
        status: 0, stdout: observation.stdout, stderr: observation.stderr
    }, readFile);
}

export function observePathEntries(pathValue, {
    realpath = fs.realpathSync,
    exists = fs.existsSync
} = {})
{
    return String(pathValue ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((entry, index) =>
        {
            const absolutePath = path.resolve(entry);
            if (!exists(absolutePath))
            {
                return {
                    index,
                    absolutePath,
                    realPath: null,
                    applicable: false,
                    notApplicableReason: 'path-entry-missing'
                };
            }
            return {
                index,
                absolutePath,
                realPath: realpath(absolutePath),
                applicable: true,
                notApplicableReason: null
            };
        });
}

function environmentObservation(name, value)
{
    const sensitive = sensitiveNamePattern.test(name);
    return {
        name,
        present: value !== undefined,
        type: value === undefined ? 'not-applicable' : 'string',
        sensitive,
        value: value === undefined || sensitive ? null : value,
        valueDigest: value === undefined ? null : sha256(String(value)),
        notApplicableReason: value === undefined ? 'allowlisted-parent-value-absent' : null
    };
}

function validateEnvironmentName(name)
{
    if (!environmentNamePattern.test(name))
    {
        throw new Error(`execution envelope environment name is invalid: ${name}`);
    }
}

export function createMinimalCorrectnessEnvironment({
    parentEnvironment,
    producerAllowlist,
    injectedEnvironment = {},
    policy
})
{
    if (policy?.contract?.environment?.mode !== 'minimal-base-plus-producer-allowlist')
    {
        throw new Error('execution envelope environment policy is unavailable');
    }
    const controlled = new Set(policy.contract.environment.controlledVariables);
    const allowlist = [...new Set(['PATH', ...producerAllowlist])].sort();
    for (const name of [...allowlist, ...Object.keys(injectedEnvironment)])
    {
        validateEnvironmentName(name);
    }
    const childEnvironment = { ...fixedEnvironment };
    const observations = [];
    for (const name of allowlist)
    {
        const value = parentEnvironment[name];
        observations.push(environmentObservation(name, value));
        if (value !== undefined)
        {
            childEnvironment[name] = String(value);
        }
    }
    for (const [name, value] of Object.entries(injectedEnvironment))
    {
        if (value === undefined || value === null)
        {
            throw new Error(`execution envelope injected environment is missing: ${name}`);
        }
        childEnvironment[name] = String(value);
        observations.push(environmentObservation(name, String(value)));
    }
    const controlledDisposition = [...controlled]
        .sort()
        .map((name) => ({
            name,
            disposition: allowlist.includes(name) || Object.hasOwn(injectedEnvironment, name)
                ? 'allowlisted'
                : 'denied'
        }));
    return {
        childEnvironment: Object.freeze(childEnvironment),
        observation: Object.freeze({
            mode: policy.contract.environment.mode,
            inheritedAmbientCount: 0,
            fixedNames: Object.keys(fixedEnvironment).sort(),
            producerAllowlist: allowlist,
            variables: observations.sort((left, right) => left.name.localeCompare(right.name)),
            controlledDisposition,
            pathEntries: observePathEntries(childEnvironment.PATH)
        })
    };
}

export function verifyExecutableIdentity(planned, actual)
{
    for (const field of ['absolutePath', 'realPath', 'version', 'sha256'])
    {
        if (planned?.[field] !== actual?.[field])
        {
            throw new Error(
                `execution envelope executable drift: ${field} planned=${planned?.[field] ?? '<missing>'} actual=${actual?.[field] ?? '<missing>'}`
            );
        }
    }
    return actual;
}

export function prepareCorrectnessEnvironment({
    command,
    parentEnvironment,
    producerAllowlist,
    injectedEnvironment,
    policy,
    catalog,
    observeExecutable = observeExecutableIdentity
})
{
    if (!Array.isArray(command) || command.length === 0)
    {
        throw new Error('execution envelope command is missing');
    }
    const minimal = createMinimalCorrectnessEnvironment({
        parentEnvironment,
        producerAllowlist,
        injectedEnvironment,
        policy
    });
    const plannedExecutable = observeExecutable(command[0], {
        pathValue: minimal.childEnvironment.PATH
    });
    const observedActualExecutable = observeExecutable(plannedExecutable.absolutePath, {
        pathValue: minimal.childEnvironment.PATH
    });
    return preparedEnvironmentFromObservations({ command, minimal, plannedExecutable, observedActualExecutable, policy, catalog });
}

function preparedEnvironmentFromObservations({ command, minimal, plannedExecutable, observedActualExecutable, policy, catalog })
{
    verifyExecutableIdentity(plannedExecutable, observedActualExecutable);
    const actualExecutable = Object.freeze({
        ...observedActualExecutable,
        requestedName: plannedExecutable.requestedName
    });
    const policyIdentity = createExecutionEnvelopePolicyIdentity({ policy, catalog });
    const fragment = Object.freeze({
        schema: executionEnvelopeEnvironmentSchema,
        qualificationEligible: true,
        ...policyIdentity,
        environment: minimal.observation,
        plannedExecutable,
        actualExecutable,
        admission: 'planned-actual-exact'
    });
    return Object.freeze({
        command: [actualExecutable.absolutePath, ...command.slice(1)],
        environment: minimal.childEnvironment,
        fragment,
        fragmentDigest: executionEnvelopeDigest(fragment)
    });
}

export async function prepareCorrectnessEnvironmentAsync({
    command, cwd, parentEnvironment, producerAllowlist, injectedEnvironment, policy, catalog,
    executePreparation, assertPreparationExecution
})
{
    if (!Array.isArray(command) || command.length === 0)
    {
        throw new Error('execution envelope command is missing');
    }
    if (typeof executePreparation !== 'function' || typeof assertPreparationExecution !== 'function')
    {
        throw new Error('asynchronous correctness preparation requires the original held-managed owner port');
    }
    const minimal = createMinimalCorrectnessEnvironment({ parentEnvironment, producerAllowlist, injectedEnvironment, policy });
    const observationOptions = {
        pathValue: minimal.childEnvironment.PATH, environment: minimal.childEnvironment, cwd,
        executePreparation, assertPreparationExecution
    };
    const plannedExecutable = await observeExecutableIdentityAsync(command[0], observationOptions);
    const observedActualExecutable = await observeExecutableIdentityAsync(plannedExecutable.absolutePath, observationOptions);
    return preparedEnvironmentFromObservations({ command, minimal, plannedExecutable, observedActualExecutable, policy, catalog });
}

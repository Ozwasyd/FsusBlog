import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    createExecutionEnvelopePolicyIdentity,
    executionEnvelopeDigest
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../test-matrix/execution-envelope-policy.mjs';

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

function versionArguments(name)
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

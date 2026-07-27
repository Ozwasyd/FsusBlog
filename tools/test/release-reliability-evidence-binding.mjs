import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { digestValue } from './release-reliability-receipt.mjs';

const bindingEnvironmentNames = [
    'FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID',
    'FSUSBLOG_RELEASE_RELIABILITY_RUN_ID',
    'FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID',
    'FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH',
    'FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_DIGEST'
];
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

function requiredEnvironment(environment, name)
{
    const value = String(environment[name] ?? '').trim();
    if (!value)
    {
        throw new Error(`release reliability evidence binding requires ${name}`);
    }
    return value;
}

function approvedIdentityPath(repositoryRoot, configuredPath, invocationId)
{
    const normalized = String(configuredPath ?? '').trim().replaceAll('\\', '/').replace(/^\.\//u, '');
    const expected = `.tmp/release-reliability/${invocationId}/identity.json`;
    if (normalized !== expected || path.posix.normalize(normalized) !== normalized)
    {
        throw new Error('release reliability identity path is not canonical for the current invocation');
    }
    const absolute = path.resolve(repositoryRoot, normalized);
    if (absolute === repositoryRoot || !absolute.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error('release reliability identity path escapes the repository');
    }
    let cursor = absolute;
    while (cursor !== repositoryRoot)
    {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
        {
            throw new Error('release reliability identity path contains a symlink');
        }
        cursor = path.dirname(cursor);
    }
    if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile())
    {
        throw new Error('release reliability identity file is unavailable');
    }
    return absolute;
}

export function readReleaseReliabilityEvidenceBinding({
    repositoryRoot = process.cwd(),
    environment = process.env
} = {})
{
    const configured = bindingEnvironmentNames.filter(
        (name) => String(environment[name] ?? '').trim() !== ''
    );
    if (configured.length === 0)
    {
        return null;
    }
    if (configured.length !== bindingEnvironmentNames.length)
    {
        throw new Error('release reliability evidence binding environment is incomplete');
    }

    const invocationId = requiredEnvironment(
        environment,
        'FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID'
    );
    const runId = requiredEnvironment(environment, 'FSUSBLOG_RELEASE_RELIABILITY_RUN_ID');
    const scenarioId = requiredEnvironment(
        environment,
        'FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID'
    );
    if (![invocationId, runId, scenarioId].every((value) => safeIdentifierPattern.test(value)))
    {
        throw new Error('release reliability evidence binding identifiers are invalid');
    }
    const identityContentDigest = requiredEnvironment(
        environment,
        'FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_DIGEST'
    );
    if (!digestPattern.test(identityContentDigest))
    {
        throw new Error('release reliability identity digest is invalid');
    }
    const identityPath = approvedIdentityPath(
        path.resolve(repositoryRoot),
        requiredEnvironment(environment, 'FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH'),
        invocationId
    );
    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    if (identity?.schema !== 'fsusblog.release-reliability-run-identity.v1'
        || identity.status !== 'complete'
        || identity.invocationId !== invocationId
        || identity.runId !== runId
        || identity.contentDigest !== identityContentDigest
        || identity.contentDigest !== digestValue(identity)
        || !/^[0-9a-f]{40}$/u.test(identity.sourceState?.commit ?? '')
        || !digestPattern.test(identity.sourceState?.worktreeFingerprint ?? '')
        || !Number.isInteger(identity.sourceState?.dirtyPathCount)
        || identity.sourceState.dirtyPathCount < 0
        || !Number.isInteger(identity.sourceState?.hashedPathCount)
        || identity.sourceState.hashedPathCount < 0
        || !digestPattern.test(identity.build?.contentDigest ?? ''))
    {
        throw new Error('release reliability run identity is incomplete or mismatched');
    }
    return {
        invocationId,
        runId,
        scenarioId,
        identityContentDigest,
        sourceState: identity.sourceState,
        buildContentDigest: identity.build.contentDigest
    };
}

export function bindReleaseReliabilityEvidence(value, options = {})
{
    const binding = readReleaseReliabilityEvidenceBinding(options);
    if (binding === null)
    {
        return value;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error('release reliability authoritative evidence must be an object');
    }
    if (Object.hasOwn(value, 'releaseReliability'))
    {
        throw new Error('release reliability authoritative evidence already contains a binding');
    }
    return { ...value, releaseReliability: binding };
}

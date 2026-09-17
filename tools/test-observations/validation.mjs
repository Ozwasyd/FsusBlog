import fs from 'node:fs';
import path from 'node:path';

import { supportedFrameworks } from './adapters.mjs';
import { canonicalize, sha256, sha256File } from './source-identity.mjs';

export const observationArtifactSchema = 'fsusblog.test-observation-artifact.v1';

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const outcomes = new Set(['passed', 'failed', 'skipped', 'blocked']);

function digestValue(value)
{
    const content = structuredClone(value);
    delete content.contentDigest;
    return sha256(JSON.stringify(canonicalize(content)));
}

function text(value)
{
    return typeof value === 'string' && value.trim().length > 0;
}

function validReference(value)
{
    const reference = String(value ?? '').trim().replaceAll(path.sep, '/');
    return reference && !path.posix.isAbsolute(reference) && reference !== '..' && !reference.startsWith('../');
}

export function validateObservationArtifact(artifact, {
    evidenceRoot = null,
    expectedSourceState = null,
    expectedClosureDigest = null
} = {})
{
    const errors = [];
    if (artifact?.schema !== observationArtifactSchema)
    {
        errors.push('artifact schema is invalid');
    }
    if (artifact?.contentDigest !== digestValue(artifact))
    {
        errors.push('artifact content digest mismatch');
    }
    if (!Number.isFinite(Date.parse(artifact?.observedAt)))
    {
        errors.push('artifact observedAt is invalid');
    }
    if (!commitPattern.test(String(artifact?.sourceState?.commit ?? '')))
    {
        errors.push('artifact source commit is invalid');
    }
    if (!digestPattern.test(String(artifact?.sourceState?.worktreeFingerprint ?? '')))
    {
        errors.push('artifact worktree fingerprint is invalid');
    }
    if (!digestPattern.test(String(artifact?.sourceClosureDigest ?? '')))
    {
        errors.push('artifact closure digest is invalid');
    }
    if (!digestPattern.test(String(artifact?.producer?.digest ?? '')))
    {
        errors.push('artifact producer digest is invalid');
    }
    if (!supportedFrameworks.has(artifact?.producer?.framework))
    {
        errors.push('artifact producer framework is invalid');
    }
    if (!validReference(artifact?.producer?.reference))
    {
        errors.push('artifact producer reference is invalid');
    }
    if (['os', 'arch', 'runtime'].some((field) => !text(artifact?.runner?.[field])))
    {
        errors.push('artifact runner identity is incomplete');
    }
    if (!text(artifact?.run?.id)
        || !['primary', 'retry', 'diagnostic'].includes(artifact?.run?.attemptKind)
        || !text(artifact?.run?.evidenceClass))
    {
        errors.push('artifact run identity is invalid');
    }
    if (!Array.isArray(artifact?.observations) || artifact.observations.length === 0)
    {
        errors.push('artifact observations must be a non-empty array');
    }
    if (expectedSourceState
        && (artifact?.sourceState?.commit !== expectedSourceState.commit
            || artifact?.sourceState?.worktreeFingerprint !== expectedSourceState.worktreeFingerprint))
    {
        errors.push('artifact source identity mismatch');
    }
    if (expectedClosureDigest && artifact?.sourceClosureDigest !== expectedClosureDigest)
    {
        errors.push('artifact source closure digest mismatch');
    }
    if (evidenceRoot && validReference(artifact?.producer?.reference))
    {
        const file = path.resolve(evidenceRoot, artifact.producer.reference);
        if (!fs.existsSync(file))
        {
            errors.push(`producer report is missing: ${artifact.producer.reference}`);
        }
        else if (sha256File(file) !== artifact.producer.digest)
        {
            errors.push('producer report digest mismatch');
        }
    }
    for (const [index, observation] of (artifact?.observations ?? []).entries())
    {
        const label = `observation[${index}]`;
        if (!text(observation?.testId))
        {
            errors.push(`${label} testId is required`);
        }
        if (!text(observation?.suite))
        {
            errors.push(`${label} suite is required`);
        }
        if (!text(observation?.partition))
        {
            errors.push(`${label} partition is required`);
        }
        if (!supportedFrameworks.has(observation?.framework))
        {
            errors.push(`${label} framework is invalid`);
        }
        if (!outcomes.has(observation?.outcome))
        {
            errors.push(`${label} outcome is invalid`);
        }
        if (!Number.isFinite(observation?.durationMs) || observation.durationMs < 0)
        {
            errors.push(`${label} duration is invalid`);
        }
        if ((observation?.outcome === 'failed' || observation?.outcome === 'blocked')
            && !digestPattern.test(String(observation?.failureSignature ?? '')))
        {
            errors.push(`${label} failure signature is required`);
        }
        if (observation?.sourceState?.commit !== artifact?.sourceState?.commit
            || observation?.sourceState?.worktreeFingerprint !== artifact?.sourceState?.worktreeFingerprint)
        {
            errors.push(`${label} source identity mismatch`);
        }
        if (observation?.sourceClosureDigest !== artifact?.sourceClosureDigest)
        {
            errors.push(`${label} source closure digest mismatch`);
        }
        if (observation?.producer?.digest !== artifact?.producer?.digest
            || observation?.producer?.reference !== artifact?.producer?.reference)
        {
            errors.push(`${label} producer binding mismatch`);
        }
        if (JSON.stringify(observation?.run) !== JSON.stringify(artifact?.run))
        {
            errors.push(`${label} run binding mismatch`);
        }
        if (JSON.stringify(observation?.runner) !== JSON.stringify(artifact?.runner))
        {
            errors.push(`${label} runner binding mismatch`);
        }
    }
    return errors;
}

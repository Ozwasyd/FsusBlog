import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { validateRuntimeMatrixEvidence } from './runtime-publish-evidence.mjs';

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SAFE_PROFILE_ID = /^[a-z][a-z0-9-]{2,63}$/u;
const ZERO_SHA256 = `sha256:${'0'.repeat(64)}`;

export function validateReleaseRuntimeMatrix(manifest, manifestFile)
{
    const errors = [];
    const commitSha = String(manifest?.commitSha ?? '');
    const releaseProfile = manifest?.releaseIdentity?.runtimeProfile;
    const artifact = manifest?.artifacts?.runtimePublishMatrix;
    const summary = manifest?.evidenceSummary?.operations?.runtimeTuning;

    if (!COMMIT_SHA.test(commitSha))
    {
        errors.push('runtime matrix requires a lowercase full release commit SHA');
    }
    if (!releaseProfile || typeof releaseProfile !== 'object' || Array.isArray(releaseProfile))
    {
        errors.push('runtime matrix requires releaseIdentity.runtimeProfile');
    }
    else
    {
        if (!SAFE_PROFILE_ID.test(String(releaseProfile.id ?? '')))
        {
            errors.push('release runtime profile id is invalid');
        }
        for (const field of ['manifestDigest', 'profileDigest'])
        {
            const digest = String(releaseProfile[field] ?? '');
            if (!SHA256.test(digest))
            {
                errors.push(`release runtime profile ${field} is invalid`);
            }
            else if (digest === ZERO_SHA256)
            {
                errors.push(`release runtime profile ${field} must not be the zero digest`);
            }
        }
    }

    const resolved = resolveArtifact(manifestFile, artifact, errors);
    const recordedDigest = manifest?.artifactDigests?.runtimePublishMatrix;
    if (!recordedDigest || recordedDigest.algorithm !== 'sha256' || !SHA256_HEX.test(String(recordedDigest.value ?? '')))
    {
        errors.push('artifactDigests.runtimePublishMatrix must contain a concrete sha256 digest');
    }
    if (summary?.runtimeMatrixStatus !== 'ok')
    {
        errors.push('runtime tuning summary must mark runtimeMatrixStatus as ok');
    }
    if (summary?.runtimeMatrixEvidence !== artifact)
    {
        errors.push('runtime tuning summary must reference artifacts.runtimePublishMatrix');
    }
    if (releaseProfile && summary?.profile?.id !== releaseProfile.id)
    {
        errors.push('runtime tuning summary profile id does not match releaseIdentity.runtimeProfile');
    }
    if (releaseProfile && summary?.profile?.manifestDigest !== releaseProfile.manifestDigest)
    {
        errors.push('runtime tuning summary profile manifestDigest does not match releaseIdentity.runtimeProfile');
    }
    if (releaseProfile && summary?.profile?.profileDigest !== releaseProfile.profileDigest)
    {
        errors.push('runtime tuning summary profile profileDigest does not match releaseIdentity.runtimeProfile');
    }

    if (!resolved)
    {
        return errors;
    }
    let bytes;
    try
    {
        bytes = fs.readFileSync(resolved);
    }
    catch (error)
    {
        errors.push(`runtime matrix artifact cannot be read: ${error instanceof Error ? error.message : String(error)}`);
        return errors;
    }
    const actualDigest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (recordedDigest?.value !== actualDigest)
    {
        errors.push('runtime matrix artifact digest does not match the collected file');
    }

    let evidence;
    try
    {
        evidence = JSON.parse(bytes.toString('utf8'));
    }
    catch (error)
    {
        errors.push(`runtime matrix artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        return errors;
    }
    errors.push(...validateRuntimeMatrixEvidence(evidence, {
        requireComplete: true,
        expectedCommitSha: commitSha,
        expectedSelectedProfileId: releaseProfile?.id,
        expectedProfileManifestDigest: releaseProfile?.manifestDigest,
        expectedProfileDigest: releaseProfile?.profileDigest
    }).map((error) => `runtime matrix: ${error}`));
    return errors;
}

function resolveArtifact(manifestFile, artifact, errors)
{
    if (typeof artifact !== 'string' || artifact.length === 0 || path.isAbsolute(artifact))
    {
        errors.push('artifacts.runtimePublishMatrix must be a relative collected artifact path');
        return null;
    }
    const base = path.resolve(path.dirname(manifestFile));
    const resolved = path.resolve(base, artifact);
    if (resolved === base || !resolved.startsWith(`${base}${path.sep}`))
    {
        errors.push('artifacts.runtimePublishMatrix must stay inside the release evidence directory');
        return null;
    }
    let stat;
    try
    {
        stat = fs.lstatSync(resolved);
    }
    catch
    {
        errors.push('runtime matrix artifact is missing');
        return null;
    }
    if (stat.isSymbolicLink() || !stat.isFile())
    {
        errors.push('runtime matrix artifact must be a regular non-symlink file');
        return null;
    }
    const baseReal = fs.realpathSync(base);
    const resolvedReal = fs.realpathSync(resolved);
    if (!resolvedReal.startsWith(`${baseReal}${path.sep}`))
    {
        errors.push('runtime matrix artifact must not escape through a symlinked parent directory');
        return null;
    }
    return resolved;
}

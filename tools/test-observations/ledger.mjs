import fs from 'node:fs';
import path from 'node:path';

import { adaptReport, failureSignature, supportedFrameworks } from './adapters.mjs';
import { canonicalize, sha256, sha256File } from './source-identity.mjs';
import { observationArtifactSchema, validateObservationArtifact } from './validation.mjs';

export { failureSignature } from './adapters.mjs';
export { computeSourceClosureDigest, sha256, sha256File } from './source-identity.mjs';
export { validateObservationArtifact } from './validation.mjs';

export { observationArtifactSchema };
export const observationIndexSchema = 'fsusblog.test-observation-index.v1';

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const outcomes = new Set(['passed', 'failed', 'skipped', 'blocked']);
const frameworks = supportedFrameworks;

function digestValue(value)
{
    const content = structuredClone(value);
    delete content.contentDigest;
    return sha256(JSON.stringify(canonicalize(content)));
}

function seal(value)
{
    const result = { ...value, contentDigest: null };
    result.contentDigest = digestValue(result);
    return result;
}

function requiredText(value, label)
{
    const result = String(value ?? '').trim();
    if (!result)
    {
        throw new Error(`${label} is required`);
    }
    return result;
}

function normalizeEvidenceReference(value)
{
    const reference = requiredText(value, 'producer reference').replaceAll(path.sep, '/');
    if (path.posix.isAbsolute(reference) || reference === '..' || reference.startsWith('../'))
    {
        throw new Error('producer reference must stay within the evidence root');
    }
    return reference;
}

function validateMetadata(metadata)
{
    if (!commitPattern.test(String(metadata?.sourceState?.commit ?? '')))
    {
        throw new Error('sourceState.commit must be a full lowercase commit SHA');
    }
    if (!digestPattern.test(String(metadata?.sourceState?.worktreeFingerprint ?? '')))
    {
        throw new Error('sourceState.worktreeFingerprint must be a sha256 digest');
    }
    if (!digestPattern.test(String(metadata?.sourceClosureDigest ?? '')))
    {
        throw new Error('sourceClosureDigest must be a sha256 digest');
    }
    requiredText(metadata?.run?.id, 'run.id');
    if (!['primary', 'retry', 'diagnostic'].includes(metadata?.run?.attemptKind))
    {
        throw new Error('run.attemptKind must be primary, retry, or diagnostic');
    }
    requiredText(metadata?.run?.evidenceClass, 'run.evidenceClass');
    for (const field of ['os', 'arch', 'runtime'])
    {
        requiredText(metadata?.runner?.[field], `runner.${field}`);
    }
}

export function createObservationArtifact({
    framework,
    reportFile,
    evidenceReference,
    suite,
    partition = 'default',
    metadata,
    observedAt = new Date().toISOString()
})
{
    validateMetadata(metadata);
    if (!frameworks.has(framework))
    {
        throw new Error(`unsupported test observation framework: ${framework}`);
    }
    const producerReference = normalizeEvidenceReference(evidenceReference);
    const producerDigest = sha256File(reportFile);
    const reportText = fs.readFileSync(reportFile, 'utf8');
    const adapted = adaptReport({ framework, reportText, suite });
    const runner = {
        os: metadata.runner.os,
        arch: metadata.runner.arch,
        runtime: metadata.runner.runtime,
        browser: metadata.runner.browser ?? null,
        project: metadata.runner.project ?? null
    };
    const records = adapted.map((entry) =>
    {
        const outcome = entry.outcome;
        const signature = outcome === 'failed' || outcome === 'blocked' ? failureSignature(entry.failure) : null;
        if ((outcome === 'failed' || outcome === 'blocked') && !signature)
        {
            throw new Error(`${entry.testId} has no failure details for ${outcome} outcome`);
        }
        return {
            testId: entry.testId,
            suite: requiredText(entry.suite ?? suite, 'observation.suite'),
            framework,
            partition: String(entry.partition ?? partition),
            outcome,
            durationMs: entry.durationMs,
            failureSignature: signature,
            sourceState: metadata.sourceState,
            sourceClosureDigest: metadata.sourceClosureDigest,
            runner,
            run: metadata.run,
            producer: { reference: producerReference, digest: producerDigest },
            attempt: Number.isInteger(entry.attempt) ? entry.attempt : 0
        };
    });
    return seal({
        schema: observationArtifactSchema,
        observedAt,
        sourceState: metadata.sourceState,
        sourceClosureDigest: metadata.sourceClosureDigest,
        runner,
        run: metadata.run,
        producer: {
            framework,
            reference: producerReference,
            digest: producerDigest
        },
        observations: records
    });
}

function percentile(values, percentage)
{
    if (values.length === 0)
    {
        return null;
    }
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1)];
}

export function aggregateObservationArtifacts(artifacts, options = {})
{
    const observations = [];
    for (const artifact of artifacts)
    {
        const errors = validateObservationArtifact(artifact, options);
        if (errors.length > 0)
        {
            throw new Error(`observation artifact rejected: ${errors.join('; ')}`);
        }
        observations.push(...artifact.observations);
    }
    const groups = Map.groupBy(observations, (entry) => entry.testId);
    const tests = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([testId, entries]) =>
    {
        const outcomeCounts = Object.fromEntries([...outcomes].map((outcome) =>
            [outcome, entries.filter((entry) => entry.outcome === outcome).length]));
        const signatureCounts = Object.fromEntries([...Map.groupBy(
            entries.filter((entry) => entry.failureSignature),
            (entry) => entry.failureSignature
        )].map(([signature, matches]) => [signature, matches.length]).sort(([left], [right]) => left.localeCompare(right)));
        return {
            testId,
            samples: entries.length,
            durationMs: {
                p50: percentile(entries.map((entry) => entry.durationMs), 50),
                p95: percentile(entries.map((entry) => entry.durationMs), 95)
            },
            outcomeCounts,
            signatureCounts,
            sourceCommits: [...new Set(entries.map((entry) => entry.sourceState.commit))].sort(),
            sourceClosureDigests: [...new Set(entries.map((entry) => entry.sourceClosureDigest))].sort(),
            runnerIdentities: [...new Set(entries.map((entry) => JSON.stringify(entry.runner)))]
                .map((entry) => JSON.parse(entry)).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
        };
    });
    return seal({
        schema: observationIndexSchema,
        coldStart: observations.length === 0,
        artifactCount: artifacts.length,
        observationCount: observations.length,
        tests
    });
}

export function ingestObservationArtifact({ artifactFile, storeDirectory, evidenceRoot = null })
{
    const artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
    const errors = validateObservationArtifact(artifact, { evidenceRoot });
    if (errors.length > 0)
    {
        throw new Error(`observation artifact rejected: ${errors.join('; ')}`);
    }
    const observationsDirectory = path.join(storeDirectory, 'observations');
    fs.mkdirSync(observationsDirectory, { recursive: true });
    const target = path.join(observationsDirectory, `${artifact.contentDigest.slice('sha256:'.length)}.json`);
    if (fs.existsSync(target))
    {
        const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
        const existingErrors = validateObservationArtifact(existing);
        if (existingErrors.length > 0 || existing.contentDigest !== artifact.contentDigest)
        {
            throw new Error('history artifact key collision');
        }
        return { added: false, target };
    }
    fs.copyFileSync(artifactFile, target, fs.constants.COPYFILE_EXCL);
    return { added: true, target };
}

export function rebuildObservationIndex({ storeDirectory, evidenceRoot = null })
{
    const observationsDirectory = path.join(storeDirectory, 'observations');
    const files = fs.existsSync(observationsDirectory)
        ? fs.readdirSync(observationsDirectory).filter((file) => file.endsWith('.json')).sort()
        : [];
    const artifacts = files.map((file) => JSON.parse(fs.readFileSync(path.join(observationsDirectory, file), 'utf8')));
    const index = aggregateObservationArtifacts(artifacts, { evidenceRoot });
    fs.mkdirSync(storeDirectory, { recursive: true });
    const target = path.join(storeDirectory, 'index.json');
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`);
    fs.renameSync(temporary, target);
    return index;
}

export function compactObservationStore({
    storeDirectory,
    maxArtifacts = 2_000,
    maxAgeDays = 180,
    now = new Date(),
    dryRun = false
})
{
    if (!Number.isInteger(maxArtifacts) || maxArtifacts < 1)
    {
        throw new Error('maxArtifacts must be a positive integer');
    }
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0)
    {
        throw new Error('maxAgeDays must be a positive number');
    }
    const observationsDirectory = path.join(storeDirectory, 'observations');
    if (!fs.existsSync(observationsDirectory))
    {
        return { kept: [], removed: [] };
    }
    const candidates = fs.readdirSync(observationsDirectory).filter((file) => file.endsWith('.json')).map((file) =>
    {
        const absolute = path.join(observationsDirectory, file);
        const artifact = JSON.parse(fs.readFileSync(absolute, 'utf8'));
        const errors = validateObservationArtifact(artifact);
        if (errors.length > 0)
        {
            throw new Error(`cannot compact invalid observation artifact ${file}: ${errors.join('; ')}`);
        }
        return { file, absolute, observedAt: Date.parse(artifact.observedAt) };
    }).sort((left, right) => right.observedAt - left.observedAt || left.file.localeCompare(right.file));
    const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
    const kept = [];
    const removed = [];
    for (const [index, candidate] of candidates.entries())
    {
        if (index < maxArtifacts && candidate.observedAt >= cutoff)
        {
            kept.push(candidate.file);
        }
        else
        {
            removed.push(candidate.file);
            if (!dryRun)
            {
                fs.rmSync(candidate.absolute);
            }
        }
    }
    if (!dryRun && removed.length > 0)
    {
        const index = path.join(storeDirectory, 'index.json');
        if (fs.existsSync(index))
        {
            fs.rmSync(index);
        }
    }
    return { kept, removed };
}

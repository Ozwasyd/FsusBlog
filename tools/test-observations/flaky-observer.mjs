#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256, sha256File } from './source-identity.mjs';
import {
    canonicalBinding,
    commandProducerDigest,
    runAttempt,
    runnerIdentity,
    sourceIdentity
} from './flaky-observer-execution.mjs';

export { sourceIdentity } from './flaky-observer-execution.mjs';

export const flakyObservationSchema = 'fsusblog.flaky-observation-set.v1';
export const flakyCandidateManifestSchema = 'fsusblog.flaky-observation-candidates.v1';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const identityFields = ['sourceCommit', 'worktreeFingerprint', 'producerDigest', 'runnerDigest'];
const environmentFailureClasses = new Set(['environment', 'infra', 'infrastructure']);
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

function assertSameIdentity(expected, actual, label)
{
    for (const field of identityFields)
    {
        if (actual[field] !== expected[field])
            throw new Error(`${label} ${field} does not match the observation set`);
    }
}

export function classifyAttempts(attempts, { minimumSamples = 2 } = {})
{
    if (!Array.isArray(attempts) || attempts.length === 0) return 'insufficient-samples';
    const expected = attempts[0];
    for (const [index, attempt] of attempts.entries())
    {
        assertSameIdentity(expected, attempt, `attempt[${index}]`);
        if (attempt.attemptIndex !== index + 1) throw new Error(`attempt[${index}] index is not contiguous`);
    }
    if (attempts.length < minimumSamples) return 'insufficient-samples';
    const outcomes = new Set(attempts.map((attempt) => attempt.outcome));
    if (outcomes.size > 1) return 'outcome-inconsistent';
    if (outcomes.has('passed')) return 'stable-pass';
    if ([...attempts].every((attempt) => environmentFailureClasses.has(attempt.failureClass)))
        return 'environment-failure';
    const signatures = new Set(attempts.map((attempt) => attempt.failureSignature).filter(Boolean));
    if (signatures.size > 1) return 'signature-inconsistent';
    if (outcomes.has('failed') && signatures.size === 1) return 'stable-fail';
    return 'insufficient-samples';
}

export function runCandidate(candidate, {
    cwd = root,
    outputDirectory,
    canonicalEvidenceFile = null
})
{
    if (!candidate?.testId || !Array.isArray(candidate.command) || candidate.command.length === 0)
        throw new Error('candidate requires an explicit testId and non-empty command');
    const attempts = Number(candidate.attempts);
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100)
        throw new Error('candidate attempts must be an integer from 1 to 100');
    const minimumSamples = Number(candidate.minimumSamples ?? 2);
    if (!Number.isInteger(minimumSamples) || minimumSamples < 2 || minimumSamples > attempts + 1)
        throw new Error('candidate minimumSamples must be an integer of at least 2');
    const initialIdentity = sourceIdentity(cwd);
    const runner = runnerIdentity();
    const producerDigest = commandProducerDigest(candidate.command, cwd);
    const setIdentity = { ...initialIdentity, producerDigest, runnerDigest: runner.runnerDigest };
    const attemptRecords = [];
    for (let index = 1; index <= attempts; index += 1)
    {
        const before = sourceIdentity(cwd);
        assertSameIdentity(setIdentity, { ...before, producerDigest, runnerDigest: runner.runnerDigest }, `attempt[${index - 1}]`);
        attemptRecords.push(runAttempt({
            candidate,
            attemptIndex: index,
            seed: Number(candidate.seed ?? 1) + index - 1,
            outputDirectory,
            identity: initialIdentity,
            runner,
            producerDigest,
            cwd
        }));
        const after = sourceIdentity(cwd);
        assertSameIdentity(setIdentity, { ...after, producerDigest, runnerDigest: runner.runnerDigest }, `attempt[${index - 1}] post-run`);
    }
    return {
        testId: candidate.testId,
        requestedAttempts: attempts,
        minimumSamples,
        classification: classifyAttempts(attemptRecords, { minimumSamples }),
        bindings: setIdentity,
        canonical: canonicalBinding(canonicalEvidenceFile, root),
        attempts: attemptRecords
    };
}

function digestWithoutContentDigest(value)
{
    const content = structuredClone(value);
    delete content.contentDigest;
    return sha256(JSON.stringify(canonicalize(content)));
}

export function validateFlakyObservationSet(value, { evidenceRoot = null } = {})
{
    const errors = [];
    if (value?.schema !== flakyObservationSchema) errors.push('schema is invalid');
    if (value?.contentDigest !== digestWithoutContentDigest(value)) errors.push('content digest mismatch');
    if (value?.lane !== 'observation-only'
        || value?.affectsCanonicalCorrectness !== false
        || value?.satisfiesReleaseCorrectness !== false)
        errors.push('observation/correctness isolation flags are invalid');
    if (!Array.isArray(value?.candidates) || value.candidates.length === 0)
        errors.push('at least one explicit candidate is required');
    for (const [candidateIndex, candidate] of (value?.candidates ?? []).entries())
    {
        const label = `candidate[${candidateIndex}]`;
        if (!candidate?.testId || !Array.isArray(candidate?.attempts) || candidate.attempts.length === 0)
        {
            errors.push(`${label} identity or attempts are missing`);
            continue;
        }
        if (!Number.isInteger(candidate.requestedAttempts)
            || candidate.requestedAttempts !== candidate.attempts.length
            || !Number.isInteger(candidate.minimumSamples)
            || candidate.minimumSamples < 2)
            errors.push(`${label} sample policy is invalid`);
        try
        {
            const classification = classifyAttempts(candidate.attempts, {
                minimumSamples: candidate.minimumSamples
            });
            if (classification !== candidate.classification) errors.push(`${label} classification mismatch`);
        }
        catch (error)
        {
            errors.push(`${label} ${error.message}`);
        }
        for (const [attemptIndex, attempt] of candidate.attempts.entries())
        {
            const attemptLabel = `${label}.attempt[${attemptIndex}]`;
            if (attempt.testId !== candidate.testId) errors.push(`${attemptLabel} test ID mismatch`);
            for (const field of identityFields)
            {
                if (attempt[field] !== candidate.bindings?.[field])
                    errors.push(`${attemptLabel} ${field} does not match candidate bindings`);
            }
            if (!Number.isInteger(attempt.seed)
                || attempt.processIsolation !== 'new-process-per-attempt'
                || !Number.isFinite(attempt.durationMs)
                || !['passed', 'failed'].includes(attempt.outcome))
                errors.push(`${attemptLabel} execution evidence is incomplete`);
            if (attempt.outcome === 'failed' && !String(attempt.failureSignature).startsWith('sha256:'))
                errors.push(`${attemptLabel} failure signature is missing`);
            if (attempt.rawEvidenceDigest !== sha256(JSON.stringify(canonicalize(attempt.rawEvidence))))
                errors.push(`${attemptLabel} raw evidence digest mismatch`);
            for (const kind of ['stdout', 'stderr', 'metadata'])
            {
                const reference = attempt.rawEvidenceReferences?.[kind];
                const digest = attempt.rawEvidence?.[kind];
                if ((reference === null) !== (digest === null))
                    errors.push(`${attemptLabel} ${kind} reference/digest mismatch`);
                if (kind !== 'metadata' && (!reference || !sha256Pattern.test(String(digest))))
                    errors.push(`${attemptLabel} ${kind} evidence binding is incomplete`);
                if (evidenceRoot && reference)
                {
                    const absolute = path.resolve(evidenceRoot, String(candidateIndex + 1).padStart(3, '0'), reference);
                    const relative = path.relative(evidenceRoot, absolute);
                    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
                        errors.push(`${attemptLabel} ${kind} reference escapes evidence root`);
                    else if (!fs.existsSync(absolute) || sha256File(absolute) !== digest)
                        errors.push(`${attemptLabel} ${kind} evidence is missing or modified`);
                }
            }
        }
        if (candidate.canonical
            && (candidate.canonical.observationAffectsCanonical !== false
                || candidate.canonical.observationSatisfiesReleaseCorrectness !== false))
            errors.push(`${label} canonical isolation flags are invalid`);
    }
    return errors;
}

function option(args, name)
{
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : null;
}

function parseCandidates(args)
{
    const separator = args.indexOf('--');
    const manifestFile = option(args, 'manifest');
    if (manifestFile)
    {
        if (separator >= 0) throw new Error('--manifest cannot be combined with an inline command');
        const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestFile), 'utf8'));
        if (manifest.schema !== flakyCandidateManifestSchema || !Array.isArray(manifest.candidates))
            throw new Error(`candidate manifest must use ${flakyCandidateManifestSchema}`);
        return manifest.candidates;
    }
    if (separator < 0) throw new Error('inline observation requires -- followed by a command');
    return [{
        testId: option(args, 'test-id'),
        attempts: Number(option(args, 'attempts')),
        minimumSamples: Number(option(args, 'minimum-samples') ?? 2),
        seed: Number(option(args, 'seed') ?? 1),
        command: args.slice(separator + 1)
    }];
}

function main()
{
    const args = process.argv.slice(2);
    if (args[0] === 'check')
    {
        const evidence = path.resolve(option(args, 'evidence'));
        const value = JSON.parse(fs.readFileSync(evidence, 'utf8'));
        const errors = validateFlakyObservationSet(value, {
            evidenceRoot: path.resolve(option(args, 'evidence-root') ?? `${evidence}.d`)
        });
        if (errors.length > 0) throw new Error(errors.join('; '));
        process.stdout.write(`[flaky-observer] valid evidence=${evidence}\n`);
        return;
    }
    const output = path.resolve(option(args, 'output') ?? '.tmp/test-observations/flaky-observation.json');
    const outputDirectory = `${output}.d`;
    const candidates = parseCandidates(args);
    if (candidates.length === 0) throw new Error('candidate manifest must select at least one explicit test');
    const canonicalEvidenceFile = option(args, 'canonical-evidence');
    const results = candidates.map((candidate, index) => runCandidate(candidate, {
        outputDirectory: path.join(outputDirectory, String(index + 1).padStart(3, '0')),
        canonicalEvidenceFile
    }));
    const value = {
        schema: flakyObservationSchema,
        generatedAt: new Date().toISOString(),
        lane: 'observation-only',
        candidateSelection: option(args, 'manifest') ? 'explicit-manifest' : 'explicit-test-id',
        affectsCanonicalCorrectness: false,
        satisfiesReleaseCorrectness: false,
        candidates: results
    };
    value.contentDigest = digestWithoutContentDigest(value);
    writeJsonAtomic(output, value);
    process.stdout.write(`[flaky-observer] candidates=${results.length} output=${output}\n`);
    for (const result of results)
        process.stdout.write(`[flaky-observer] ${result.testId}: ${result.classification} (${result.attempts.length} attempts)\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    try
    {
        main();
    }
    catch (error)
    {
        process.stderr.write(`[flaky-observer] ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

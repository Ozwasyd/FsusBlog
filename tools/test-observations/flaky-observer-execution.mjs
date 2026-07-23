import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { failureSignature } from './adapters.mjs';
import { canonicalize, sha256, sha256File } from './source-identity.mjs';

function git(args, cwd)
{
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
    return result.stdout;
}

export function sourceIdentity(cwd)
{
    const commit = git(['rev-parse', 'HEAD'], cwd).trim();
    const diff = git(['diff', '--binary', 'HEAD', '--'], cwd);
    const untracked = git(['ls-files', '--others', '--exclude-standard'], cwd)
        .split(/\r?\n/u).filter(Boolean).sort();
    const untrackedBindings = untracked.map((relative) => ({
        path: relative.replaceAll(path.sep, '/'),
        digest: sha256File(path.join(cwd, relative))
    }));
    return {
        sourceCommit: commit,
        worktreeFingerprint: sha256(JSON.stringify(canonicalize({ diff, untrackedBindings })))
    };
}

export function runnerIdentity()
{
    const runner = {
        os: process.platform,
        arch: process.arch,
        runtime: process.version
    };
    return { ...runner, runnerDigest: sha256(JSON.stringify(canonicalize(runner))) };
}

export function commandProducerDigest(command, cwd)
{
    const fileBindings = command.slice(1).filter((argument) =>
    {
        const candidate = path.resolve(cwd, argument);
        return candidate.startsWith(`${cwd}${path.sep}`) && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    }).map((argument) => ({
        argument: path.relative(cwd, path.resolve(cwd, argument)).replaceAll(path.sep, '/'),
        digest: sha256File(path.resolve(cwd, argument))
    }));
    return sha256(JSON.stringify(canonicalize({ command, fileBindings })));
}

function loadAttemptMetadata(file)
{
    if (!fs.existsSync(file)) return {};
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('attempt metadata must be an object');
    return value;
}

export function canonicalBinding(canonicalEvidenceFile, root)
{
    if (!canonicalEvidenceFile) return null;
    const absolute = path.resolve(canonicalEvidenceFile);
    const value = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const first = Array.isArray(value.attempts) ? value.attempts[0] : null;
    const raw = first?.status ?? value.status ?? value.finalStatus;
    const canonicalFirstOutcome = ['success', 'passed', 'pass'].includes(String(raw).toLowerCase())
        ? 'passed'
        : 'failed';
    return {
        reference: path.relative(root, absolute).replaceAll(path.sep, '/'),
        digest: sha256File(absolute),
        canonicalFirstOutcome,
        observationAffectsCanonical: false,
        observationSatisfiesReleaseCorrectness: false
    };
}

export function runAttempt({
    candidate,
    attemptIndex,
    seed,
    outputDirectory,
    identity,
    runner,
    producerDigest,
    cwd
})
{
    const attemptDirectory = path.join(outputDirectory, 'attempts', String(attemptIndex).padStart(3, '0'));
    fs.mkdirSync(attemptDirectory, { recursive: true });
    const stdoutFile = path.join(attemptDirectory, 'stdout.log');
    const stderrFile = path.join(attemptDirectory, 'stderr.log');
    const metadataFile = path.join(attemptDirectory, 'metadata.json');
    const started = process.hrtime.bigint();
    const result = spawnSync(candidate.command[0], candidate.command.slice(1), {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_OBSERVATION_TEST_ID: candidate.testId,
            FSUSBLOG_OBSERVATION_ATTEMPT: String(attemptIndex),
            FSUSBLOG_OBSERVATION_SEED: String(seed),
            FSUSBLOG_OBSERVATION_ATTEMPT_EVIDENCE: metadataFile
        }
    });
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    fs.writeFileSync(stdoutFile, result.stdout ?? '');
    fs.writeFileSync(stderrFile, `${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`);
    const metadata = loadAttemptMetadata(metadataFile);
    const outcome = result.status === 0 && !result.error && !result.signal ? 'passed' : 'failed';
    const failureText = [metadata.failure, result.stderr, result.stdout, result.error?.message]
        .filter(Boolean).join('\n');
    const rawEvidence = {
        stdout: sha256File(stdoutFile),
        stderr: sha256File(stderrFile),
        metadata: fs.existsSync(metadataFile) ? sha256File(metadataFile) : null
    };
    return {
        testId: candidate.testId,
        attemptIndex,
        seed,
        processIsolation: 'new-process-per-attempt',
        ...identity,
        ...runner,
        producerDigest,
        durationMs,
        outcome,
        failureClass: outcome === 'failed'
            ? String(metadata.failureClass ?? (result.error || result.signal ? 'environment' : 'product'))
            : null,
        failureSignature: outcome === 'failed' ? failureSignature(failureText || `exit:${result.status}`) : null,
        exitCode: Number.isInteger(result.status) ? result.status : null,
        signal: result.signal ?? null,
        rawEvidenceReferences: {
            stdout: path.relative(outputDirectory, stdoutFile).replaceAll(path.sep, '/'),
            stderr: path.relative(outputDirectory, stderrFile).replaceAll(path.sep, '/'),
            metadata: fs.existsSync(metadataFile)
                ? path.relative(outputDirectory, metadataFile).replaceAll(path.sep, '/')
                : null
        },
        rawEvidence,
        rawEvidenceDigest: sha256(JSON.stringify(canonicalize(rawEvidence)))
    };
}

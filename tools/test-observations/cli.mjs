#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    compactObservationStore,
    computeSourceClosureDigest,
    createObservationArtifact,
    ingestObservationArtifact,
    rebuildObservationIndex
} from './ledger.mjs';

function values(name)
{
    const result = [];
    for (let index = 2; index < process.argv.length; index += 1)
    {
        if (process.argv[index] === `--${name}` && process.argv[index + 1])
        {
            result.push(process.argv[index + 1]);
        }
    }
    return result;
}

function option(name, fallback = null)
{
    return values(name).at(-1) ?? fallback;
}

function required(name)
{
    const result = option(name);
    if (!result)
    {
        throw new Error(`--${name} is required`);
    }
    return result;
}

function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

function runner()
{
    return {
        os: required('runner-os'),
        arch: required('runner-arch'),
        runtime: required('runner-runtime'),
        browser: option('runner-browser'),
        project: option('runner-project')
    };
}

function adapt()
{
    const input = path.resolve(required('input'));
    const output = path.resolve(required('output'));
    const root = path.resolve(option('root', process.cwd()));
    const closurePaths = values('closure-path');
    const closureDigest = closurePaths.length > 0
        ? computeSourceClosureDigest({ root, paths: closurePaths })
        : required('closure-digest');
    const artifact = createObservationArtifact({
        framework: required('framework'),
        reportFile: input,
        evidenceReference: option('evidence-reference', path.relative(root, input)),
        suite: required('suite'),
        partition: option('partition', 'default'),
        metadata: {
            sourceState: {
                commit: required('source-commit'),
                worktreeFingerprint: required('worktree-fingerprint')
            },
            sourceClosureDigest: closureDigest,
            runner: runner(),
            run: {
                id: required('run-id'),
                attemptKind: option('attempt-kind', 'primary'),
                evidenceClass: option('evidence-class', 'correctness')
            }
        },
        observedAt: option('observed-at', new Date().toISOString())
    });
    writeJson(output, artifact);
    process.stdout.write(`[test-observations] adapted framework=${artifact.producer.framework} observations=${artifact.observations.length} output=${output}\n`);
}

function ingest()
{
    const result = ingestObservationArtifact({
        artifactFile: path.resolve(required('artifact')),
        storeDirectory: path.resolve(required('store')),
        evidenceRoot: option('evidence-root') ? path.resolve(option('evidence-root')) : null
    });
    process.stdout.write(`[test-observations] ingest=${result.added ? 'added' : 'duplicate'} artifact=${result.target}\n`);
}

function rebuild()
{
    const index = rebuildObservationIndex({
        storeDirectory: path.resolve(required('store')),
        evidenceRoot: option('evidence-root') ? path.resolve(option('evidence-root')) : null
    });
    process.stdout.write(`[test-observations] rebuilt artifacts=${index.artifactCount} observations=${index.observationCount} tests=${index.tests.length} coldStart=${index.coldStart}\n`);
}

function compact()
{
    const result = compactObservationStore({
        storeDirectory: path.resolve(required('store')),
        maxArtifacts: Number(option('max-artifacts', 2_000)),
        maxAgeDays: Number(option('max-age-days', 180)),
        dryRun: process.argv.includes('--dry-run')
    });
    process.stdout.write(`[test-observations] compact kept=${result.kept.length} removed=${result.removed.length}\n`);
}

try
{
    const command = process.argv[2];
    if (command === 'adapt')
    {
        adapt();
    }
    else if (command === 'ingest')
    {
        ingest();
    }
    else if (command === 'rebuild')
    {
        rebuild();
    }
    else if (command === 'compact')
    {
        compact();
    }
    else
    {
        throw new Error('usage: cli.mjs <adapt|ingest|rebuild|compact> [options]');
    }
}
catch (error)
{
    process.stderr.write(`[test-observations] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}

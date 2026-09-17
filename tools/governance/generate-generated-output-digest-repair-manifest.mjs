#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generatedOutputDigestRepairProducers } from './change-contract-registry.mjs';
import { createGeneratedOutputDigestRepairRepository } from './generated-output-digest-repair-repository.mjs';
import { generatedOutputDigestRepairSchema } from './generated-output-digest-repair-v2.mjs';

const root = resolve(import.meta.dirname, '../..');
const producer = generatedOutputDigestRepairProducers[0];
const revisionPattern = /^[a-f0-9]{40}$/u;

function option(name)
{
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
}

function requiredRevision(name)
{
    const value = option(name);
    if (!revisionPattern.test(value ?? ''))
    {
        throw new Error(`${name} must be one full commit SHA`);
    }
    return value;
}

function sha256(bytes)
{
    return createHash('sha256').update(bytes).digest('hex');
}

function git(rootPath, args, options = {})
{
    return execFileSync('git', args, {
        cwd: rootPath,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null' },
        ...options
    });
}

function authorityCheckout(base)
{
    const path = `${root}/.generated-digest-authority-${process.pid}`;
    git(root, ['worktree', 'add', '--detach', path, base], { stdio: 'ignore' });
    return {
        path,
        cleanup()
        {
            try
            {
                git(root, ['worktree', 'remove', '--force', path], { stdio: 'ignore' });
            }
            finally
            {
                rmSync(path, { recursive: true, force: true });
            }
        }
    };
}

function identity(repository, revision, file)
{
    const blob = repository.blob(revision, file);
    return {
        mode: blob.mode,
        object: blob.object,
        sha256: sha256(blob.bytes)
    };
}

function replayIdentity(repository, revision)
{
    const observation = repository.replay({ revision, producer, attempt: 0 });
    return {
        mode: observation.first.mode,
        sha256: sha256(observation.first.bytes)
    };
}

/**
 * Build a closed v2 manifest from the trusted registry and exact adapter.
 * The adapter, not the manifest, supplies Git object identities and replay
 * bytes; the shared checker performs the full history and candidate checks.
 */
export function buildGeneratedOutputDigestRepairManifest({ repository, revisions })
{
    const { sourceParent, sourceCommit, mergeCommit, outerBaseCommit, outerHeadCommit, baseCommit, headCommit } = revisions;
    if (sourceParent !== producer.qualification.sourceParent
        || sourceCommit !== producer.qualification.sourceCommit
        || mergeCommit !== producer.qualification.mergeCommit
        || outerBaseCommit !== producer.qualification.outerBaseCommit
        || outerHeadCommit !== producer.qualification.outerHeadCommit)
    {
        throw new Error('manifest qualification must use the trusted canonical source and outer merge tuple');
    }
    if (!revisionPattern.test(baseCommit ?? '') || !revisionPattern.test(headCommit ?? ''))
    {
        throw new Error('manifest base and head must be one full commit SHA');
    }
    const closure = producer.closure.map((path) => ({
        path,
        parent: identity(repository, sourceParent, path),
        source: identity(repository, sourceCommit, path)
    }));
    const output = {
        path: producer.output,
        parent: identity(repository, sourceParent, producer.output),
        source: identity(repository, sourceCommit, producer.output),
        base: identity(repository, baseCommit, producer.output),
        expected: identity(repository, headCommit, producer.output),
        candidate: identity(repository, headCommit, producer.output)
    };
    for (const [revision, expected, label] of [
        [sourceParent, output.parent, 'source parent'],
        [sourceCommit, output.expected, 'source event'],
        [baseCommit, output.expected, 'base'],
        [headCommit, output.candidate, 'candidate']
    ])
    {
        const replay = replayIdentity(repository, revision);
        if (replay.mode !== expected.mode || replay.sha256 !== expected.sha256)
        {
            throw new Error(`${label} replay does not match its exact checked-in output`);
        }
    }
    if (output.parent.sha256 === output.expected.sha256)
    {
        throw new Error('source event did not create output drift');
    }
    return {
        schema: generatedOutputDigestRepairSchema,
        producerId: producer.id,
        repairClass: producer.repairClass,
        sourceParent,
        sourceCommit,
        mergedPullRequest: producer.qualification.mergedPullRequest,
        mergeCommit,
        outerBaseCommit,
        outerHeadCommit,
        baseCommit,
        command: structuredClone(producer.command),
        closure,
        output
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const baseCommit = requiredRevision('--base');
    const authority = authorityCheckout(baseCommit);
    try
    {
        const revisions = {
            baseCommit,
            sourceParent: producer.qualification.sourceParent,
            sourceCommit: producer.qualification.sourceCommit,
            mergeCommit: producer.qualification.mergeCommit,
            outerBaseCommit: producer.qualification.outerBaseCommit,
            outerHeadCommit: producer.qualification.outerHeadCommit,
            headCommit: requiredRevision('--head')
        };
        const evidence = buildGeneratedOutputDigestRepairManifest({
            repository: createGeneratedOutputDigestRepairRepository({
                root,
                authorityRoot: authority.path,
                base: baseCommit,
                producer
            }),
            revisions
        });
        const output = resolve(root, producer.manifest);
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, `${JSON.stringify(evidence, null, 4)}\n`, { flag: 'wx' });
        process.stdout.write(`${producer.manifest}\n`);
    }
    finally
    {
        authority.cleanup();
    }
}

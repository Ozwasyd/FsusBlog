#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createGeneratedOutputDigestRepairRepository } from './generated-output-digest-repair-repository.mjs';
import { generatedOutputHistoryRepairSchema, inspectGeneratedOutputHistoryV3 } from './generated-output-history-repair-v3.mjs';

const revisionPattern = /^[a-f0-9]{40}$/u;

/** Prepare exact Git bindings only; the trusted checker must validate the final committed manifest and replays independently. */
export function buildGeneratedOutputHistoryRepairManifest({ producer, repository, base, head })
{
    if (!revisionPattern.test(base ?? '') || !revisionPattern.test(head ?? '') || base === head
        || repository.authorityRevision !== base)
    {
        throw new Error('history manifest preparation requires exact distinct base/head and a base-bound adapter');
    }
    const inspected = inspectGeneratedOutputHistoryV3({ producer, repository });
    if (inspected.historySha256 !== producer.qualification.historySha256)
    {
        throw new Error('history manifest preparation does not match the trusted history seal');
    }
    const identity = (revision, file) =>
    {
        const value = repository.blob(revision, file);
        return { mode: value.mode, object: value.object, sha256: createHash('sha256').update(value.bytes).digest('hex') };
    };
    const { anchor, frontier } = producer.qualification;
    return {
        schema: generatedOutputHistoryRepairSchema,
        producerId: producer.id,
        repairClass: producer.repairClass,
        qualification: structuredClone(producer.qualification),
        baseCommit: base,
        command: structuredClone(producer.command),
        closure: producer.closure.map((path) => ({ path,
            anchor: identity(anchor, path), frontier: identity(frontier, path), base: identity(base, path) })),
        output: { path: producer.output, anchor: identity(anchor, producer.output), base: identity(base, producer.output),
            candidate: identity(head, producer.output) }
    };
}

async function run()
{
    const options = { write: false };
    for (let index = 2; index < process.argv.length; index += 1)
    {
        const flag = process.argv[index];
        if (flag === '--write' && !options.write)
        {
            options.write = true;
        }
        else if (['--base', '--head'].includes(flag) && !options[flag.slice(2)]
            && revisionPattern.test(process.argv[index + 1] ?? ''))
        {
            options[flag.slice(2)] = process.argv[++index];
        }
        else
        {
            throw new Error('use --base <full SHA> --head <full SHA> [--write] with no duplicate options');
        }
    }
    if (!options.base || !options.head)
    {
        throw new Error('both exact --base and --head are required');
    }
    const root = resolve(import.meta.dirname, '../..');
    const git = (arguments_) => execFileSync('git', arguments_, { cwd: root, stdio: 'pipe', timeout: 10_000,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null' } });
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'fsusblog-history-repair-authority-'));
    const authorityRoot = join(temporaryRoot, 'authority');
    let added = false;
    try
    {
        git(['worktree', 'add', '--detach', authorityRoot, options.base]);
        added = true;
        const authority = await import(pathToFileURL(join(authorityRoot, 'tools/governance/change-contract-registry.mjs')).href);
        const producer = authority.generatedOutputHistoryRepairProducers?.find((entry) => entry.id === 'backend-evidence-path-authority');
        if (!producer)
        {
            throw new Error('v3 history policy has not been registered at the trusted base; candidate rules cannot self-promote');
        }
        const repository = createGeneratedOutputDigestRepairRepository({ root, authorityRoot, base: options.base, producer });
        const evidence = buildGeneratedOutputHistoryRepairManifest({ producer, repository, base: options.base, head: options.head });
        const content = `${JSON.stringify(evidence, null, 4)}\n`;
        if (options.write)
        {
            const destination = join(root, producer.manifest);
            mkdirSync(dirname(destination), { recursive: true });
            writeFileSync(destination, content, { flag: 'wx' });
            process.stdout.write(`${producer.manifest}\n`);
        }
        else
        {
            process.stdout.write(content);
        }
    }
    finally
    {
        if (added)
        {
            git(['worktree', 'remove', '--force', authorityRoot]);
        }
        rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    await run();
}

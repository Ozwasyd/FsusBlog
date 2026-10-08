#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

import { projectFrontendManifestGroup } from './manifest-projection.mjs';

const { loadTestMatrix } = await import(new URL('../../test-matrix/command-groups.mjs', import.meta.url));
const { executeManifestEntry } = await import(new URL('../run-command-manifest.mjs', import.meta.url));

/**
 * Execute exactly one canonical entry inside the caller's admitted attempt.
 * This is a command executor, not an admission, attempt or scheduler owner.
 * Reload source at execution so a stale projection cannot select changed bytes.
 * Composite localCommands require the canonical disposition before migration.
 */
export async function executeFrontendManifestEntry({
    root,
    groupId,
    entryId,
    expectedSourceDigest,
    env = process.env,
    signal
})
{
    const projection = projectFrontendManifestGroup(loadTestMatrix(root), groupId);
    if (projection.sourceDigest !== expectedSourceDigest)
    {
        throw new Error('frontend manifest source digest mismatch');
    }
    const entry = projection.entries.find((candidate) => candidate.id === entryId);
    if (!entry)
    {
        throw new Error(`unknown frontend manifest entry: ${entryId}`);
    }
    if ((entry.manifestEntry.localCommands?.length ?? 0) > 0)
    {
        throw new Error(`${entryId} requires composite-entry disposition before atomic execution`);
    }
    await executeManifestEntry(entry.manifestEntry, {
        cwd: path.join(root, 'src/frontend'),
        env,
        signal
    });
}

/** Fail closed on duplicate, unknown or missing selectors; never accept a group loop. */
export function parseFrontendManifestEntryArguments(argv)
{
    const fields = new Map([
        ['--matrix-group', 'groupId'],
        ['--entry-id', 'entryId'],
        ['--source-digest', 'expectedSourceDigest']
    ]);
    const options = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        const field = fields.get(argv[index]);
        const value = argv[index + 1];
        if (!field || Object.hasOwn(options, field) || !value || value.startsWith('--'))
        {
            throw new Error('requires unique --matrix-group, --entry-id and --source-digest selectors');
        }
        options[field] = value;
    }
    if (Object.keys(options).length !== fields.size)
    {
        throw new Error('requires --matrix-group, --entry-id and --source-digest');
    }
    return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
{
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'])
    {
        process.once(signal, () => controller.abort(new Error(`frontend entry cancelled by ${signal}`)));
    }
    try
    {
        await executeFrontendManifestEntry({
            root,
            ...parseFrontendManifestEntryArguments(process.argv.slice(2)),
            signal: controller.signal
        });
    }
    catch (error)
    {
        console.error(error.message);
        process.exitCode = 1;
    }
}

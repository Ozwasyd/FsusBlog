#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    extractCurrentRunEvidenceTransport,
    packCurrentRunEvidenceTransport,
    validateEvidenceTransportManifest
} from './current-run-evidence-transport.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function option(name)
{
    const index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
    return process.argv[index + 1];
}

function optional(name)
{
    const index = process.argv.indexOf(name);
    return index < 0 ? '' : process.argv[index + 1];
}

function main()
{
    const action = process.argv[2];
    if (action === 'pack')
    {
        const context = JSON.parse(fs.readFileSync(path.resolve(repositoryRoot, option('--context')), 'utf8'));
        const objects = JSON.parse(fs.readFileSync(path.resolve(repositoryRoot, option('--objects')), 'utf8'));
        const result = packCurrentRunEvidenceTransport({
            context,
            objects,
            repositoryRoot,
            archivePath: option('--archive'),
            manifestPath: option('--manifest'),
            transportRunId: option('--transport-run'),
            downloadRunId: option('--download-run')
        });
        process.stdout.write(`${JSON.stringify({ archiveDigest: result.manifest.archive.digest,
            manifestDigest: result.manifest.contentDigest })}\n`);
        return;
    }
    if (action === 'extract')
    {
        const extracted = extractCurrentRunEvidenceTransport({
            repositoryRoot: optional('--root') || repositoryRoot,
            archivePath: optional('--archive') || undefined,
            manifestPath: option('--manifest'),
            extractRoot: optional('--extract-root') || '.'
        });
        process.stdout.write(`${JSON.stringify({ objects: extracted.objects.length,
            manifestDigest: extracted.contentDigest })}\n`);
        return;
    }
    if (action === 'verify')
    {
        const manifest = validateEvidenceTransportManifest(JSON.parse(fs.readFileSync(
            path.resolve(repositoryRoot, option('--manifest')), 'utf8')));
        process.stdout.write(`${JSON.stringify({ objects: manifest.objects.length,
            manifestDigest: manifest.contentDigest })}\n`);
        return;
    }
    throw new Error('usage: run-current-run-evidence-transport.mjs pack|extract|verify');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try { main(); }
    catch (error)
    {
        process.stderr.write(`[current-run-evidence-transport] ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

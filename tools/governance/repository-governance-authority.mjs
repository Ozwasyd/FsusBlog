#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveInputFiles } from './repository-governance-identity.mjs';
import { defaultManifest, loadAuthorityManifest, validateAuthorityManifest } from './repository-governance-manifest.mjs';
import { createGovernanceReceipt, readReceipt, verifyGovernanceReceipt } from './repository-governance-receipt.mjs';

export { createGovernanceReceipt, loadAuthorityManifest, resolveInputFiles, validateAuthorityManifest, verifyGovernanceReceipt };

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArguments(argv)
{
    const [action, authorityId, ...rest] = argv;
    const options = { action, authorityId };
    for (let index = 0; index < rest.length; index += 1)
    {
        if (rest[index] === '--receipt')
        {
            options.receiptFile = rest[++index];
        }
        else if (rest[index] === '--manifest')
        {
            options.manifestFile = rest[++index];
        }
        else
        {
            throw new Error(`unknown repository governance option: ${rest[index]}`);
        }
    }
    return options;
}

export async function main(argv = process.argv.slice(2), { root = defaultRoot } = {})
{
    const options = parseArguments(argv);
    const manifest = loadAuthorityManifest(root, options.manifestFile ?? defaultManifest);
    if (options.action === 'validate-manifest')
    {
        console.log(`[repository-governance] manifest ok authorities=${manifest.authorities.length}`);
        return;
    }
    if (!options.authorityId)
    {
        throw new Error('repository governance authority id is required');
    }
    if (options.action === 'run')
    {
        const receipt = await createGovernanceReceipt({ root, manifest, authorityId: options.authorityId });
        console.log(`[repository-governance] produced authority=${options.authorityId} receipt=${path.relative(root, receipt.file)} digest=${receipt.contentDigest}`);
        return;
    }
    if (options.action === 'verify' || options.action === 'ensure')
    {
        try
        {
            const { file, receipt } = readReceipt(root, options.authorityId, options.receiptFile);
            const result = await verifyGovernanceReceipt({ root, manifest, authorityId: options.authorityId, receipt });
            if (!result.valid)
            {
                throw new Error(result.errors.join('; '));
            }
            console.log(`[repository-governance] verified authority=${options.authorityId} receipt=${path.relative(root, file)} digest=${receipt.contentDigest}`);
            return;
        }
        catch (error)
        {
            if (options.action !== 'ensure')
            {
                throw error;
            }
            console.log(`[repository-governance] current receipt unavailable authority=${options.authorityId}; executing exact-input checker`);
            const receipt = await createGovernanceReceipt({ root, manifest, authorityId: options.authorityId });
            console.log(`[repository-governance] produced authority=${options.authorityId} receipt=${path.relative(root, receipt.file)} digest=${receipt.contentDigest}`);
            return;
        }
    }
    throw new Error('usage: repository-governance-authority.mjs validate-manifest | run|verify|ensure <authority> [--receipt file]');
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain)
{
    main().catch((error) =>
    {
        console.error(`[repository-governance] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}

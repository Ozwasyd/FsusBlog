import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanAuthorTypographyInventory } from './author-typography-inventory.mjs';

const legacyPattern = /\bzen\b|zen[-_]?mode|focus[-_]?mode|writing[-_]?mode|["']write["']/iu;

function digest(value)
{
    return createHash('sha256').update(value).digest('hex');
}

/** Discovery only: matching identifiers do not prove a storage key or authorize deleting it. */
export function scanWritingAidLegacyInventory(repositoryRoot)
{
    const root = fs.realpathSync(repositoryRoot);
    const source = scanAuthorTypographyInventory(root);
    const candidates = [];
    for (const file of source.files)
    {
        if (file.status !== 'text-scanned')
        {
            continue;
        }
        const bytes = fs.readFileSync(path.join(root, file.path));
        if (digest(bytes) !== file.sha256)
        {
            throw new Error(`Source changed during writing aid inventory: ${file.path}`);
        }
        bytes.toString('utf8').split('\n').forEach((line, index) =>
        {
            if (!legacyPattern.test(line))
            {
                return;
            }
            const classification = file.path === 'src/frontend/src/components/article/ArticleCommentComposer.vue'
                ? 'comment-composer-owner-1794'
                : /^(?:tests|tools|docs|config|artifacts|\.agents)\//u.test(file.path)
                  ? 'evidence-or-policy'
                  : 'requires-owner-review';
            candidates.push({
                path: file.path,
                line: index + 1,
                lineDigest: digest(line),
                fileDigest: file.sha256,
                classification,
                storageKey: null,
                migrationRule: null
            });
        });
    }
    const body = {
        schema: 'fsusblog.writing-aid-legacy-discovery.v1',
        sourceCommit: source.sourceCommit,
        inputInventoryDigest: source.inventoryDigest,
        scannerDigest: digest(fs.readFileSync(fileURLToPath(import.meta.url))),
        files: source.files,
        candidates,
        refusals: source.refusals,
        status: 'discovery-only',
        runtimeBrowserStorageInspected: false,
        migrationEligible: false,
        deletionEligible: false,
        ownedLegacyKeys: [],
        unresolvedSourceCandidates: candidates.filter((candidate) => candidate.classification === 'requires-owner-review').length
    };
    return { ...body, contentDigest: digest(JSON.stringify(body)) };
}

export function verifyWritingAidLegacyInventory(repositoryRoot, inventory)
{
    return JSON.stringify(scanWritingAidLegacyInventory(repositoryRoot)) === JSON.stringify(inventory);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    process.stdout.write(`${JSON.stringify(scanWritingAidLegacyInventory(root), null, 4)}\n`);
}

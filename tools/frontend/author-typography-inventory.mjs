import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const candidatePattern = /font[-_\s]?(?:family|size|url|face)|line[-_\s]?height|paragraph[-_\s]?spacing|canvas[-_\s]?width|prose[-_\s]?(?:width|font)|typograph|:deep\(|--fsus-.*(?:font|prose|width)|(?:localStorage|sessionStorage|indexedDB|persist).*?(?:font|prose|width)|(?:font|prose|width).*?(?:localStorage|sessionStorage|indexedDB|persist)/i;
const maximumFileBytes = 16 * 1024 * 1024;

function digest(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function classify(filePath)
{
    if (/^(?:src\/shared\/Contracts\/Fonts\/|src\/backend\/Services\/Fonts\/|src\/frontend\/src\/(?:assets\/|styles\/|style\/|fonts\/))/.test(filePath))
    {
        return 'system-or-public-font-owner';
    }
    if (/^(?:src\/frontend\/src\/(?:components\/public\/|views\/public\/|public-renderers\/)|src\/backend\/Services\/DocumentExport\/)/.test(filePath))
    {
        return 'public-or-export-owner';
    }
    if (/^(?:tests\/|docs\/|tools\/|config\/|artifacts\/|\.agents\/)/.test(filePath))
    {
        return 'evidence-or-policy';
    }
    return 'ambiguous-owner';
}

/**
 * Enumerate every indexed regular text file, not a known-key allowlist. Matches are
 * discovery candidates: they cannot authorize migration/deletion or establish residue=0.
 * Bind whole-file bytes and source lines so a reviewer can resolve actual readers/writers.
 */
export function scanAuthorTypographyInventory(repositoryRoot)
{
    const root = fs.realpathSync(repositoryRoot);
    const paths = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
        .split('\0').filter(Boolean).sort();
    const files = [];
    const candidates = [];
    const refusals = [];
    for (const filePath of paths)
    {
        const absolutePath = path.resolve(root, filePath);
        if (!absolutePath.startsWith(`${root}${path.sep}`))
        {
            refusals.push({ path: filePath, reason: 'path-outside-repository' });
            continue;
        }
        let bytes;
        try
        {
            const stat = fs.lstatSync(absolutePath);
            if (!stat.isFile() || stat.size > maximumFileBytes || fs.realpathSync(absolutePath) !== absolutePath)
            {
                refusals.push({ path: filePath, reason: 'nonregular-aliased-or-oversized-file' });
                continue;
            }
            bytes = fs.readFileSync(absolutePath);
        }
        catch
        {
            refusals.push({ path: filePath, reason: 'file-unavailable' });
            continue;
        }
        const fileDigest = digest(bytes);
        const text = bytes.toString('utf8');
        if (bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes))
        {
            files.push({ path: filePath, sha256: fileDigest, status: 'binary-not-scanned' });
            continue;
        }
        files.push({ path: filePath, sha256: fileDigest, status: 'text-scanned' });
        const lines = text.split('\n');
        lines.forEach((line, index) =>
        {
            if (candidatePattern.test(line))
            {
                candidates.push({
                    path: filePath,
                    line: index + 1,
                    lineDigest: digest(line),
                    fileDigest,
                    ownerClassification: classify(filePath),
                    resolution: 'requires-owner-review'
                });
            }
        });
    }
    const body = {
        schema: 'fsusblog.author-typography-discovery.v1',
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        scannerDigest: digest(fs.readFileSync(fileURLToPath(import.meta.url))),
        status: 'discovery-only',
        migrationEligible: false,
        deletionEligible: false,
        files,
        candidates,
        refusals
    };
    return { ...body, inventoryDigest: digest(JSON.stringify(body)) };
}

/** Re-enumerate physical inputs; caller-provided receipts and a historical HEAD are insufficient. */
export function verifyAuthorTypographyInventory(repositoryRoot, inventory)
{
    const actual = scanAuthorTypographyInventory(repositoryRoot);
    return JSON.stringify(actual) === JSON.stringify(inventory);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    process.stdout.write(`${JSON.stringify(scanAuthorTypographyInventory(root), null, 4)}\n`);
}

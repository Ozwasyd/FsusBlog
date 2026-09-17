import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Shared helpers for seed extractors. Owns no behavior semantics.
 * Seeds may only read declared consumedInputs passed by the runner context.
 */

export function readDeclaredJson(repositoryRoot, relativePath, allowedInputs)
{
    const normalized = relativePath.replaceAll(path.sep, '/');
    if (!allowedInputs.has(normalized))
    {
        throw new Error(`seed attempted to read undeclared input ${normalized}`);
    }
    const absolute = path.join(repositoryRoot, normalized);
    return JSON.parse(readFileSync(absolute, 'utf8'));
}

export function readDeclaredText(repositoryRoot, relativePath, allowedInputs)
{
    const normalized = relativePath.replaceAll(path.sep, '/');
    if (!allowedInputs.has(normalized))
    {
        throw new Error(`seed attempted to read undeclared input ${normalized}`);
    }
    return readFileSync(path.join(repositoryRoot, normalized), 'utf8');
}

export function allowedInputSet(extractor)
{
    return new Set((extractor.consumedInputs ?? []).map((entry) => String(entry).replaceAll(path.sep, '/')));
}

export function sortedUniqueStrings(values)
{
    return [...new Set(values.map(String))].sort();
}

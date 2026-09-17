import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function isDirectExecution(moduleUrl, entry = process.argv[1])
{
    if (!entry)
    {
        return false;
    }
    return moduleUrl === pathToFileURL(path.resolve(entry)).href;
}

export function reportDirectFailure(label, error)
{
    console.error(`[${label}] fatal:`, error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}

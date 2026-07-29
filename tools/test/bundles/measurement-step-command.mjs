import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const performanceAdmission = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../performance-admission.mjs'
);

export function wrapTaskScopedMeasurementCommand({
    windowId,
    evidenceFile,
    command,
    runId,
    attemptSequence,
    authorityRoot,
    authorityManifestRoot = null,
    priorAuthorityRoots = [],
    policyFile = null,
    productEvidenceFile = null
} = {})
{
    if (!String(windowId ?? '').trim())
    {
        throw new Error('bundle measurement window id is required');
    }
    if (!String(evidenceFile ?? '').trim())
    {
        throw new Error('bundle measurement evidence file is required');
    }
    if (!Array.isArray(command) || command.length === 0)
    {
        throw new Error('bundle measurement command is required');
    }
    if (!String(runId ?? '').trim())
    {
        throw new Error('bundle measurement run id is required');
    }
    if (attemptSequence !== null
    && attemptSequence !== undefined
    && (!Number.isInteger(Number(attemptSequence)) || Number(attemptSequence) <= 0))
    {
        throw new Error('bundle measurement attempt sequence must be positive');
    }
    if (!String(authorityRoot ?? '').trim())
    {
        throw new Error('bundle measurement authority root is required');
    }
    const resolvedAuthorityManifestRoot = String(authorityManifestRoot ?? '').trim()
        ? path.resolve(authorityManifestRoot)
        : `${path.resolve(authorityRoot)}.manifest`;
    if (!Array.isArray(priorAuthorityRoots)
    || priorAuthorityRoots.some((candidate) => !String(candidate ?? '').trim()))
    {
        throw new Error('bundle prior measurement authority roots must be non-empty paths');
    }

    const args = [
        performanceAdmission,
        '--window-id',
        windowId,
        '--evidence',
        path.resolve(evidenceFile),
        '--run-id',
        runId,
        '--authority-root',
        path.resolve(authorityRoot),
        '--authority-manifest-root',
        resolvedAuthorityManifestRoot
    ];
    if (attemptSequence !== null && attemptSequence !== undefined)
    {
        args.push('--attempt-sequence', String(attemptSequence));
    }
    for (const priorAuthorityRoot of priorAuthorityRoots)
    {
        args.push('--prior-authority-root', path.resolve(priorAuthorityRoot));
    }
    if (policyFile)
    {
        args.push('--policy', path.resolve(policyFile));
    }
    if (productEvidenceFile)
    {
        args.push('--product-evidence', path.resolve(productEvidenceFile));
    }
    args.push('--', ...command);
    return {
        executable: process.execPath,
        args
    };
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Auxiliary evidence is explicit, content-addressed and owned by the same run.
// Domains cannot discover a second candidate after a bad ref.
export function readOwnerEvidenceFile(reference, { repositoryRoot, context })
{
    if (!reference || typeof reference.path !== 'string'
        || !/^sha256:[a-f0-9]{64}$/u.test(reference.digest ?? ''))
    {
        throw new Error('explicit owner evidence path and digest are required');
    }
    if (path.isAbsolute(reference.path) || reference.path.includes('\\')
        || reference.path.split('/').some((part) => ['', '.', '..'].includes(part)))
    {
        throw new Error('owner evidence reference must be a canonical relative path');
    }
    const absolute = path.resolve(repositoryRoot, reference.path);
    const real = fs.realpathSync(absolute);
    const roots = context.ownedRoots.map((root) => fs.realpathSync(path.resolve(repositoryRoot, root)));
    if (real !== absolute || !roots.some((root) => real.startsWith(`${root}${path.sep}`)) || !fs.lstatSync(real).isFile())
    {
        throw new Error('owner evidence reference escapes current-run owned roots');
    }
    const bytes = fs.readFileSync(real);
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== reference.digest)
    {
        throw new Error('owner evidence content digest mismatch');
    }
    return { file: real, bytes, digest };
}

export function readOwnerEvidenceReference(reference, options)
{
    const { file, bytes, digest } = readOwnerEvidenceFile(reference, options);
    return { file, receipt: JSON.parse(bytes), digest };
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function canonicalize(value)
{
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function sha256(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function sha256File(file)
{
    return sha256(fs.readFileSync(file));
}

export function computeSourceClosureDigest({ root, paths })
{
    const declarations = [...new Set((paths ?? []).map((entry) => String(entry).replaceAll(path.sep, '/')))].sort();
    if (declarations.length === 0) throw new Error('source closure paths must be non-empty');
    const entries = [];
    const visit = (absolute) =>
    {
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error(`source closure path cannot be a symlink: ${absolute}`);
        if (stat.isDirectory())
        {
            for (const child of fs.readdirSync(absolute).sort()) visit(path.join(absolute, child));
        }
        else if (stat.isFile()) entries.push(absolute);
        else throw new Error(`source closure path is not a regular file or directory: ${absolute}`);
    };
    for (const declaration of declarations)
    {
        const absolute = path.resolve(root, declaration);
        const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
        if (relative.startsWith('../') || path.isAbsolute(relative))
            throw new Error(`source closure path escapes root: ${declaration}`);
        visit(absolute);
    }
    const bindings = [...new Set(entries)].sort().map((absolute) => ({
        path: path.relative(root, absolute).replaceAll(path.sep, '/'),
        digest: sha256File(absolute)
    }));
    return sha256(JSON.stringify(canonicalize(bindings)));
}

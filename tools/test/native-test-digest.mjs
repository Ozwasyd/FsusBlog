import { createHash } from 'node:crypto';
import fs from 'node:fs';

export function nativeSha256(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function fileSetDigest(root, paths)
{
    const rows = paths.map((relative) => `${relative}\0${nativeSha256(fs.readFileSync(new URL(relative, `file://${root}/`)))}`);
    return nativeSha256(rows.sort().join('\n'));
}

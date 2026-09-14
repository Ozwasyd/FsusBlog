import { createHash } from 'node:crypto';

/** Read regular source blobs at an immutable commit without following download URLs. */
export function createDependencySourceReader({ repository, fetchJson, headers = {} })
{
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    {
        throw new Error('dependency_source_repository_invalid');
    }
    const trees = new Map();
    async function readTree(headSha)
    {
        const base = `https://api.github.com/repos/${repository}`;
        const commit = await fetchJson(`${base}/git/commits/${headSha}`, headers);
        if (commit.sha !== headSha || !/^[0-9a-f]{40}$/u.test(commit.tree?.sha ?? ''))
        {
            throw new Error('dependency_source_commit_invalid');
        }
        const tree = await fetchJson(`${base}/git/trees/${commit.tree.sha}?recursive=1`, headers);
        if (tree.sha !== commit.tree.sha || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 100000)
        {
            throw new Error('dependency_source_tree_incomplete');
        }
        const entries = new Map();
        for (const entry of tree.tree)
        {
            if (typeof entry?.path !== 'string' || entries.has(entry.path))
            {
                throw new Error('dependency_source_tree_invalid');
            }
            entries.set(entry.path, entry);
        }
        return entries;
    }
    return async (file, headSha) =>
    {
        if (!/^[0-9a-f]{40}$/u.test(headSha ?? '') || typeof file !== 'string'
            || file.split('/').some(segment => !segment || segment === '.' || segment === '..')
            || /[\\\x00-\x1f\x7f:]/u.test(file)) // eslint-disable-line no-control-regex -- intentional ASCII-boundary probe
        {
            throw new Error('dependency_source_identity_invalid');
        }
        if (!trees.has(headSha))
        {
            trees.set(headSha, readTree(headSha));
        }
        const entry = (await trees.get(headSha)).get(file);
        if (entry?.type !== 'blob' || !['100644', '100755'].includes(entry.mode))
        {
            throw new Error('dependency_source_not_regular_file');
        }
        const url = `https://api.github.com/repos/${repository}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${headSha}`;
        const blob = await fetchJson(url, headers);
        if (blob?.type !== 'file' || blob.path !== file || blob.encoding !== 'base64'
            || !/^[0-9a-f]{40}$/u.test(blob.sha ?? '') || !Number.isSafeInteger(blob.size)
            || blob.size < 0 || blob.size > 16 * 1024 * 1024 || typeof blob.content !== 'string')
        {
            throw new Error('dependency_source_blob_invalid');
        }
        const encoded = blob.content.replace(/\n/gu, '');
        const bytes = Buffer.from(encoded, 'base64');
        const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (bytes.length !== blob.size || bytes.toString('base64') !== encoded || digest !== blob.sha || digest !== entry.sha)
        {
            throw new Error('dependency_source_blob_digest_mismatch');
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    };
}

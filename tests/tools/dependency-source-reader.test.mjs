import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDependencySourceReader } from '../../tools/governance/dependency-source-reader.mjs';

const head = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
function fixture(override = {})
{
    const source = 'source content\n';
    const sha = createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0${source}`).digest('hex');
    const calls = [];
    const read = createDependencySourceReader({ repository: 'owner/repo', fetchJson: async url => {
        calls.push(url);
        if (url.includes('/git/commits/')) return { sha: head, tree: { sha: treeSha } };
        if (url.includes('/git/trees/')) return { sha: treeSha, truncated: false, tree: [{ path: 'file.txt', type: 'blob', mode: override.mode ?? '100644', sha }], ...override.tree };
        assert.ok(url.endsWith(`/contents/file.txt?ref=${head}`));
        return { type: 'file', path: 'file.txt', sha, size: Buffer.byteLength(source), encoding: 'base64', content: Buffer.from(source).toString('base64'), ...override.blob };
    } });
    return { read, calls, source };
}

test('source bytes bind exact commit, complete tree, regular mode and Git blob digest', async () => {
    const { read, calls, source } = fixture();
    assert.equal(await read('file.txt', head), source);
    assert.equal(await read('file.txt', head), source);
    assert.equal(calls.filter(url => url.includes('/git/trees/')).length, 1);
});

test('symlinks, truncated trees, altered bytes and path drift fail closed', async () => {
    for (const override of [{ mode: '120000' }, { tree: { truncated: true } }, { blob: { content: 'YWx0ZXJlZA==' } }, { blob: { path: 'other.txt' } }])
    {
        await assert.rejects(fixture(override).read('file.txt', head), /dependency_source_/);
    }
});

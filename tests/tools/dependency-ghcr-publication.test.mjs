import assert from 'node:assert/strict';
import test from 'node:test';

import { readGhcrPublication } from '../../tools/governance/dependency-ghcr-publication.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const version = { id: 1, name: digest, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z',
    metadata: { package_type: 'container', container: { tags: ['latest'] } } };

test('GHCR publication binds exact digest and uses created_at rather than updated_at', async () => {
    for (const type of ['User', 'Organization'])
    {
        const result = await readGhcrPublication('ghcr.io/example/image', 'latest', digest, async (url) => {
            if (url === 'https://api.github.com/users/example') return { login: 'example', type };
            assert.equal(url, `https://api.github.com/${type === 'User' ? 'users' : 'orgs'}/example/packages/container/image/versions?state=active&per_page=100&page=1`);
            return [structuredClone(version)];
        });
        assert.equal(result, '2026-01-01T00:00:00.000Z');
    }
});

test('GHCR target on a later page is discovered through complete pagination', async () => {
    const result = await readGhcrPublication('ghcr.io/example/image', 'latest', digest, async (url) => {
        if (url.endsWith('/users/example')) return { login: 'example', type: 'User' };
        return url.endsWith('page=1') ? Array.from({ length: 100 }, (_, index) => ({ id: index + 2, name: 'other' })) : [version];
    });
    assert.equal(result, '2026-01-01T00:00:00.000Z');
});

test('missing or retagged digest, duplicate versions and missing dates fail closed', async () => {
    for (const versions of [[], [version, version], [{ ...version, created_at: undefined }],
        [{ ...version, metadata: { package_type: 'container', container: { tags: ['old'] } } }]])
    {
        await assert.rejects(readGhcrPublication('ghcr.io/example/image', 'latest', digest, async (url) =>
            url.endsWith('/users/example') ? { login: 'example', type: 'User' } : versions));
    }
});

test('package read permission errors never fabricate publication timestamps', async () => {
    await assert.rejects(readGhcrPublication('ghcr.io/example/image', 'latest', digest, async (url) => {
        if (url.endsWith('/users/example')) return { login: 'example', type: 'User' };
        throw new Error('GitHub HTTP 403');
    }), /GitHub HTTP 403/);
});

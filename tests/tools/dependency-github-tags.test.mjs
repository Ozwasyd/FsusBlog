import assert from 'node:assert/strict';
import test from 'node:test';
import { readLatestGithubTag } from '../../tools/governance/dependency-github-tags.mjs';

const sha = 'a'.repeat(40);
const tag = name => ({ name, commit: { sha } });
const release = name => ({ tag_name: name, draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' });

test('Action tag ordering ignores bundle releases, rolling aliases and prerelease tags', async () => {
    const result = await readLatestGithubTag('github/codeql-action', async url => {
        if (url.includes('/tags?')) return ['v3.99.0', 'codeql-bundle-v9.0.0', 'v4', 'v4.9.0', 'v5.0.0-rc.1', 'v4.10.0'].map(tag);
        assert.ok(url.endsWith('/releases/tags/v4.10.0'));
        return release('v4.10.0');
    });
    assert.deepEqual(result, { latestStable: 'v4.10.0', releasedAt: '2026-01-01T00:00:00.000Z', targetDigest: sha });
});

test('all tag pages are read before selecting a target and prerelease metadata is respected', async () => {
    const result = await readLatestGithubTag('owner/action', async url => {
        if (url.endsWith('page=1')) return Array.from({ length: 100 }, (_, index) => tag(`bundle-${index}`));
        if (url.endsWith('page=2')) return [tag('v9.0.0'), tag('v8.0.0')];
        if (url.endsWith('/v9.0.0')) return { ...release('v9.0.0'), prerelease: true };
        return release('v8.0.0');
    });
    assert.equal(result.latestStable, 'v8.0.0');
});

test('missing release identity or timestamp and late page errors fail closed', async () => {
    for (const metadata of [{ ...release('v1.0.0'), tag_name: 'v2.0.0' }, { ...release('v1.0.0'), published_at: null }])
    {
        await assert.rejects(readLatestGithubTag('owner/action', async url => url.includes('/tags?') ? [tag('v1.0.0')] : metadata));
    }
    await assert.rejects(readLatestGithubTag('owner/action', async url => {
        if (url.endsWith('page=1')) return Array.from({ length: 100 }, (_, index) => tag(`v1.0.${index}`));
        throw new Error('page unavailable');
    }), /page unavailable/);
    await assert.rejects(readLatestGithubTag('owner/action', async () => [tag('v1.0.0'), tag('v1.0.0')]), /identity_invalid/);
});

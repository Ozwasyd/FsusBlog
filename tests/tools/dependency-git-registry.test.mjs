import assert from 'node:assert/strict';
import test from 'node:test';

const { readLatestGitRef } = await import(new URL('../../tools/governance/dependency-git-registry.mjs', import.meta.url));
const packageName = 'https://github.com/example/upstream.git';
const sha = 'a'.repeat(40);

function fixture(branch = 'main')
{
    const metadata = { full_name: 'example/upstream', default_branch: branch };
    const commit = { sha, commit: { committer: { date: '2026-01-01T00:00:00Z' } } };
    const requests = [];
    const read = async (url) =>
    {
        requests.push(url);
        if (url === 'https://api.github.com/repos/example/upstream')
        {
            return structuredClone(metadata);
        }
        assert.equal(url, `https://api.github.com/repos/example/upstream/commits/${encodeURIComponent(branch)}`);
        return commit;
    };
    return { metadata, commit, requests, read };
}

test('rolling upstream uses its discovered default branch including slash-containing names', async () =>
{
    for (const branch of ['main', 'master', 'release/current'])
    {
        const data = fixture(branch);
        assert.deepEqual(await readLatestGitRef(packageName, data.read), {
            latestStable: sha, releasedAt: '2026-01-01T00:00:00.000Z'
        });
        assert.equal(data.requests.length, 3);
    }
});

test('default branch changes during collection invalidate the snapshot', async () =>
{
    const data = fixture();
    await assert.rejects(readLatestGitRef(packageName, async (url) =>
    {
        const result = await data.read(url);
        if (url.includes('/commits/'))
        {
            data.metadata.default_branch = 'next';
        }
        return result;
    }), /default_branch_changed/);
});

test('missing branch, mismatched repository and malformed commit identity fail closed', async () =>
{
    for (const mutate of [
        (data) =>
        {
            delete data.metadata.default_branch;
        },
        (data) =>
        {
            data.metadata.full_name = 'other/repository';
        },
        (data) =>
        {
            data.commit.sha = 'not-a-sha';
        }
    ])
    {
        const data = fixture();
        mutate(data);
        await assert.rejects(readLatestGitRef(packageName, data.read), /git_registry_/);
    }
});

test('late API failure or missing commit date cannot produce successful freshness metadata', async () =>
{
    const data = fixture();
    await assert.rejects(readLatestGitRef(packageName, async (url) =>
    {
        if (data.requests.length === 2)
        {
            throw new Error('permission denied');
        }
        return data.read(url);
    }), /permission denied/);
    delete data.commit.commit.committer.date;
    await assert.rejects(readLatestGitRef(packageName, data.read), /registry_publication_missing/);
});

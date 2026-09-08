import { registryRelease } from './dependency-registry-release.mjs';

/** Action tags, not unrelated repository releases, own the update identity. */
export async function readLatestGithubTag(packageName, fetchJson, headers = {})
{
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(packageName))
    {
        throw new Error('github_tags_package_invalid');
    }
    const base = `https://api.github.com/repos/${packageName}`;
    const candidates = [];
    const seen = new Set();
    for (let page = 1; ; page += 1)
    {
        if (page > 100) throw new Error(`github_tags_pagination_limit:${packageName}`);
        const tags = await fetchJson(`${base}/tags?per_page=100&page=${page}`, headers);
        if (!Array.isArray(tags) || tags.length > 100) throw new Error('github_tags_page_invalid');
        for (const tag of tags)
        {
            if (typeof tag?.name !== 'string' || seen.has(tag.name)) throw new Error('github_tags_identity_invalid');
            seen.add(tag.name);
            if (!/^v?\d+\.\d+\.\d+$/u.test(tag.name)) continue;
            if (!/^[0-9a-f]{40}$/u.test(tag.commit?.sha ?? '')) throw new Error('github_tags_commit_invalid');
            candidates.push(tag);
        }
        if (tags.length < 100) break;
    }
    candidates.sort((left, right) => {
        const a = left.name.replace(/^v/u, '').split('.').map(BigInt);
        const b = right.name.replace(/^v/u, '').split('.').map(BigInt);
        for (let index = 0; index < a.length; index += 1)
        {
            if (a[index] !== b[index]) return a[index] > b[index] ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
    });
    for (const tag of candidates)
    {
        const release = await fetchJson(`${base}/releases/tags/${encodeURIComponent(tag.name)}`, headers);
        if (release.tag_name !== tag.name || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean')
        {
            throw new Error('github_tags_release_identity_invalid');
        }
        if (release.draft || release.prerelease) continue;
        return { ...registryRelease(tag.name, release.published_at, `github-tags:${packageName}`), targetDigest: tag.commit.sha };
    }
    throw new Error(`github_tags_stable_release_missing:${packageName}`);
}

import { registryRelease } from './dependency-registry-release.mjs';

/** GitHub Packages versions expose digest identity and registry creation time. */
export async function readGhcrPublication(packageName, tag, digest, fetchJson, headers = {})
{
    const match = /^ghcr\.io\/([a-z0-9-]+)\/([a-z0-9][a-z0-9._/-]*)$/.exec(packageName);
    if (!match || !/^sha256:[0-9a-f]{64}$/.test(digest) || !/^[\w][\w.-]{0,127}$/.test(tag))
    {
        throw new Error('ghcr_publication_input_invalid');
    }
    const [, owner, name] = match;
    const identity = await fetchJson(`https://api.github.com/users/${owner}`, headers);
    if (typeof identity.login !== 'string' || identity.login.toLowerCase() !== owner
        || !['User', 'Organization'].includes(identity.type))
    {
        throw new Error('ghcr_publication_owner_invalid');
    }
    const path = `${identity.type === 'Organization' ? 'orgs' : 'users'}/${owner}/packages/container/${encodeURIComponent(name)}/versions`;
    const seen = new Set();
    const matching = [];
    for (let page = 1; page <= 100; page++)
    {
        const versions = await fetchJson(`https://api.github.com/${path}?state=active&per_page=100&page=${page}`, headers);
        if (!Array.isArray(versions) || versions.length > 100)
        {
            throw new Error('ghcr_publication_page_invalid');
        }
        for (const version of versions)
        {
            if (!Number.isSafeInteger(version.id) || version.id <= 0 || seen.has(version.id))
            {
                throw new Error('ghcr_publication_version_ambiguous');
            }
            seen.add(version.id);
            if (version.name === digest)
            {
                if (version.metadata?.package_type !== 'container' || !Array.isArray(version.metadata.container?.tags)
                    || !version.metadata.container.tags.includes(tag))
                {
                    throw new Error('ghcr_publication_tag_changed');
                }
                matching.push(version);
            }
        }
        if (versions.length < 100)
        {
            if (matching.length !== 1)
            {
                throw new Error('ghcr_publication_digest_missing_or_ambiguous');
            }
            return registryRelease(digest, matching[0].created_at, `ghcr:${owner}/${name}`).releasedAt;
        }
    }
    throw new Error('ghcr_publication_pagination_incomplete');
}

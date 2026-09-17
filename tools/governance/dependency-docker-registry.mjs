import { createHash } from 'node:crypto';

import { registryRelease } from './dependency-registry-release.mjs';

const manifestTypes = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json'
];
const digestPattern = /^sha256:[0-9a-f]{64}$/;

/** Consume the same digest-bound publication metadata shown by Microsoft's artifact catalog. */
export async function readMcrPublication(packageName, tag, digest, fetchJson)
{
    const { origin, name } = dockerRepository(packageName);
    if (origin !== 'https://mcr.microsoft.com' || !/^[\w][\w.-]{0,127}$/.test(tag) || !digestPattern.test(digest))
    {
        throw new Error('mcr_publication_input_invalid');
    }
    const entries = await fetchJson(`https://mcr.microsoft.com/api/v1/catalog/${name}/tags?reg=mar`);
    if (!Array.isArray(entries))
    {
        throw new Error('mcr_publication_catalog_invalid');
    }
    const matching = entries.filter((entry) => entry?.name === tag);
    if (matching.length !== 1 || matching[0].digest !== digest || matching[0].repository !== name
        || matching[0].regHash !== 'mar' || !manifestTypes.includes(matching[0].manifestType))
    {
        throw new Error(`mcr_publication_identity_mismatch:${packageName}`);
    }
    return registryRelease(tag, matching[0].lastModifiedDate, `mcr:${name}`).releasedAt;
}

/** Bind Docker Hub's tag publication timestamp to the exact observed manifest digest. */
export async function readDockerHubPublication(packageName, tag, digest, fetchJson)
{
    const { origin, name } = dockerRepository(packageName);
    if (origin !== 'https://registry-1.docker.io' || !/^[\w][\w.-]{0,127}$/.test(tag) || !digestPattern.test(digest))
    {
        throw new Error('docker_hub_publication_input_invalid');
    }
    const [namespace, repository, ...extra] = name.split('/');
    if (extra.length)
    {
        throw new Error('docker_hub_repository_invalid');
    }
    const body = await fetchJson(`https://hub.docker.com/v2/namespaces/${namespace}/repositories/${repository}/tags/${tag}`);
    if (body.name !== tag || body.digest !== digest)
    {
        throw new Error(`docker_hub_publication_digest_changed:${packageName}`);
    }
    return registryRelease(tag, body.tag_last_pushed, `docker-hub:${name}`).releasedAt;
}

/** Join target selection, verified manifest and a digest-bound publication provider. */
export async function readLatestDocker(packageName, currentVersion, readResponse, readPublication)
{
    if (typeof currentVersion === 'string' && currentVersion.startsWith('['))
    {
        const references = JSON.parse(currentVersion);
        if (!Array.isArray(references) || references.length < 2 || references.length > 16
            || references.some(reference => typeof reference !== 'string' || reference.startsWith('['))
            || new Set(references).size !== references.length
            || JSON.stringify([...references].sort()) !== currentVersion)
        {
            throw new Error(`docker_variant_identity_invalid:${packageName}`);
        }
        const targets = [];
        for (const reference of references)
        {
            targets.push(await readLatestDocker(packageName, reference, readResponse, readPublication));
        }
        const changed = targets.filter((target, index) => target.latestStable !== references[index]);
        const published = (changed.length ? changed : targets).map(target => target.releasedAt).sort()[0];
        return registryRelease(JSON.stringify([...new Set(targets.map(target => target.latestStable))].sort()), published, `docker:${packageName}`);
    }
    const digestOnly = digestPattern.test(currentVersion);
    const pinned = typeof currentVersion === 'string' && currentVersion.includes('@');
    const [currentTag, currentDigest, ...extra] = String(currentVersion).split('@');
    if (pinned && (!currentTag || !digestPattern.test(currentDigest) || extra.length))
    {
        throw new Error(`docker_current_reference_invalid:${packageName}`);
    }
    const tag = digestOnly ? 'latest' : selectLatestDockerTag(await readDockerTags(packageName, readResponse), currentTag);
    const observed = await readDockerManifest(packageName, tag, readResponse);
    const published = await readPublication(packageName, tag, observed.digest);
    const result = registryRelease(digestOnly ? observed.digest : pinned ? `${tag}@${observed.digest}` : tag, published, `docker:${packageName}`);
    return { ...result, targetTag: tag, targetDigest: observed.digest };
}

function numericDockerTag(tag)
{
    if (typeof tag !== 'string' || /^[0-9a-f]{40,64}$/.test(tag))
    {
        return null;
    }
    const match = /^(v?)(0|[1-9][0-9]*)(\.(?:0|[1-9][0-9]*)){0,3}(-[A-Za-z0-9][A-Za-z0-9_.-]*)?$/.exec(tag);
    if (!match)
    {
        return null;
    }
    const separator = tag.indexOf('-');
    const version = separator < 0 ? tag : tag.slice(0, separator);
    return {
        tag, prefix: match[1], suffix: separator < 0 ? '' : tag.slice(separator),
        parts: version.replace(/^v/, '').split('.').map(BigInt)
    };
}

function compareDockerTags(left, right)
{
    for (let index = 0; index < left.parts.length; index++)
    {
        if (left.parts[index] < right.parts[index])
        {
            return -1;
        }
        if (left.parts[index] > right.parts[index])
        {
            return 1;
        }
    }
    return 0;
}

/** Docker's numeric tags retain precision and the exact compatibility suffix. */
export function selectLatestDockerTag(tags, currentVersion)
{
    const current = numericDockerTag(currentVersion);
    if (!current || !Array.isArray(tags))
    {
        throw new Error('docker_numeric_tag_required');
    }
    const candidates = tags.map(numericDockerTag).filter((tag) => tag
        && tag.parts.length === current.parts.length && tag.suffix === current.suffix && tag.prefix === current.prefix);
    if (candidates.length === 0)
    {
        throw new Error('docker_compatible_tag_missing');
    }
    candidates.sort(compareDockerTags);
    const latest = candidates.at(-1);
    if (compareDockerTags(latest, current) < 0)
    {
        throw new Error('docker_latest_tag_would_downgrade');
    }
    return latest.tag;
}

export function dockerRepository(packageName)
{
    let registry = 'registry-1.docker.io';
    let name = packageName;
    if (name.startsWith('docker.io/'))
    {
        name = name.slice('docker.io/'.length);
    }
    else if (name.startsWith('mcr.microsoft.com/') || name.startsWith('ghcr.io/'))
    {
        const slash = name.indexOf('/');
        registry = name.slice(0, slash);
        name = name.slice(slash + 1);
    }
    if (!name.includes('/'))
    {
        name = `library/${name}`;
    }
    if (name.length >= 256 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/.test(name))
    {
        throw new Error('docker_repository_invalid');
    }
    return { origin: `https://${registry}`, name };
}

/** Verify manifest bytes before using their descriptors as registry evidence. */
export async function readDockerManifest(packageName, reference, readResponse)
{
    if (!digestPattern.test(reference) && !/^[\w][\w.-]{0,127}$/.test(reference))
    {
        throw new Error('docker_manifest_reference_invalid');
    }
    const { origin, name } = dockerRepository(packageName);
    const response = await readResponse(`${origin}/v2/${name}/manifests/${reference}`, manifestTypes.join(', '));
    if (!response.ok)
    {
        throw new Error(`docker_manifest_http_error:${packageName}:${response.status}`);
    }
    const mediaType = response.headers.get('content-type')?.split(';')[0].trim();
    if (!manifestTypes.includes(mediaType))
    {
        throw new Error('docker_manifest_media_type_invalid');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body)
    {
        size += chunk.byteLength;
        if (size > 4 * 1024 * 1024)
        {
            throw new Error('docker_manifest_size_exceeded');
        }
        chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const header = response.headers.get('docker-content-digest');
    if ((header && header !== digest) || (digestPattern.test(reference) && reference !== digest))
    {
        throw new Error('docker_manifest_digest_mismatch');
    }
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (manifest.schemaVersion !== 2 || manifest.mediaType !== mediaType)
    {
        throw new Error('docker_manifest_schema_invalid');
    }
    const index = manifestTypes.indexOf(mediaType) < 2;
    const descriptors = index ? manifest.manifests : [manifest.config];
    if (!Array.isArray(descriptors) || descriptors.length === 0 || descriptors.some((entry) => !entry
        || !digestPattern.test(entry.digest) || !Number.isSafeInteger(entry.size) || entry.size < 0
        || typeof entry.mediaType !== 'string'))
    {
        throw new Error('docker_manifest_descriptors_invalid');
    }
    return { digest, manifest, size };
}

/** Public metadata only: obtain repository-scoped anonymous pull tokens, never Docker login credentials. */
export function createDockerRegistryReader(packageName, fetchImpl = fetch)
{
    const { origin, name } = dockerRepository(packageName);
    let token;
    return async (value, accept = 'application/json') =>
    {
        const url = new URL(value);
        if (url.origin !== origin || !url.pathname.startsWith(`/v2/${name}/`)
            || url.username || url.password || url.hash)
        {
            throw new Error('docker_registry_read_scope_invalid');
        }
        const request = () => fetchImpl(url.href, {
            method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
            headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
        });
        let response = await request();
        if (response.status !== 401 || token)
        {
            return response;
        }
        const authority = origin === 'https://registry-1.docker.io'
            ? ['https://auth.docker.io/token', 'registry.docker.io']
            : origin === 'https://ghcr.io' ? ['https://ghcr.io/token', 'ghcr.io'] : null;
        if (!authority)
        {
            return response;
        }
        await response.body?.cancel();
        const tokenUrl = new URL(authority[0]);
        tokenUrl.searchParams.set('service', authority[1]);
        tokenUrl.searchParams.set('scope', `repository:${name}:pull`);
        const grant = await fetchImpl(tokenUrl.href, {
            method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' }
        });
        if (!grant.ok)
        {
            throw new Error(`docker_public_token_http_error:${packageName}:${grant.status}`);
        }
        const body = await grant.json();
        token = body.token ?? body.access_token;
        if (typeof token !== 'string' || token.length === 0 || /[\r\n]/.test(token))
        {
            throw new Error(`docker_public_token_invalid:${packageName}`);
        }
        response = await request();
        return response;
    };
}

/** Follow the registry's tag pagination; never treat the first page as complete evidence. */
export async function readDockerTags(packageName, readResponse)
{
    const { origin, name } = dockerRepository(packageName);
    const pathname = `/v2/${name}/tags/list`;
    let next = `${origin}${pathname}?n=1000`;
    const pages = new Set();
    const tags = new Set();
    while (next)
    {
        if (pages.size >= 100 || pages.has(next))
        {
            throw new Error('docker_tag_pagination_incomplete');
        }
        pages.add(next);
        const response = await readResponse(next);
        if (!response.ok)
        {
            throw new Error(`docker_tags_http_error:${packageName}:${response.status}`);
        }
        const body = await response.json();
        if (body.name !== name || !Array.isArray(body.tags)
            || body.tags.some((tag) => typeof tag !== 'string' || !/^[\w][\w.-]{0,127}$/.test(tag)))
        {
            throw new Error(`docker_tags_invalid:${packageName}`);
        }
        for (const tag of body.tags)
        {
            if (tags.has(tag))
            {
                throw new Error(`docker_tags_duplicate:${packageName}`);
            }
            tags.add(tag);
        }
        const link = response.headers.get('link');
        next = null;
        if (link)
        {
            const match = /^<([^>]+)>;\s*rel="next"$/.exec(link);
            if (!match)
            {
                throw new Error('docker_tag_next_link_invalid');
            }
            const url = new URL(match[1], origin);
            if (url.origin !== origin || url.pathname !== pathname || url.username || url.password || url.hash
                || [...url.searchParams.keys()].some((key) => !['n', 'last'].includes(key)))
            {
                throw new Error('docker_tag_next_link_invalid');
            }
            next = url.href;
        }
    }
    return [...tags];
}

export function dockerRepository(packageName)
{
    let registry = 'registry-1.docker.io';
    let name = packageName;
    if (name.startsWith('docker.io/')) name = name.slice('docker.io/'.length);
    else if (name.startsWith('mcr.microsoft.com/') || name.startsWith('ghcr.io/'))
    {
        const slash = name.indexOf('/');
        registry = name.slice(0, slash);
        name = name.slice(slash + 1);
    }
    if (!name.includes('/')) name = `library/${name}`;
    if (name.length >= 256 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/.test(name))
    {
        throw new Error('docker_repository_invalid');
    }
    return { origin: `https://${registry}`, name };
}

/** Public metadata only: obtain repository-scoped anonymous pull tokens, never Docker login credentials. */
export function createDockerRegistryReader(packageName, fetchImpl = fetch)
{
    const { origin, name } = dockerRepository(packageName);
    let token;
    return async (value, accept = 'application/json') => {
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
        if (response.status !== 401 || token) return response;
        const authority = origin === 'https://registry-1.docker.io'
            ? ['https://auth.docker.io/token', 'registry.docker.io']
            : origin === 'https://ghcr.io' ? ['https://ghcr.io/token', 'ghcr.io'] : null;
        if (!authority) return response;
        await response.body?.cancel();
        const tokenUrl = new URL(authority[0]);
        tokenUrl.searchParams.set('service', authority[1]);
        tokenUrl.searchParams.set('scope', `repository:${name}:pull`);
        const grant = await fetchImpl(tokenUrl.href, {
            method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' }
        });
        if (!grant.ok) throw new Error(`docker_public_token_http_error:${packageName}:${grant.status}`);
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
        if (pages.size >= 100 || pages.has(next)) throw new Error('docker_tag_pagination_incomplete');
        pages.add(next);
        const response = await readResponse(next);
        if (!response.ok) throw new Error(`docker_tags_http_error:${packageName}:${response.status}`);
        const body = await response.json();
        if (body.name !== name || !Array.isArray(body.tags)
            || body.tags.some((tag) => typeof tag !== 'string' || !/^[\w][\w.-]{0,127}$/.test(tag)))
        {
            throw new Error(`docker_tags_invalid:${packageName}`);
        }
        for (const tag of body.tags)
        {
            if (tags.has(tag)) throw new Error(`docker_tags_duplicate:${packageName}`);
            tags.add(tag);
        }
        const link = response.headers.get('link');
        next = null;
        if (link)
        {
            const match = /^<([^>]+)>;\s*rel="next"$/.exec(link);
            if (!match) throw new Error('docker_tag_next_link_invalid');
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

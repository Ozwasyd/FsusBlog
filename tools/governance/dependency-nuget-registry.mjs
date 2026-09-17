function registryUrl(value, inlineIdentity = false)
{
    const url = new URL(value);
    if (url.origin !== 'https://api.nuget.org' || url.username || url.password || (url.hash && !inlineIdentity))
    {
        throw new Error('nuget_registry_url_invalid');
    }
    return url.href;
}

/** Resolve the latest listed stable release, excluding explicitly unlisted package versions. */
export async function readLatestNuget(packageName, fetchJson)
{
    if (!/^[A-Za-z0-9_.-]+$/.test(packageName))
    {
        throw new Error('nuget_package_id_invalid');
    }
    const id = packageName.toLowerCase();
    const versions = await fetchJson(`https://api.nuget.org/v3-flatcontainer/${id}/index.json`);
    if (!Array.isArray(versions?.versions) || versions.versions.some((version) => typeof version !== 'string'))
    {
        throw new Error('nuget_versions_invalid');
    }
    const stableVersions = versions.versions.filter((version) => !version.includes('-')).reverse();
    if (!stableVersions.length)
    {
        throw new Error('nuget_latest_missing');
    }
    const service = await fetchJson('https://api.nuget.org/v3/index.json');
    const resources = service.resources?.filter((resource) => resource['@type'] === 'RegistrationsBaseUrl/3.6.0');
    if (resources?.length !== 1)
    {
        throw new Error('nuget_registration_resource_ambiguous');
    }
    const base = registryUrl(resources[0]['@id']);
    const registration = await fetchJson(registryUrl(`${base.replace(/\/$/, '')}/${id}/index.json`));
    if (!Array.isArray(registration.items) || registration.items.length > 100
        || registration.count !== registration.items.length)
    {
        throw new Error('nuget_registration_pages_invalid');
    }
    const entries = [];
    const seen = new Set();
    for (const page of registration.items)
    {
        const pageUrl = registryUrl(page['@id'], Array.isArray(page.items));
        if (seen.has(pageUrl))
        {
            throw new Error('nuget_registration_page_duplicate');
        }
        seen.add(pageUrl);
        const content = Array.isArray(page.items) ? page : await fetchJson(pageUrl);
        if (!Array.isArray(content.items) || content.items.length !== page.count || content.count !== page.count)
        {
            throw new Error('nuget_registration_page_incomplete');
        }
        for (const leaf of content.items)
        {
            const entry = leaf.catalogEntry;
            if (!entry || typeof entry !== 'object' || typeof entry.version !== 'string'
                || typeof entry.id !== 'string' || entry.id.toLowerCase() !== id)
            {
                throw new Error('nuget_registration_entry_invalid');
            }
            entries.push(entry);
        }
    }
    for (const latestStable of stableVersions)
    {
        const matches = entries.filter((entry) => entry.version.toLowerCase() === latestStable.toLowerCase());
        if (matches.length !== 1)
        {
            throw new Error('nuget_publication_missing_or_ambiguous');
        }
        if (matches[0].listed === false)
        {
            continue;
        }
        const published = matches[0].published;
        if (typeof published !== 'string' || !Number.isFinite(Date.parse(published)) || new Date(published).getUTCFullYear() <= 1900)
        {
            throw new Error('nuget_publication_missing_or_ambiguous');
        }
        return { latestStable, releasedAt: new Date(published).toISOString() };
    }
    throw new Error('nuget_listed_stable_missing');
}

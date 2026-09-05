const metadataRoot = 'https://builds.dotnet.microsoft.com/dotnet/release-metadata';
const stableVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Read the SDK target and its actual release date from Microsoft's release metadata. */
export async function readLatestDotnetSdk(fetchJson)
{
    const index = await fetchJson(`${metadataRoot}/releases-index.json`);
    if (!Array.isArray(index?.['releases-index']))
    {
        throw new Error('dotnet_release_index_invalid');
    }
    const candidates = index['releases-index'].filter((entry) => stableVersion.test(entry['latest-sdk'] ?? ''));
    candidates.sort((left, right) => {
        const a = left['latest-sdk'].split('.').map(Number);
        const b = right['latest-sdk'].split('.').map(Number);
        return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
    });
    const selected = candidates[0];
    if (!selected || !/^[0-9]+\.[0-9]+$/.test(selected['channel-version'] ?? '')
        || !selected['latest-sdk'].startsWith(`${selected['channel-version']}.`)
        || candidates.filter((entry) => entry['latest-sdk'] === selected['latest-sdk']).length !== 1)
    {
        throw new Error('dotnet_latest_sdk_missing_or_ambiguous');
    }
    const latestStable = selected['latest-sdk'];
    const channel = await fetchJson(`${metadataRoot}/${selected['channel-version']}/releases.json`);
    if (!Array.isArray(channel?.releases) || channel['channel-version'] !== selected['channel-version'])
    {
        throw new Error('dotnet_release_channel_invalid');
    }
    const matching = channel.releases.filter((release) => release.sdk?.version === latestStable
        || (Array.isArray(release.sdks) && release.sdks.some((sdk) => sdk.version === latestStable)));
    const dates = [...new Set(matching.map((release) => release['release-date']))];
    const date = dates[0];
    if (dates.length !== 1 || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)
    {
        throw new Error('dotnet_sdk_release_date_missing_or_ambiguous');
    }
    return { latestStable, releasedAt: new Date(date).toISOString() };
}

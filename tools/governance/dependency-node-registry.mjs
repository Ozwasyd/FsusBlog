import { registryRelease } from './dependency-registry-release.mjs';

export async function readLatestNode(fetchJson)
{
    const releases = await fetchJson('https://nodejs.org/dist/index.json');
    if (!Array.isArray(releases)) throw new Error('node_registry_index_invalid');
    const candidates = releases.filter(release => /^v\d+\.\d+\.\d+$/u.test(release?.version ?? ''));
    candidates.sort((left, right) => {
        const a = left.version.slice(1).split('.').map(BigInt);
        const b = right.version.slice(1).split('.').map(BigInt);
        for (let index = 0; index < a.length; index += 1)
        {
            if (a[index] !== b[index]) return a[index] > b[index] ? -1 : 1;
        }
        return 0;
    });
    const latest = candidates[0];
    if (!latest) throw new Error('node_registry_stable_release_missing');
    if (candidates.filter(release => release.version === latest.version).length !== 1)
    {
        throw new Error('node_registry_latest_release_ambiguous');
    }
    return registryRelease(latest.version.slice(1), latest.date, 'node-version:node');
}

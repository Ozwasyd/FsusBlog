/** Preserve the freshness producer's PR matching semantics for all consumers. */
export function parseRenovatePullRequests(pulls, catalog)
{
    const items = catalog.items ?? [];
    return pulls.flatMap((pull) => {
        if (pull.user?.login !== 'renovate[bot]' && pull.user?.type !== 'Bot')
        {
            return [];
        }
        return items.flatMap((item) => {
            const mentionsPackage = `${pull.title ?? ''} ${pull.body ?? ''}`.includes(item.packageName);
            const versionMatch = /to (?:v)?(\S+)/u.exec(pull.title ?? '');
            if (!mentionsPackage || !versionMatch)
            {
                return [];
            }
            return [{
                number: pull.number,
                state: pull.state,
                dependencyId: item.id,
                packageName: item.packageName,
                group: item.group,
                targetVersion: versionMatch[1]
            }];
        });
    });
}

/** Never evaluate freshness from the first page of a larger open-PR set. */
export async function readFreshnessPullPages(readPage)
{
    const pulls = [];
    const seen = new Set();
    for (let page = 1; page <= 100; page++)
    {
        const batch = await readPage(page);
        if (!Array.isArray(batch) || batch.length > 100)
        {
            throw new Error('github pull request payload is not a complete page');
        }
        for (const pull of batch)
        {
            if (!Number.isSafeInteger(pull?.number) || pull.number <= 0 || seen.has(pull.number))
            {
                throw new Error('github pull request pages contain invalid or repeated identities');
            }
            seen.add(pull.number);
            pulls.push(pull);
        }
        if (batch.length < 100)
        {
            return pulls;
        }
    }
    throw new Error('github pull request pagination limit reached');
}

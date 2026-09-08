import { updateTypes } from './dependency-required-checks.mjs';

function plainCell(value)
{
    return value.replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replaceAll('`', '').trim();
}

function declaredUpdates(body)
{
    const rows = [];
    let headers;
    for (const line of String(body ?? '').split(/\r?\n/u))
    {
        if (!line.trim().startsWith('|') || !line.trim().endsWith('|'))
        {
            headers = undefined;
            continue;
        }
        const cells = line.trim().slice(1, -1).split('|').map(plainCell);
        if (cells.includes('Package') && cells.includes('Update'))
        {
            headers = cells;
            continue;
        }
        if (!headers || cells.length !== headers.length || cells.every((cell) => /^:?-+:?$/u.test(cell)))
        {
            continue;
        }
        const row = Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
        rows.push({
            packageName: row.Package,
            updateType: row.Update,
            targetVersion: row['New value'] ?? row.Change?.split('→').at(-1)?.trim()
        });
    }
    return rows;
}

function declaredTitleUpdate(title)
{
    const match = /^Update (?:dependency )?(.+?) to (?:v)?(\S+)$/u.exec(String(title ?? ''));
    return match ? { packageName: match[1], targetVersion: match[2] } : undefined;
}

/** Read producer-declared table metadata; freshness evaluation remains owned by evaluateFreshness. */
export function parseRenovatePullRequests(pulls, catalog)
{
    const items = catalog.items ?? [];
    return pulls.flatMap((pull) => {
        if (pull.user?.login !== 'renovate[bot]')
        {
            return [];
        }
        const updates = declaredUpdates(pull.body);
        const titleUpdate = updates.length === 0 ? declaredTitleUpdate(pull.title) : undefined;
        return items.flatMap((item) => {
            const declared = updates.filter((update) => update.packageName === item.packageName);
            if (declared.length > 0)
            {
                const identities = new Set(declared.map((update) => JSON.stringify([update.updateType, update.targetVersion])));
                if (identities.size !== 1 || ![...updateTypes, 'pin'].includes(declared[0].updateType)
                    || !declared[0].targetVersion)
                {
                    throw new Error(`dependency_pull_ambiguous_update:${pull.number}:${item.id}`);
                }
            }
            const targetVersion = declared[0]?.targetVersion
                ?? (titleUpdate?.packageName === item.packageName ? titleUpdate.targetVersion : undefined);
            if (!targetVersion)
            {
                return [];
            }
            return [{
                number: pull.number,
                state: pull.state,
                dependencyId: item.id,
                packageName: item.packageName,
                group: item.group,
                targetVersion,
                ...(declared.length > 0 ? { updateType: declared[0].updateType } : {}),
                ...(pull.head?.sha ? { headSha: pull.head.sha } : {})
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

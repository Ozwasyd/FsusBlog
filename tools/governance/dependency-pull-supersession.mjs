import { parseRenovatePullRequests } from './dependency-freshness-pulls.mjs';

function references(body, heading)
{
    const expression = new RegExp(`^\\s*${heading}:?\\s+#([1-9][0-9]*)\\s*$`, 'gimu');
    const numbers = [...String(body ?? '').matchAll(expression)].map((match) => Number(match[1]));
    if (numbers.some((number) => !Number.isSafeInteger(number)) || new Set(numbers).size !== numbers.length)
    {
        throw new Error('dependency_supersession_invalid_reference');
    }
    return numbers;
}

/** Only explicit reciprocal PR references establish supersession, never package-name coincidence. */
export async function collectDependencySupersession({ pulls, catalog, readPullRequest })
{
    const records = new Map();
    const pending = pulls.filter((pull) => parseRenovatePullRequests([pull], catalog).length > 0);
    while (pending.length > 0)
    {
        const pull = pending.shift();
        if (!Number.isSafeInteger(pull?.number) || pull.number <= 0)
        {
            throw new Error('dependency_supersession_invalid_pull');
        }
        if (records.has(pull.number))
        {
            continue;
        }
        const supersedes = references(pull.body, 'Supersedes');
        const supersededBy = references(pull.body, 'Superseded by');
        if (supersededBy.length > 1)
        {
            throw new Error('dependency_supersession_multiple_successors');
        }
        records.set(pull.number, { pull, supersedes, supersededBy });
        for (const number of [...supersedes, ...supersededBy])
        {
            if (number === pull.number)
            {
                throw new Error('dependency_supersession_cycle');
            }
            if (!records.has(number) && !pending.some((item) => item.number === number))
            {
                if (records.size + pending.length >= pulls.length + 100)
                {
                    throw new Error('dependency_supersession_reference_limit');
                }
                const linked = await readPullRequest(number);
                if (linked?.number !== number)
                {
                    throw new Error('dependency_supersession_target_mismatch');
                }
                pending.push(linked);
            }
        }
    }
    const mappings = new Map([...records].map(([number, record]) => [number, parseRenovatePullRequests([record.pull], catalog)]));
    const relations = [];
    for (const [number, record] of records)
    {
        for (const successor of record.supersededBy)
        {
            if (!records.get(successor)?.supersedes.includes(number))
            {
                throw new Error('dependency_supersession_missing_backlink');
            }
        }
        for (const predecessor of record.supersedes)
        {
            if (!records.get(predecessor)?.supersededBy.includes(number))
            {
                throw new Error('dependency_supersession_missing_backlink');
            }
            const shared = mappings.get(number).filter((item) => mappings.get(predecessor).some((old) => old.dependencyId === item.dependencyId));
            if (shared.length === 0)
            {
                throw new Error('dependency_supersession_dependency_mismatch');
            }
            for (const item of shared)
            {
                relations.push({ dependencyId: item.dependencyId, predecessor, successor: number });
            }
        }
        const visited = new Set([number]);
        let next = record.supersededBy[0];
        while (next !== undefined)
        {
            if (visited.has(next))
            {
                throw new Error('dependency_supersession_cycle');
            }
            visited.add(next);
            next = records.get(next)?.supersededBy[0];
        }
    }
    relations.sort((left, right) => left.dependencyId < right.dependencyId ? -1 : left.dependencyId > right.dependencyId ? 1 : left.predecessor - right.predecessor);
    return { pullRequests: [...mappings.values()].flat(), relations };
}

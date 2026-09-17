export function resolveAutoBalancedCpuSets({ visibleCpus, physicalCoreGroups, numaNodes = [], topologyMode })
{
    const visible = normalizeCpuList(visibleCpus, 'visibleCpus');
    if (visible.length < 2)
    {
        throw new Error('auto-balanced isolation requires at least two visible CPUs');
    }

    const visibleSet = new Set(visible);
    const coreGroups = normalizeGroups(physicalCoreGroups, visibleSet, true);
    if (topologyMode === 'physical-core-only')
    {
        const representatives = coreGroups.map((group) => group[0]);
        if (representatives.length < 2)
        {
            throw new Error('physical-core-only isolation requires at least two visible physical cores');
        }
        return splitCpuGroups(representatives.map((cpu) => [cpu]));
    }

    if (topologyMode === 'numa-local')
    {
        const nodes = normalizeGroups(numaNodes, visibleSet, false);
        if (nodes.length >= 2)
        {
            return {
                targetCpus: nodes[0],
                loadGeneratorCpus: nodes.slice(1).flat()
            };
        }
        const localCpus = nodes[0] ?? visible;
        const localSet = new Set(localCpus);
        const localCoreGroups = coreGroups
            .map((group) => group.filter((cpu) => localSet.has(cpu)))
            .filter((group) => group.length > 0);
        if (localCoreGroups.length < 2)
        {
            throw new Error('numa-local isolation requires two disjoint physical-core groups inside one visible NUMA node');
        }
        return splitCpuGroups(localCoreGroups);
    }

    if (topologyMode !== 'smt-visible')
    {
        throw new Error(`unsupported topology mode: ${topologyMode}`);
    }
    return splitCpuGroups(coreGroups);
}

function splitCpuGroups(groups)
{
    if (groups.length < 2)
    {
        throw new Error('auto-balanced isolation requires at least two disjoint CPU groups');
    }
    const targetGroupCount = Math.max(1, Math.floor(groups.length / 2));
    const targetCpus = groups.slice(0, targetGroupCount).flat();
    const loadGeneratorCpus = groups.slice(targetGroupCount).flat();
    if (targetCpus.length === 0 || loadGeneratorCpus.length === 0)
    {
        throw new Error('auto-balanced isolation could not produce disjoint target and load-generator CPUs');
    }
    return { targetCpus, loadGeneratorCpus };
}

function normalizeGroups(groups, visibleSet, fillMissing)
{
    if (!Array.isArray(groups))
    {
        return fillMissing ? [...visibleSet].map((cpu) => [cpu]) : [];
    }
    const normalized = groups
        .map((group) => normalizeCpuList(group, 'CPU group').filter((cpu) => visibleSet.has(cpu)))
        .filter((group) => group.length > 0);
    const covered = new Set(normalized.flat());
    if (fillMissing)
    {
        for (const cpu of visibleSet)
        {
            if (!covered.has(cpu))
            {
                normalized.push([cpu]);
            }
        }
    }
    return normalized;
}

function normalizeCpuList(cpus, label)
{
    if (!Array.isArray(cpus) || cpus.some((cpu) => !Number.isInteger(cpu) || cpu < 0))
    {
        throw new Error(`${label} must contain non-negative CPU indexes`);
    }
    return [...new Set(cpus)].sort((left, right) => left - right);
}

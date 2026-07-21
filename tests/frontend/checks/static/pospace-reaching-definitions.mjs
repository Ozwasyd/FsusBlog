import { functionOwner } from './pospace-control-flow-writes.mjs';

export function createPoSpaceReachingDefinitions(ts)
{
    function reachingValues(initial, writes, useNode)
    {
        let values = [...initial];
        let initialReaches = true;
        const owner = functionOwner(ts, useNode);
        const candidates = [...(writes ?? [])]
            .filter(candidate => candidate.node.pos < useNode.pos && candidate.owner === owner)
            .sort((left, right) => left.node.pos - right.node.pos);
        const completeGroups = completeControlGroups(candidates);
        const processedGroups = new Set();
        for (const write of candidates)
        {
            if (completeGroups.has(write.controlGroup))
            {
                if (!processedGroups.has(write.controlGroup))
                {
                    const definitions = candidates.filter(candidate => candidate.controlGroup === write.controlGroup);
                    initialReaches = false;
                    values = definitions.flatMap(definition => definition.value ? [definition.value] : []);
                    processedGroups.add(write.controlGroup);
                }
                continue;
            }
            if (write.conditional || !write.kills)
            {
                if (write.value)
                {
                    values.push(write.value);
                }
                continue;
            }
            initialReaches = false;
            values = write.value ? [write.value] : [];
        }
        return { initialReaches, values };
    }

    function completeControlGroups(writes)
    {
        const groups = new Map();
        for (const write of writes.filter(candidate => candidate.controlGroup && candidate.kills))
        {
            const arms = groups.get(write.controlGroup) ?? new Set();
            arms.add(write.controlArm);
            groups.set(write.controlGroup, arms);
        }
        return new Set([...groups]
            .filter(([group, arms]) => ts.isIfStatement(group)
                ? arms.has('then') && arms.has('else')
                : arms.has('try') && arms.has('catch'))
            .map(([group]) => group));
    }

    return { reachingValues };
}

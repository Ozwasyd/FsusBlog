import { types } from 'node:util';

const { canonicalJson, digestCanonical, sealContentDigest } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));

export function requireFact(condition, message)
{
    if (!condition)
    {
        throw new Error(`atomic failure projection: ${message}`);
    }
}

/** Admit detached bounded JSON data, never producer authentication or policy. */
export function admitMaterial(value, limits)
{
    requireFact(limits && ['maxDepth', 'maxNodes', 'maxBytes', 'maxItems'].every((key) =>
        Number.isSafeInteger(limits[key]) && limits[key] > 0), 'explicit host limits are required');
    const pending = [{ value, depth: 0 }];
    const seen = new WeakSet();
    let nodes = 0;
    let items = 0;
    let bytes = 0;
    while (pending.length)
    {
        const entry = pending.pop();
        if (entry.exit)
        {
            seen.delete(entry.value);
            continue;
        }
        nodes += 1;
        requireFact(nodes <= limits.maxNodes && entry.depth <= limits.maxDepth, 'JSON node/depth limit exceeded');
        const current = entry.value;
        if (current === null || typeof current === 'boolean' || typeof current === 'number')
        {
            requireFact(typeof current !== 'number' || Number.isFinite(current), 'non-finite JSON number');
            bytes += 8;
        }
        else if (typeof current === 'string')
        {
            bytes += Buffer.byteLength(current) * 6 + 2;
        }
        else
        {
            requireFact(typeof current === 'object' && !types.isProxy(current), 'plain JSON data required');
            requireFact(!seen.has(current), 'cyclic input is not JSON material');
            seen.add(current);
            pending.push({ value: current, exit: true });
            const array = Array.isArray(current);
            requireFact(Object.getPrototypeOf(current) === (array ? Array.prototype : Object.prototype),
                'special JSON object rejected');
            if (array)
            {
                requireFact(current.length <= limits.maxItems - items, 'JSON item limit exceeded');
            }
            const keys = Reflect.ownKeys(current).filter((key) => !array || key !== 'length');
            requireFact(!array || keys.length === current.length, 'sparse or extended JSON array');
            items += keys.length;
            requireFact(items <= limits.maxItems && nodes + pending.length + keys.length <= limits.maxNodes,
                'JSON item/node limit exceeded');
            bytes += 2;
            for (const key of keys)
            {
                const descriptor = Object.getOwnPropertyDescriptor(current, key);
                requireFact(typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value'),
                    'hidden/accessor/symbol JSON property rejected');
                bytes += Buffer.byteLength(key) * 6 + 4;
                pending.push({ value: descriptor.value, depth: entry.depth + 1 });
            }
        }
        requireFact(bytes <= limits.maxBytes, 'JSON byte limit exceeded');
    }
    return structuredClone(value);
}

export function exactFields(value, fields, label)
{
    requireFact(value && !Array.isArray(value) && canonicalJson(Object.keys(value).sort())
        === canonicalJson([...fields].sort()), `${label} fields must be exact`);
}

export function sameFact(actual, expected, label)
{
    requireFact(canonicalJson(actual) === canonicalJson(expected), `${label} mismatch`);
}

export function digestFact(value, label)
{
    requireFact(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value), `${label} must be SHA-256`);
}

export function stableIds(values, label)
{
    requireFact(Array.isArray(values) && values.every((value) => typeof value === 'string'
        && /^[a-z][a-z0-9-]*$/u.test(value)) && new Set(values).size === values.length,
    `${label} must be unique semantic IDs`);
    return [...values].sort();
}

export function currentReference(reference, context, label)
{
    exactFields(reference, ['path', 'objectDigest'], label);
    digestFact(reference.objectDigest, label);
    requireFact(typeof reference.path === 'string' && reference.path.startsWith(`.tmp/test-runs/${context.schedulerRunId}/`)
        && reference.path.split('/').every((part) => part && part !== '.' && part !== '..')
        && !/[\\*?[\]{}%\s]/u.test(reference.path)
        && !/(?:^|\/)(?:latest|secrets?|private|credentials?)(?:\/|\.|$)/iu.test(reference.path),
    `${label} must be an explicit privacy-safe current-run reference`);
}

export function freezeMaterial(value)
{
    if (value && typeof value === 'object')
    {
        Object.values(value).forEach(freezeMaterial);
        Object.freeze(value);
    }
    return value;
}

export function sealProjection(value)
{
    return freezeMaterial(sealContentDigest({ ...value, dataOnly: true, verificationStatus: 'unverified' }));
}

/** A display digest detects modification; it confers no execution or evidence authority. */
export function checkProjectionDigest(value)
{
    const { contentDigest, ...unsigned } = value;
    sameFact(contentDigest, digestCanonical(unsigned), 'projection content digest');
    requireFact(value.dataOnly === true && value.verificationStatus === 'unverified', 'projection authority promotion rejected');
}

/** Consume externally extracted compiled facts. This is not an atomic declaration catalog. */
export function checkGraphMaterial(graph)
{
    exactFields(graph, ['graphRef', 'dagDigest', 'nodes'], 'compiled graph material');
    digestFact(graph.dagDigest, 'compiled DAG digest');
    exactFields(graph.graphRef, ['path', 'objectDigest'], 'compiled graph reference');
    digestFact(graph.graphRef.objectDigest, 'compiled graph reference');
    requireFact(typeof graph.graphRef.path === 'string' && graph.graphRef.path.length > 0, 'explicit compiled graph reference required');
    requireFact(Array.isArray(graph.nodes) && graph.nodes.length > 0, 'compiled nodes required');
    stableIds(graph.nodes.map((node) => node.id), 'compiled node IDs');
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const node of graph.nodes)
    {
        exactFields(node, ['id', 'logicalParentId', 'kind', 'evidenceClass', 'dependsOn', 'settledDependsOn',
            'ciJobId', 'stateAccess', 'exclusiveResources'], 'compiled node');
        stableIds([node.logicalParentId], 'logical parent');
        stableIds([node.ciJobId], 'CI job');
        requireFact(['producer', 'hard-prerequisite', 'settled-join', 'finalizer'].includes(node.kind), 'unknown compiled node kind');
        requireFact(['correctness', 'diagnostic', 'coordination'].includes(node.evidenceClass), 'unknown evidence class');
        requireFact(!['settled-join', 'finalizer'].includes(node.kind) || node.evidenceClass === 'coordination',
            'coordination node cannot own correctness evidence');
        const dependencies = [...stableIds(node.dependsOn, 'hard dependencies'), ...stableIds(node.settledDependsOn, 'settled dependencies')];
        requireFact(new Set(dependencies).size === dependencies.length
            && dependencies.every((id) => byId.has(id) && id !== node.id), 'ambiguous/missing/self dependency');
        stableIds(node.exclusiveResources, 'exclusive resources');
        requireFact(Array.isArray(node.stateAccess), 'explicit state access required');
        const domains = new Set();
        for (const access of node.stateAccess)
        {
            exactFields(access, ['domain', 'mode'], 'state access');
            requireFact(typeof access.domain === 'string' && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(access.domain),
                'explicit canonical state domain required');
            requireFact(['read', 'write'].includes(access.mode) && !domains.has(access.domain), 'ambiguous state access');
            domains.add(access.domain);
        }
    }
    const visiting = new Set();
    const done = new Set();
    const visit = (id) =>
    {
        requireFact(!visiting.has(id), 'compiled graph cycle');
        if (done.has(id))
        {
            return;
        }
        visiting.add(id);
        const node = byId.get(id);
        [...node.dependsOn, ...node.settledDependsOn].forEach(visit);
        visiting.delete(id);
        done.add(id);
    };
    [...byId.keys()].forEach(visit);
    for (const node of graph.nodes)
    {
        requireFact(![...node.dependsOn, ...node.settledDependsOn].some((id) => byId.get(id).kind === 'finalizer'),
            'finalizer cannot unlock downstream work');
    }
    return byId;
}

export function hardFailureRoots(id, byId, states)
{
    const roots = new Set();
    const visit = (current) =>
    {
        for (const dependency of byId.get(current).dependsOn)
        {
            const state = states.get(dependency);
            if (state === 'blocked')
            {
                visit(dependency);
            }
            else if (state !== 'success')
            {
                roots.add(dependency);
            }
        }
    };
    visit(id);
    return [...roots].sort();
}

export function replayConflict(left, right, byId)
{
    const ancestors = (id, target) => [...byId.get(id).dependsOn, ...byId.get(id).settledDependsOn]
        .some((dependency) => dependency === target || ancestors(dependency, target));
    if (ancestors(left.id, right.id) || ancestors(right.id, left.id))
    {
        return true;
    }
    if (left.exclusiveResources.some((resource) => right.exclusiveResources.includes(resource)))
    {
        return true;
    }
    return left.stateAccess.some((access) => right.stateAccess.some((other) => access.domain === other.domain
        && (access.mode === 'write' || other.mode === 'write')));
}

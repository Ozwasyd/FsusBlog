import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const productionDiskDemandCatalogSchema = 'fsusblog.production-disk-demand-catalog.v1';
export const productionDiskDemandPlanSchema = 'fsusblog.production-disk-demand-plan.v1';

const byteFields = Object.freeze([
    'peakAdditionalBytes',
    'terminalRetainedBytes',
    'rollbackOrRecoveryBytes',
    'uncertaintyBytes'
]);

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

export function productionDiskDemandDigest(value)
{
    return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

function nearestExistingPath(candidate, {
    lstat = fs.lstatSync,
    realpath = fs.realpathSync.native
} = {})
{
    let current = path.resolve(candidate);
    while (true)
    {
        try
        {
            lstat(current);
            break;
        }
        catch (error)
        {
            if (!['ENOENT', 'ENOTDIR'].includes(error?.code))
            {
                throw error;
            }
        }
        const parent = path.dirname(current);
        if (parent === current)
        {
            throw new Error(`filesystem identity cannot resolve an existing ancestor for ${candidate}`);
        }
        current = parent;
    }
    return realpath(current);
}

export function canonicalFilesystemIdentity(candidate, {
    lstat = fs.lstatSync,
    realpath = fs.realpathSync.native,
    stat = fs.statSync,
    statfs = fs.statfsSync,
    platform = process.platform
} = {})
{
    const canonicalPath = nearestExistingPath(candidate, { lstat, realpath });
    const metadata = stat(canonicalPath);
    const filesystem = statfs(canonicalPath);
    const device = metadata.dev;
    if (device === undefined || device === null || !Number.isFinite(Number(device)))
    {
        throw new Error(`filesystem identity is unknown for ${candidate}`);
    }
    const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    if (!Number.isSafeInteger(availableBytes) || availableBytes < 0)
    {
        throw new Error(`filesystem available capacity is unknown for ${candidate}`);
    }
    if (filesystem.type === undefined || filesystem.type === null || String(filesystem.type) === '')
    {
        throw new Error(`filesystem type is unknown for ${candidate}`);
    }
    const filesystemType = String(filesystem.type);
    return {
        filesystemIdentity: `${platform}:device:${String(device)}:type:${filesystemType}`,
        canonicalPath,
        availableBytes
    };
}

export function remeasureProductionFilesystemAvailability(filesystem, {
    resolveFilesystem = canonicalFilesystemIdentity
} = {})
{
    if (typeof filesystem?.filesystemIdentity !== 'string' || !filesystem.filesystemIdentity)
    {
        throw new Error('Production capacity expected filesystem identity is missing');
    }
    if (!Array.isArray(filesystem.canonicalPaths) || filesystem.canonicalPaths.length === 0)
    {
        throw new Error(`Production capacity paths are missing for ${filesystem.filesystemIdentity}`);
    }
    let availableBytes = Number.POSITIVE_INFINITY;
    for (const recordedPath of filesystem.canonicalPaths)
    {
        if (typeof recordedPath !== 'string' || !recordedPath)
        {
            throw new Error(`Production capacity path is invalid for ${filesystem.filesystemIdentity}`);
        }
        const current = resolveFilesystem(recordedPath);
        if (current?.filesystemIdentity !== filesystem.filesystemIdentity)
        {
            throw new Error(
                `Production capacity filesystem identity drifted for ${recordedPath}:`
        + ` expected=${filesystem.filesystemIdentity}`
        + ` actual=${current?.filesystemIdentity ?? 'unknown'}`
            );
        }
        if (!Number.isSafeInteger(current.availableBytes) || current.availableBytes < 0)
        {
            throw new Error(`Production capacity is unknown for ${filesystem.filesystemIdentity}`);
        }
        availableBytes = Math.min(availableBytes, current.availableBytes);
    }
    if (!Number.isSafeInteger(availableBytes) || availableBytes < 0)
    {
        throw new Error(`Production capacity is unknown for ${filesystem.filesystemIdentity}`);
    }
    return availableBytes;
}

function validateCatalog(catalog)
{
    if (catalog?.schema !== productionDiskDemandCatalogSchema)
    {
        throw new Error('Production disk demand catalog schema is invalid');
    }
    if (!Number.isSafeInteger(catalog.safetyBytes) || catalog.safetyBytes <= 0)
    {
        throw new Error('Production disk demand catalog safetyBytes must be positive');
    }
    if (typeof catalog.estimatorVersion !== 'string' || !catalog.estimatorVersion)
    {
        throw new Error('Production disk demand estimatorVersion is required');
    }
    if (!catalog.rootBindings || typeof catalog.rootBindings !== 'object')
    {
        throw new Error('Production disk demand root bindings are required');
    }
    const producerIds = new Set();
    for (const producer of catalog.producers ?? [])
    {
        if (typeof producer.producerId !== 'string' || !producer.producerId || producerIds.has(producer.producerId))
        {
            throw new Error(`Production disk demand producer identity is invalid: ${producer?.producerId ?? '<missing>'}`);
        }
        producerIds.add(producer.producerId);
        if (!Array.isArray(producer.demands) || producer.demands.length === 0)
        {
            throw new Error(`Production disk demand producer has no declarations: ${producer.producerId}`);
        }
        const roots = new Set();
        for (const demand of producer.demands)
        {
            if (!Object.hasOwn(catalog.rootBindings, demand.rootId) || roots.has(demand.rootId))
            {
                throw new Error(`Production disk demand root declaration is invalid: ${producer.producerId}/${demand.rootId}`);
            }
            roots.add(demand.rootId);
            for (const field of byteFields)
            {
                if (!Number.isSafeInteger(demand[field]) || demand[field] < 0)
                {
                    throw new Error(`Production disk demand ${producer.producerId}/${demand.rootId}.${field} is invalid`);
                }
            }
            if (demand.peakAdditionalBytes <= 0 || demand.uncertaintyBytes <= 0)
            {
                throw new Error(`Production disk demand ${producer.producerId}/${demand.rootId} must declare measured growth and uncertainty`);
            }
            if (typeof demand.concurrencyClass !== 'string' || !demand.concurrencyClass
        || typeof demand.sourceOfEstimate !== 'string' || !demand.sourceOfEstimate)
            {
                throw new Error(`Production disk demand ${producer.producerId}/${demand.rootId} lacks estimator provenance`);
            }
            if (producer.producerId === 'behavior-doc-static-admission'
        && demand.reusePolicy !== 'reserve-worst-case-on-cache-hit-and-cache-miss')
            {
                throw new Error(
                    `Production disk demand ${producer.producerId}/${demand.rootId} cache reuse policy drifted`);
            }
        }
    }
    return catalog;
}

export function readProductionDiskDemandCatalog(root, {
    file = path.join(root, 'config/testing/production-disk-demand.json')
} = {})
{
    return validateCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function dependencyClosure(tiers)
{
    const byId = new Map(tiers.map((tier) => [tier.id, tier]));
    const ancestors = new Map();
    const visit = (id, trail = new Set()) =>
    {
        if (ancestors.has(id))
        {
            return ancestors.get(id);
        }
        if (trail.has(id))
        {
            throw new Error(`Production disk demand DAG contains a cycle at ${id}`);
        }
        const nextTrail = new Set(trail).add(id);
        const result = new Set();
        for (const dependency of byId.get(id)?.executionDependsOn ?? [])
        {
            // A caller may enumerate only the currently ready frontier; dependencies
            // outside that frontier are already complete and cannot overlap it.
            if (!byId.has(dependency))
            {
                continue;
            }
            result.add(dependency);
            for (const ancestor of visit(dependency, nextTrail))
            {
                result.add(ancestor);
            }
        }
        ancestors.set(id, result);
        return result;
    };
    for (const { id } of tiers)
    {
        visit(id);
    }
    return ancestors;
}

function canOverlap(left, right, ancestors)
{
    if (ancestors.get(left.id).has(right.id) || ancestors.get(right.id).has(left.id))
    {
        return false;
    }
    const rightExclusive = new Set(right.exclusiveResources ?? []);
    return !(left.exclusiveResources ?? []).some((resource) => rightExclusive.has(resource));
}

function enumerateConcurrentSets(tiers, maxParallel)
{
    const ancestors = dependencyClosure(tiers);
    const sets = [];
    const visit = (index, selected) =>
    {
        if (selected.length > 0)
        {
            sets.push([...selected]);
        }
        if (selected.length >= maxParallel)
        {
            return;
        }
        for (let candidateIndex = index; candidateIndex < tiers.length; candidateIndex += 1)
        {
            const candidate = tiers[candidateIndex];
            if (selected.every((current) => canOverlap(current, candidate, ancestors)))
            {
                selected.push(candidate);
                visit(candidateIndex + 1, selected);
                selected.pop();
            }
        }
    };
    visit(0, []);
    return sets;
}

function sumDemand(demands, field)
{
    return demands.reduce((total, demand) => total + demand[field], 0);
}

function calculateProductionDiskPeakByGroup({
    tiers,
    declarationsByProducer,
    maxParallel = tiers.length,
    groupForDemand
})
{
    const peakByGroup = new Map();
    const states = [];
    const visited = new Set();
    const visit = (completed) =>
    {
        const key = [...completed].sort().join('\0');
        if (visited.has(key))
        {
            return;
        }
        visited.add(key);
        states.push(new Set(completed));
        const ready = tiers.filter((tier) => (
            !completed.has(tier.id)
      && (tier.executionDependsOn ?? []).every((dependency) => completed.has(dependency))
        ));
        for (const tier of ready)
        {
            visit(new Set(completed).add(tier.id));
        }
    };
    visit(new Set());
    for (const completed of states)
    {
        const ready = tiers.filter((tier) => (
            !completed.has(tier.id)
      && (tier.executionDependsOn ?? []).every((dependency) => completed.has(dependency))
        ));
        const liveSets = [[], ...enumerateConcurrentSets(ready, Math.max(1, maxParallel))];
        for (const liveSet of liveSets)
        {
            const byGroup = new Map();
            for (const producerId of completed)
            {
                for (const demand of declarationsByProducer.get(producerId) ?? [])
                {
                    const group = groupForDemand(demand);
                    if (typeof group !== 'string' || !group)
                    {
                        throw new Error(`Production disk demand group is missing for ${producerId}/${demand.rootId}`);
                    }
                    const values = byGroup.get(group) ?? { completed: [], live: [] };
                    values.completed.push(demand);
                    byGroup.set(group, values);
                }
            }
            for (const tier of liveSet)
            {
                for (const demand of declarationsByProducer.get(tier.id) ?? [])
                {
                    const group = groupForDemand(demand);
                    if (typeof group !== 'string' || !group)
                    {
                        throw new Error(`Production disk demand group is missing for ${tier.id}/${demand.rootId}`);
                    }
                    const values = byGroup.get(group) ?? { completed: [], live: [] };
                    values.live.push(demand);
                    byGroup.set(group, values);
                }
            }
            for (const [group, demands] of byGroup)
            {
                const retainedBytes = sumDemand(demands.completed, 'terminalRetainedBytes');
                const liveBytes = sumDemand(demands.live, 'peakAdditionalBytes')
          + sumDemand(demands.live, 'rollbackOrRecoveryBytes')
          + sumDemand(demands.live, 'uncertaintyBytes');
                const requestedBytes = retainedBytes + liveBytes;
                peakByGroup.set(group, Math.max(peakByGroup.get(group) ?? 0, requestedBytes));
            }
        }
    }
    return peakByGroup;
}

export function calculateProductionDiskPeak({
    tiers,
    declarationsByProducer,
    maxParallel = tiers.length
})
{
    return calculateProductionDiskPeakByGroup({
        tiers,
        declarationsByProducer,
        maxParallel,
        groupForDemand: (demand) => demand.rootId
    });
}

function calculateProductionFilesystemPeak({
    tiers,
    declarationsByProducer,
    filesystemByRootId,
    maxParallel = tiers.length
})
{
    return calculateProductionDiskPeakByGroup({
        tiers,
        declarationsByProducer,
        maxParallel,
        groupForDemand: (demand) => filesystemByRootId.get(demand.rootId)
    });
}

export function defaultProductionDiskRoots(root, {
    resolveDockerRoot = null,
    includeDockerStorage = true,
    outputRoot = path.join(root, '.tmp', 'production-fresh-outputs'),
    buildRoot = path.join(root, '.tmp', 'build'),
    dependencyCacheRoot = path.join(root, '.tmp', 'dependency-cache'),
    behaviorDocContractBuildCacheRoot = path.join(root, '.tmp', 'behavior-doc-contract-builds'),
    behaviorDocObservationRoot = path.join(root, '.tmp', 'contracts')
} = {})
{
    let dockerStorageRoot = null;
    if (includeDockerStorage)
    {
        try
        {
            dockerStorageRoot = resolveDockerRoot?.();
        }
        catch (error)
        {
            throw new Error(`Docker filesystem identity is unavailable: ${error.message}`, { cause: error });
        }
        if (!dockerStorageRoot)
        {
            throw new Error('Docker filesystem identity is unavailable');
        }
    }
    return {
        behaviorDocContractBuildCacheRoot,
        behaviorDocObservationRoot,
        productionFreshOutputRoot: outputRoot,
        productionBuildRoot: buildRoot,
        osTempRoot: os.tmpdir(),
        ...(includeDockerStorage ? { dockerStorageRoot } : {}),
        dependencyCacheRoot
    };
}

export function buildProductionDiskDemandPlan({
    root,
    tiers,
    roots,
    maxParallel,
    catalog = readProductionDiskDemandCatalog(root),
    resolveFilesystem = canonicalFilesystemIdentity
})
{
    validateCatalog(catalog);
    const catalogById = new Map(catalog.producers.map((producer) => [producer.producerId, producer]));
    const selectedCatalogIds = tiers.map((tier) => tier.physicalBundleId ?? tier.id);
    const projectionResumeTier = tiers.find((tier) => tier.id === 'logical-projection-resume');
    if (projectionResumeTier
    && !/^sha256:[a-f0-9]{64}$/u.test(String(projectionResumeTier.capacityIdentity ?? '')))
    {
        throw new Error('logical-projection-resume capacity identity must bind the checkpoint authority digest');
    }
    if (new Set(selectedCatalogIds).size !== selectedCatalogIds.length
    || selectedCatalogIds.some((id) => !catalogById.has(id)))
    {
        throw new Error(
            `Production disk demand inventory mismatch: selected=${selectedCatalogIds.sort().join(',')} `
      + `catalog=${[...catalogById.keys()].sort().join(',')}`
        );
    }
    const declarationsByProducer = new Map(tiers.map((tier) => [
        tier.id,
        catalogById.get(tier.physicalBundleId ?? tier.id).demands.map((demand) => ({
            ...demand,
            producerId: tier.id,
            estimatorVersion: catalog.estimatorVersion
        }))
    ]));
    const selectedRootIds = new Set(
        [...declarationsByProducer.values()].flat().map((demand) => demand.rootId));
    const rootResolutions = Object.entries(catalog.rootBindings)
        .filter(([rootId]) => selectedRootIds.has(rootId))
        .map(([rootId, binding]) =>
        {
            const target = roots?.[binding];
            if (!target)
            {
                throw new Error(`Production disk demand root ${rootId} cannot be resolved`);
            }
            return { rootId, binding, target, ...resolveFilesystem(target) };
        });
    const filesystemByRootId = new Map(rootResolutions.map((resolution) => [
        resolution.rootId,
        resolution.filesystemIdentity
    ]));
    const peakByRootId = calculateProductionDiskPeak({ tiers, declarationsByProducer, maxParallel });
    const peakByFilesystem = calculateProductionFilesystemPeak({
        tiers,
        declarationsByProducer,
        filesystemByRootId,
        maxParallel
    });
    const filesystems = new Map();
    for (const resolution of rootResolutions)
    {
        const current = filesystems.get(resolution.filesystemIdentity) ?? {
            filesystemIdentity: resolution.filesystemIdentity,
            canonicalPaths: [],
            rootIds: [],
            observedFreeBytes: resolution.availableBytes,
            requestedBytes: peakByFilesystem.get(resolution.filesystemIdentity) ?? 0,
            safetyBytes: catalog.safetyBytes
        };
        current.canonicalPaths.push(resolution.canonicalPath);
        current.rootIds.push(resolution.rootId);
        current.observedFreeBytes = Math.min(current.observedFreeBytes, resolution.availableBytes);
        filesystems.set(resolution.filesystemIdentity, current);
    }
    const rootDemandPeaks = rootResolutions.map((resolution) => ({
        rootId: resolution.rootId,
        filesystemIdentity: resolution.filesystemIdentity,
        requestedBytes: peakByRootId.get(resolution.rootId) ?? 0
    })).sort((left, right) => left.rootId.localeCompare(right.rootId));
    const producerDeclarations = tiers.flatMap((tier) => declarationsByProducer.get(tier.id));
    const declarationDigest = productionDiskDemandDigest(producerDeclarations);
    const planIdentityPayload = {
        schema: productionDiskDemandPlanSchema,
        producerDeclarationDigest: declarationDigest,
        estimatorVersion: catalog.estimatorVersion,
        maxParallel,
        tiers: tiers.map((tier) => ({
            producerId: tier.id,
            dependsOn: [...(tier.executionDependsOn ?? [])].sort(),
            exclusiveResources: [...(tier.exclusiveResources ?? [])].sort(),
            capacityIdentity: tier.capacityIdentity ?? null
        })),
        filesystems: [...filesystems.values()].map((entry) => ({
            ...entry,
            canonicalPaths: [...new Set(entry.canonicalPaths)].sort(),
            rootIds: [...new Set(entry.rootIds)].sort()
        })).sort((left, right) => left.filesystemIdentity.localeCompare(right.filesystemIdentity)),
        rootDemandPeaks,
        producerDeclarations
    };
    const planDigestPayload = {
        ...planIdentityPayload,
        filesystems: planIdentityPayload.filesystems.map((filesystem) =>
        {
            const entry = { ...filesystem };
            delete entry.observedFreeBytes;
            delete entry.canonicalPaths;
            return entry;
        })
    };
    return {
        ...planIdentityPayload,
        planDigest: productionDiskDemandDigest(planDigestPayload)
    };
}

export function producerRemainingDiskDemand(plan, producerId)
{
    const declarations = plan.producerDeclarations.filter((entry) => entry.producerId === producerId);
    if (declarations.length === 0)
    {
        throw new Error(`Production disk demand declaration is missing for ${producerId}`);
    }
    const byFilesystem = new Map();
    for (const declaration of declarations)
    {
        const filesystem = plan.filesystems.find((entry) => entry.rootIds.includes(declaration.rootId));
        if (!filesystem)
        {
            throw new Error(`Production disk demand filesystem is missing for ${producerId}/${declaration.rootId}`);
        }
        const requestedBytes = declaration.peakAdditionalBytes
      + declaration.rollbackOrRecoveryBytes
      + declaration.uncertaintyBytes;
        byFilesystem.set(filesystem.filesystemIdentity,
            (byFilesystem.get(filesystem.filesystemIdentity) ?? 0) + requestedBytes);
    }
    return byFilesystem;
}

const runtimeModes = new Set(['single', 'static-role', 'adaptive']);
const artifactStorageModes = new Set(['local', 'shared-volume']);
const coordinationStores = new Set(['none', 'redis']);
const clusterScenarios = new Set(['none', 'convergence', 'handoff', 'notification', 'lease']);
const clusterBootstrapStrategies = new Set(['none', 'homogeneous']);
const clusterFixtureKinds = new Set(['shared-postgres', 'shared-redis', 'shared-artifact-storage']);

export const defaultTierTopology = Object.freeze({
    runtimeMode: 'single',
    nodeCount: 1,
    artifactStorage: 'local',
    coordinationStore: 'none',
    clusterScenario: 'none',
    clusterBootstrap: 'none',
    clusterFixtures: Object.freeze([])
});

export function resolveTierTopology(tier = {})
{
    const clusterFixtures = tier.clusterFixtures ?? defaultTierTopology.clusterFixtures;
    return {
        runtimeMode: tier.runtimeMode ?? defaultTierTopology.runtimeMode,
        nodeCount: tier.nodeCount ?? defaultTierTopology.nodeCount,
        artifactStorage: tier.artifactStorage ?? defaultTierTopology.artifactStorage,
        coordinationStore: tier.coordinationStore ?? defaultTierTopology.coordinationStore,
        clusterScenario: tier.clusterScenario ?? defaultTierTopology.clusterScenario,
        clusterBootstrap: tier.clusterBootstrap ?? defaultTierTopology.clusterBootstrap,
        clusterFixtures: Array.isArray(clusterFixtures) ? [...clusterFixtures] : clusterFixtures
    };
}

export function topologyEnvironmentForTier(tier = {})
{
    const topology = resolveTierTopology(tier);
    return {
        FSUSBLOG_TEST_RUNTIME_MODE: topology.runtimeMode,
        FSUSBLOG_TEST_NODE_COUNT: String(topology.nodeCount),
        FSUSBLOG_TEST_ARTIFACT_STORAGE: topology.artifactStorage,
        FSUSBLOG_TEST_COORDINATION_STORE: topology.coordinationStore,
        FSUSBLOG_TEST_CLUSTER_SCENARIO: topology.clusterScenario,
        FSUSBLOG_TEST_CLUSTER_BOOTSTRAP: topology.clusterBootstrap,
        FSUSBLOG_TEST_CLUSTER_FIXTURES: Array.isArray(topology.clusterFixtures) ? topology.clusterFixtures.join(',') : ''
    };
}

export function validateTierTopology(tier = {})
{
    const id = tier.id ?? '<unknown-tier>';
    const topology = resolveTierTopology(tier);
    const errors = [];
    const services = new Set(Array.isArray(tier.services) ? tier.services : []);

    if (!runtimeModes.has(topology.runtimeMode))
    {
        errors.push(`${id}.runtimeMode is invalid: ${topology.runtimeMode}`);
    }
    if (!Number.isInteger(topology.nodeCount) || topology.nodeCount < 1 || topology.nodeCount > 3)
    {
        errors.push(`${id}.nodeCount must be an integer from 1 to 3`);
    }
    if (!artifactStorageModes.has(topology.artifactStorage))
    {
        errors.push(`${id}.artifactStorage is invalid: ${topology.artifactStorage}`);
    }
    if (!coordinationStores.has(topology.coordinationStore))
    {
        errors.push(`${id}.coordinationStore is invalid: ${topology.coordinationStore}`);
    }
    if (!clusterScenarios.has(topology.clusterScenario))
    {
        errors.push(`${id}.clusterScenario is invalid: ${topology.clusterScenario}`);
    }
    if (!clusterBootstrapStrategies.has(topology.clusterBootstrap))
    {
        errors.push(`${id}.clusterBootstrap is invalid: ${topology.clusterBootstrap}`);
    }
    if (!Array.isArray(topology.clusterFixtures))
    {
        errors.push(`${id}.clusterFixtures must be an array`);
        return errors;
    }
    const fixtures = new Set(topology.clusterFixtures);
    if (fixtures.size !== topology.clusterFixtures.length)
    {
        errors.push(`${id}.clusterFixtures must not contain duplicates`);
    }
    for (const fixture of fixtures)
    {
        if (!clusterFixtureKinds.has(fixture))
        {
            errors.push(`${id}.clusterFixtures contains invalid fixture: ${fixture}`);
        }
    }

    if (topology.runtimeMode === 'single' && topology.nodeCount !== 1)
    {
        errors.push(`${id}.runtimeMode=single requires nodeCount=1`);
    }
    if (topology.nodeCount === 1 && topology.clusterScenario !== 'none')
    {
        errors.push(`${id}.clusterScenario=${topology.clusterScenario} requires nodeCount greater than 1`);
    }
    if (topology.nodeCount === 1 && topology.clusterBootstrap !== 'none')
    {
        errors.push(`${id}.clusterBootstrap=${topology.clusterBootstrap} requires nodeCount greater than 1`);
    }

    if (topology.artifactStorage === 'shared-volume' && !fixtures.has('shared-artifact-storage'))
    {
        errors.push(`${id}.artifactStorage=shared-volume requires clusterFixtures to include shared-artifact-storage`);
    }
    if (topology.artifactStorage === 'local' && fixtures.has('shared-artifact-storage'))
    {
        errors.push(`${id}.clusterFixtures shared-artifact-storage requires artifactStorage=shared-volume`);
    }
    if (topology.coordinationStore === 'redis')
    {
        if (!services.has('redis'))
        {
            errors.push(`${id}.coordinationStore=redis requires services to include redis`);
        }
        if (!fixtures.has('shared-redis'))
        {
            errors.push(`${id}.coordinationStore=redis requires clusterFixtures to include shared-redis`);
        }
    }
    if (fixtures.has('shared-postgres') && !services.has('postgres'))
    {
        errors.push(`${id}.clusterFixtures shared-postgres requires services to include postgres`);
    }
    if (fixtures.has('shared-redis') && !services.has('redis'))
    {
        errors.push(`${id}.clusterFixtures shared-redis requires services to include redis`);
    }

    if (topology.nodeCount > 1)
    {
        if (topology.runtimeMode === 'single')
        {
            errors.push(`${id} multi-node topology requires runtimeMode=static-role or adaptive`);
        }
        if (topology.clusterScenario === 'none')
        {
            errors.push(`${id} multi-node topology requires an explicit clusterScenario`);
        }
        if (topology.clusterBootstrap !== 'homogeneous')
        {
            errors.push(`${id} multi-node topology requires clusterBootstrap=homogeneous`);
        }
        if (topology.artifactStorage !== 'shared-volume')
        {
            errors.push(`${id} multi-node topology requires artifactStorage=shared-volume`);
        }
        if (topology.coordinationStore !== 'redis')
        {
            errors.push(`${id} multi-node topology requires coordinationStore=redis`);
        }
        if (tier.requiresBootstrap === 'none')
        {
            errors.push(`${id} multi-node topology requires runtime bootstrap`);
        }
        for (const [fixture, service] of [['shared-postgres', 'postgres'], ['shared-redis', 'redis'], ['shared-artifact-storage', null]])
        {
            if (!fixtures.has(fixture))
            {
                errors.push(`${id} multi-node topology requires clusterFixtures to include ${fixture}`);
            }
            if (service && !services.has(service))
            {
                errors.push(`${id} multi-node topology requires services to include ${service}`);
            }
        }
    }

    return errors;
}

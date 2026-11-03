const { buildProducerDag } = await import(new URL('../../test-fixtures/dag.mjs', import.meta.url));
const { readCatalog, validateRuntimeScenarioCatalog } = await import(new URL('../runtime-scenario-host.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../test-fixtures/receipt/canonical.mjs', import.meta.url));

import {
    consumeOwnerReference,
    sealProjection,
    validateContext
} from './contract.mjs';

export function projectSecurityBarriers({ catalog = readCatalog(), profileId, mode, fixtureCatalogs } = {})
{
    const errors = validateRuntimeScenarioCatalog(catalog);
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    if (!['resident', 'legacy'].includes(mode))
    {
        throw new Error('security topology requires explicit resident or legacy mode');
    }
    const consumers = catalog.scenarios.filter((scenario) => scenario.phase === 'security');
    if (consumers.length === 0)
    {
        throw new Error('security barriers require catalog consumers');
    }
    const fixtureConsumers = consumers.filter((scenario) => scenario.requiredPreconditions.includes('runtime-fixtures'));
    const fixturePlan = fixtureConsumers.length > 0 ? buildProducerDag(profileId, fixtureCatalogs) : null;
    if (fixturePlan && fixturePlan.capabilities.length === 0)
    {
        throw new Error('security fixture consumers require a non-empty canonical profile');
    }
    const nodes = [{
        producerId: 'security-runtime-ready',
        kind: 'coordination',
        dependsOn: [],
        ownerCapability: 'runtime-identity',
        consumers: consumers.map((scenario) => scenario.id)
    }];
    if (fixturePlan)
    {
        nodes.push({
            producerId: 'security-fixture-prepare',
            kind: 'fixture-lifecycle-reference',
            dependsOn: ['security-runtime-ready'],
            ownerCapability: 'fixture-lifecycle',
            consumers: fixtureConsumers.map((scenario) => scenario.id)
        });
    }
    nodes.push({
        producerId: 'security-reset-pre-scenarios',
        kind: 'reset-barrier',
        dependsOn: nodes.map((node) => node.producerId),
        ownerCapability: 'reset-postconditions',
        resetBarriers: [...new Set(consumers.map((scenario) => scenario.resetBarrier))],
        consumers: consumers.map((scenario) => scenario.id)
    });
    const attackConsumers = consumers.filter((scenario) => scenario.coverageIds.includes('security.attack-matrix'));
    if (mode === 'legacy' && attackConsumers.length > 0)
    {
        nodes.push({
            producerId: 'security-reset-pre-attack',
            kind: 'reset-barrier',
            dependsOn: ['security-reset-pre-scenarios'],
            ownerCapability: 'reset-postconditions',
            resetBarriers: [...new Set(attackConsumers.map((scenario) => scenario.resetBarrier))],
            consumers: attackConsumers.map((scenario) => scenario.id)
        });
    }
    nodes.push({
        producerId: 'security-reset-post-gate',
        kind: 'cleanup-finalizer',
        alwaysRun: true,
        settledScenarioIds: consumers.map((scenario) => scenario.id),
        ownerCapability: 'reset-postconditions',
        unlocksCorrectness: false
    });
    return sealProjection({
        schema: 'fsusblog.security-atomic-barrier-projection.v1', catalogDigest: digestCanonical(catalog), mode, fixturePlan, nodes
    });
}

export async function admitSecurityPrerequisites({ context, references, needsFixture, needsAttackReset, ownerVerifiers })
{
    const binding = validateContext(context);
    const consumed = [];
    consumed.push(await consumeOwnerReference('runtime', references?.runtime, binding, ownerVerifiers));
    if (needsFixture)
    {
        consumed.push(await consumeOwnerReference('fixture', references?.fixture, binding, ownerVerifiers));
    }
    consumed.push(await consumeOwnerReference('reset', references?.reset, binding, ownerVerifiers));
    if (needsAttackReset)
    {
        consumed.push(await consumeOwnerReference('reset', references?.attackReset, binding, ownerVerifiers));
    }
    return Object.freeze(consumed);
}

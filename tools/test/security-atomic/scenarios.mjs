const { readCatalog, validateRuntimeScenarioCatalog } = await import(new URL('../runtime-scenario-host.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../test-fixtures/receipt/canonical.mjs', import.meta.url));

import { admitSecurityPrerequisites } from './barriers.mjs';
import {
    consumeOwnerReference,
    requireExactKeys,
    sealProjection,
    validateContext,
    validateReference
} from './contract.mjs';

export function projectSecurityScenarios({ catalog = readCatalog(), bindings, mode } = {})
{
    const errors = validateRuntimeScenarioCatalog(catalog);
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    if (!['resident', 'legacy'].includes(mode))
    {
        throw new Error('scenario mode must be resident or legacy');
    }
    // The four external producers are owned by #2260. Application membership
    // comes from the existing catalog executor, never a copied scenario roster.
    const scenarios = catalog.scenarios.filter((scenario) => scenario.phase === 'security' && scenario.executor === 'resident');
    const unsupported = catalog.scenarios.find((scenario) => scenario.phase === 'security'
      && scenario.executor !== 'resident'
      && !['security.local-runtime-exposure', 'security.dast'].includes(scenario.id));
    if (unsupported)
    {
        throw new Error(`unprojected security catalog scenario: ${unsupported.id}`);
    }
    if (!Array.isArray(bindings) || bindings.length !== scenarios.length
      || new Set(bindings.map((binding) => binding.scenarioId)).size !== scenarios.length)
    {
        throw new Error('scenario owner bindings must cover the catalog exactly once');
    }
    const isolationDigests = new Set();
    const producers = scenarios.map((scenario) =>
    {
        const binding = bindings.find((item) => item.scenarioId === scenario.id);
        requireExactKeys(binding, ['scenarioId', 'stateAccess', 'isolation', 'replay', 'envelope'], 'scenario binding');
        for (const field of ['stateAccess', 'isolation', 'replay', 'envelope'])
        {
            validateReference(binding[field]);
        }
        if (isolationDigests.has(binding.isolation.contentDigest))
        {
            throw new Error('cross-scenario isolation reference reuse');
        }
        isolationDigests.add(binding.isolation.contentDigest);
        const dependsOn = ['security-runtime-ready', 'security-reset-pre-scenarios'];
        if (scenario.requiredPreconditions.includes('runtime-fixtures'))
        {
            dependsOn.push('security-fixture-prepare');
        }
        if (mode === 'legacy' && scenario.coverageIds.includes('security.attack-matrix'))
        {
            dependsOn.push('security-reset-pre-attack');
        }
        return {
            producerId: `security-scenario:${scenario.id}`,
            testId: scenario.id,
            kind: 'atomic-correctness',
            allowedRetries: 0,
            attemptNumber: 1,
            dependsOn,
            invocation: { kind: 'catalog-scenario', scenarioId: scenario.id, mode },
            scenario,
            binding
        };
    });
    return sealProjection({
        schema: 'fsusblog.security-atomic-scenario-projection.v1',
        catalogDigest: digestCanonical(catalog),
        producers,
        aggregate: {
            producerId: 'security-runtime-core',
            kind: 'settled-projection',
            settledDependsOn: producers.map((producer) => producer.producerId),
            executesCommands: false
        }
    });
}

export async function admitSecurityScenario({ producer, context, references, ownerVerifiers, hostFailureRefs = [] })
{
    const binding = validateContext(context);
    if (producer.kind !== 'atomic-correctness' || producer.allowedRetries !== 0 || producer.attemptNumber !== 1)
    {
        throw new Error('scenario requires exact-one zero-retry attempt');
    }
    const verifier = ownerVerifiers?.scenarioDeclaration;
    if (typeof verifier !== 'function' || await verifier(producer, binding) !== producer.producerId)
    {
        throw new Error('scenario declaration must match the canonical catalog and owner bindings');
    }
    const prerequisites = await admitSecurityPrerequisites({
        context: binding, references, ownerVerifiers,
        needsFixture: producer.scenario.requiredPreconditions.includes('runtime-fixtures'),
        needsAttackReset: producer.dependsOn.includes('security-reset-pre-attack')
    });
    for (const kind of ['stateAccess', 'isolation', 'replay', 'envelope'])
    {
        await consumeOwnerReference(kind, producer.binding[kind], binding, ownerVerifiers);
    }
    if (producer.invocation.mode === 'resident')
    {
        await consumeOwnerReference('host', references.host, binding, ownerVerifiers);
        // The canonical host verifier must independently check its failure ledger;
        // callers cannot erase a failed attempt by omitting hostFailureRefs.
        if (!Array.isArray(hostFailureRefs))
        {
            throw new Error('hostFailureRefs must be an array');
        }
        if (hostFailureRefs.length > 0)
        {
            await consumeOwnerReference('hostRevalidation', references.hostRevalidation, binding, ownerVerifiers);
            const healthVerifier = ownerVerifiers?.hostFailureLedger;
            if (typeof healthVerifier !== 'function'
              || await healthVerifier(hostFailureRefs, references.hostRevalidation, binding) !== references.hostRevalidation.contentDigest)
            {
                throw new Error('host revalidation must cover all failed attempts and state isolation');
            }
        }
    }
    return sealProjection({
        schema: 'fsusblog.security-atomic-admission-request.v1',
        producerId: producer.producerId,
        context: binding,
        declaration: producer,
        prerequisites,
        hostFailureRefs,
        references
    });
}

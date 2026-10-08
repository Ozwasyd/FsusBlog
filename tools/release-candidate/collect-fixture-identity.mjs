import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { exactKeys, requireDigest } from './identity-contract.mjs';

const { canonicalJson, digestCanonical, sealContentDigest } = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));
const { verifyRepositorySourceSnapshot } = await import(new URL('../test/repository-source-snapshot.mjs', import.meta.url));
const { buildProducerDag } = await import(new URL('../test-fixtures/dag.mjs', import.meta.url));
const { validateFixtureReceipt } = await import(new URL('../test-fixtures/receipt/index.mjs', import.meta.url));
const { resolveFixtureProfile } = await import(new URL('../testing/fixture-catalog.mjs', import.meta.url));

export const fixtureIdentitySchema = 'fsusblog.release-candidate-fixture-identity.v1';

function same(actual, expected, field)
{
    if (canonicalJson(actual) !== canonicalJson(expected))
    {
        throw new Error(`fixture identity mismatch: ${field}`);
    }
}

/** Verify existing sealed plan and receipt facts; never prepare, seed, verify
 * live postconditions or clean a fixture. Upstream refs are explicit bindings
 * that the final aggregate must independently verify against their fragments. */
export function collectFixtureIdentity({ plan, receipt, sourceSnapshot, aliasIdentityDigest, policyIdentityDigest,
    expectedRunId, expectedNamespace, catalogs })
{
    verifyRepositorySourceSnapshot(sourceSnapshot);
    requireDigest(aliasIdentityDigest, 'explicit alias identity digest');
    requireDigest(policyIdentityDigest, 'explicit policy identity digest');
    if (!expectedRunId || typeof expectedRunId !== 'string' || !expectedNamespace || typeof expectedNamespace !== 'string' || !catalogs)
    {
        throw new Error('fixture collector requires explicit run, namespace and canonical catalogs');
    }
    exactKeys(plan, ['schema', 'profileIdentity', 'executionIdentity', 'catalogDigest', 'expandedCapabilityDigest', 'capabilities',
        'variantIds', 'variantPlan', 'variantPlanDigest', 'producers', 'producerSpecs', 'edges', 'order', 'waves', 'mutationPolicy',
        'requiresLocalAuthBypass', 'requiresAuthFixtures', 'requiresPublicFixtures', 'requiresDemoSeed', 'requiresSecurityState',
        'terminalState'], 'fixture orchestrator plan');
    exactKeys(plan.profileIdentity, ['profileId', 'profileSource', 'executionClass', 'sealed'], 'fixture profile identity');
    exactKeys(plan.executionIdentity, ['runId', 'namespace', 'sourceIdentity', 'handles'], 'fixture execution identity');
    if (plan.schema !== 'fsusblog.fixture-orchestrator-plan.v1' || plan.terminalState !== 'planned'
        || plan.profileIdentity.profileSource !== 'matrix' || !plan.profileIdentity.sealed || typeof plan.profileIdentity.sealed !== 'object'
        || typeof plan.profileIdentity.executionClass !== 'string' || !plan.profileIdentity.executionClass)
    {
        throw new Error('fixture collector requires an explicit sealed matrix profile and execution class');
    }
    exactKeys(plan.profileIdentity.sealed, ['fixtureProfileId', 'fixtureCatalogDigest', 'expandedCapabilityDigest',
        'fixtureVariantIds', 'fixtureVariantPlanDigest', 'executionClass'], 'fixture profile seal');
    const sourceState = { commit: sourceSnapshot.commit, worktreeFingerprint: sourceSnapshot.snapshotDigest };
    same(plan.executionIdentity.runId, expectedRunId, 'plan.runId');
    same(plan.executionIdentity.namespace, expectedNamespace, 'plan.namespace');
    same(plan.executionIdentity.sourceIdentity, sourceState, 'plan.sourceIdentity');
    // Consume the canonical resolver as a pure verifier with every input
    // explicit. No tier/default/profile environment is consulted.
    const resolved = resolveFixtureProfile({
        profileId: plan.profileIdentity.profileId, profileSource: plan.profileIdentity.profileSource,
        executionClass: plan.profileIdentity.executionClass, requestedVariantIds: plan.variantIds,
        sealed: plan.profileIdentity.sealed,
        catalogs, allowFreeProfileEnv: false, freeProfileEnv: ''
    });
    same(plan.profileIdentity.sealed, resolved.sealed, 'plan.profile seal');
    for (const field of ['catalogDigest', 'expandedCapabilityDigest', 'capabilities', 'variantIds', 'variantPlan', 'variantPlanDigest',
        'mutationPolicy', 'requiresLocalAuthBypass', 'requiresAuthFixtures', 'requiresPublicFixtures', 'requiresDemoSeed', 'requiresSecurityState'])
    {
        same(plan[field], resolved[field], `plan.${field}`);
    }
    const dag = buildProducerDag(plan.profileIdentity.profileId, catalogs);
    same(plan.producers, dag.producers.map((producer) => producer.id), 'plan.producers');
    same(plan.producerSpecs, dag.producers, 'plan.producerSpecs');
    for (const field of ['edges', 'order', 'waves'])
    {
        same(plan[field], dag[field], `plan.${field}`);
    }
    const expectedExecutionIdentity = { runId: expectedRunId, namespace: expectedNamespace, source: sourceState,
        serviceGeneration: plan.executionIdentity.handles?.serviceGeneration ?? null };
    validateFixtureReceipt(receipt, { catalogs, requireVerified: true, expectedExecutionIdentity,
        expectedCatalogDigest: plan.catalogDigest, expectedProfileId: plan.profileIdentity.profileId });
    same(receipt.profileIdentity, { ...plan.profileIdentity, sealed: true }, 'receipt.profileIdentity');
    same(receipt.fixtureVariantIds, plan.variantIds, 'receipt.variantIds');
    same(receipt.variantPlanDigest, plan.variantPlanDigest, 'receipt.variantPlanDigest');
    same(receipt.capabilityMap, plan.capabilities.map((id) =>
    {
        const capability = catalogs.capability.capabilities.find((item) => item.id === id);
        return { capabilityId: id, producerId: capability.ownerProducerId, postconditionIds: capability.postconditionIds };
    }), 'receipt.capability postcondition closure');
    const producerReceipts = receipt.producerReceipts;
    if (!Array.isArray(producerReceipts))
    {
        throw new Error('fixture receipt requires explicit producer receipts');
    }
    const producerIds = producerReceipts.map((item) => item.producerId);
    if (new Set(producerIds).size !== producerIds.length)
    {
        throw new Error('fixture receipt contains duplicate producer');
    }
    same(producerIds, plan.order, 'receipt.producer order/closure');
    same(receipt.orderedProducerReceiptDigests, producerReceipts.map((item) => item.producerReceiptDigest), 'receipt.producer digests');
    for (const producer of producerReceipts)
    {
        for (const field of ['runId', 'namespace', 'source', 'serviceGeneration'])
        {
            same(producer[field], expectedExecutionIdentity[field], `receipt.producer.${producer.producerId}.${field}`);
        }
        same(producer.profileId, plan.profileIdentity.profileId, `receipt.producer.${producer.producerId}.profileId`);
        same(producer.fixtureCatalogDigest, plan.catalogDigest, `receipt.producer.${producer.producerId}.catalogDigest`);
        same(producer.variantPlanDigest, plan.variantPlanDigest, `receipt.producer.${producer.producerId}.variantPlanDigest`);
    }
    const identity = {
        profileIdentity: plan.profileIdentity, catalogDigest: plan.catalogDigest, expandedCapabilityDigest: plan.expandedCapabilityDigest,
        variantPlanDigest: plan.variantPlanDigest, variantIds: plan.variantIds, mutationPolicy: plan.mutationPolicy,
        producerDagDigest: digestCanonical({ producers: plan.producerSpecs, edges: plan.edges, order: plan.order, waves: plan.waves }),
        producerReceiptDigests: producerReceipts.map((item) => item.producerReceiptDigest),
        fixtureReceiptDigest: receipt.receiptDigest,
        postconditionDigest: digestCanonical(receipt.capabilityMap),
        stateDigests: { database: receipt.databaseObservationDigest, redis: receipt.redisObservationDigest, cache: receipt.cacheObservationDigest }
    };
    return sealContentDigest({ schema: fixtureIdentitySchema, status: 'verified',
        bindings: { sourceCommit: sourceSnapshot.commit, worktreeFingerprint: sourceSnapshot.snapshotDigest,
            sourceIdentityDigest: sourceSnapshot.contentDigest, aliasIdentityDigest, policyIdentityDigest,
            schedulerRunId: expectedRunId, namespace: expectedNamespace },
        planDigest: digestCanonical(plan), identity, warnings: [] });
}

export function verifyFixtureIdentity(fragment, inputs)
{
    const recomputed = collectFixtureIdentity(inputs);
    same(fragment, recomputed, 'fragment content');
    return fragment;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    process.stderr.write('fixture collector CLI admission requires verified upstream alias/policy refs and a canonical current-run locator binding; use the owned collectFixtureIdentity API until that integration capability is supplied\n');
    process.exitCode = 1;
}

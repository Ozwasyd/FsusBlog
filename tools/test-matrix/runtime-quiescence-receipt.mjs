import {readProductionFreshJsonOutput} from './production-fresh-output-locator.mjs';
import {quiescenceDigest, validateQuiescenceObservation} from './quiescence-contract.mjs';

export const quiescenceReceiptSchema = 'fsusblog.runtime-quiescence-receipt.v1';
export const quiescencePlanSchema = 'fsusblog.quiescence-barrier-plan.v1';
const identityFields = ['runId', 'namespace', 'candidateIdentityDigest', 'runtimeIdentityDigest', 'stateDomainCatalogDigest'];

export function assertQuiescenceIdentity(actual, expected)
{
    if (!actual || !expected || identityFields.some((field) => !expected[field] || actual[field] !== expected[field]))
    {
        throw new Error('quiescence current-run identity is unavailable or changed');
    }
    for (const field of identityFields.filter((field) => field.endsWith('Digest')))
    {
        if (!/^sha256:[a-f0-9]{64}$/u.test(actual[field]))
        {
            throw new Error('quiescence identity digest is invalid');
        }
    }
}

export function assertQuiescenceLease(grant, identity, expectedLease = null)
{
    assertQuiescenceIdentity(grant?.identity, identity);
    if (grant.status !== 'active' || typeof grant.leaseId !== 'string' || !grant.leaseId ||
        !Number.isSafeInteger(grant.generation) || grant.generation <= 0 ||
        !Number.isFinite(grant.remainingLeaseMs) || grant.remainingLeaseMs <= 0 ||
        (expectedLease && (grant.leaseId !== expectedLease.leaseId || grant.generation !== expectedLease.generation)))
    {
        throw new Error('quiescence lease conflict, unavailable generation, expired or changed owner');
    }
}

export function validateQuiescencePlan(plan, {inventory, identity, lease})
{
    assertQuiescenceIdentity(plan?.identity, identity);
    if (plan.schema !== quiescencePlanSchema || plan.inventoryDigest !== inventory.contentDigest ||
        plan.observerSchemaDigest !== inventory.observerSchemaDigest || plan.leaseId !== lease.leaseId ||
        plan.leaseGeneration !== lease.generation || !Array.isArray(plan.domains) ||
        plan.domains.length !== inventory.contracts.length ||
        new Set(plan.domains.map((entry) => entry.domainId)).size !== plan.domains.length)
    {
        throw new Error('quiescence plan schema, inventory, lease or exact domain roster drift');
    }
    const {contentDigest, ...payload} = plan;
    if (contentDigest !== quiescenceDigest(payload))
    {
        throw new Error('quiescence owner plan content drift');
    }
    for (const contract of inventory.contracts)
    {
        const entry = plan.domains.find((domain) => domain.domainId === contract.domainId);
        if (!entry?.highWatermark || !entry.observedGeneration || !entry.observerIdentity?.incarnation ||
            entry.observerIdentity.api !== contract.observerApi || entry.observerIdentity.version !== 'v1' ||
            entry.observerIdentity.schemaDigest !== inventory.observerSchemaDigest ||
            !/^sha256:[a-f0-9]{64}$/u.test(entry.observerIdentity.sourceDigest ?? ''))
        {
            throw new Error(`quiescence plan has missing observer/watermark/generation: ${contract.domainId}`);
        }
    }
    return plan;
}

export function observationOptions(plan, entry, inventory, schema)
{
    return {inventory, schema, expectedIdentity: {...plan.identity, observerIdentity: entry.observerIdentity},
        requiredHighWatermark: entry.highWatermark, expectedGeneration: entry.observedGeneration};
}

export function quiescenceSemanticState(domains)
{
    return domains.map((domain) =>
    {
        const semantic = {...domain};
        delete semantic.contentDigest;
        delete semantic.evidenceDigest;
        return semantic;
    })
        .sort((left, right) => left.domainId.localeCompare(right.domainId, 'en'));
}

// Producer only seals explicit owner observations. The validator below independently
// checks each domain, current lease and content; the producer never grants authority.
export function generateQuiescenceReceipt({identity, inventory, lease, plan, domains, startedAt, sealedAt, status, blockers = []})
{
    const ordered = [...domains].sort((left, right) => left.domainId.localeCompare(right.domainId, 'en'));
    const payload = {schema: quiescenceReceiptSchema, ...identity, inventoryDigest: inventory.contentDigest,
        observerSchemaDigest: inventory.observerSchemaDigest, quiescenceLeaseId: lease?.leaseId ?? null,
        quiescenceGeneration: lease?.generation ?? null, planDigest: plan?.contentDigest ?? null,
        startedAt, sealedAt, domains: ordered, finalStateDigest: quiescenceDigest(quiescenceSemanticState(ordered)),
        status, blockers: [...new Set(blockers)].sort()};
    return {...payload, contentDigest: quiescenceDigest(payload)};
}

export function validateQuiescenceReceipt(receipt, {identity, inventory, schema, plan, currentLease})
{
    const required = ['schema', ...identityFields, 'inventoryDigest', 'observerSchemaDigest', 'quiescenceLeaseId',
        'quiescenceGeneration', 'planDigest', 'startedAt', 'sealedAt', 'domains', 'finalStateDigest', 'status', 'blockers', 'contentDigest'];
    if (!receipt || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(required.sort()))
    {
        throw new Error('quiescence receipt has missing or unsupported fields');
    }
    assertQuiescenceIdentity(receipt, identity);
    assertQuiescenceLease(currentLease, identity);
    validateQuiescencePlan(plan, {identity, inventory, lease: currentLease});
    const {contentDigest, ...payload} = receipt;
    if (receipt.schema !== quiescenceReceiptSchema || receipt.status !== 'quiescent' ||
        receipt.inventoryDigest !== inventory.contentDigest || receipt.observerSchemaDigest !== inventory.observerSchemaDigest ||
        receipt.quiescenceLeaseId !== currentLease.leaseId || receipt.quiescenceGeneration !== currentLease.generation ||
        receipt.planDigest !== plan.contentDigest || contentDigest !== quiescenceDigest(payload) ||
        !Array.isArray(receipt.blockers) || receipt.blockers.length || !Array.isArray(receipt.domains) ||
        receipt.domains.length !== inventory.contracts.length ||
        new Set(receipt.domains.map((entry) => entry.domainId)).size !== receipt.domains.length ||
        !Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.sealedAt)) ||
        Date.parse(receipt.startedAt) > Date.parse(receipt.sealedAt))
    {
        throw new Error('quiescence receipt schema, seal, roster, lease or content drift');
    }
    for (const entry of plan.domains)
    {
        const observation = receipt.domains.find((domain) => domain.domainId === entry.domainId);
        validateQuiescenceObservation(observation, observationOptions(plan, entry, inventory, schema));
    }
    if (receipt.finalStateDigest !== quiescenceDigest(quiescenceSemanticState(receipt.domains)))
    {
        throw new Error('quiescence receipt final semantic state drift');
    }
    return receipt;
}

export function projectRuntimeStateReady({root, locator, validation})
{
    if (!locator || locator.runId !== validation.identity.runId || locator.schema !== quiescenceReceiptSchema)
    {
        throw new Error('runtime-state-ready requires an explicit current-run sealed receipt locator');
    }
    const output = readProductionFreshJsonOutput({root, locator,
        expectedCandidateIdentityDigest: validation.identity.candidateIdentityDigest});
    const receipt = validateQuiescenceReceipt(output.json, validation);
    return {kind: 'sealed-quiescence-receipt', receiptRef: output.locator, receiptDigest: receipt.contentDigest,
        leaseId: receipt.quiescenceLeaseId, leaseGeneration: receipt.quiescenceGeneration};
}

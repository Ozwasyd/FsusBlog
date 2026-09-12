import {
    assertDigest,
    freezeDeep,
    plainObject
} from './canonical.mjs';
import { assertNoSecrets } from './secrets.mjs';

const decimalId = /^[1-9][0-9]*$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;

function exactKeys(value, keys, label)
{
    if (!plainObject(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()))
        throw new Error(`comment cleanup ${label} has an invalid shape`);
}

function requireText(value, label)
{
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`comment cleanup ${label} is required`);
    return value;
}

function normalizeBinding(binding)
{
    const keys = [
        'runId', 'namespace', 'testSession', 'owner', 'profileId', 'capabilities',
        'articleId', 'authProducerResultDigest', 'authPrepareReferenceDigests',
        'publicContentProducerResultDigest', 'articleProjectionDigest', 'inventoryDigest',
        'capabilityCatalogDigest', 'variantCatalogDigest', 'temporalContextDigest',
        'producerPlanDigest', 'planDigest'
    ];
    exactKeys(binding, keys, 'binding');
    if (!Number.isSafeInteger(binding.articleId) || binding.articleId <= 0)
        throw new Error('comment cleanup binding articleId is invalid');
    const capabilities = binding.capabilities;
    if (!Array.isArray(capabilities) || capabilities.length === 0
        || JSON.stringify(capabilities) !== JSON.stringify([...new Set(capabilities)].sort()))
        throw new Error('comment cleanup binding capabilities must be sorted and unique');
    const references = binding.authPrepareReferenceDigests;
    if (!Array.isArray(references) || references.length !== 3
        || JSON.stringify(references) !== JSON.stringify([...new Set(references)].sort()))
        throw new Error('comment cleanup auth references must be exact');
    for (const key of [
        'authProducerResultDigest', 'publicContentProducerResultDigest', 'articleProjectionDigest',
        'inventoryDigest', 'capabilityCatalogDigest', 'variantCatalogDigest',
        'temporalContextDigest', 'producerPlanDigest', 'planDigest'
    ])
        assertDigest(binding[key], `comment cleanup binding ${key}`);
    references.forEach((value, index) => assertDigest(value, `comment cleanup auth reference ${index}`));
    const result = {
        runId: requireText(binding.runId, 'runId'),
        namespace: requireText(binding.namespace, 'namespace'),
        testSession: requireText(binding.testSession, 'testSession'),
        owner: requireText(binding.owner, 'owner'),
        profileId: requireText(binding.profileId, 'profileId'),
        capabilities: Object.freeze([...capabilities]),
        articleId: binding.articleId,
        authProducerResultDigest: binding.authProducerResultDigest,
        authPrepareReferenceDigests: Object.freeze([...references]),
        publicContentProducerResultDigest: binding.publicContentProducerResultDigest,
        articleProjectionDigest: binding.articleProjectionDigest,
        inventoryDigest: binding.inventoryDigest,
        capabilityCatalogDigest: binding.capabilityCatalogDigest,
        variantCatalogDigest: binding.variantCatalogDigest,
        temporalContextDigest: binding.temporalContextDigest,
        producerPlanDigest: binding.producerPlanDigest,
        planDigest: binding.planDigest
    };
    if (result.owner !== `comment-fixture:${result.namespace}:${result.runId}`)
        throw new Error('comment cleanup binding owner is cross-run');
    return freezeDeep(result);
}

function normalizeCrossDomain(value, binding)
{
    const keys = [
        'schema', 'articleId', 'accountIds', 'adminPrincipalId',
        'articleDigest', 'authDigest', 'adminDigest', 'securityDigest'
    ];
    exactKeys(value, keys, 'cross-domain sentinel');
    if (value.schema !== 'fsusblog.comment-fixture-cross-domain-sentinel.v1'
        || value.articleId !== binding.articleId
        || !Array.isArray(value.accountIds) || value.accountIds.length !== 2
        || value.accountIds.some((item) => !Number.isSafeInteger(item) || item <= 0)
        || JSON.stringify(value.accountIds) !== JSON.stringify([...new Set(value.accountIds)].sort((a, b) => a - b))
        || !Number.isSafeInteger(value.adminPrincipalId) || value.adminPrincipalId <= 0
        || ['articleDigest', 'authDigest', 'adminDigest', 'securityDigest']
            .some((key) => !digest.test(String(value[key] ?? ''))))
        throw new Error('comment cleanup cross-domain sentinel is invalid');
    return freezeDeep({ ...value, accountIds: Object.freeze([...value.accountIds]) });
}

function normalizeOwnedComments(value, binding)
{
    if (!plainObject(value) || Object.keys(value).length === 0)
        throw new Error('comment cleanup ownedComments must be non-empty');
    const identityKeys = [
        'commentId', 'articleId', 'semanticRole', 'actorMode', 'accountId',
        'contentDigest', 'currentVersion', 'isDeleted', 'operationPlanDigest'
    ];
    const entries = Object.entries(value).sort(([left], [right]) =>
        BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);
    const roles = new Set();
    const operationDigests = new Set();
    const normalized = {};
    for (const [id, identity] of entries)
    {
        exactKeys(identity, identityKeys, `owned comment ${id}`);
        if (!decimalId.test(id) || String(identity.commentId) !== id
            || identity.articleId !== binding.articleId
            || !identity.semanticRole || roles.has(identity.semanticRole)
            || !['public', 'zk_anonymous'].includes(identity.actorMode)
            || identity.accountId != null && (!Number.isSafeInteger(identity.accountId) || identity.accountId <= 0)
            || !digest.test(String(identity.contentDigest ?? ''))
            || !Number.isSafeInteger(identity.currentVersion) || identity.currentVersion <= 0
            || typeof identity.isDeleted !== 'boolean'
            || !digest.test(String(identity.operationPlanDigest ?? ''))
            || operationDigests.has(identity.operationPlanDigest))
            throw new Error(`comment cleanup owned comment ${id} is invalid`);
        roles.add(identity.semanticRole);
        operationDigests.add(identity.operationPlanDigest);
        normalized[id] = freezeDeep({ ...identity });
    }
    return freezeDeep(normalized);
}

export function normalizeCleanupContract(value)
{
    if (!plainObject(value) || value.kind !== 'comment-exact-receipt')
        throw new Error('comment cleanup contract requires comment-exact-receipt');
    exactKeys(value, ['kind', 'receipt'], 'contract');
    exactKeys(value.receipt, ['schema', 'binding', 'ownedComments', 'crossDomainBefore'], 'receipt');
    if (value.receipt.schema !== 'fsusblog.comment-thread-fixture-cleanup.v1')
        throw new Error('comment cleanup contract requires its exact typed receipt');
    const binding = normalizeBinding(value.receipt.binding);
    const receipt = {
        schema: value.receipt.schema,
        binding,
        ownedComments: normalizeOwnedComments(value.receipt.ownedComments, binding),
        crossDomainBefore: normalizeCrossDomain(value.receipt.crossDomainBefore, binding)
    };
    assertNoSecrets(receipt);
    return freezeDeep({ kind: value.kind, receipt });
}

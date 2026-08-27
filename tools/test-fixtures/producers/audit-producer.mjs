// fixture-catalog: producer audit-records
import { createHash } from 'node:crypto';

const producerId = 'audit-records';
const strategy = 'transaction-fixture';
const receiptSchema = 'fsusblog.audit-fixture-receipt.v1';
const negativeCapabilities = new Set([
    'audit.tamper-negative',
    'audit.unknown-action-negative'
]);
const forbiddenReceiptKeys = new Set([
    'authorization',
    'contextJson',
    'contextPayload',
    'cookie',
    'deviceFingerprint',
    'ipAddress',
    'recordMac',
    'secret',
    'token',
    'userAgent'
]);

export function buildAuditPlan(context)
{
    const capabilities = [...new Set(
        (context?.plan?.capabilities ?? [])
            .filter((id) => String(id).startsWith('audit.'))
            .map(String)
    )].sort();
    if (capabilities.length === 0)
    {
        throw new Error('audit-records producer requires at least one audit capability');
    }
    if (capabilities.includes('audit.empty') && capabilities.length !== 1)
    {
        throw new Error('audit.empty cannot mix with mutating audit capabilities');
    }
    const temporal = context?.temporalContext;
    const businessEpochUtc = temporal?.businessEpochUtc
        ?? context?.handles?.businessEpochUtc;
    if (!businessEpochUtc || !/Z$/u.test(String(businessEpochUtc)))
    {
        throw new Error('audit-records requires the UTC business epoch from temporal authority');
    }
    return Object.freeze({
        producerId,
        strategy,
        namespace: context.namespace,
        runId: context.runIdentity,
        businessEpochUtc,
        capabilities: Object.freeze(capabilities),
        scaleRecordCount: Number(context?.handles?.auditScaleRecordCount ?? 0),
        temporalContext: temporal ?? null
    });
}

export async function prepareAuditRecords(context, signal)
{
    const plan = buildAuditPlan(context);
    const adapter = context.handles?.auditFixtureAdapter;
    const receipt = adapter && typeof adapter.prepare === 'function'
        ? await adapter.prepare(plan, signal)
        : await invokeLocalAuditFixture(context, plan, signal);
    const validated = validateAuditReceipt(receipt, plan);
    const entityIdentities = validated.records.map((record) => ({
        kind: 'audit-record',
        id: record.identity,
        digest: record.semanticDigest,
        variantId: `canonical.${record.capability}`
    }));
    const variantEvidence = buildVariantEvidence(context, validated, entityIdentities);
    return Object.freeze({
        producerId,
        strategy,
        implementation: adapter
            ? 'injected-audit-production-port'
            : 'src/backend/Services/Fixtures/AuditFixtureProducer.cs',
        enforceVariantEvidence: true,
        providedCapabilities: validated.capabilities,
        entityIdentities: Object.freeze(entityIdentities),
        observations: Object.freeze({
            source: 'production-audit-store',
            database: Object.freeze({
                owner: validated.owner,
                recordCount: validated.records.length,
                policyDigest: validated.policyDigest,
                semanticRecordSetDigest: validated.semanticRecordSetDigest,
                negativeCases: Object.freeze(validated.negativeCases),
                retention: Object.freeze(validated.retention),
                query: validated.query ? Object.freeze(validated.query) : null,
                entities: Object.freeze(validated.records.map((record) => ({
                    kind: 'audit-record',
                    id: record.identity,
                    digest: record.semanticDigest,
                    owned: true,
                    fields: Object.freeze({
                        capability: record.capability,
                        action: record.action,
                        chainId: record.chainId,
                        highValue: record.highValue,
                        payloadProtected: record.payloadProtected,
                        recordHash: record.recordHash,
                        recordMacDigest: record.recordMacDigest
                    })
                })))
            })
        }),
        auditReceipt: validated,
        variantEvidence,
        postconditions: Object.freeze(postconditionsFor(validated.capabilities))
    });
}

export async function verifyAuditRecords(context, producerResult)
{
    const plan = buildAuditPlan(context);
    const receipt = validateAuditReceipt(producerResult?.auditReceipt, plan);
    const adapter = context.handles?.auditFixtureAdapter;
    if (adapter && typeof adapter.verify === 'function')
    {
        const verification = await adapter.verify(receipt, context);
        if (!verification || verification.ok !== true)
        {
            return {
                ok: false,
                producerId,
                reason: verification?.reason ?? 'audit production verifier rejected receipt'
            };
        }
    }
    return {
        ok: true,
        producerId,
        semanticRecordSetDigest: receipt.semanticRecordSetDigest,
        negativeReasonDigest: digestJson(receipt.negativeCases.map((item) => ({
            mutationId: item.mutationId,
            actualReason: item.actualReason
        })))
    };
}

export async function cleanupAuditRecords(context, _receipt, signal)
{
    const adapter = context.handles?.auditFixtureAdapter;
    if (adapter && typeof adapter.cleanup === 'function')
    {
        await adapter.cleanup({
            namespace: context.namespace,
            runId: context.runIdentity
        }, signal);
        return;
    }
    await invokeLocalAuditCleanup(context, signal);
}

export function validateAuditReceipt(receipt, plan)
{
    if (!receipt || receipt.schema !== receiptSchema)
    {
        throw new Error(`audit receipt schema must be ${receiptSchema}`);
    }
    if (receipt.producerId !== producerId
        || receipt.strategy !== strategy
        || receipt.status !== 'verified')
    {
        throw new Error('audit receipt producer/strategy/status mismatch');
    }
    const capabilities = sortedStrings(receipt.capabilities);
    if (JSON.stringify(capabilities) !== JSON.stringify([...plan.capabilities]))
    {
        throw new Error('audit receipt capabilities do not exact-match the plan');
    }
    if (!Array.isArray(receipt.warnings) || receipt.warnings.length !== 0)
    {
        throw new Error('audit terminal receipt must have warnings=0');
    }
    if (!Array.isArray(receipt.records) || !Array.isArray(receipt.negativeCases))
    {
        throw new Error('audit receipt record and negative evidence arrays are required');
    }
    if (!Array.isArray(receipt.retention))
    {
        throw new Error('audit receipt retention evidence array is required');
    }
    if (capabilities.some((id) => id === 'audit.legal-hold-eligible' || id === 'audit.pseudonym-retention'))
    {
        if (receipt.retention.length === 0
            || receipt.retention.some((item) => item.ineligibleHoldReason !== 'audit_legal_hold_not_allowed'
                || item.eligibleHoldActiveBeforeExpiry !== true
                || item.eligibleHoldInactiveAtExpiry !== true))
        {
            throw new Error('audit retention evidence must bind production boundary and legal-hold semantics');
        }
    }
    if (capabilities.includes('audit.investigation-page'))
    {
        if (!receipt.query
            || receipt.query.total !== 3
            || receipt.query.firstPageCount !== 2
            || receipt.query.secondPageCount !== 1
            || receipt.query.cursorBound !== true
            || receipt.query.orderedDescending !== true
            || receipt.query.piiRedacted !== true
            || receipt.query.chainVerified !== true
            || !/^[0-9a-f]{64}$/u.test(receipt.query.projectionDigest))
        {
            throw new Error('audit investigation evidence must come from the verified paged production projection');
        }
    }
    if (capabilities.length === 1 && capabilities[0] === 'audit.empty'
        && receipt.records.length !== 0)
    {
        throw new Error('audit.empty receipt must prove zero records');
    }
    for (const record of receipt.records)
    {
        for (const field of ['identity', 'capability', 'action', 'chainId', 'recordHash', 'recordMacDigest', 'semanticDigest'])
        {
            if (typeof record?.[field] !== 'string' || record[field].length === 0)
            {
                throw new Error(`audit record evidence requires ${field}`);
            }
        }
        if (!/^[0-9]{8}$/u.test(record.chainId)
            || !/^[0-9a-f]{64}$/u.test(record.recordHash)
            || !/^[0-9a-f]{64}$/u.test(record.recordMacDigest)
            || !/^[0-9a-f]{64}$/u.test(record.semanticDigest))
        {
            throw new Error('audit record evidence has invalid chain/hash identity');
        }
    }
    const expectedNegative = capabilities.filter((id) => negativeCapabilities.has(id));
    if (expectedNegative.length > 0 && receipt.negativeCases.length === 0)
    {
        throw new Error('audit negative capability requires isolated negative evidence');
    }
    for (const negative of receipt.negativeCases)
    {
        if (negative.isolated !== true
            || negative.expectedReason !== negative.actualReason
            || typeof negative.mutatedField !== 'string')
        {
            throw new Error('audit negative evidence must be isolated with one exact reason');
        }
    }
    assertReceiptPrivacy(receipt);
    if (receipt.contentDigest !== computeAuditReceiptContentDigest(receipt))
    {
        throw new Error('audit receipt content digest mismatch');
    }
    return Object.freeze(receipt);
}

function postconditionsFor(capabilities)
{
    return capabilities.map((id) => id.replace(/^audit\./u, 'audit-')).sort();
}

function buildVariantEvidence(context, receipt, entityIdentities)
{
    const variants = (context?.variantPlan?.variants ?? []).map((variant) =>
    {
        const ids = entityIdentities
            .filter((entity) => entity.variantId === variant.id)
            .map((entity) => entity.id);
        if (variant.validityClass === 'negative-invalid')
        {
            const cases = receipt.negativeCases.filter((item) => variant.capabilityId === 'audit.tamper-negative'
                ? item.mutationId !== 'unknown-action'
                : item.mutationId === 'unknown-action');
            if (cases.length === 0)
            {
                throw new Error(`audit negative variant ${variant.id} has no isolated cases`);
            }
            return Object.freeze({
                variantId: variant.id,
                source: 'live-service',
                rejected: true,
                injectedSentinelId: variant.injectedSentinelId,
                injectedSentinelValue: variant.injectedSentinelValue,
                invariantIds: Object.freeze([variant.expectedInvariantId]),
                cases: Object.freeze(cases)
            });
        }
        return Object.freeze({
            variantId: variant.id,
            source: 'live-service',
            entityIds: Object.freeze(ids),
            emptyVerified: variant.capabilityId === 'audit.empty'
                && receipt.records.length === 0
        });
    });
    return Object.freeze({ variants: Object.freeze(variants) });
}

async function invokeLocalAuditFixture(context, plan, signal)
{
    const baseUrl = context.handles?.debugBackendUrl
        ?? context.handles?.baseUrl;
    const secret = context.handles?.localPublicContentFixtureSecret;
    if (!baseUrl || !secret)
    {
        throw new Error('audit-records requires a production adapter or loopback backend handle');
    }
    const response = await fetch(`${String(baseUrl).replace(/\/$/u, '')}/__local/audit-fixture/prepare`, {
        method: 'POST',
        headers: requestHeaders(context, secret),
        body: JSON.stringify(plan),
        signal
    });
    const text = await response.text();
    if (!response.ok)
    {
        throw new Error(`audit fixture prepare failed HTTP ${response.status}: ${text.slice(0, 400)}`);
    }
    return JSON.parse(text);
}

async function invokeLocalAuditCleanup(context, signal)
{
    const baseUrl = context.handles?.debugBackendUrl
        ?? context.handles?.baseUrl;
    const secret = context.handles?.localPublicContentFixtureSecret;
    if (!baseUrl || !secret)
    {
        throw new Error('audit-records cleanup requires a production adapter or loopback backend handle');
    }
    const response = await fetch(`${String(baseUrl).replace(/\/$/u, '')}/__local/audit-fixture/cleanup`, {
        method: 'POST',
        headers: requestHeaders(context, secret),
        body: JSON.stringify({ namespace: context.namespace, runId: context.runIdentity }),
        signal
    });
    if (!response.ok)
    {
        throw new Error(`audit fixture cleanup failed HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }
}

function requestHeaders(context, secret)
{
    return {
        'Content-Type': 'application/json',
        'X-Fsus-Local-Audit-Fixture-Secret': secret,
        'X-Fsus-Test-Namespace': context.namespace ?? '',
        'X-Fsus-Test-Run-Id': context.runIdentity ?? ''
    };
}

function assertReceiptPrivacy(value, path = '$')
{
    if (Array.isArray(value))
    {
        value.forEach((item, index) => assertReceiptPrivacy(item, `${path}[${index}]`));
        return;
    }
    if (!value || typeof value !== 'object')
    {
        return;
    }
    for (const [key, child] of Object.entries(value))
    {
        if (forbiddenReceiptKeys.has(key))
        {
            throw new Error(`audit receipt leaks forbidden field ${path}.${key}`);
        }
        assertReceiptPrivacy(child, `${path}.${key}`);
    }
}

function sortedStrings(values)
{
    if (!Array.isArray(values))
    {
        throw new Error('audit receipt capabilities must be an array');
    }
    const sorted = [...new Set(values.map(String))].sort();
    if (sorted.length !== values.length || JSON.stringify(sorted) !== JSON.stringify(values))
    {
        throw new Error('audit receipt capabilities must be sorted and unique');
    }
    return sorted;
}

function digestJson(value)
{
    return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function computeAuditReceiptContentDigest(receipt)
{
    const unsigned = {
        schema: receipt.schema,
        producerId: receipt.producerId,
        strategy: receipt.strategy,
        owner: receipt.owner,
        capabilities: receipt.capabilities,
        records: receipt.records,
        negativeCases: receipt.negativeCases,
        retention: receipt.retention,
        query: receipt.query,
        performance: receipt.performance,
        policyDigest: receipt.policyDigest,
        semanticRecordSetDigest: receipt.semanticRecordSetDigest,
        status: receipt.status,
        warnings: receipt.warnings
    };
    return createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
}

function stableStringify(value)
{
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

import {
    createTemporalDomainProducerReceipt,
    readTemporalDomainProducerInventory,
    resolveTemporalRolesForProducer,
    verifyResolvedTemporalArtifact
} from '../../test/temporal-role-resolver.mjs';
import { digestCanonical, TemporalContractError } from '../../test/temporal-context.mjs';
import { bindTemporalBusinessFields, verifyObservedTemporalBusinessFields } from '../temporal-business-fields.mjs';

const producerIds = new Set(['public-content', 'comment-moderation', 'audit-records']);

function fail(reasonCode, message)
{
    throw new TemporalContractError(reasonCode, message);
}

// The catalog/inventory owner supplies the mapping. Never assign an unbound producer
// to another domain's shape or build a private epoch/offset table here.
export function bindArticleCommentAuditTemporal(context, producerId)
{
    if (!producerIds.has(producerId))
    {
        fail('temporal.producer-domain-mismatch', 'consumer is outside article/comment/audit');
    }
    if (!context?.temporalContext
        || context.temporalContext.producerId !== producerId
        || context.temporalContext.schedulerRunId !== context.runIdentity)
    {
        fail('temporal.resolver-context-mismatch', 'producer/run must bind the sealed temporal context');
    }
    const artifact = resolveTemporalRolesForProducer({
        temporalContext: context.temporalContext,
        namespace: context.namespace,
        fixtureId: producerId,
        planDigest: context.variantPlan?.producerVariantPlanDigest
    });
    return Object.freeze({ artifact, receipt: createTemporalDomainProducerReceipt(artifact) });
}

// Backend ports must independently observe every mapped business field. This verifier
// keeps those instants in the digest; generatedAt never substitutes for a business field.
export function verifyArticleCommentAuditTemporalRows(context, binding, observation)
{
    const artifact = binding?.artifact;
    verifyResolvedTemporalArtifact(artifact, { temporalContext: context.temporalContext });
    const producerId = artifact.fixtureIdentity.producerId;
    if (!producerIds.has(producerId)
        || artifact.fixtureIdentity.namespace !== context.namespace
        || artifact.fixtureIdentity.runId !== context.runIdentity)
    {
        fail('temporal.resolver-context-mismatch', 'observed rows do not bind producer/namespace/run');
    }
    const inventory = readTemporalDomainProducerInventory();
    const owner = inventory.producerBindings.find((entry) => entry.producerId === producerId);
    if (!owner || owner.shapeId !== artifact.shape.id)
    {
        fail('temporal.producer-unbound', `${producerId} lacks its canonical field mapping`);
    }
    const result = compareResolvedTemporalFields(artifact, owner.fieldMappings, observation, context.temporalContext);
    const receipt = createTemporalDomainProducerReceipt(artifact);
    if (digestCanonical(receipt) !== digestCanonical(binding.receipt))
    {
        fail('temporal.resolved-artifact-tamper', 'producer receipt differs from the canonical artifact');
    }
    return result;
}

// Row comparison is an independently testable component. It does not bind a
// producer to a shape, qualify its writer path, or issue a producer receipt.
export function compareResolvedTemporalFields(artifact, fieldMappings, observation, temporalContext)
{
    const binding = bindTemporalBusinessFields({
        temporalContext, artifact, fieldMappings,
        expected: {
            artifactDigest: observation?.resolvedArtifactDigest,
            ...artifact?.fixtureIdentity,
            shapeId: artifact?.shape.id
        }
    });
    if (observation?.resolvedArtifactDigest !== artifact.contentDigest
        || !Array.isArray(observation.rows) || observation.rows.length > 100_000)
    {
        fail('temporal.producer-observation-invalid', 'bounded exact row observation is required');
    }
    const mappings = new Map(fieldMappings.map((mapping) => [mapping.field, mapping.roleId]));
    const seenFields = new Set();
    const seenRows = new Set();
    const observedFields = {};
    const rows = observation.rows.map((row) =>
    {
        if (!row || Object.keys(row).sort().join(',') !== 'entityId,field,instantUtc')
        {
            fail('temporal.producer-observation-invalid', 'unknown row fields cannot be ignored');
        }
        const roleId = mappings.get(row.field);
        if (!roleId || typeof row.entityId !== 'string' || !row.entityId)
        {
            fail('temporal.role-missing', 'unmapped business field or missing entity identity');
        }
        const key = JSON.stringify([row.entityId, row.field]);
        if (seenRows.has(key))
        {
            fail('temporal.role-duplicate', 'duplicate observed entity/field');
        }
        seenRows.add(key);
        seenFields.add(row.field);
        if (row.instantUtc !== binding.requireField(row.field).instantUtc)
        {
            fail('temporal.cross-runtime-mismatch', `${row.field} differs from its semantic role`);
        }
        observedFields[row.field] = row.instantUtc;
        return { entityId: row.entityId, field: row.field, roleId, instantUtc: row.instantUtc };
    }).sort((left, right) =>
    {
        const leftKey = JSON.stringify([left.entityId, left.field]);
        const rightKey = JSON.stringify([right.entityId, right.field]);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    if (seenFields.size !== mappings.size)
    {
        fail('temporal.producer-observation-incomplete', 'mapped business timestamps cannot be omitted');
    }
    verifyObservedTemporalBusinessFields(binding, observedFields);
    return Object.freeze({
        resolvedArtifactDigest: artifact.contentDigest,
        temporalSemanticDigest: artifact.semanticDigest,
        observedRowDigest: digestCanonical(rows),
        observedFieldCount: seenFields.size,
        observedRowCount: rows.length
    });
}

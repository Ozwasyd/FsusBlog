import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateBusinessEpochUtc } from './temporal-context-contract.mjs';
import {
    digestCanonical,
    TemporalContractError,
    validateTemporalContext
} from './temporal-context.mjs';
import {
    readTemporalShapeCatalog,
    resolveTemporalEntityShape,
    resolveTemporalShape
} from './temporal-shape-catalog.mjs';

export const RESOLVED_TEMPORAL_ROLES_SCHEMA = 'fsusblog.resolved-temporal-roles.v1';
export const POSTGRES_TEMPORAL_ROLES_SCHEMA = 'fsusblog.postgres-temporal-roles.v1';
export const DOTNET_TEMPORAL_ROLES_SCHEMA = 'fsusblog.dotnet-temporal-roles.v1';
export const BROWSER_TEMPORAL_ROLES_SCHEMA = 'fsusblog.browser-temporal-roles.v1';
export const TEMPORAL_DOMAIN_PRODUCER_RECEIPT_SCHEMA = 'fsusblog.temporal-domain-producer-receipt.v1';
export const TEMPORAL_ENTITY_PRODUCER_RECEIPT_SCHEMA = 'fsusblog.temporal-entity-producer-receipt.v1';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const producerInventoryPath = path.join(
    repositoryRoot,
    'config/testing/temporal-domain-producer-inventory.json'
);
const stableId = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function fail(reasonCode, message, details = {})
{
    throw new TemporalContractError(reasonCode, message, details);
}

function plainObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value, field)
{
    if (typeof value !== 'string' || !value.trim())
    {
        fail('temporal.resolver-input-invalid', `${field} is required`);
    }
    return value.trim();
}

function stableIdentity(value, field)
{
    const normalized = requiredText(value, field);
    if (!stableId.test(normalized))
    {
        fail('temporal.resolver-input-invalid', `${field} is not a stable identity`);
    }
    return normalized;
}

function normalizeFixtureIdentity(value)
{
    if (!plainObject(value))
    {
        fail('temporal.resolver-input-invalid', 'fixtureIdentity is required');
    }
    const allowed = new Set(['producerId', 'runId', 'namespace', 'fixtureId', 'planDigest']);
    const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
    if (unknown.length > 0)
    {
        fail('temporal.resolver-input-invalid', 'fixtureIdentity contains unknown fields', { unknown });
    }
    const normalized = {
        producerId: stableIdentity(value.producerId, 'fixtureIdentity.producerId'),
        runId: requiredText(value.runId, 'fixtureIdentity.runId'),
        namespace: requiredText(value.namespace, 'fixtureIdentity.namespace'),
        fixtureId: stableIdentity(value.fixtureId, 'fixtureIdentity.fixtureId')
    };
    if (value.planDigest !== undefined)
    {
        if (typeof value.planDigest !== 'string' || !digestPattern.test(value.planDigest))
        {
            fail('temporal.resolver-input-invalid', 'fixtureIdentity.planDigest must be a sha256 digest');
        }
        normalized.planDigest = value.planDigest;
    }
    return Object.freeze(normalized);
}

function exactEpochMilliseconds(value)
{
    const normalized = requiredText(value, 'temporalContext.businessEpochUtc');
    const fraction = normalized.match(/\.(\d+)Z$/u)?.[1] ?? '';
    if (fraction.length > 3 && /[1-9]/u.test(fraction.slice(3)))
    {
        fail('temporal.precision-loss', 'business epoch exceeds exact millisecond precision');
    }
    const parsed = Date.parse(normalized);
    if (!Number.isSafeInteger(parsed))
    {
        fail('temporal.resolver-input-invalid', 'business epoch is not an exact ECMAScript instant');
    }
    return parsed;
}

function localProjection(epochMilliseconds, timezone, culture)
{
    let parts;
    try
    {
        parts = new Intl.DateTimeFormat(culture.locale, {
            calendar: culture.calendar,
            day: '2-digit',
            fractionalSecondDigits: 3,
            hour: '2-digit',
            hourCycle: 'h23',
            minute: '2-digit',
            month: '2-digit',
            second: '2-digit',
            timeZone: timezone,
            timeZoneName: 'longOffset',
            year: 'numeric'
        }).formatToParts(new Date(epochMilliseconds));
    }
    catch (error)
    {
        fail('temporal.timezone-culture-unsupported', 'timezone or culture projection is unsupported', {
            cause: error instanceof Error ? error.message : String(error),
            locale: culture.locale,
            timezone
        });
    }
    const projected = Object.fromEntries(parts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]));
    return Object.freeze({
        calendar: culture.calendar,
        day: projected.day,
        fractionalSecond: projected.fractionalSecond,
        hour: projected.hour,
        minute: projected.minute,
        month: projected.month,
        second: projected.second,
        timeZoneOffset: projected.timeZoneName,
        year: projected.year
    });
}

function verifyRelation(operator, left, right)
{
    if ((operator === '<' && !(left < right))
      || (operator === '<=' && !(left <= right)))
    {
        fail('temporal.invariant-mismatch', `cross-field invariant failed: ${left} ${operator} ${right}`);
    }
}

function resolvedRelations(catalog, shape, rolesById)
{
    const relations = [];
    for (const invariantId of shape.invariantIds)
    {
        const invariant = catalog.invariants.find((candidate) => candidate.id === invariantId);
        if (!invariant.roles.every((roleId) => rolesById.has(roleId)))
        {
            continue;
        }
        const roleInstants = invariant.roles.map((roleId) => rolesById.get(roleId).epochMilliseconds);
        if (invariant.kind === 'ordered-chain')
        {
            invariant.operators.forEach((operator, index) =>
                verifyRelation(operator, roleInstants[index], roleInstants[index + 1]));
        }
        if (invariant.kind === 'same-instant' && new Set(roleInstants).size !== 1)
        {
            fail('temporal.randomized-tie-break', `${invariant.id} must preserve exact same instants`);
        }
        if (invariant.kind === 'occurred-arrival'
          && !(roleInstants[0] <= roleInstants[1] && roleInstants[1] <= roleInstants[2]))
        {
            fail('temporal.invariant-mismatch', `${invariant.id} loses occurred/arrival/processing identity`);
        }
        relations.push({
            id: invariant.id,
            kind: invariant.kind,
            roleIds: [...invariant.roles],
            operators: invariant.operators ? [...invariant.operators] : [],
            tieBreakerId: invariant.tieBreakerId ?? null,
            verified: true
        });
    }
    return relations;
}

function clockAdvancePlan(roles)
{
    const targets = [...new Set(roles
        .map((role) => role.sourceOffsetMilliseconds)
        .filter((offset) => offset > 0))]
        .sort((left, right) => left - right);
    let previous = 0;
    return targets.map((target) =>
    {
        const step = {
            fromOffsetMilliseconds: previous,
            toOffsetMilliseconds: target,
            advanceByMilliseconds: target - previous,
            clockKind: 'business-wall',
            monotonicClockEffect: 'none'
        };
        previous = target;
        return step;
    });
}

function unsignedArtifact(artifact)
{
    const unsigned = { ...artifact };
    delete unsigned.contentDigest;
    delete unsigned.semanticDigest;
    return unsigned;
}

function semanticContent(artifact)
{
    return {
        schema: artifact.schema,
        contextIdentity: artifact.contextIdentity,
        fixtureIdentity: artifact.fixtureIdentity,
        catalog: artifact.catalog,
        shape: artifact.shape,
        projection: artifact.projection,
        roles: artifact.roles,
        relations: artifact.relations,
        clockAdvancePlan: artifact.clockAdvancePlan
    };
}

export function resolveTemporalRoles({
    temporalContext,
    shapeId,
    fixtureIdentity,
    roleIds
})
{
    const context = validateTemporalContext(temporalContext);
    const fixture = normalizeFixtureIdentity(fixtureIdentity);
    if (fixture.producerId !== context.producerId || fixture.runId !== context.schedulerRunId)
    {
        fail('temporal.resolver-context-mismatch', 'fixture identity does not exact-match sealed temporal context', {
            contextProducerId: context.producerId,
            contextRunId: context.schedulerRunId,
            fixtureProducerId: fixture.producerId,
            fixtureRunId: fixture.runId
        });
    }
    const loadedCatalog = readTemporalShapeCatalog();
    const resolvedShape = resolveTemporalShape(shapeId, { catalog: loadedCatalog });
    const shape = resolvedShape.shape;
    const requested = roleIds === undefined
        ? shape.timestampRoles.map((binding) => binding.roleId)
        : roleIds;
    if (!Array.isArray(requested) || requested.length > 1000)
    {
        fail('temporal.resolver-input-invalid', 'roleIds must be a bounded array of at most 1000 roles');
    }
    const selected = new Set();
    for (const roleId of requested)
    {
        stableIdentity(roleId, 'roleIds[]');
        if (selected.has(roleId))
        {
            fail('temporal.role-duplicate', `duplicate temporal role: ${roleId}`);
        }
        if (!shape.timestampRoles.some((binding) => binding.roleId === roleId))
        {
            fail('temporal.role-unknown', `${roleId} is not owned by temporal shape ${shape.id}`);
        }
        selected.add(roleId);
    }
    const baseEpochMilliseconds = exactEpochMilliseconds(context.businessEpochUtc);
    const timezoneCase = loadedCatalog.catalog.timezoneCases
        .find((candidate) => candidate.id === shape.timezoneCaseId);
    const cultureCase = loadedCatalog.catalog.cultureCases
        .find((candidate) => candidate.id === shape.cultureCaseId);
    const registryByRole = new Map(loadedCatalog.catalog.roleRegistry
        .map((role) => [role.id, role]));
    const roles = shape.timestampRoles
        .filter((binding) => selected.has(binding.roleId))
        .map((binding) =>
        {
            const registry = registryByRole.get(binding.roleId);
            if (registry.clockKind !== 'business-wall' || registry.semanticEffect !== 'included')
            {
                fail('temporal.metadata-semantic-mix', `${binding.roleId} cannot be resolved as a business role`);
            }
            const epochMilliseconds = baseEpochMilliseconds + binding.offsetMilliseconds;
            if (!Number.isSafeInteger(epochMilliseconds))
            {
                fail('temporal.precision-loss', `${binding.roleId} exceeds exact instant range`);
            }
            const role = {
                roleId: binding.roleId,
                owner: registry.owner,
                clockKind: registry.clockKind,
                semanticEffect: registry.semanticEffect,
                instantUtc: new Date(epochMilliseconds).toISOString(),
                epochMilliseconds,
                precision: 'millisecond',
                sourceOffsetMilliseconds: binding.offsetMilliseconds,
                timezone: timezoneCase.timezone,
                culture: cultureCase.locale,
                localRepresentation: localProjection(
                    epochMilliseconds,
                    timezoneCase.timezone,
                    cultureCase
                ),
                expectedBusinessState: binding.expectedBusinessState
            };
            return Object.freeze({ ...role, digest: digestCanonical(role) });
        });
    const rolesById = new Map(roles.map((role) => [role.roleId, role]));
    const artifact = {
        schema: RESOLVED_TEMPORAL_ROLES_SCHEMA,
        contextIdentity: {
            sourceCommit: context.sourceCommit,
            sourceFingerprint: context.sourceFingerprint,
            producerId: context.producerId,
            schedulerRunId: context.schedulerRunId,
            businessEpochUtc: context.businessEpochUtc,
            contextDigest: digestCanonical(context)
        },
        fixtureIdentity: fixture,
        catalog: {
            schema: loadedCatalog.catalog.schema,
            digest: loadedCatalog.catalogDigest
        },
        shape: {
            id: shape.id,
            digest: resolvedShape.shapeDigest,
            timezoneCaseId: shape.timezoneCaseId,
            cultureCaseId: shape.cultureCaseId
        },
        projection: {
            timezone: timezoneCase.timezone,
            locale: cultureCase.locale,
            backendCulture: cultureCase.backendCulture,
            calendar: cultureCase.calendar,
            precision: 'millisecond',
            rounding: 'none'
        },
        roles,
        relations: resolvedRelations(loadedCatalog.catalog, shape, rolesById),
        clockAdvancePlan: clockAdvancePlan(roles)
    };
    const semanticDigest = digestCanonical(semanticContent(artifact));
    return Object.freeze({
        ...artifact,
        semanticDigest,
        contentDigest: digestCanonical({ ...unsignedArtifact(artifact), semanticDigest })
    });
}

export function resolveTemporalRolesForProducer({
    temporalContext,
    namespace,
    fixtureId,
    planDigest,
    entityPlan
})
{
    const context = validateTemporalContext(temporalContext);
    const inventory = readTemporalDomainProducerInventory();
    const binding = inventory.producerBindings
        .find((candidate) => candidate.producerId === context.producerId);
    if (!binding)
    {
        fail('temporal.producer-unbound', `${context.producerId} has no semantic temporal role binding`);
    }
    if (binding.resolutionMode === 'entity-plan')
    {
        return resolveTemporalEntityRoles({ temporalContext: context, shapeId: binding.shapeId,
            fixtureIdentity: { producerId: context.producerId, runId: context.schedulerRunId, namespace, fixtureId, planDigest },
            entityPlan });
    }
    const roleIds = [...new Set(binding.fieldMappings.map((mapping) => mapping.roleId))];
    if (roleIds.length !== new Set(roleIds).size)
    {
        fail('temporal.producer-inventory-invalid', `${context.producerId} role projection is ambiguous`);
    }
    return resolveTemporalRoles({
        temporalContext: context,
        shapeId: binding.shapeId,
        fixtureIdentity: {
            producerId: context.producerId,
            runId: context.schedulerRunId,
            namespace: requiredText(namespace, 'namespace'),
            fixtureId: stableIdentity(fixtureId, 'fixtureId'),
            ...(planDigest === undefined ? {} : { planDigest })
        },
        roleIds
    });
}

export function readTemporalDomainProducerInventory()
{
    return validateTemporalDomainProducerInventory(JSON.parse(readFileSync(producerInventoryPath, 'utf8')));
}

/** Validate source field registrations without turning explicitly unsupported fields into bindings. */
export function validateTemporalDomainProducerInventory(inventory, { catalogState = readTemporalShapeCatalog() } = {})
{
    if (!plainObject(inventory) || inventory.schema !== 'fsusblog.temporal-domain-producer-inventory.v1'
      || inventory.catalog !== 'config/testing/temporal-shape-catalog.json'
      || inventory.resolvedArtifactSchema !== 'config/testing/resolved-temporal-roles.schema.json'
      || !Array.isArray(inventory.producerBindings))
    {
        fail('temporal.producer-inventory-invalid', 'temporal domain producer inventory is invalid');
    }
    const producerIds = new Set();
    for (const binding of inventory.producerBindings)
    {
        stableIdentity(binding?.producerId, 'producerBindings.producerId');
        stableIdentity(binding?.shapeId, `${binding.producerId}.shapeId`);
        if (producerIds.has(binding.producerId))
        {
            fail('temporal.producer-inventory-invalid', `duplicate producer binding: ${binding.producerId}`);
        }
        producerIds.add(binding.producerId);
        if (!Array.isArray(binding.implementations) || binding.implementations.length === 0
          || !Array.isArray(binding.fieldMappings) || binding.fieldMappings.length === 0)
        {
            fail('temporal.producer-inventory-invalid', `${binding.producerId} inventory is incomplete`);
        }
        let permittedRoles;
        if (binding.resolutionMode !== undefined)
        {
            if (binding.resolutionMode !== 'entity-plan' || !Array.isArray(binding.requiredRoleIds)
                || !Array.isArray(binding.scalarRoleIds))
            {
                fail('temporal.producer-inventory-invalid', 'entity producer requires exact resolution and role closure declarations');
            }
            const shape = resolveTemporalEntityShape(binding.shapeId, { catalog: catalogState }).shape;
            const required = [...new Set(shape.entityKinds.flatMap((kind) => kind.roles.map((role) => role.roleId)))];
            if (digestCanonical([...binding.requiredRoleIds].sort()) !== digestCanonical(required.sort()))
            {
                fail('temporal.producer-inventory-invalid', 'entity producer must bind the complete canonical role closure');
            }
            if (!Array.isArray(binding.unsupportedFields)
                || new Set(binding.scalarRoleIds).size !== binding.scalarRoleIds.length
                || binding.scalarRoleIds.some((roleId) => !catalogState.roleIds.has(roleId)))
            {
                fail('temporal.producer-inventory-invalid', 'entity producer requires explicit unsupported fields and canonical scalar roles');
            }
            permittedRoles = new Set([...required, ...binding.scalarRoleIds]);
        }
        else
        {
            permittedRoles = new Set(resolveTemporalShape(binding.shapeId, { catalog: catalogState }).shape.timestampRoles
                .map((role) => role.roleId));
        }
        const fields = new Set();
        for (const mapping of binding.fieldMappings)
        {
            stableIdentity(mapping?.field, `${binding.producerId}.field`);
            stableIdentity(mapping?.roleId, `${binding.producerId}.roleId`);
            stableIdentity(mapping?.consumer, `${binding.producerId}.consumer`);
            if (!catalogState.roleIds.has(mapping.roleId))
            {
                fail('temporal.producer-inventory-invalid', `${binding.producerId}.${mapping.field} references an unknown canonical role`);
            }
            if (!permittedRoles.has(mapping.roleId))
            {
                fail('temporal.producer-inventory-invalid', `${binding.producerId}.${mapping.field} is outside its declared temporal shape`);
            }
            if (fields.has(mapping.field))
            {
                fail('temporal.producer-inventory-invalid', `${binding.producerId} has duplicate field ${mapping.field}`);
            }
            fields.add(mapping.field);
        }
        const unsupportedFields = new Set();
        for (const unsupported of binding.unsupportedFields ?? [])
        {
            if (!plainObject(unsupported) || Object.keys(unsupported).sort().join(',') !== 'field,reason,roleId')
            {
                fail('temporal.producer-inventory-invalid', 'unsupported source field requires exact field, roleId and reason');
            }
            stableIdentity(unsupported.field, `${binding.producerId}.unsupportedField`);
            stableIdentity(unsupported.roleId, `${binding.producerId}.unsupportedRole`);
            if (!catalogState.roleIds.has(unsupported.roleId) || typeof unsupported.reason !== 'string' || !unsupported.reason.trim()
                || fields.has(unsupported.field) || unsupportedFields.has(unsupported.field))
            {
                fail('temporal.producer-inventory-invalid', 'unsupported source field cannot be mapped, duplicated or missing its canonical role/reason');
            }
            unsupportedFields.add(unsupported.field);
        }
    }
    return Object.freeze(inventory);
}

export function resolveTemporalRolesForProducerIfBound(input)
{
    const context = validateTemporalContext(input.temporalContext);
    const inventory = readTemporalDomainProducerInventory();
    if (!inventory.producerBindings.some((binding) => binding.producerId === context.producerId))
    {
        return null;
    }
    return resolveTemporalRolesForProducer(input);
}

function exactRoleDocument(role, baseEpochMilliseconds, shapeRole)
{
    const { digest, ...unsigned } = role;
    if (digestCanonical(unsigned) !== digest)
    {
        fail('temporal.resolved-artifact-tamper', `${role.roleId} role digest mismatch`);
    }
    if (role.epochMilliseconds !== baseEpochMilliseconds + shapeRole.offsetMilliseconds
      || role.instantUtc !== new Date(role.epochMilliseconds).toISOString()
      || role.sourceOffsetMilliseconds !== shapeRole.offsetMilliseconds
      || role.precision !== 'millisecond')
    {
        fail('temporal.cross-runtime-mismatch', `${role.roleId} instant/offset/precision mismatch`);
    }
}

export function verifyResolvedTemporalArtifact(artifact, { temporalContext } = {})
{
    if (artifact?.schema === 'fsusblog.resolved-temporal-entities.v1')
    {
        if (!temporalContext)
        {
            fail('temporal.resolver-input-invalid', 'entity verification requires its original temporal context');
        }
        const expected = resolveTemporalEntityRoles({ temporalContext, fixtureIdentity: artifact.fixtureIdentity,
            shapeId: artifact.shape?.id, entityPlan: artifact.entityPlan });
        if (digestCanonical(expected) !== digestCanonical(artifact))
        {
            fail('temporal.entity-facts-invalid', 'entity artifact differs from the complete ordinary producer plan');
        }
        return Object.freeze({ qualificationEligible: false, entityCount: expected.entities.length,
            semanticDigest: expected.semanticDigest, contentDigest: expected.contentDigest });
    }
    if (!plainObject(artifact) || artifact.schema !== RESOLVED_TEMPORAL_ROLES_SCHEMA
      || !Array.isArray(artifact.roles) || !Array.isArray(artifact.relations)
      || !Array.isArray(artifact.clockAdvancePlan))
    {
        fail('temporal.resolved-artifact-invalid', 'resolved temporal artifact is missing or malformed');
    }
    const loadedCatalog = readTemporalShapeCatalog();
    if (artifact.catalog?.digest !== loadedCatalog.catalogDigest
      || artifact.catalog?.schema !== loadedCatalog.catalog.schema)
    {
        fail('temporal.catalog-stale', 'resolved artifact catalog identity is stale');
    }
    const resolvedShape = resolveTemporalShape(artifact.shape?.id, { catalog: loadedCatalog });
    if (artifact.shape?.digest !== resolvedShape.shapeDigest)
    {
        fail('temporal.shape-stale', 'resolved artifact shape identity is stale');
    }
    const baseEpochMilliseconds = exactEpochMilliseconds(artifact.contextIdentity?.businessEpochUtc);
    const shapeRoles = new Map(resolvedShape.shape.timestampRoles
        .map((binding) => [binding.roleId, binding]));
    const seen = new Set();
    for (const role of artifact.roles)
    {
        if (seen.has(role.roleId) || !shapeRoles.has(role.roleId))
        {
            fail('temporal.role-duplicate', `${role.roleId} is duplicate or outside the shape`);
        }
        seen.add(role.roleId);
        exactRoleDocument(role, baseEpochMilliseconds, shapeRoles.get(role.roleId));
    }
    const recomputedRelations = resolvedRelations(
        loadedCatalog.catalog,
        resolvedShape.shape,
        new Map(artifact.roles.map((role) => [role.roleId, role]))
    );
    if (digestCanonical(recomputedRelations) !== digestCanonical(artifact.relations)
      || digestCanonical(clockAdvancePlan(artifact.roles)) !== digestCanonical(artifact.clockAdvancePlan))
    {
        fail('temporal.resolved-artifact-tamper', 'relations or clock advance plan mismatch');
    }
    if (artifact.semanticDigest !== digestCanonical(semanticContent(artifact))
      || artifact.contentDigest !== digestCanonical({
          ...unsignedArtifact(artifact),
          semanticDigest: artifact.semanticDigest
      }))
    {
        fail('temporal.resolved-artifact-tamper', 'resolved artifact digest mismatch');
    }
    if (temporalContext !== undefined)
    {
        const context = validateTemporalContext(temporalContext);
        if (artifact.contextIdentity.contextDigest !== digestCanonical(context)
          || artifact.contextIdentity.producerId !== context.producerId
          || artifact.contextIdentity.schedulerRunId !== context.schedulerRunId
          || artifact.contextIdentity.sourceCommit !== context.sourceCommit
          || artifact.contextIdentity.sourceFingerprint !== context.sourceFingerprint
          || artifact.contextIdentity.businessEpochUtc !== context.businessEpochUtc)
        {
            fail('temporal.resolver-context-mismatch', 'resolved artifact does not bind the supplied context');
        }
    }
    return Object.freeze({
        qualificationEligible: true,
        roleCount: artifact.roles.length,
        semanticDigest: artifact.semanticDigest,
        contentDigest: artifact.contentDigest
    });
}

function entityKeys(value, keys, location)
{
    if (!plainObject(value) || digestCanonical(Object.keys(value).sort()) !== digestCanonical([...keys].sort()))
    {
        fail('temporal.entity-facts-invalid', `${location} requires exactly ${keys.join(', ')}`);
    }
}

function boundedInteger(value, minimum, location)
{
    if (!Number.isSafeInteger(value) || value < minimum || value > 1_000_000)
    {
        fail('temporal.entity-facts-invalid', `${location} is outside its explicit coordinate range`);
    }
    return value;
}

function entityIdentity(coordinate)
{
    return JSON.stringify([coordinate.entityKind, coordinate.semanticIdentity]);
}

function explicitEntityIdentity(value, location)
{
    if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.trim() !== value)
    {
        fail('temporal.entity-facts-invalid', `${location} requires a bounded explicit producer identity`);
    }
    return value;
}

function entityRoleFacts(entity, kind, epoch)
{
    entityKeys(entity.stateFacts, kind.stateFacts, 'stateFacts');
    if (Object.values(entity.stateFacts).some((value) => typeof value !== 'boolean'))
    {
        fail('temporal.entity-facts-invalid', 'state facts must be explicit booleans');
    }
    entityKeys(entity.facts, kind.roles.map((role) => role.roleId), 'complete entity role closure');
    const roles = [];
    for (const binding of kind.roles)
    {
        const fact = entity.facts[binding.roleId];
        entityKeys(fact, ['applicability', 'instantUtc'], binding.roleId);
        const present = binding.presence === 'always' || entity.stateFacts[binding.presence];
        if (!present)
        {
            if (fact.applicability !== binding.absent || fact.instantUtc !== null)
            {
                fail('temporal.entity-facts-invalid', `${binding.roleId} must explicitly declare ${binding.absent} for this state`);
            }
            roles.push({ roleId: binding.roleId, applicability: binding.absent, instantUtc: null, epochMilliseconds: null });
            continue;
        }
        if (fact.applicability !== 'instant')
        {
            fail('temporal.entity-facts-invalid', `${binding.roleId} requires an ordinary producer instant`);
        }
        validateBusinessEpochUtc(fact.instantUtc);
        const milliseconds = Date.parse(fact.instantUtc);
        if (milliseconds > epoch)
        {
            fail('temporal.entity-facts-invalid', `${binding.roleId} is later than observed business time`);
        }
        roles.push({ roleId: binding.roleId, applicability: 'instant', instantUtc: new Date(milliseconds).toISOString(), epochMilliseconds: milliseconds });
    }
    return roles;
}

function validateEntityDistribution(distribution, entities, shape, producerId)
{
    entityKeys(distribution, ['kind', 'tier', 'ordinalBase', 'counts', 'stateCounts', 'rootNested'], 'distribution');
    const expectedKind = producerId === 'scale-data' ? 'scale' : producerId === 'development-demo' ? 'demo' : null;
    if (distribution.kind !== expectedKind || ![0, 1].includes(distribution.ordinalBase)
        || (expectedKind === 'scale' ? !['scale-xs', 'scale-s', 'scale-m', 'scale-l-nightly'].includes(distribution.tier)
            : distribution.tier !== null) || !Array.isArray(distribution.rootNested))
    {
        fail('temporal.entity-facts-invalid', 'producer distribution kind, tier, ordinal base and relationships are required');
    }
    entityKeys(distribution.counts, shape.entityKinds.map((kind) => kind.kind), 'distribution counts');
    entityKeys(distribution.stateCounts, shape.entityKinds.map((kind) => kind.kind), 'distribution state counts');
    const identities = new Map();
    for (const entity of entities)
    {
        const key = entityIdentity(entity.coordinate);
        const previous = identities.get(key);
        if (previous && previous.coordinate.ordinal !== entity.coordinate.ordinal)
        {
            fail('temporal.entity-facts-invalid', 'a semantic entity changed its declared ordinal');
        }
        if (previous && (previous.coordinate.revisionNumber ?? 0) > (entity.coordinate.revisionNumber ?? 0))
        {
            fail('temporal.entity-facts-invalid', 'entity histories must declare revision coordinates in order');
        }
        identities.set(key, entity);
    }
    for (const kind of shape.entityKinds)
    {
        const rows = [...identities.values()].filter((entity) => entity.coordinate.entityKind === kind.kind);
        const count = boundedInteger(distribution.counts[kind.kind], 0, `${kind.kind}.count`);
        if (rows.length !== count || new Set(rows.map((entity) => entity.coordinate.ordinal)).size !== count
            || rows.some((entity) => entity.coordinate.ordinal < distribution.ordinalBase
                || entity.coordinate.ordinal >= distribution.ordinalBase + count))
        {
            fail('temporal.entity-facts-invalid', `${kind.kind} count/ordinal distribution does not match the supplied entities`);
        }
        entityKeys(distribution.stateCounts[kind.kind], kind.states, `${kind.kind} state counts`);
        for (const state of kind.states)
        {
            if (boundedInteger(distribution.stateCounts[kind.kind][state], 0, 'state count') !== rows.filter((entity) => entity.state === state).length)
            {
                fail('temporal.entity-facts-invalid', 'state distribution differs from the final supplied entity coordinates');
            }
        }
    }
    const comments = new Map([...identities.values()].filter((entity) => entity.coordinate.entityKind === 'comment')
        .map((entity) => [entity.coordinate.semanticIdentity, entity]));
    const links = new Map();
    for (const link of distribution.rootNested)
    {
        entityKeys(link, ['commentIdentity', 'parentIdentity', 'rootIdentity'], 'root/nested mapping');
        if (!comments.has(link.commentIdentity) || links.has(link.commentIdentity)
            || (link.parentIdentity === null ? link.rootIdentity !== null
                : !comments.has(link.rootIdentity) || !comments.has(link.parentIdentity)))
        {
            fail('temporal.entity-facts-invalid', 'comment relationships require exact plan-owned identities');
        }
        links.set(link.commentIdentity, link);
    }
    if (links.size !== comments.size)
    {
        fail('temporal.entity-facts-invalid', 'root/nested mapping must cover every comment');
    }
    for (const [identity, link] of links)
    {
        let current = identity;
        const visited = new Set();
        while (links.get(current).parentIdentity !== null)
        {
            if (visited.has(current))
            {
                fail('temporal.entity-facts-invalid', 'comment relationships contain a cycle');
            }
            visited.add(current);
            current = links.get(current).parentIdentity;
        }
        if ((link.parentIdentity !== null && current !== link.rootIdentity)
            || comments.get(identity).coordinate.articleIdentity !== comments.get(current).coordinate.articleIdentity)
        {
            fail('temporal.entity-facts-invalid', 'comment root mapping differs from its article-owned chain');
        }
        if (link.parentIdentity !== null)
        {
            const createdAt = (semanticIdentity) => comments.get(semanticIdentity).roles
                .find((role) => role.roleId === 'comment.created').epochMilliseconds;
            verifyRelation(shape.parentChronology.operator, createdAt(link.parentIdentity), createdAt(identity));
        }
    }
    for (const entity of comments.values())
    {
        if (!identities.has(JSON.stringify(['article', entity.coordinate.articleIdentity])))
        {
            fail('temporal.entity-facts-invalid', 'comment article identity is missing from the producer plan');
        }
    }
}

function entityHistoryRelations(entities, shape, catalog)
{
    const revisions = new Map();
    const publications = new Map();
    const created = new Map();
    const pointIds = new Set();
    for (const entity of entities)
    {
        const coordinate = entity.coordinate;
        const identity = entityIdentity(coordinate);
        const pointId = JSON.stringify([coordinate.entityKind, coordinate.semanticIdentity, coordinate.operationIdentity]);
        if (pointIds.has(pointId))
        {
            fail('temporal.entity-facts-invalid', 'duplicate explicit entity operation coordinate');
        }
        pointIds.add(pointId);
        const byRole = new Map(entity.roles.map((role) => [role.roleId, role]));
        const createdRole = byRole.get(`${coordinate.entityKind}.created`);
        if (createdRole)
        {
            if (created.has(identity) && created.get(identity) !== createdRole.epochMilliseconds)
            {
                fail('temporal.entity-facts-invalid', 'entity creation instant changed across history');
            }
            created.set(identity, createdRole.epochMilliseconds);
        }
        if (coordinate.entityKind === 'article')
        {
            const revisionKey = `${identity}:${coordinate.revisionNumber}`;
            const revision = byRole.get('article.revision');
            if (revisions.has(revisionKey) && revisions.get(revisionKey).epochMilliseconds !== revision.epochMilliseconds)
            {
                fail('temporal.entity-facts-invalid', 'revision instant changed across history coordinates');
            }
            if (coordinate.revisionNumber !== null)
            {
                revisions.set(revisionKey, revision);
            }
            if (coordinate.publicationNumber !== null)
            {
                const publication = [coordinate.publicationRevisionNumber, byRole.get('article.publication').epochMilliseconds];
                const key = `${identity}:${coordinate.publicationNumber}`;
                if ((publications.has(key) && digestCanonical(publications.get(key)) !== digestCanonical(publication))
                    || byRole.get('article.published').epochMilliseconds !== publication[1])
                {
                    fail('temporal.entity-facts-invalid', 'publication history or published instant is inconsistent');
                }
                publications.set(key, publication);
            }
        }
    }
    const revisionTimes = new Map();
    for (const entity of entities.filter((candidate) => candidate.coordinate.entityKind === 'article' && candidate.coordinate.revisionNumber !== null)
        .sort((left, right) => left.coordinate.revisionNumber - right.coordinate.revisionNumber))
    {
        const identity = entityIdentity(entity.coordinate);
        const time = revisions.get(`${identity}:${entity.coordinate.revisionNumber}`).epochMilliseconds;
        if (revisionTimes.has(identity) && revisionTimes.get(identity) > time)
        {
            fail('temporal.entity-facts-invalid', 'revision history moves backwards in business time');
        }
        revisionTimes.set(identity, time);
    }
    return entities.map((entity) =>
    {
        const kind = shape.entityKinds.find((candidate) => candidate.kind === entity.coordinate.entityKind);
        const roles = new Map(entity.roles.map((role) => [role.roleId, role]));
        return kind.invariantIds.map((id) =>
        {
            const invariant = catalog.invariants.find((candidate) => candidate.id === id);
            const values = invariant.roles.map((roleId) => roles.get(roleId));
            if (id === 'article-lifecycle' && entity.coordinate.publicationNumber !== null)
            {
                const revision = revisions.get(`${entityIdentity(entity.coordinate)}:${entity.coordinate.publicationRevisionNumber}`);
                if (!revision)
                {
                    fail('temporal.entity-facts-invalid', 'publication requires its explicitly referenced revision coordinate');
                }
                values[1] = revision;
            }
            const present = values.map((value, index) => ({ value, index })).filter(({ value }) => value.applicability === 'instant');
            for (let index = 1; index < present.length; index++)
            {
                const previous = present[index - 1];
                const current = present[index];
                const operator = invariant.operators.slice(previous.index, current.index).includes('<') ? '<' : '<=';
                verifyRelation(operator, previous.value.epochMilliseconds, current.value.epochMilliseconds);
            }
            return { id, roleIds: [...invariant.roles], status: present.length === values.length ? 'verified' : 'state-bound',
                nullRoleIds: values.filter((value) => value.applicability !== 'instant').map((value) => value.roleId) };
        });
    });
}

/** Resolve explicit producer entity/history facts; missing distribution or nullable role closure is refused. */
export function resolveTemporalEntityRoles({ temporalContext, fixtureIdentity, shapeId, entityPlan })
{
    const context = validateTemporalContext(temporalContext);
    const fixture = normalizeFixtureIdentity(fixtureIdentity);
    if (fixture.producerId !== context.producerId || fixture.runId !== context.schedulerRunId)
    {
        fail('temporal.resolver-context-mismatch', 'entity plan does not match its producer/run context');
    }
    entityKeys(entityPlan, ['schema', 'sourcePlanDigest', 'distribution', 'entities'], 'entityPlan');
    if (entityPlan.schema !== 'fsusblog.temporal-entity-plan.v1' || !digestPattern.test(entityPlan.sourcePlanDigest)
        || entityPlan.sourcePlanDigest !== fixture.planDigest || !Array.isArray(entityPlan.entities) || entityPlan.entities.length > 1_000_000)
    {
        fail('temporal.entity-facts-invalid', 'entity plan requires its original plan digest and bounded explicit entities');
    }
    const loaded = readTemporalShapeCatalog();
    const { shape, shapeDigest } = resolveTemporalEntityShape(shapeId, { catalog: loaded });
    const entities = entityPlan.entities.map((entity) =>
    {
        entityKeys(entity, ['coordinate', 'state', 'stateFacts', 'facts'], 'entity');
        const coordinate = entity.coordinate;
        entityKeys(coordinate, ['entityKind', 'semanticIdentity', 'operationIdentity', 'ordinal', 'revisionNumber',
            'publicationNumber', 'publicationRevisionNumber', 'articleIdentity'], 'entity coordinate');
        explicitEntityIdentity(coordinate.semanticIdentity, 'semanticIdentity');
        explicitEntityIdentity(coordinate.operationIdentity, 'operationIdentity');
        boundedInteger(coordinate.ordinal, 0, 'ordinal');
        const kind = shape.entityKinds.find((candidate) => candidate.kind === coordinate.entityKind);
        if (!kind || !kind.states.includes(entity.state))
        {
            fail('temporal.entity-facts-invalid', 'entity kind/state is unsupported by the canonical shape');
        }
        entityKeys(entity.stateFacts, kind.stateFacts, 'stateFacts');
        const hasRevision = kind.revisionRequired && entity.stateFacts.hasRevision === true;
        if (hasRevision ? !Number.isSafeInteger(coordinate.revisionNumber) || coordinate.revisionNumber < 1
            : coordinate.revisionNumber !== null)
        {
            fail('temporal.entity-facts-invalid', 'revision coordinate must match the entity kind');
        }
        const published = coordinate.publicationNumber !== null;
        if (published && (!kind.publicationAllowed || !Number.isSafeInteger(coordinate.publicationNumber)
            || coordinate.publicationNumber < 1 || !Number.isSafeInteger(coordinate.publicationRevisionNumber)
            || coordinate.publicationRevisionNumber < 1 || coordinate.publicationRevisionNumber > coordinate.revisionNumber)
            || !published && coordinate.publicationRevisionNumber !== null
            || coordinate.entityKind === 'article' && (entity.stateFacts.hasPublication !== published || published && !hasRevision
                || entity.state === 'published' && !published || entity.state === 'draft' && published)
            || (coordinate.entityKind === 'comment' ? typeof coordinate.articleIdentity !== 'string' : coordinate.articleIdentity !== null))
        {
            fail('temporal.entity-facts-invalid', 'publication/state/article coordinates are inconsistent');
        }
        return { coordinate: { ...coordinate }, state: entity.state, stateFacts: { ...entity.stateFacts },
            roles: entityRoleFacts(entity, kind, Date.parse(context.businessEpochUtc)) };
    });
    validateEntityDistribution(entityPlan.distribution, entities, shape, context.producerId);
    const relations = entityHistoryRelations(entities, shape, loaded.catalog);
    const commentLinks = new Map(entityPlan.distribution.rootNested.map((link) => [link.commentIdentity, link]));
    for (const [index, entity] of entities.entries())
    {
        if (entity.coordinate.entityKind === 'comment')
        {
            const link = commentLinks.get(entity.coordinate.semanticIdentity);
            relations[index].push({ id: 'comment-parent-chronology', roleIds: [shape.parentChronology.roleId],
                status: link.parentIdentity === null ? 'state-bound' : 'verified', nullRoleIds: [],
                parentIdentity: link.parentIdentity });
        }
    }
    const binding = readTemporalDomainProducerInventory().producerBindings.find((candidate) => candidate.producerId === context.producerId);
    const scalarRoleIds = binding?.scalarRoleIds ?? [];
    const scalarRoles = scalarRoleIds.length === 0 ? null : resolveTemporalRoles({ temporalContext: context,
        fixtureIdentity: fixture, shapeId: 'auth-security-messaging-account-lifecycle', roleIds: scalarRoleIds });
    const artifact = { schema: 'fsusblog.resolved-temporal-entities.v1', contextIdentity: {
        producerId: context.producerId, schedulerRunId: context.schedulerRunId, contextDigest: digestCanonical(context),
        sourceCommit: context.sourceCommit, sourceFingerprint: context.sourceFingerprint, businessEpochUtc: context.businessEpochUtc },
    fixtureIdentity: fixture, catalog: { schema: loaded.catalog.schema, digest: loaded.catalogDigest },
    shape: { id: shape.id, digest: shapeDigest }, entityPlan: structuredClone(entityPlan), entityPlanDigest: digestCanonical(entityPlan),
    entities: entities.map((entity, index) => ({ ...entity, relations: relations[index] })), scalarRoles,
    scalarRolesPurpose: 'canonical-planned-offsets', unsupportedFields: structuredClone(binding?.unsupportedFields ?? []), qualificationEligible: false };
    const semanticDigest = digestCanonical(artifact);
    return Object.freeze({ ...artifact, semanticDigest, contentDigest: digestCanonical({ ...artifact, semanticDigest }) });
}

export function loadResolvedTemporalRoles(env = process.env, { temporalContext } = {})
{
    const raw = requiredText(
        env.FSUSBLOG_RESOLVED_TEMPORAL_ROLES_JSON,
        'FSUSBLOG_RESOLVED_TEMPORAL_ROLES_JSON'
    );
    let artifact;
    try
    {
        artifact = JSON.parse(raw);
    }
    catch
    {
        fail('temporal.resolved-artifact-invalid', 'resolved temporal role environment is not JSON');
    }
    verifyResolvedTemporalArtifact(artifact, { temporalContext });
    if (env.FSUSBLOG_TEMPORAL_ROLE_ARTIFACT_DIGEST !== artifact.contentDigest)
    {
        fail('temporal.resolved-artifact-tamper', 'resolved temporal role environment digest mismatch');
    }
    return Object.freeze(artifact);
}

export function requireResolvedTemporalRole(artifact, roleId)
{
    verifyResolvedTemporalArtifact(artifact);
    const normalized = stableIdentity(roleId, 'roleId');
    const role = artifact.roles.find((candidate) => candidate.roleId === normalized);
    if (!role)
    {
        fail('temporal.role-missing', `resolved artifact is missing role ${normalized}`);
    }
    return role;
}

/** Read an explicitly named entity operation role, retaining authorized null rather than coercing a date. */
export function requireResolvedTemporalEntityRole(artifact, coordinate, roleId, { temporalContext } = {})
{
    verifyResolvedTemporalArtifact(artifact, { temporalContext });
    entityKeys(coordinate, ['entityKind', 'semanticIdentity', 'operationIdentity'], 'entity role lookup');
    const entity = artifact.entities.find((candidate) => candidate.coordinate.entityKind === coordinate.entityKind
        && candidate.coordinate.semanticIdentity === coordinate.semanticIdentity
        && candidate.coordinate.operationIdentity === coordinate.operationIdentity);
    const role = entity?.roles.find((candidate) => candidate.roleId === roleId);
    if (!role)
    {
        fail('temporal.role-missing', 'the exact entity operation coordinate or role is missing');
    }
    return role;
}

export function createTemporalDomainProducerReceipt(artifact, { temporalContext } = {})
{
    verifyResolvedTemporalArtifact(artifact, { temporalContext });
    if (artifact.schema === 'fsusblog.resolved-temporal-entities.v1')
    {
        const receipt = {
            schema: TEMPORAL_ENTITY_PRODUCER_RECEIPT_SCHEMA,
            qualificationEligible: false,
            fixtureIdentity: structuredClone(artifact.fixtureIdentity),
            temporalContext: structuredClone(validateTemporalContext(temporalContext)),
            contextIdentity: structuredClone(artifact.contextIdentity),
            catalog: structuredClone(artifact.catalog),
            shape: structuredClone(artifact.shape),
            plan: { schema: artifact.entityPlan.schema, sourcePlanDigest: artifact.entityPlan.sourcePlanDigest,
                contentDigest: artifact.entityPlanDigest, distribution: structuredClone(artifact.entityPlan.distribution) },
            entities: artifact.entities.map((entity) =>
            {
                const value = structuredClone(entity);
                return { ...value, contentDigest: digestCanonical(value) };
            }),
            scalarRolesPurpose: artifact.scalarRolesPurpose,
            scalarRoles: artifact.scalarRoles === null ? null : createTemporalDomainProducerReceipt(artifact.scalarRoles),
            unsupportedFields: structuredClone(artifact.unsupportedFields),
            semanticDigest: artifact.semanticDigest,
            resolvedArtifactDigest: artifact.contentDigest
        };
        return Object.freeze({ ...receipt, contentDigest: digestCanonical(receipt) });
    }
    const receipt = {
        schema: TEMPORAL_DOMAIN_PRODUCER_RECEIPT_SCHEMA,
        producerId: artifact.fixtureIdentity.producerId,
        fixtureIdentity: artifact.fixtureIdentity,
        contextDigest: artifact.contextIdentity.contextDigest,
        catalogDigest: artifact.catalog.digest,
        shapeId: artifact.shape.id,
        shapeDigest: artifact.shape.digest,
        roles: artifact.roles.map((role) => ({
            roleId: role.roleId,
            expectedBusinessState: role.expectedBusinessState,
            digest: role.digest
        })),
        invariantIds: artifact.relations.map((relation) => relation.id),
        semanticDigest: artifact.semanticDigest,
        resolvedArtifactDigest: artifact.contentDigest
    };
    return Object.freeze({ ...receipt, contentDigest: digestCanonical(receipt) });
}

/** Reconstruct the ordinary receipt from the original complete plan and context; no execution is implied. */
export function verifyTemporalDomainProducerReceipt(receipt, { artifact, temporalContext } = {})
{
    const expected = createTemporalDomainProducerReceipt(artifact, { temporalContext });
    if (digestCanonical(expected) !== digestCanonical(receipt))
    {
        fail('temporal.producer-receipt-mismatch', 'producer receipt differs from the original resolved plan/context');
    }
    return Object.freeze({ schema: expected.schema, contentDigest: expected.contentDigest,
        resolvedArtifactDigest: expected.resolvedArtifactDigest,
        ...(expected.qualificationEligible === false ? { qualificationEligible: false } : {}) });
}

/** Prepare the existing producer file/env carriers without declaring generation or runtime acceptance. */
export function createTemporalEntityTransport({ artifact, temporalContext })
{
    if (artifact?.schema !== 'fsusblog.resolved-temporal-entities.v1')
    {
        fail('temporal.resolver-input-invalid', 'entity transport requires the ordinary entity artifact');
    }
    const receipt = createTemporalDomainProducerReceipt(artifact, { temporalContext });
    return Object.freeze({ schema: 'fsusblog.temporal-entity-transport.v1', qualificationEligible: false,
        receiptFileName: 'temporal-domain-producer-receipt.json', receipt,
        artifactDigest: artifact.contentDigest, receiptDigest: receipt.contentDigest,
        environment: Object.freeze({ FSUSBLOG_TEMPORAL_CONTEXT_JSON: JSON.stringify(receipt.temporalContext),
            FSUSBLOG_RESOLVED_TEMPORAL_ROLES_JSON: JSON.stringify(artifact),
            FSUSBLOG_TEMPORAL_ROLE_ARTIFACT_DIGEST: artifact.contentDigest }) });
}

export function projectTemporalRolesForPostgres(artifact)
{
    verifyResolvedTemporalArtifact(artifact);
    return Object.freeze({
        schema: POSTGRES_TEMPORAL_ROLES_SCHEMA,
        contextDigest: artifact.contextIdentity.contextDigest,
        catalogDigest: artifact.catalog.digest,
        shapeDigest: artifact.shape.digest,
        timezone: artifact.projection.timezone,
        roles: artifact.roles.map((role) => ({
            roleId: role.roleId,
            instantUtc: role.instantUtc,
            timestamptzLiteral: `timestamptz '${role.instantUtc}'`,
            expectedBusinessState: role.expectedBusinessState,
            digest: role.digest
        })),
        semanticDigest: artifact.semanticDigest
    });
}

export function projectTemporalRolesForDotNet(artifact)
{
    verifyResolvedTemporalArtifact(artifact);
    return Object.freeze({
        schema: DOTNET_TEMPORAL_ROLES_SCHEMA,
        contextDigest: artifact.contextIdentity.contextDigest,
        catalogDigest: artifact.catalog.digest,
        shapeDigest: artifact.shape.digest,
        roles: artifact.roles.map((role) => ({
            roleId: role.roleId,
            dateTimeOffsetUtc: role.instantUtc,
            unixTimeMilliseconds: role.epochMilliseconds,
            expectedBusinessState: role.expectedBusinessState,
            digest: role.digest
        })),
        semanticDigest: artifact.semanticDigest
    });
}

export function projectTemporalRolesForBrowser(artifact)
{
    verifyResolvedTemporalArtifact(artifact);
    return Object.freeze({
        schema: BROWSER_TEMPORAL_ROLES_SCHEMA,
        contextDigest: artifact.contextIdentity.contextDigest,
        catalogDigest: artifact.catalog.digest,
        shapeDigest: artifact.shape.digest,
        timezoneId: artifact.projection.timezone,
        locale: artifact.projection.locale,
        roles: artifact.roles.map((role) => ({
            roleId: role.roleId,
            instantUtc: role.instantUtc,
            localRepresentation: role.localRepresentation,
            expectedBusinessState: role.expectedBusinessState,
            digest: role.digest
        })),
        semanticDigest: artifact.semanticDigest
    });
}

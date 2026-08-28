import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    digestCanonical,
    TemporalContractError,
    validateTemporalContext
} from './temporal-context.mjs';
import {
    readTemporalShapeCatalog,
    resolveTemporalShape
} from './temporal-shape-catalog.mjs';

export const RESOLVED_TEMPORAL_ROLES_SCHEMA = 'fsusblog.resolved-temporal-roles.v1';
export const POSTGRES_TEMPORAL_ROLES_SCHEMA = 'fsusblog.postgres-temporal-roles.v1';
export const DOTNET_TEMPORAL_ROLES_SCHEMA = 'fsusblog.dotnet-temporal-roles.v1';
export const BROWSER_TEMPORAL_ROLES_SCHEMA = 'fsusblog.browser-temporal-roles.v1';
export const TEMPORAL_DOMAIN_PRODUCER_RECEIPT_SCHEMA = 'fsusblog.temporal-domain-producer-receipt.v1';

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
    const { contentDigest, semanticDigest, ...unsigned } = artifact;
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
    planDigest
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
    const inventory = JSON.parse(readFileSync(producerInventoryPath, 'utf8'));
    if (inventory.schema !== 'fsusblog.temporal-domain-producer-inventory.v1'
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
        const fields = new Set();
        for (const mapping of binding.fieldMappings)
        {
            stableIdentity(mapping?.field, `${binding.producerId}.field`);
            stableIdentity(mapping?.roleId, `${binding.producerId}.roleId`);
            stableIdentity(mapping?.consumer, `${binding.producerId}.consumer`);
            if (fields.has(mapping.field))
            {
                fail('temporal.producer-inventory-invalid', `${binding.producerId} has duplicate field ${mapping.field}`);
            }
            fields.add(mapping.field);
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

export function createTemporalDomainProducerReceipt(artifact)
{
    verifyResolvedTemporalArtifact(artifact);
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

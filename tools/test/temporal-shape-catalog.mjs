import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    canonicalJson,
    digestCanonical,
    TemporalContractError
} from './temporal-context.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = path.join(repositoryRoot, 'config/testing/temporal-shape-catalog.json');
const loginSessionPolicyPath = path.join(repositoryRoot, 'src/backend/Services/UserLoginWorkflowService.cs');
const refreshSessionPolicyPath = path.join(repositoryRoot, 'src/backend/Services/UserSessionCommandService.cs');

export const TEMPORAL_SHAPE_CATALOG_SCHEMA = 'fsusblog.temporal-shape-catalog.v1';
export const TEMPORAL_SHAPE_SCHEMA = 'fsusblog.temporal-shape.v1';

const stableId = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const forbiddenAbsoluteInstant = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u;

function fail(reasonCode, message, details = {})
{
    throw new TemporalContractError(reasonCode, message, details);
}

function plainObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, required, optional, location)
{
    if (!plainObject(value))
    {
        fail('temporal.catalog-invalid', `${location} must be an object`);
    }
    const allowed = new Set([...required, ...optional]);
    const missing = required.filter((key) => !(key in value));
    const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
    if (missing.length > 0 || unknown.length > 0)
    {
        fail('temporal.catalog-invalid', `${location} has a closed-schema violation`, {
            location,
            missing,
            unknown
        });
    }
}

function exactId(value, location)
{
    if (typeof value !== 'string' || !stableId.test(value))
    {
        fail('temporal.catalog-invalid', `${location} must be a stable ID`);
    }
    return value;
}

function integer(value, location)
{
    if (!Number.isSafeInteger(value))
    {
        fail('temporal.catalog-invalid', `${location} must be a safe integer`);
    }
    return value;
}

function uniqueIds(rows, location)
{
    if (!Array.isArray(rows))
    {
        fail('temporal.catalog-invalid', `${location} must be an array`);
    }
    const ids = new Set();
    for (const [index, row] of rows.entries())
    {
        const id = exactId(row?.id, `${location}[${index}].id`);
        if (ids.has(id))
        {
            fail('temporal.catalog-invalid', `duplicate ${location} ID: ${id}`);
        }
        ids.add(id);
    }
    return ids;
}

export function temporalShapeContent(shape)
{
    const content = { ...shape };
    delete content.contentDigest;
    return content;
}

export function temporalShapeDigest(shape)
{
    return digestCanonical(temporalShapeContent(shape));
}

function validateRole(role, roleIds, ownerIds, index)
{
    const location = `roleRegistry[${index}]`;
    exactKeys(role, [
        'id',
        'domain',
        'owner',
        'clockKind',
        'semanticEffect'
    ], [], location);
    exactId(role.id, `${location}.id`);
    exactId(role.domain, `${location}.domain`);
    exactId(role.owner, `${location}.owner`);
    if (!ownerIds.has(role.owner))
    {
        fail('temporal.catalog-invalid', `${role.id} has an unknown role owner`);
    }
    if (!['business-wall', 'artifact-metadata'].includes(role.clockKind))
    {
        fail('temporal.catalog-invalid', `${role.id} has an unsupported clock kind`);
    }
    if (!['included', 'excluded'].includes(role.semanticEffect))
    {
        fail('temporal.catalog-invalid', `${role.id} has an unsupported semantic effect`);
    }
    if (role.clockKind === 'artifact-metadata' && role.semanticEffect !== 'excluded')
    {
        fail('temporal.metadata-semantic-mix', `${role.id} metadata must be excluded from semantic digests`);
    }
    if (role.clockKind === 'business-wall' && role.semanticEffect !== 'included')
    {
        fail('temporal.metadata-semantic-mix', `${role.id} business time cannot be omitted from semantic digests`);
    }
    roleIds.add(role.id);
}

function validateInvariant(invariant, roleIds, tieBreakerIds, index)
{
    const location = `invariants[${index}]`;
    exactKeys(invariant, ['id', 'kind', 'roles'], ['operators', 'tieBreakerId'], location);
    exactId(invariant.id, `${location}.id`);
    if (!['ordered-chain', 'same-instant', 'occurred-arrival', 'metadata-exclusion'].includes(invariant.kind))
    {
        fail('temporal.catalog-invalid', `${invariant.id} has an unknown invariant kind`);
    }
    if (!Array.isArray(invariant.roles) || invariant.roles.length === 0)
    {
        fail('temporal.catalog-invalid', `${invariant.id} must bind roles`);
    }
    for (const roleId of invariant.roles)
    {
        if (!roleIds.has(roleId))
        {
            fail('temporal.catalog-invalid', `${invariant.id} references unknown role ${roleId}`);
        }
    }
    if (invariant.kind === 'ordered-chain')
    {
        if (!Array.isArray(invariant.operators)
          || invariant.operators.length !== invariant.roles.length - 1
          || invariant.operators.some((operator) => !['<', '<='].includes(operator)))
        {
            fail('temporal.catalog-invalid', `${invariant.id} has an ambiguous ordered chain`);
        }
    }
    if (invariant.kind === 'same-instant')
    {
        if (!tieBreakerIds.has(invariant.tieBreakerId))
        {
            fail('temporal.catalog-invalid', `${invariant.id} must bind a formal product tie-breaker`);
        }
    }
}

function validateShape(shape, context, index)
{
    const location = `shapes[${index}]`;
    exactKeys(shape, [
        'id',
        'schema',
        'baseEpochReference',
        'timezoneCaseId',
        'cultureCaseId',
        'timestampRoles',
        'orderingGroups',
        'expiryBoundaries',
        'expectedBusinessStates',
        'invariantIds',
        'boundaryTags',
        'contentDigest'
    ], [], location);
    exactId(shape.id, `${location}.id`);
    if (shape.schema !== TEMPORAL_SHAPE_SCHEMA
      || shape.baseEpochReference !== 'temporalContext.businessEpochUtc')
    {
        fail('temporal.catalog-invalid', `${shape.id} has an invalid shape authority`);
    }
    if (!context.timezoneCaseIds.has(shape.timezoneCaseId)
      || !context.cultureCaseIds.has(shape.cultureCaseId))
    {
        fail('temporal.catalog-invalid', `${shape.id} references an unknown timezone/culture case`);
    }
    if (!digestPattern.test(shape.contentDigest)
      || shape.contentDigest !== temporalShapeDigest(shape))
    {
        fail('temporal.catalog-tamper', `${shape.id} content digest mismatch`);
    }
    if (!Array.isArray(shape.timestampRoles) || shape.timestampRoles.length === 0)
    {
        fail('temporal.catalog-invalid', `${shape.id} must declare temporal roles`);
    }
    const seenRoles = new Set();
    const offsets = new Map();
    for (const [roleIndex, binding] of shape.timestampRoles.entries())
    {
        exactKeys(binding, ['roleId', 'offsetMilliseconds', 'expectedBusinessState'], [], `${location}.timestampRoles[${roleIndex}]`);
        if (!context.roleIds.has(binding.roleId) || seenRoles.has(binding.roleId))
        {
            fail('temporal.catalog-invalid', `${shape.id} has an unknown or duplicate role ${binding.roleId}`);
        }
        seenRoles.add(binding.roleId);
        offsets.set(binding.roleId, integer(binding.offsetMilliseconds, `${shape.id}.${binding.roleId}.offsetMilliseconds`));
        exactId(binding.expectedBusinessState, `${shape.id}.${binding.roleId}.expectedBusinessState`);
    }
    for (const [groupIndex, group] of shape.orderingGroups.entries())
    {
        exactKeys(group, ['id', 'roleIds', 'direction'], ['tieBreakerId'], `${location}.orderingGroups[${groupIndex}]`);
        exactId(group.id, `${location}.orderingGroups[${groupIndex}].id`);
        if (!['ascending', 'descending', 'same-instant'].includes(group.direction)
          || !Array.isArray(group.roleIds) || group.roleIds.length < 2
          || group.roleIds.some((roleId) => !seenRoles.has(roleId)))
        {
            fail('temporal.catalog-invalid', `${shape.id}.${group.id} is not a valid ordering group`);
        }
        if (group.direction === 'same-instant')
        {
            if (!context.tieBreakerIds.has(group.tieBreakerId))
            {
                fail('temporal.catalog-invalid', `${shape.id}.${group.id} lacks a product tie-breaker`);
            }
            if (new Set(group.roleIds.map((roleId) => offsets.get(roleId))).size !== 1)
            {
                fail('temporal.randomized-tie-break', `${shape.id}.${group.id} must preserve exact same instants`);
            }
        }
        else
        {
            for (let roleIndex = 1; roleIndex < group.roleIds.length; roleIndex += 1)
            {
                const previous = offsets.get(group.roleIds[roleIndex - 1]);
                const current = offsets.get(group.roleIds[roleIndex]);
                if ((group.direction === 'ascending' && current < previous)
                  || (group.direction === 'descending' && current > previous))
                {
                    fail('temporal.ordering-invalid', `${shape.id}.${group.id} offset ordering is invalid`);
                }
            }
        }
    }
    for (const [boundaryIndex, boundary] of shape.expiryBoundaries.entries())
    {
        exactKeys(boundary, ['id', 'subjectRoleId', 'referenceRoleId', 'relation'], [], `${location}.expiryBoundaries[${boundaryIndex}]`);
        exactId(boundary.id, `${location}.expiryBoundaries[${boundaryIndex}].id`);
        if (!seenRoles.has(boundary.subjectRoleId) || !seenRoles.has(boundary.referenceRoleId)
          || !['before', 'at', 'after'].includes(boundary.relation))
        {
            fail('temporal.expiry-invalid', `${shape.id}.${boundary.id} is invalid`);
        }
        const delta = offsets.get(boundary.subjectRoleId) - offsets.get(boundary.referenceRoleId);
        if ((boundary.relation === 'before' && delta >= 0)
          || (boundary.relation === 'at' && delta !== 0)
          || (boundary.relation === 'after' && delta <= 0))
        {
            fail('temporal.expiry-invalid', `${shape.id}.${boundary.id} relation does not match offsets`);
        }
    }
    if (!plainObject(shape.expectedBusinessStates)
      || Object.keys(shape.expectedBusinessStates).length === 0)
    {
        fail('temporal.catalog-invalid', `${shape.id} must declare expected business states`);
    }
    for (const invariantId of shape.invariantIds)
    {
        if (!context.invariantIds.has(invariantId))
        {
            fail('temporal.catalog-invalid', `${shape.id} references unknown invariant ${invariantId}`);
        }
    }
    for (const boundaryTag of shape.boundaryTags)
    {
        exactId(boundaryTag, `${shape.id}.boundaryTags`);
    }
}

function validateEntityShape(shape, context)
{
    exactKeys(shape, ['id', 'schema', 'entityKinds', 'parentChronology', 'contentDigest'], [], 'entityShape');
    exactId(shape.id, 'entityShape.id');
    if (shape.schema !== 'fsusblog.temporal-entity-shape.v1'
        || shape.contentDigest !== temporalShapeDigest(shape)
        || !Array.isArray(shape.entityKinds) || shape.entityKinds.length === 0)
    {
        fail('temporal.catalog-invalid', 'entity shape requires exact versioned content and entity kinds');
    }
    const kinds = new Set();
    if (canonicalJson(shape.parentChronology) !== canonicalJson({ roleId: 'comment.created', operator: '<=' }))
    {
        fail('temporal.catalog-invalid', 'comment parent chronology must bind the existing creation role');
    }
    for (const kind of shape.entityKinds)
    {
        exactKeys(kind, ['kind', 'states', 'revisionRequired', 'publicationAllowed', 'stateFacts', 'roles', 'invariantIds'], [], 'entityKind');
        exactId(kind.kind, 'entityKind.kind');
        if (kinds.has(kind.kind) || !Array.isArray(kind.states) || kind.states.length === 0
            || new Set(kind.states).size !== kind.states.length
            || typeof kind.revisionRequired !== 'boolean' || typeof kind.publicationAllowed !== 'boolean'
            || !Array.isArray(kind.stateFacts) || new Set(kind.stateFacts).size !== kind.stateFacts.length
            || !Array.isArray(kind.roles) || kind.roles.length === 0 || !Array.isArray(kind.invariantIds))
        {
            fail('temporal.catalog-invalid', 'entity kind states and coordinate rules are incomplete');
        }
        kinds.add(kind.kind);
        kind.states.forEach((state) => exactId(state, 'entityKind.state'));
        const roleIds = new Set();
        for (const role of kind.roles)
        {
            exactKeys(role, ['roleId', 'presence', 'absent'], [], 'entityRole');
            if (!context.roleIds.has(role.roleId) || roleIds.has(role.roleId)
                || !['null', 'not-generated'].includes(role.absent)
                || !(role.presence === 'always' || kind.stateFacts.includes(role.presence)))
            {
                fail('temporal.catalog-invalid', 'entity role presence must bind explicit state facts');
            }
            roleIds.add(role.roleId);
        }
        for (const id of kind.invariantIds)
        {
            const invariant = context.invariants.find((candidate) => candidate.id === id);
            if (!invariant || invariant.kind !== 'ordered-chain' || invariant.roles.some((role) => !roleIds.has(role)))
            {
                fail('temporal.catalog-invalid', 'entity shape must include the complete invariant role closure');
            }
        }
    }
}

export function validateTemporalShapeCatalog(catalog)
{
    exactKeys(catalog, [
        'schema',
        'baseEpochAuthority',
        'precisionPolicy',
        'roleOwners',
        'roleRegistry',
        'timezoneCases',
        'cultureCases',
        'tieBreakers',
        'invariants',
        'requiredBoundaryTags',
        'shapes'
    ], ['entityShapes'], 'catalog');
    if (catalog.schema !== TEMPORAL_SHAPE_CATALOG_SCHEMA
      || canonicalJson(catalog.baseEpochAuthority) !== canonicalJson({
          source: 'temporalContext.businessEpochUtc',
          representation: 'relative-offsets-only'
      }))
    {
        fail('temporal.catalog-invalid', 'catalog base epoch authority is invalid');
    }
    exactKeys(catalog.precisionPolicy, ['unit', 'rounding', 'loss'], [], 'precisionPolicy');
    if (catalog.precisionPolicy.unit !== 'millisecond'
      || catalog.precisionPolicy.rounding !== 'none'
      || catalog.precisionPolicy.loss !== 'reject')
    {
        fail('temporal.catalog-invalid', 'catalog precision policy is not exact millisecond rejection');
    }
    const serialized = JSON.stringify(catalog);
    if (forbiddenAbsoluteInstant.test(serialized))
    {
        fail('temporal.absolute-date-authority', 'catalog must not store absolute business dates');
    }
    const ownerIds = uniqueIds(catalog.roleOwners, 'roleOwners');
    for (const owner of catalog.roleOwners)
    {
        exactKeys(owner, ['id', 'source'], [], `roleOwners.${owner.id}`);
        if (typeof owner.source !== 'string' || !owner.source.trim())
        {
            fail('temporal.catalog-invalid', `${owner.id} owner source is required`);
        }
    }
    uniqueIds(catalog.roleRegistry, 'roleRegistry');
    const roleIds = new Set();
    catalog.roleRegistry.forEach((role, index) => validateRole(role, roleIds, ownerIds, index));
    const timezoneCaseIds = uniqueIds(catalog.timezoneCases, 'timezoneCases');
    for (const row of catalog.timezoneCases)
    {
        exactKeys(row, ['id', 'timezone'], [], `timezoneCases.${row.id}`);
        if (typeof row.timezone !== 'string' || !row.timezone.trim())
        {
            fail('temporal.catalog-invalid', `${row.id} timezone is required`);
        }
    }
    const cultureCaseIds = uniqueIds(catalog.cultureCases, 'cultureCases');
    for (const row of catalog.cultureCases)
    {
        exactKeys(row, ['id', 'locale', 'backendCulture', 'calendar'], [], `cultureCases.${row.id}`);
    }
    const tieBreakerIds = uniqueIds(catalog.tieBreakers, 'tieBreakers');
    for (const tieBreaker of catalog.tieBreakers)
    {
        exactKeys(tieBreaker, ['id', 'identity', 'source'], [], `tieBreakers.${tieBreaker.id}`);
    }
    const invariantIds = uniqueIds(catalog.invariants, 'invariants');
    catalog.invariants.forEach((invariant, index) => validateInvariant(invariant, roleIds, tieBreakerIds, index));
    const shapeIds = uniqueIds(catalog.shapes, 'shapes');
    const context = {
        roleIds,
        timezoneCaseIds,
        cultureCaseIds,
        tieBreakerIds,
        invariantIds,
        invariants: catalog.invariants
    };
    catalog.shapes.forEach((shape, index) => validateShape(shape, context, index));
    const entityShapeIds = uniqueIds(catalog.entityShapes ?? [], 'entityShapes');
    (catalog.entityShapes ?? []).forEach((shape) => validateEntityShape(shape, context));
    const coveredBoundaryTags = new Set(catalog.shapes.flatMap((shape) => shape.boundaryTags));
    const missingBoundaryTags = catalog.requiredBoundaryTags.filter((tag) => !coveredBoundaryTags.has(tag));
    if (missingBoundaryTags.length > 0)
    {
        fail('temporal.matrix-incomplete', 'fixed temporal matrix is incomplete', { missingBoundaryTags });
    }
    return Object.freeze({
        catalog,
        catalogDigest: digestCanonical(catalog),
        invariantIds,
        roleIds,
        shapeIds,
        entityShapeIds,
        tieBreakerIds
    });
}

function productionPolicyMilliseconds(source, constantName, sourceName)
{
    const pattern = new RegExp(`\\b${constantName}\\s*=\\s*TimeSpan\\.FromDays\\(([1-9][0-9]*)\\)`, 'u');
    const match = source.match(pattern);
    if (!match)
    {
        fail('temporal.session-policy-drift', `${sourceName} does not expose ${constantName} as an exact day policy`);
    }
    return Number(match[1]) * 86_400_000;
}

export function verifyAuthSessionPolicyRoles(catalogState, {
    loginSource = readFileSync(loginSessionPolicyPath, 'utf8'),
    refreshSource = readFileSync(refreshSessionPolicyPath, 'utf8')
} = {})
{
    const shape = catalogState.catalog.shapes
        .find((candidate) => candidate.id === 'auth-security-messaging-account-lifecycle');
    if (!shape)
    {
        fail('temporal.session-policy-drift', 'auth session lifecycle shape is missing');
    }
    const roles = new Map(shape.timestampRoles.map((role) => [role.roleId, role]));
    const expected = new Map([
        ['session.idle-expiry', productionPolicyMilliseconds(
            loginSource,
            's_standardSessionIdleTtl',
            'UserLoginWorkflowService')],
        ['session.persistent-idle-expiry', productionPolicyMilliseconds(
            loginSource,
            's_rememberMeSessionIdleTtl',
            'UserLoginWorkflowService')],
        ['session.absolute-expiry', productionPolicyMilliseconds(
            loginSource,
            's_standardSessionAbsoluteTtl',
            'UserLoginWorkflowService')],
        ['session.persistent-absolute-expiry', productionPolicyMilliseconds(
            loginSource,
            's_rememberMeSessionAbsoluteTtl',
            'UserLoginWorkflowService')]
    ]);
    const refreshIdle = new Map([
        ['session.idle-expiry', productionPolicyMilliseconds(
            refreshSource,
            's_standardSessionIdleTtl',
            'UserSessionCommandService')],
        ['session.persistent-idle-expiry', productionPolicyMilliseconds(
            refreshSource,
            's_rememberMeSessionIdleTtl',
            'UserSessionCommandService')]
    ]);
    for (const [roleId, expectedOffset] of expected)
    {
        const role = roles.get(roleId);
        if (!role || role.offsetMilliseconds !== expectedOffset)
        {
            fail('temporal.session-policy-drift', `${roleId} does not match the production session policy`, {
                roleId,
                expectedOffsetMilliseconds: expectedOffset,
                actualOffsetMilliseconds: role?.offsetMilliseconds ?? null
            });
        }
    }
    for (const [roleId, refreshOffset] of refreshIdle)
    {
        if (refreshOffset !== expected.get(roleId))
        {
            fail('temporal.session-policy-drift', `${roleId} login and refresh policies disagree`);
        }
    }
    if (!shape.invariantIds.includes('session-persistent-lifetime'))
    {
        fail('temporal.session-policy-drift', 'persistent session lifetime invariant is missing');
    }
    return Object.freeze({
        shapeId: shape.id,
        standardIdleMilliseconds: expected.get('session.idle-expiry'),
        standardAbsoluteMilliseconds: expected.get('session.absolute-expiry'),
        rememberMeIdleMilliseconds: expected.get('session.persistent-idle-expiry'),
        rememberMeAbsoluteMilliseconds: expected.get('session.persistent-absolute-expiry')
    });
}

export function readTemporalShapeCatalog(file = catalogPath)
{
    const state = validateTemporalShapeCatalog(JSON.parse(readFileSync(file, 'utf8')));
    verifyAuthSessionPolicyRoles(state);
    return state;
}

export function resolveTemporalShape(shapeId, { catalog = readTemporalShapeCatalog() } = {})
{
    const id = exactId(shapeId, 'shapeId');
    const shape = catalog.catalog.shapes.find((candidate) => candidate.id === id);
    if (!shape)
    {
        fail('temporal.shape-unknown', `unknown temporal shape: ${id}`);
    }
    return Object.freeze({
        shape,
        shapeDigest: temporalShapeDigest(shape),
        catalogDigest: catalog.catalogDigest
    });
}

/** Resolve the canonical coordinate-aware contract without supplying or inventing producer dates. */
export function resolveTemporalEntityShape(shapeId, { catalog = readTemporalShapeCatalog() } = {})
{
    const shape = catalog.catalog.entityShapes?.find((candidate) => candidate.id === exactId(shapeId, 'shapeId'));
    if (!shape)
    {
        fail('temporal.shape-unknown', `unknown entity temporal shape: ${shapeId}`);
    }
    return Object.freeze({ shape, shapeDigest: temporalShapeDigest(shape), catalogDigest: catalog.catalogDigest });
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateRolloutState } from './release-rollout-lib.mjs';
import { RELEASE_SLOTS, validateSlotState } from './slot-lib.mjs';

export const DESTRUCTIVE_OPERATION_AUTHORITY_SCHEMA = 'fsusblog.destructive-operation-authority.v1';
export const DEFAULT_DESTRUCTIVE_OPERATION_AUTHORITY = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../config/deployment/destructive-operation-authority.json');

const EXACT_ROOT_FIELDS = ['contentDigest', 'operations', 'schema'];
const EXACT_OPERATION_FIELDS = [
    'activeIdentitySources', 'consumer', 'id', 'lock', 'resourceClass', 'status', 'verification'
];

export function readDestructiveOperationAuthority(file = DEFAULT_DESTRUCTIVE_OPERATION_AUTHORITY)
{
    const authority = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    return validateDestructiveOperationAuthority(authority);
}

export function validateDestructiveOperationAuthority(authority)
{
    exactObject(authority, EXACT_ROOT_FIELDS, 'destructive operation authority');
    if (authority.schema !== DESTRUCTIVE_OPERATION_AUTHORITY_SCHEMA)
    {
        throw new Error(`destructive operation authority schema must be ${DESTRUCTIVE_OPERATION_AUTHORITY_SCHEMA}`);
    }
    if (!Array.isArray(authority.operations) || authority.operations.length === 0)
    {
        throw new Error('destructive operation authority operations are required');
    }
    const seen = new Set();
    for (const operation of authority.operations)
    {
        exactObject(operation, EXACT_OPERATION_FIELDS, 'destructive operation');
        if (!/^[a-z][a-z0-9-]{2,63}$/u.test(operation.id) || seen.has(operation.id))
        {
            throw new Error(`unknown or duplicate destructive operation: ${String(operation.id)}`);
        }
        seen.add(operation.id);
        if (!/^[a-z][a-z0-9-]{2,63}$/u.test(operation.resourceClass)
        || !/^[a-z][a-z0-9-]{2,95}$/u.test(operation.verification)
        || !Array.isArray(operation.activeIdentitySources)
        || new Set(operation.activeIdentitySources).size !== operation.activeIdentitySources.length
        || operation.activeIdentitySources.some(source => !/^[a-z][a-z0-9-]{2,63}$/u.test(source)))
        {
            throw new Error(`${operation.id} contains an invalid closed identity declaration`);
        }
        if (operation.status === 'supported')
        {
            if (!/^tools\/[a-z0-9./-]+$/u.test(operation.consumer ?? '')
          || operation.activeIdentitySources.length === 0 || operation.lock === 'unsupported')
            {
                throw new Error(`${operation.id} supported consumer binding is incomplete`);
            }
        }
        else if (operation.status === 'unsupported')
        {
            if (operation.consumer !== null || operation.activeIdentitySources.length !== 0
          || operation.lock !== 'unsupported' || operation.verification !== 'unsupported-fail-closed')
            {
                throw new Error(`${operation.id} unsupported operation must remain unbound and fail closed`);
            }
        }
        else
        {
            throw new Error(`${operation.id}.status is invalid`);
        }
    }
    const { contentDigest, ...payload } = authority;
    if (!/^sha256:[0-9a-f]{64}$/u.test(contentDigest) || digestCanonical(payload) !== contentDigest)
    {
        throw new Error('destructive operation authority contentDigest does not match canonical content');
    }
    return authority;
}

export function verifyRuntimeSlotStop({ authority, slotState, rolloutState, targetObservation, activeObservation })
{
    requireSupported(authority, 'runtime-slot-stop', {
        consumer: 'tools/deployment/slot-stop.sh',
        activeIdentitySources: ['durable-slot-state', 'durable-rollout-state', 'live-container-labels'],
        lock: 'deployment',
        verification: 'exact-active-and-target-runtime-identity'
    });
    validateSlotState(slotState);
    validateRolloutState(rolloutState);
    assertClosedRuntimeIdentities(slotState, rolloutState);
    if (slotState.status !== 'stable' || slotState.activeSlot === null)
    {
        throw new Error('durable active runtime identity is missing, ambiguous, or transitioning');
    }
    const targetSlot = runtimeObservationSlot(targetObservation, 'target');
    if (targetSlot === slotState.activeSlot)
    {
        throw new Error(`refusing to stop active slot ${targetSlot}`);
    }
    const activeSlot = runtimeObservationSlot(activeObservation, 'active');
    if (activeSlot !== slotState.activeSlot)
    {
        throw new Error('live active slot does not match durable active slot');
    }
    exactRuntimeIdentity(activeObservation, slotState.slots[activeSlot], slotState, 'active');
    const activeMatches = rolloutIdentities(rolloutState).filter(identity => observationMatchesIdentity(activeObservation, identity));
    const targetMatches = rolloutIdentities(rolloutState).filter(identity => observationMatchesIdentity(targetObservation, identity));
    if (activeMatches.length !== 1 || (targetObservation.exists && targetMatches.length !== 1)
      || (targetObservation.exists && activeMatches[0] === targetMatches[0]))
    {
        throw new Error('runtime stop is not bound to one exact current rollout operation');
    }
    if (!targetObservation.exists)
    {
        if (targetObservation.running || (slotState.slots[targetSlot] && slotState.slots[targetSlot].status !== 'stopped'))
        {
            throw new Error('missing target runtime conflicts with durable target state');
        }
        const persistedTargetMatches = rolloutIdentities(rolloutState).filter(identity =>
            slotRecordMatchesIdentity(targetSlot, slotState.slots[targetSlot], identity));
        if (slotState.slots[targetSlot] && persistedTargetMatches.length !== 1)
        {
            throw new Error('stopped target is not bound to one exact current rollout operation');
        }
        return { activeSlot, targetSlot, rolloutId: rolloutState.rolloutId, alreadyStopped: true };
    }
    exactRuntimeIdentity(targetObservation, slotState.slots[targetSlot], slotState, 'target');
    return { activeSlot, targetSlot, rolloutId: rolloutState.rolloutId, alreadyStopped: false };
}

export function verifyArtifactGcActiveIdentity({ authority, slotState, rolloutState, retentionState })
{
    requireSupported(authority, 'release-artifact-gc', {
        consumer: 'tools/storage/gc-release-assets.mjs',
        activeIdentitySources: ['durable-slot-state', 'durable-rollout-state', 'durable-retention-state'],
        lock: 'deployment-and-storage',
        verification: 'exact-active-release-before-delete'
    });
    validateSlotState(slotState);
    validateRolloutState(rolloutState);
    assertClosedRuntimeIdentities(slotState, rolloutState);
    if (slotState.status !== 'stable' || slotState.activeSlot === null)
    {
        throw new Error('durable active runtime identity is missing, ambiguous, or transitioning');
    }
    const active = slotState.slots[slotState.activeSlot];
    if (!active || active.status !== 'running'
      || active.releaseId !== slotState.activeReleaseId
      || active.imageDigest !== slotState.activeImageDigest)
    {
        throw new Error('durable active runtime identity is incomplete or ambiguous');
    }
    const matches = [rolloutState.source, rolloutState.target].filter(identity =>
        identity.slot === slotState.activeSlot
    && identity.releaseId === active.releaseId
    && identity.imageDigest === active.imageDigest
    && identity.runtimeGeneration === active.deploymentGeneration);
    if (matches.length !== 1)
    {
        throw new Error('durable rollout state does not contain exactly one active runtime identity');
    }
    if (retentionState.activeReleaseId !== active.releaseId)
    {
        throw new Error('retention active release does not match durable slot and rollout identity');
    }
    return Object.freeze({
        releaseId: active.releaseId,
        slot: slotState.activeSlot,
        imageDigest: active.imageDigest,
        deploymentGeneration: active.deploymentGeneration,
        rolloutId: rolloutState.rolloutId
    });
}

export function verifyCandidateCleanupOwnership({ authority, slotState, rolloutState, candidate })
{
    requireSupported(authority, 'runtime-candidate-cleanup', {
        consumer: 'tools/deployment/slot-start.sh',
        activeIdentitySources: ['durable-slot-state', 'durable-rollout-state', 'candidate-compose-identity'],
        lock: 'deployment',
        verification: 'exact-current-operation-candidate-identity'
    });
    validateSlotState(slotState);
    validateRolloutState(rolloutState);
    assertClosedRuntimeIdentities(slotState, rolloutState);
    if (slotState.status !== 'stable' || slotState.activeSlot === null)
    {
        throw new Error('durable active runtime identity is missing, ambiguous, or transitioning');
    }
    const activeRecord = slotState.slots[slotState.activeSlot];
    if (!slotRecordMatchesIdentity(slotState.activeSlot, activeRecord, rolloutState.source)
      && !slotRecordMatchesIdentity(slotState.activeSlot, activeRecord, rolloutState.target))
    {
        throw new Error('durable active runtime identity is not bound to the current rollout');
    }
    exactObject(candidate, ['imageDigest', 'releaseId', 'runtimeGeneration', 'slot'], 'candidate cleanup identity');
    if (candidate.slot === slotState.activeSlot
      || candidate.slot !== rolloutState.target.slot
      || candidate.releaseId !== rolloutState.target.releaseId
      || candidate.imageDigest !== rolloutState.target.imageDigest
      || candidate.runtimeGeneration !== rolloutState.target.runtimeGeneration)
    {
        throw new Error('candidate cleanup identity is not exact current-operation-owned target');
    }
    return { rolloutId: rolloutState.rolloutId, candidate: { ...candidate } };
}

export function assertUnsupportedOperation(authority, operationId)
{
    const operation = operationById(authority, operationId);
    if (operation.status !== 'unsupported' || operation.consumer !== null)
    {
        throw new Error(`${operationId} must remain closed unsupported until a bound product consumer exists`);
    }
    return operation;
}

function requireSupported(authority, operationId, expected)
{
    const operation = operationById(authority, operationId);
    if (operation.status !== 'supported' || !operation.consumer)
    {
        throw new Error(`${operationId} is unsupported`);
    }
    for (const field of ['consumer', 'lock', 'verification'])
    {
        if (operation[field] !== expected[field])
        {
            throw new Error(`${operationId}.${field} does not match its consumer requirement`);
        }
    }
    if (JSON.stringify(operation.activeIdentitySources) !== JSON.stringify(expected.activeIdentitySources))
    {
        throw new Error(`${operationId}.activeIdentitySources does not match its consumer requirement`);
    }
    return operation;
}

function operationById(authority, operationId)
{
    validateDestructiveOperationAuthority(authority);
    const operation = authority.operations.find(candidate => candidate.id === operationId);
    if (!operation)
    {
        throw new Error(`destructive operation is not registered: ${operationId}`);
    }
    return operation;
}

function runtimeObservationSlot(observation, label)
{
    const fields = observation?.exists === false
        ? ['containerName', 'exists', 'health', 'host', 'liveness', 'loopbackOnly', 'persisted', 'port',
      'projectName', 'readiness', 'release', 'running', 'slot', 'startedAt']
        : ['containerName', 'exists', 'health', 'host', 'identityMatchesSlot', 'liveness', 'loopbackOnly',
      'persisted', 'port', 'projectName', 'readiness', 'release', 'running', 'slot', 'startedAt'];
    exactObject(observation, fields, `${label} runtime observation`, { allowAdditional: ['portBindings'] });
    if (!RELEASE_SLOTS.includes(observation.slot))
    {
        throw new Error(`${label} runtime slot is invalid`);
    }
    return observation.slot;
}

function exactRuntimeIdentity(observation, persisted, slotState, label)
{
    if (!observation.exists || !observation.running || observation.identityMatchesSlot !== true || !persisted)
    {
        throw new Error(`${label} runtime is missing or not verified`);
    }
    exactObject(observation.release, [
        'commitSha', 'deploymentGeneration', 'deploymentMode', 'imageDigest', 'imageRef', 'releaseId', 'slot'
    ], `${label} runtime release`);
    if (observation.release.slot !== observation.slot
      || observation.release.releaseId !== persisted.releaseId
      || observation.release.imageDigest !== persisted.imageDigest
      || observation.release.deploymentGeneration !== persisted.deploymentGeneration
      || observation.release.deploymentGeneration > slotState.runtimeGeneration)
    {
        throw new Error(`${label} live runtime identity does not exactly match durable slot state`);
    }
}

function rolloutIdentities(rolloutState)
{
    return [rolloutState.source, rolloutState.target];
}

function assertClosedRuntimeIdentities(slotState, rolloutState)
{
    for (const [label, identity] of [['source', rolloutState.source], ['target', rolloutState.target]])
    {
        exactObject(identity, ['imageDigest', 'releaseId', 'runtimeGeneration', 'slot'], `rollout ${label} identity`);
    }
    for (const slot of RELEASE_SLOTS)
    {
        if (slotState.slots[slot] !== null)
        {
            exactObject(slotState.slots[slot], [
                'containerName', 'deploymentGeneration', 'host', 'imageDigest', 'imageRef', 'lastObservedAt',
                'lastSuccessfulStartAt', 'port', 'projectName', 'releaseId', 'status'
            ], `durable ${slot} slot identity`);
        }
    }
}

function observationMatchesIdentity(observation, identity)
{
    return observation?.exists === true
    && observation.slot === identity.slot
    && observation.release?.releaseId === identity.releaseId
    && observation.release?.imageDigest === identity.imageDigest
    && observation.release?.deploymentGeneration === identity.runtimeGeneration;
}

function slotRecordMatchesIdentity(slot, record, identity)
{
    return record
    && slot === identity.slot
    && record.releaseId === identity.releaseId
    && record.imageDigest === identity.imageDigest
    && record.deploymentGeneration === identity.runtimeGeneration;
}

function exactObject(value, fields, label, options = {})
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error(`${label} must be an object`);
    }
    const allowed = new Set([...fields, ...(options.allowAdditional ?? [])]);
    const keys = Object.keys(value).sort();
    const required = [...fields].sort();
    if (required.some(field => !Object.hasOwn(value, field)) || keys.some(field => !allowed.has(field)))
    {
        throw new Error(`${label} fields are not closed exact`);
    }
}

function digestCanonical(value)
{
    return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object')
    {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

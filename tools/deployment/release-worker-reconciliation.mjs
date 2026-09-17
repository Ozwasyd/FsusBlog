#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { validateRolloutState } from './release-rollout-lib.mjs';

const ledgerSchema = 'fsusblog.release-worker-event-ledger.v1';
const evidenceSchema = 'fsusblog.release-worker-reconciliation-evidence.v2';
const qualificationControlSchema = 'fsusblog.release-worker-qualification-control.v1';
const resourcePolicySchema = 'fsusblog.zero-downtime-resource-policy.v1';
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const safeRunIdPattern = /^[0-9A-Za-z][0-9A-Za-z._:-]{7,127}$/u;
const normalRequiredKinds = Object.freeze([
    'scheduled-publish',
    'article-mutation-outbox',
    'audit-writer',
    'visit-view-projection',
    'public-hot-aot',
    'upload-cleanup',
    'active-singleton-control',
    'multi-consumer-safe-control'
]);
const qualificationRequiredKinds = Object.freeze([
    ...normalRequiredKinds,
    'forced-source-recovery'
]);
const normalRequiredChecks = Object.freeze([
    'rollout-source-target-binding',
    'target-health-binding',
    'graceful-source-drain',
    'eight-worker-kind-coverage',
    'durable-buffer-drain-or-replay',
    'exactly-once-final-effects',
    'zero-stale-generation-commits',
    'audit-record-reconciliation',
    'visit-view-projection-reconciliation'
]);
const qualificationRequiredChecks = Object.freeze([
    'qualification-run-identity',
    'qualification-control-binding',
    'resource-policy-binding',
    'target-health-binding',
    'sigkill-source-termination',
    'target-takeover-after-source-termination',
    'nine-worker-kind-forced-recovery',
    'exactly-once-final-effects',
    'zero-stale-generation-commits',
    'audit-record-reconciliation',
    'visit-view-projection-reconciliation'
]);

try
{
    const options = parseArgs(process.argv.slice(2));
    const rolloutInput = readJsonArtifact(options.rolloutState);
    validateRolloutState(rolloutInput.value);
    const ledgerInput = readJsonArtifact(options.ledger);
    const healthInput = readJsonArtifact(options.targetHealth);
    const drainInput = options.sourceDrain === null ? null : readJsonArtifact(options.sourceDrain);
    const qualificationControlInput = options.qualificationControl === null
        ? null
        : readJsonArtifact(options.qualificationControl);
    const resourcePolicyInput = options.resourcePolicy === null ? null : readJsonArtifact(options.resourcePolicy);
    const expectedNormalRolloutInput = options.expectedNormalRolloutState === null
        ? null
        : readJsonArtifact(options.expectedNormalRolloutState);
    if (expectedNormalRolloutInput !== null)
    {
        validateRolloutState(expectedNormalRolloutInput.value);
    }
    const rollout = rolloutInput.value;
    const ledger = ledgerInput.value;
    const health = healthInput.value;
    const drain = drainInput?.value ?? null;
    const qualificationControl = qualificationControlInput?.value ?? null;
    const resourcePolicy = resourcePolicyInput?.value ?? null;
    const expectedNormalRollout = expectedNormalRolloutInput?.value ?? null;
    const errors = [];
    const requiredKinds = options.mode === 'normal' ? normalRequiredKinds : qualificationRequiredKinds;

    const ledgerChecks = validateLedger(ledger, rollout, requiredKinds, options.mode, errors);
    const targetHealthBound = validateHealth(
        health,
        rollout,
        ledgerInput.artifact,
        options.mode === 'qualification',
        errors);
    const gracefulDrainVerified = options.mode === 'normal'
        ? validateDrain(drain, errors)
        : false;
    const qualificationChecks = options.mode === 'qualification'
        ? validateQualification({
        ledger,
        rollout,
        qualificationId: options.qualificationId,
        qualificationControl,
        ledgerArtifact: ledgerInput.artifact,
        resourcePolicy,
        resourcePolicyArtifact: resourcePolicyInput.artifact,
        expectedNormalRollout,
        errors
      })
        : null;

    const events = Array.isArray(ledger.events) ? ledger.events : [];
    const duplicateEffectCount = events.reduce(
        (sum, event) => sum + Math.max(0, Number(event.finalEffectCount ?? 0) - 1),
        0);
    const staleGenerationCommitCount = events.reduce(
        (sum, event) => sum + Math.max(0, Number(event.staleGenerationCommitCount ?? 0)),
        0);
    const lostAuditCount = events.reduce(
        (sum, event) => sum + Math.max(0, Number(event.expectedAuditCount ?? 0) - Number(event.actualAuditCount ?? 0)),
        0);
    const lostVisitProjectionCount = events
        .filter(event => event.kind === 'visit-view-projection')
        .reduce(
            (sum, event) => sum + Math.max(0, Number(event.expectedProjectionCount ?? 0) - Number(event.actualProjectionCount ?? 0)),
            0);
    const components = drain?.observations?.components
    ?? drain?.snapshot?.drain?.components
    ?? drain?.drain?.components
    ?? [];
    const buffersDrained = options.mode === 'normal'
    && Array.isArray(components)
    && components.length > 0
    && components.every(component => Number(component.pendingCount ?? component.PendingCount ?? 0) === 0
      && !String(component.error ?? component.Error ?? '').trim());
    const durableReplayVerified = events.length > 0
    && events.every(event => Number.isSafeInteger(event.pendingCountAtDrain)
      && (event.pendingCountAtDrain === 0 || isDurableReplaySource(event.durableReplaySource)));
    const exactlyOnceVerified = events.length > 0
    && events.every(event => event.finalEffectCount === 1 && safeRunIdPattern.test(String(event.finalEffectKey ?? '')))
    && duplicateEffectCount === 0
    && ledgerChecks.effectKeysUnique;
    const staleGenerationRejected = events.length > 0
    && events.every(event => Number.isSafeInteger(event.staleGenerationCommitCount)
      && event.staleGenerationCommitCount === 0);
    const auditEvents = events.filter(event => event.kind === 'audit-writer');
    const visitProjectionEvents = events.filter(event => event.kind === 'visit-view-projection');
    const auditReconciled = auditEvents.length > 0
    && auditEvents.every(event => Number.isSafeInteger(event.expectedAuditCount)
      && event.expectedAuditCount >= 1
      && event.actualAuditCount === event.expectedAuditCount)
    && lostAuditCount === 0;
    const visitProjectionReconciled = visitProjectionEvents.length > 0
    && visitProjectionEvents.every(event => Number.isSafeInteger(event.expectedProjectionCount)
      && event.expectedProjectionCount >= 1
      && event.actualProjectionCount === event.expectedProjectionCount)
    && lostVisitProjectionCount === 0;

    if (options.mode === 'normal' && !buffersDrained && !durableReplayVerified)
    {
        errors.push('source buffers were neither drained nor bound to durable replay');
    }
    if (duplicateEffectCount !== 0)
    {
        errors.push(`duplicate final side effects: ${duplicateEffectCount}`);
    }
    if (staleGenerationCommitCount !== 0)
    {
        errors.push(`stale generation commits: ${staleGenerationCommitCount}`);
    }
    if (lostAuditCount !== 0)
    {
        errors.push(`lost audit records: ${lostAuditCount}`);
    }
    if (lostVisitProjectionCount !== 0)
    {
        errors.push(`lost visit/view projections: ${lostVisitProjectionCount}`);
    }

    const checks = options.mode === 'normal'
        ? {
        rolloutSourceTargetBound: ledgerChecks.sourceTargetBound,
        targetHealthBound,
        gracefulDrainVerified,
        requiredWorkerKindsCovered: ledgerChecks.requiredKindsCovered,
        durableBufferDrainOrReplayVerified: buffersDrained || durableReplayVerified,
        exactlyOnceVerified,
        staleGenerationRejected,
        auditReconciled,
        visitProjectionReconciled
      }
        : {
        qualificationRunIdentityBound: qualificationChecks.runIdentityBound,
        qualificationControlBound: qualificationChecks.controlBound,
        resourcePolicyBound: qualificationChecks.resourcePolicyBound,
        targetHealthBound,
        sigkillSourceTerminationVerified: qualificationChecks.sigkillVerified,
        targetTakeoverAfterTerminationVerified: qualificationChecks.takeoverVerified,
        requiredWorkerKindsCovered: ledgerChecks.requiredKindsCovered,
        allKindsRecoveredByTarget: qualificationChecks.allKindsRecoveredByTarget,
        exactlyOnceVerified,
        staleGenerationRejected,
        auditReconciled,
        visitProjectionReconciled,
        normalRolloutSeparationVerified: qualificationChecks.normalRolloutSeparationVerified
      };

    const evidence = {
        schema: evidenceSchema,
        mode: options.mode,
        status: errors.length === 0 ? 'pass' : 'fail',
        requiredChecks: options.mode === 'normal' ? normalRequiredChecks : qualificationRequiredChecks,
        checks,
        rolloutId: rollout.rolloutId,
        source: rollout.source,
        target: rollout.target,
        eventCount: events.length,
        kinds: [...new Set(events.map(event => event.kind))],
        duplicateEffectCount,
        staleGenerationCommitCount,
        lostAuditCount,
        lostVisitProjectionCount,
        buffersDrained,
        durableReplayVerified,
        gracefulDrainVerified,
        retryCount: events.reduce((sum, event) => sum + Math.max(0, Number(event.attemptCount ?? 1) - 1), 0),
        forcedSourceRecoveryRequired: options.mode === 'qualification',
        forcedSourceRecoveryVerified: options.mode === 'qualification'
      && qualificationChecks.sigkillVerified
      && qualificationChecks.takeoverVerified
      && qualificationChecks.allKindsRecoveredByTarget,
        qualification: options.mode === 'qualification'
            ? {
          qualificationId: options.qualificationId,
          qualificationRolloutId: rollout.rolloutId,
          destructive: true,
          targetReleaseId: rollout.target.releaseId,
          targetImageDigest: rollout.target.imageDigest,
          targetRuntimeGeneration: rollout.target.runtimeGeneration,
          qualificationPolicySha256: qualificationChecks.qualificationPolicySha256,
          resourcePolicySha256: qualificationChecks.resourcePolicySha256,
          freshNormalRolloutRequired: true,
          normalRolloutReuseForbidden: true,
          expectedNormalRolloutId: expectedNormalRollout?.rolloutId ?? null,
          normalRolloutSeparationVerified: qualificationChecks.normalRolloutSeparationVerified
        }
            : null,
        inputs: {
            rolloutState: rolloutInput.artifact,
            ledger: ledgerInput.artifact,
            sourceDrain: drainInput?.artifact ?? null,
            targetHealth: healthInput.artifact,
            qualificationControl: qualificationControlInput?.artifact ?? null,
            resourcePolicy: resourcePolicyInput?.artifact ?? null,
            normalRolloutState: expectedNormalRolloutInput?.artifact ?? null
        },
        errors,
        observedAtUtc: new Date().toISOString()
    };
    writeJsonAtomic(options.out, evidence);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    if (evidence.status !== 'pass')
    {
        process.exitCode = 1;
    }
}
catch (error)
{
    process.stderr.write(`[release-worker-reconciliation] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}

function parseArgs(argv)
{
    const parsed = {};
    const supported = new Set([
        'mode',
        'rollout-state',
        'ledger',
        'source-drain',
        'target-health',
        'qualification-id',
        'qualification-control',
        'resource-policy',
        'normal-rollout-state',
        'expected-normal-rollout-state',
        'out'
    ]);
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value === undefined || value.startsWith('--'))
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        const key = name.slice(2);
        if (!supported.has(key))
        {
            throw new Error(`unsupported argument: --${key}`);
        }
        if (Object.hasOwn(parsed, key))
        {
            throw new Error(`argument repeated: --${key}`);
        }
        parsed[key] = value;
    }
    for (const name of ['mode', 'rollout-state', 'ledger', 'target-health', 'out'])
    {
        if (!parsed[name])
        {
            throw new Error(`--${name} is required`);
        }
    }
    if (!['normal', 'qualification'].includes(parsed.mode))
    {
        throw new Error('--mode must be normal or qualification');
    }
    if (parsed.mode === 'normal')
    {
        if (!parsed['source-drain'])
        {
            throw new Error('--source-drain is required in normal mode');
        }
        for (const name of ['qualification-id', 'qualification-control', 'resource-policy', 'normal-rollout-state', 'expected-normal-rollout-state'])
        {
            if (parsed[name])
            {
                throw new Error(`--${name} is only valid in qualification mode`);
            }
        }
    }
    else
    {
        for (const name of ['qualification-id', 'qualification-control', 'resource-policy'])
        {
            if (!parsed[name])
            {
                throw new Error(`--${name} is required in qualification mode`);
            }
        }
        if (!safeRunIdPattern.test(parsed['qualification-id']))
        {
            throw new Error('--qualification-id is invalid');
        }
        if (parsed['source-drain'])
        {
            throw new Error('--source-drain is forbidden in qualification mode');
        }
        if (parsed['normal-rollout-state'] && parsed['expected-normal-rollout-state'])
        {
            throw new Error('--normal-rollout-state and --expected-normal-rollout-state are aliases and cannot both be supplied');
        }
    }
    return {
        mode: parsed.mode,
        rolloutState: path.resolve(parsed['rollout-state']),
        ledger: path.resolve(parsed.ledger),
        sourceDrain: optionalPath(parsed['source-drain']),
        targetHealth: path.resolve(parsed['target-health']),
        qualificationId: parsed['qualification-id'] ?? null,
        qualificationControl: optionalPath(parsed['qualification-control']),
        resourcePolicy: optionalPath(parsed['resource-policy']),
        expectedNormalRolloutState: optionalPath(parsed['normal-rollout-state'] ?? parsed['expected-normal-rollout-state']),
        out: path.resolve(parsed.out)
    };
}

function optionalPath(value)
{
    return value === undefined ? null : path.resolve(value);
}

function validateLedger(ledger, rollout, requiredKinds, mode, errors)
{
    if (ledger.schema !== ledgerSchema)
    {
        errors.push(`worker ledger schema must be ${ledgerSchema}`);
    }
    if (ledger.status !== 'pass')
    {
        errors.push('worker ledger did not pass');
    }
    appendNestedErrors(ledger.errors, 'worker ledger', errors);
    if (ledger.rolloutId !== rollout.rolloutId)
    {
        errors.push('worker ledger rolloutId mismatch');
    }
    const sourceTargetBound = identityMatches(ledger.source, rollout.source)
    && identityMatches(ledger.target, rollout.target);
    if (!identityMatches(ledger.source, rollout.source))
    {
        errors.push('worker ledger source identity/generation mismatch');
    }
    if (!identityMatches(ledger.target, rollout.target))
    {
        errors.push('worker ledger target identity/generation mismatch');
    }
    if (!Array.isArray(ledger.events) || ledger.events.length === 0)
    {
        errors.push('worker ledger events are missing');
        return { sourceTargetBound, requiredKindsCovered: false, effectKeysUnique: false };
    }
    const ids = new Set();
    const effectKeys = new Set();
    let effectKeysUnique = true;
    for (const event of ledger.events)
    {
        const eventId = String(event.logicalEventId ?? '');
        if (!safeRunIdPattern.test(eventId) || ids.has(eventId))
        {
            errors.push(`invalid or duplicate logical event id: ${event.logicalEventId ?? '<missing>'}`);
        }
        ids.add(event.logicalEventId);
        if (!requiredKinds.includes(event.kind))
        {
            errors.push(`${mode} worker ledger contains a forbidden or unknown kind: ${event.kind ?? '<missing>'}`);
        }
        if (!Number.isSafeInteger(event.attemptCount) || event.attemptCount < 1)
        {
            errors.push(`${eventId}: attemptCount must be positive`);
        }
        if (event.finalEffectCount !== 1)
        {
            errors.push(`${eventId}: exactly one final effect is required`);
        }
        if (!safeRunIdPattern.test(String(event.finalEffectKey ?? '')))
        {
            effectKeysUnique = false;
            errors.push(`${eventId}: finalEffectKey is invalid`);
        }
        else if (effectKeys.has(event.finalEffectKey))
        {
            effectKeysUnique = false;
            errors.push(`${eventId}: finalEffectKey is shared by another logical event`);
        }
        effectKeys.add(event.finalEffectKey);
        if (event.finalReleaseId !== rollout.target.releaseId)
        {
            errors.push(`${eventId}: final release is not target release`);
        }
        if (event.finalGeneration !== rollout.target.runtimeGeneration)
        {
            errors.push(`${eventId}: final generation is not target generation`);
        }
        if (!Number.isSafeInteger(event.staleGenerationCommitCount) || event.staleGenerationCommitCount !== 0)
        {
            errors.push(`${eventId}: stale generation committed or count is invalid`);
        }
        if (!Number.isSafeInteger(event.pendingCountAtDrain) || event.pendingCountAtDrain < 0)
        {
            errors.push(`${eventId}: pendingCountAtDrain must be a non-negative integer`);
        }
        else if (event.pendingCountAtDrain > 0 && !isDurableReplaySource(event.durableReplaySource))
        {
            errors.push(`${eventId}: pending work lacks a durable replay source`);
        }
        if (event.kind === 'audit-writer'
      && (!Number.isSafeInteger(event.expectedAuditCount)
        || event.expectedAuditCount < 1
        || event.actualAuditCount !== event.expectedAuditCount))
        {
            errors.push(`${eventId}: audit expected/actual counts are missing or do not reconcile`);
        }
        if (event.kind === 'visit-view-projection'
      && (!Number.isSafeInteger(event.expectedProjectionCount)
        || event.expectedProjectionCount < 1
        || event.actualProjectionCount !== event.expectedProjectionCount))
        {
            errors.push(`${eventId}: visit/view expected/actual counts are missing or do not reconcile`);
        }
        appendNestedErrors(event.errors, `${eventId} ledger event`, errors);
    }
    const kinds = new Set(ledger.events.map(event => event.kind));
    const requiredKindsCovered = requiredKinds.every(kind => kinds.has(kind));
    for (const kind of requiredKinds)
    {
        if (!kinds.has(kind))
        {
            errors.push(`worker ledger kind is missing: ${kind}`);
        }
    }
    return { sourceTargetBound, requiredKindsCovered, effectKeysUnique };
}

function validateDrain(drain, errors)
{
    const before = errors.length;
    if (!drain || !['pass', 'ok'].includes(drain.status))
    {
        errors.push('source drain evidence did not pass');
    }
    if (drain?.schema === 'fsusblog.release-rollout-gate.v1' && drain.gate !== 'source-drain')
    {
        errors.push('source drain gate kind is invalid');
    }
    const blockers = drain?.observations?.blockers ?? drain?.snapshot?.drain?.blockers ?? drain?.drain?.blockers;
    if (!Array.isArray(blockers) || blockers.length !== 0)
    {
        errors.push('source drain evidence contains blockers');
    }
    const snapshot = drain?.snapshot ?? (drain?.drain ? drain : null);
    if (snapshot && (snapshot.drain?.requested !== true || snapshot.drain?.drained !== true || snapshot.drain?.timedOut !== false))
    {
        errors.push('source drain snapshot did not prove a graceful completed drain');
    }
    appendNestedErrors(drain?.errors, 'source drain evidence', errors);
    return errors.length === before;
}

function validateHealth(health, rollout, ledgerArtifact, requireDrillLifecycle, errors)
{
    const before = errors.length;
    const observed = health?.observations ?? health;
    if (!['pass', 'ok', 'healthy'].includes(health.status))
    {
        errors.push('target health evidence did not pass');
    }
    if (requireDrillLifecycle && health.schema !== 'fsusblog.release-worker-target-health.v1')
    {
        errors.push('qualification target health schema is invalid');
    }
    if (observed.rolloutId !== rollout.rolloutId)
    {
        errors.push('target health rolloutId mismatch');
    }
    const releaseId = observed.releaseId ?? observed.release?.releaseId ?? observed.checks?.release?.releaseId;
    const slot = observed.slot ?? observed.release?.slot ?? observed.deployment?.slot;
    const generation = observed.generation ?? observed.deployment?.generation ?? observed.runtime?.deployment?.generation;
    if (releaseId !== rollout.target.releaseId)
    {
        errors.push('target health release identity mismatch');
    }
    if (slot !== undefined && slot !== rollout.target.slot)
    {
        errors.push('target health slot mismatch');
    }
    if (Number(generation) !== rollout.target.runtimeGeneration)
    {
        errors.push('target health generation mismatch');
    }
    if (requireDrillLifecycle && health.sourceLedger === undefined)
    {
        errors.push('qualification target health is not bound to its worker ledger');
    }
    else if (health.sourceLedger !== undefined)
    {
        validateArtifactReference(health.sourceLedger, ledgerArtifact, 'target health source ledger', errors);
    }
    if (requireDrillLifecycle
    && (health.readiness?.status !== 'pass' || health.takeover?.status !== 'pass'))
    {
        errors.push('qualification target health did not preserve readiness/takeover proof');
    }
    appendNestedErrors(health.errors, 'target health evidence', errors);
    return errors.length === before;
}

function validateQualification(input)
{
    const {
        ledger,
        rollout,
        qualificationId,
        qualificationControl,
        ledgerArtifact,
        resourcePolicy,
        resourcePolicyArtifact,
        expectedNormalRollout,
        errors
    } = input;
    const checks = {
        runIdentityBound: true,
        controlBound: true,
        resourcePolicyBound: true,
        sigkillVerified: true,
        takeoverVerified: true,
        allKindsRecoveredByTarget: true,
        normalRolloutSeparationVerified: false,
        qualificationPolicySha256: null,
        resourcePolicySha256: null
    };

    if (ledger.drill?.runId !== qualificationId)
    {
        checks.runIdentityBound = false;
        errors.push('qualification id does not match the destructive worker drill runId');
    }
    if (qualificationId === rollout.rolloutId)
    {
        checks.runIdentityBound = false;
        errors.push('qualification id must be distinct from its destructive rolloutId');
    }

    const controlErrorsBefore = errors.length;
    if (qualificationControl?.schema !== qualificationControlSchema || qualificationControl.status !== 'pass')
    {
        errors.push(`qualification control must be passing ${qualificationControlSchema}`);
    }
    if (qualificationControl?.rolloutId !== rollout.rolloutId)
    {
        errors.push('qualification control rolloutId mismatch');
    }
    if (!identityMatches(qualificationControl?.source, rollout.source))
    {
        errors.push('qualification control source identity mismatch');
    }
    if (!identityMatches(qualificationControl?.target, rollout.target))
    {
        errors.push('qualification control target identity mismatch');
    }
    if (qualificationControl?.source?.imageDigest !== rollout.source.imageDigest
    || qualificationControl?.target?.imageDigest !== rollout.target.imageDigest)
    {
        errors.push('qualification control source/target image digest mismatch');
    }
    if (qualificationControl?.qualificationMode !== 'forced-source-worker-termination')
    {
        errors.push('qualification control mode is not forced-source-worker-termination');
    }
    if (!digestPattern.test(String(qualificationControl?.policyHash ?? '')))
    {
        errors.push('qualification control policy hash is invalid');
    }
    else
    {
        const computedPolicyHash = sha256(JSON.stringify(qualificationControl.policyBinding ?? null));
        if (qualificationControl.policyHash !== computedPolicyHash)
        {
            errors.push('qualification control policy hash mismatch');
        }
        checks.qualificationPolicySha256 = qualificationControl.policyHash;
    }
    const policyBinding = qualificationControl?.policyBinding;
    if (policyBinding?.targetReleaseId !== rollout.target.releaseId
    || policyBinding?.targetImageDigest !== rollout.target.imageDigest
    || Number(policyBinding?.targetRuntimeGeneration) !== rollout.target.runtimeGeneration)
    {
        errors.push('qualification control policy target binding mismatch');
    }
    validateArtifactReference(qualificationControl?.ledger, ledgerArtifact, 'qualification control ledger', errors);
    validateArtifactReference(qualificationControl?.scenario, qualificationControl?.scenario?.path, 'qualification control scenario', errors);
    if (policyBinding?.scenarioSha256 !== qualificationControl?.scenario?.sha256)
    {
        errors.push('qualification control scenario policy binding mismatch');
    }
    if (policyBinding?.sourceTerminationType !== ledger.drill?.sourceTermination?.type
    || policyBinding?.coordinationMode !== ledger.drill?.coordination?.mode)
    {
        errors.push('qualification control termination/coordination policy binding mismatch');
    }
    if (qualificationControl?.coordination?.mode !== 'file-handshake'
    || qualificationControl?.coordination?.status !== 'pass')
    {
        errors.push('qualification control did not pass the file-handshake coordination');
    }
    if (qualificationControl?.sourceTermination?.status !== 'pass' || qualificationControl.sourceTermination.forced !== true)
    {
        errors.push('qualification control did not prove forced source termination');
    }
    if (qualificationControl?.targetReadiness?.status !== 'pass' || qualificationControl?.targetTakeover?.status !== 'pass')
    {
        errors.push('qualification control did not prove target readiness and takeover');
    }
    const blockers = qualificationControl?.observations?.blockers;
    if (!Array.isArray(blockers) || blockers.length !== 0)
    {
        errors.push('qualification control contains blockers');
    }
    appendNestedErrors(qualificationControl?.errors, 'qualification control', errors);
    checks.controlBound = errors.length === controlErrorsBefore;

    const policyErrorsBefore = errors.length;
    if (resourcePolicy?.schema !== resourcePolicySchema)
    {
        errors.push(`resource policy schema must be ${resourcePolicySchema}`);
    }
    if (!resourcePolicy?.minimumSupported || !resourcePolicy?.budgets || !resourcePolicy?.sampling)
    {
        errors.push('resource policy is incomplete');
    }
    checks.resourcePolicySha256 = resourcePolicyArtifact.sha256;
    checks.resourcePolicyBound = errors.length === policyErrorsBefore;

    const sourceTermination = ledger.drill?.sourceTermination;
    const terminationCompletedAt = Date.parse(sourceTermination?.completedAtUtc ?? '');
    if (ledger.drill?.coordination?.status !== 'pass'
    || ledger.drill?.terminationBoundary?.status !== 'pass'
    || sourceTermination?.status !== 'pass'
    || sourceTermination?.forced !== true
    || sourceTermination?.observation?.signal !== 'SIGKILL'
    || !Number.isFinite(terminationCompletedAt))
    {
        checks.sigkillVerified = false;
        errors.push('qualification ledger did not prove a coordinated SIGKILL at the termination boundary');
    }
    const takeoverCompletedAt = Date.parse(ledger.drill?.targetTakeover?.completedAtUtc ?? '');
    if (ledger.drill?.targetReadiness?.status !== 'pass'
    || ledger.drill?.targetTakeover?.status !== 'pass'
    || !Number.isFinite(takeoverCompletedAt)
    || !Number.isFinite(terminationCompletedAt)
    || takeoverCompletedAt < terminationCompletedAt)
    {
        checks.takeoverVerified = false;
        errors.push('qualification ledger did not prove target takeover after source termination');
    }

    const events = Array.isArray(ledger.events) ? ledger.events : [];
    for (const event of events)
    {
        const postTerminationFields = [
            'finalEffectCount',
            'finalEffectKey',
            'finalReleaseId',
            'finalGeneration',
            'staleGenerationCommitCount',
            ...(event.kind === 'audit-writer' ? ['actualAuditCount'] : []),
            ...(event.kind === 'visit-view-projection' ? ['actualProjectionCount'] : []),
            ...(event.kind === 'forced-source-recovery' ? ['recoveredByTarget'] : [])
        ];
        const finalObservationsAfterTermination = postTerminationFields.every(field =>
        {
            const observedAt = Date.parse(event.observationBindings?.[field]?.observedAtUtc ?? '');
            return Number.isFinite(observedAt)
        && Number.isFinite(terminationCompletedAt)
        && observedAt >= terminationCompletedAt;
        });
        const recovered = Number(event.pendingCountAtDrain) >= 1
      && event.finalEffectCount === 1
      && event.finalReleaseId === rollout.target.releaseId
      && event.finalGeneration === rollout.target.runtimeGeneration
      && Number(event.staleGenerationCommitCount ?? 0) === 0
      && isDurableReplaySource(event.durableReplaySource)
      && finalObservationsAfterTermination;
        if (!recovered)
        {
            checks.allKindsRecoveredByTarget = false;
            errors.push(`${event.logicalEventId ?? '<missing>'}: forced-source work was not proven recovered by the target after SIGKILL`);
        }
    }
    const forcedEvent = events.find(event => event.kind === 'forced-source-recovery');
    if (forcedEvent?.forcedSourceTermination !== true || forcedEvent?.recoveredByTarget !== true)
    {
        checks.allKindsRecoveredByTarget = false;
        errors.push('forced-source-recovery event did not prove target recovery');
    }

    if (expectedNormalRollout !== null)
    {
        if (expectedNormalRollout.rolloutId === rollout.rolloutId)
        {
            errors.push('qualification and expected normal rolloutId must differ');
        }
        else if (expectedNormalRollout.target.releaseId !== rollout.target.releaseId
      || expectedNormalRollout.target.imageDigest !== rollout.target.imageDigest)
        {
            errors.push('expected normal rollout target release/image does not match qualification target');
        }
        else
        {
            checks.normalRolloutSeparationVerified = true;
        }
    }
    return checks;
}

function identityMatches(observed, expected)
{
    return observed?.releaseId === expected.releaseId
    && observed?.slot === expected.slot
    && Number(observed?.generation ?? observed?.runtimeGeneration) === expected.runtimeGeneration
    && (observed?.imageDigest === undefined || observed.imageDigest === expected.imageDigest);
}

function validateArtifactReference(reference, expectedFile, label, errors)
{
    if (!reference || !digestPattern.test(String(reference.sha256 ?? '')) || typeof reference.path !== 'string')
    {
        errors.push(`${label} reference is incomplete`);
        return false;
    }
    let referencedPath;
    let expectedPath;
    let expectedHash;
    try
    {
        referencedPath = fs.realpathSync(reference.path);
        expectedPath = typeof expectedFile === 'string' ? fs.realpathSync(expectedFile) : expectedFile.path;
        expectedHash = typeof expectedFile === 'string' ? hashFile(expectedPath) : expectedFile.sha256;
    }
    catch (error)
    {
        errors.push(`${label} path is unreadable: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
    if (referencedPath !== expectedPath)
    {
        errors.push(`${label} path mismatch`);
    }
    const actualHash = hashFile(referencedPath);
    if (reference.sha256 !== expectedHash || actualHash !== expectedHash)
    {
        errors.push(`${label} hash mismatch`);
    }
    return referencedPath === expectedPath && reference.sha256 === expectedHash && actualHash === expectedHash;
}

function appendNestedErrors(value, label, errors)
{
    if (!Array.isArray(value))
    {
        return;
    }
    for (const error of value)
    {
        errors.push(`${label}: ${String(error)}`);
    }
}

function isDurableReplaySource(value)
{
    return ['postgres-outbox', 'postgres-row-lock', 'redis-stream', 'durable-upload-session'].includes(value);
}

function readJsonArtifact(file)
{
    const resolved = fs.realpathSync(file);
    const bytes = fs.readFileSync(resolved);
    return {
        value: JSON.parse(bytes.toString('utf8')),
        artifact: { path: resolved, bytes: bytes.length, sha256: sha256(bytes) }
    };
}

function hashFile(file)
{
    return sha256(fs.readFileSync(file));
}

function sha256(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
}

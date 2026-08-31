import fs from 'node:fs';
import path from 'node:path';

import {
    canonicalJson,
    digestCanonical,
    sealContentDigest
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../test/attempt-provenance.mjs';

import { cleanFirstAttemptVerdict } from './clean-first-attempt-verifier.mjs';

export const cleanAttemptCohortSchema = 'fsusblog.release-clean-attempt-cohort.v1';

function normalizedReference(reference, label)
{
    if (!reference || typeof reference !== 'object'
        || typeof reference.path !== 'string' || !reference.path
        || !/^sha256:[0-9a-f]{64}$/u.test(String(reference.digest ?? '')))
    {
        throw new Error(`${label} requires an exact path and SHA-256 digest`);
    }
    return { path: reference.path.replaceAll('\\', '/'), digest: reference.digest };
}

function evidenceBinding(verdict, aggregateReference, aggregateReceipt)
{
    const aggregate = verdict.aggregate;
    const attempt = verdict.attempt;
    return {
        producerId: aggregate?.producerId ?? null,
        schedulerRunId: aggregate?.schedulerRunId ?? null,
        sourceCommit: aggregate?.sourceCommit ?? null,
        worktreeFingerprint: aggregate?.worktreeFingerprint ?? null,
        retryPolicyId: aggregate?.retryPolicyId ?? null,
        aggregateReceipt: normalizedReference(aggregateReference, 'aggregateReceipt'),
        attemptReceipt: aggregateReceipt?.attempts?.[0]
            ? normalizedReference({
                path: aggregateReceipt.attempts[0].path,
                digest: aggregateReceipt.attempts[0].digest
            }, 'attemptReceipt')
            : null,
        attemptNumber: attempt?.attemptNumber ?? null,
        firstFailure: attempt?.firstFailure ?? null,
        cleanFirstAttempt: aggregate?.cleanFirstAttempt ?? false,
        qualificationEligible: aggregate?.qualificationEligible ?? false,
        executionEnvelopeDigest: attempt?.executionEnvelopeDigest ?? null,
        replayPlanDigest: attempt?.replayPlanDigest ?? null,
        temporalContextDigest: attempt?.temporalContextDigest ?? null,
        logs: attempt ? {
            stdout: {
                path: attempt.stdoutPath,
                digest: attempt.artifactDigests[attempt.stdoutPath]
            },
            stderr: {
                path: attempt.stderrPath,
                digest: attempt.artifactDigests[attempt.stderrPath]
            }
        } : null,
        artifacts: attempt ? attempt.artifactPaths.map((artifactPath) => ({
            path: artifactPath,
            digest: attempt.artifactDigests[artifactPath]
        })) : []
    };
}

export function createCleanAttemptCohort(cohortId, buildIdentity)
{
    if (typeof cohortId !== 'string' || !cohortId.trim()
        || !/^sha256:[0-9a-f]{64}$/u.test(String(buildIdentity ?? '')))
    {
        throw new Error('cohortId and buildIdentity are required');
    }
    return sealContentDigest({
        schema: cleanAttemptCohortSchema,
        cohortId: cohortId.trim(),
        buildIdentity,
        previousRevisionDigest: null,
        events: [],
        qualificationEligible: false
    });
}

export function appendCleanAttemptCohortSlot(cohort, {
    slot,
    aggregateReference,
    aggregateReceipt,
    loadAttempt,
    verifyAuthority,
    verifyArtifact,
    expectedIdentity = {}
})
{
    validateCleanAttemptCohort(cohort);
    if (!Number.isInteger(slot) || slot < 1 || slot > 3)
    {
        throw new Error(`cohort slot must be 1, 2, or 3; got ${slot}`);
    }
    if (cohort.events.some((event) => event.slot === slot))
    {
        throw new Error(`cohort.slot-immutable: slot ${slot} already has an append-only admission event`);
    }
    const verdict = cleanFirstAttemptVerdict({
        aggregateReceipt,
        loadAttempt,
        verifyAuthority,
        verifyArtifact,
        expectedIdentity
    });
    const binding = evidenceBinding(verdict, aggregateReference, aggregateReceipt);
    const duplicateRun = cohort.events.find((event) => (
        event.evidence.schedulerRunId !== null
        && event.evidence.schedulerRunId === binding.schedulerRunId
    ));
    const duplicateAttemptRoot = cohort.events.find((event) => (
        event.evidence.aggregateReceipt.path === binding.aggregateReceipt.path
    ));
    const reasons = [...verdict.reasons];
    if (duplicateRun)
    {
        reasons.push({
            code: 'cohort.run-not-independent',
            message: `slot ${slot} reuses schedulerRunId ${binding.schedulerRunId} from slot ${duplicateRun.slot}`,
            slot,
            conflictingSlot: duplicateRun.slot,
            producerId: binding.producerId,
            schedulerRunId: binding.schedulerRunId
        });
    }
    if (duplicateAttemptRoot)
    {
        reasons.push({
            code: 'cohort.attempt-root-not-independent',
            message: `slot ${slot} reuses aggregate receipt ${binding.aggregateReceipt.path} from slot ${duplicateAttemptRoot.slot}`,
            slot,
            conflictingSlot: duplicateAttemptRoot.slot,
            producerId: binding.producerId,
            schedulerRunId: binding.schedulerRunId
        });
    }
    const event = sealContentDigest({
        schema: 'fsusblog.release-clean-attempt-cohort-event.v1',
        sequence: cohort.events.length + 1,
        slot,
        previousEventDigest: cohort.events.at(-1)?.contentDigest ?? null,
        status: verdict.eligible && reasons.length === 0 ? 'admitted' : 'rejected',
        reasons,
        evidence: binding
    });
    const events = [...cohort.events, event];
    const qualificationEligible = events.length === 3
        && events.every((entry) => entry.status === 'admitted')
        && new Set(events.map((entry) => entry.evidence.schedulerRunId)).size === 3
        && new Set(events.map((entry) => entry.evidence.aggregateReceipt.path)).size === 3;
    return sealContentDigest({
        schema: cleanAttemptCohortSchema,
        cohortId: cohort.cohortId,
        buildIdentity: cohort.buildIdentity,
        previousRevisionDigest: cohort.contentDigest,
        events,
        qualificationEligible
    });
}

export function validateCleanAttemptCohort(cohort)
{
    if (cohort?.schema !== cleanAttemptCohortSchema)
    {
        throw new Error(`cohort schema must be ${cleanAttemptCohortSchema}`);
    }
    const unsigned = { ...cohort };
    delete unsigned.contentDigest;
    if (cohort.contentDigest !== digestCanonical(unsigned))
    {
        throw new Error('cohort content digest mismatch');
    }
    if (!Array.isArray(cohort.events) || cohort.events.length > 3)
    {
        throw new Error('cohort must contain at most three append-only events');
    }
    let previous = null;
    const slots = new Set();
    for (const [index, event] of cohort.events.entries())
    {
        const eventUnsigned = { ...event };
        delete eventUnsigned.contentDigest;
        if (event.sequence !== index + 1
            || event.previousEventDigest !== previous
            || event.contentDigest !== digestCanonical(eventUnsigned)
            || slots.has(event.slot))
        {
            throw new Error(`cohort event ${index + 1} breaks the append-only slot chain`);
        }
        slots.add(event.slot);
        previous = event.contentDigest;
    }
    const eligible = cohort.events.length === 3
        && cohort.events.every((event) => event.status === 'admitted')
        && new Set(cohort.events.map((event) => event.evidence.schedulerRunId)).size === 3
        && new Set(cohort.events.map((event) => event.evidence.aggregateReceipt.path)).size === 3;
    if (cohort.qualificationEligible !== eligible)
    {
        throw new Error('cohort qualification does not match three independent admitted slots');
    }
    return cohort;
}

export function persistCleanAttemptCohortRevision(file, cohort)
{
    validateCleanAttemptCohort(cohort);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${canonicalJson(cohort)}\n`, { flag: 'wx', mode: 0o444 });
}

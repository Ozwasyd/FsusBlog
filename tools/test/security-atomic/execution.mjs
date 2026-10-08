import { URL } from 'node:url';

import { validateContext } from './contract.mjs';
import { admitSecurityBoundary } from './external-boundaries.mjs';
import { admitSecurityScenario } from './scenarios.mjs';

const { verifyCompiledAtomicProducerDag } = await import(new URL('../../test-matrix/atomic-producers/compiler.mjs', import.meta.url));
const { resolveAtomicReplayPlan, resolveAtomicReference } = await import(new URL('../../test-matrix/atomic-producers/contract.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../attempt-provenance.mjs', import.meta.url));
const { runProducerAttempts } = await import(new URL('../attempt-runner.mjs', import.meta.url));
const { readCanonicalSchedulerCheckpoint, readCanonicalSchedulerResourceGrant } = await import(new URL('../../test-matrix/scheduler.mjs', import.meta.url));

function readScenarioGrant({ schedulerGrant, step, binding, executionContext })
{
    const canonical = readCanonicalSchedulerCheckpoint(schedulerGrant.checkpointFile);
    const source = canonical?.checkpoint?.sourceState;
    if (source?.commit !== binding.sourceRevision
        || source.worktreeFingerprint !== executionContext.worktreeFingerprint.replace(/^sha256:/u, ''))
    {
        throw new Error('security resource grant checkpoint differs from current source');
    }
    const grant = readCanonicalSchedulerResourceGrant({ ...schedulerGrant, runId: binding.runId });
    if (grant.checkpointDigest !== canonical.checkpointDigest
        || grant.grant.cpuUnits < (step.resources.minCpuUnits ?? 0)
        || grant.grant.memoryGiB < (step.resources.minMemoryGiB ?? 0))
    {
        throw new Error('security resource grant changed during read or is below the declared minimum');
    }
    return grant;
}

async function runDeclaredSecurityAttempt({ producer, context, ownerVerifiers,
    compiled, matrix, authorities, executionContext, producerContext, schedulerGrant },
{ executionVerifier, grantIdentityVerifier, admit })
{
    const binding = validateContext(context);
    const dag = verifyCompiledAtomicProducerDag(compiled, matrix, authorities);
    const step = dag.steps.find((item) => item.id === producer.producerId);
    const profile = step?.fixtureProfile
        ? resolveAtomicReference(authorities.fixtureProfiles, step.fixtureProfile, 'fixture profile') : null;
    if (!step || step.kind !== 'atomic-producer'
        || step.attemptPolicyId !== 'correctness-first-attempt'
        || (profile.profileId ?? profile.id) !== binding.profileId
        || digestCanonical([...step.dependsOn].sort()) !== digestCanonical([...producer.dependsOn].sort())
        || step.settledDependsOn.length !== 0)
    {
        throw new Error('security execution must bind its exact canonical declaration');
    }
    const declarationVerifier = ownerVerifiers?.[executionVerifier];
    if (typeof declarationVerifier !== 'function'
        || await declarationVerifier(producer, step, binding) !== producer.producerId)
    {
        throw new Error('scenario command/state/resource ownership requires canonical execution admission');
    }
    const grantVerifier = ownerVerifiers?.[grantIdentityVerifier];
    if (!Number.isInteger(schedulerGrant?.expectedGeneration)
        || typeof grantVerifier !== 'function'
        || await grantVerifier(producer, step, schedulerGrant, binding) !== schedulerGrant.tierId)
    {
        throw new Error('scenario resource grant requires exact generation and canonical tier/producer binding');
    }
    const replay = resolveAtomicReplayPlan(authorities.replayPlans, step.replayPlanRef);
    const replayReference = producerContext?.authorityReferences?.find((item) => item.kind === 'replay-plan');
    if (executionContext?.schedulerRunId !== binding.runId
        || executionContext.sourceCommit !== binding.sourceRevision
        || replay.plan.source.commit !== binding.sourceRevision
        || replay.plan.source.worktreeFingerprint !== executionContext.worktreeFingerprint
        || replay.plan.run.id !== binding.runId
        || replay.plan.command.environmentDigest !== digestCanonical(producerContext?.env)
        || replayReference?.artifactDigest !== step.replayPlanRef.contentDigest
        || replayReference.artifactPath !== replay.artifactPath)
    {
        throw new Error('scenario attempt requires exact replay/source/run/environment binding');
    }
    await admit(binding, step);
    // Read the actual immutable checkpoint/journal and active owner grant after
    // async admission, immediately before the existing attempt runner can spawn.
    readScenarioGrant({ schedulerGrant, step, binding, executionContext });
    // No registry/command/test-enumeration override is accepted. The original
    // runner verifies envelope/replay/temporal authorities and writes receipts.
    return runProducerAttempts({
        evidenceRoot: executionContext.evidenceRoot,
        schedulerRunId: binding.runId,
        sourceCommit: binding.sourceRevision,
        worktreeFingerprint: executionContext.worktreeFingerprint,
        producerId: producer.producerId,
        retryPolicyId: step.attemptPolicyId,
        command: step.command,
        cwd: producerContext.cwd,
        env: producerContext.env,
        signal: producerContext.signal,
        timeoutMs: producerContext.timeoutMs,
        authorityReferences: producerContext.authorityReferences,
        verifyAuthority: producerContext.verifyAuthority,
        expectedTestIds: replay.plan.testEnumerationOrder
    });
}

/** Execute one admitted scenario through the canonical zero-retry attempt port. */
export function runSecurityScenarioAttempt(options)
{
    return runDeclaredSecurityAttempt(options, {
        executionVerifier: 'scenarioExecution', grantIdentityVerifier: 'scenarioGrantIdentity',
        async admit(context, step)
        {
            if (step.executionClass !== 'runtime')
            {
                throw new Error('security scenario requires the canonical runtime execution class');
            }
            await admitSecurityScenario({ ...options, context });
        }
    });
}

/** Execute an independently applicable correctness boundary; keep exclusions pending. */
export async function runSecurityBoundaryAttempt(options)
{
    const admission = await admitSecurityBoundary(options);
    if (admission.spawn === false)
    {
        // The native terminal schema has no non-applicability state yet. Keep
        // the owner's request and unmet receipt visible without a fake success.
        return Object.freeze({ admission, attempt: null, terminalReceipt: null, qualificationEligible: false });
    }
    if (options.producer.selection.classification !== 'correctness')
    {
        throw new Error('diagnostic boundaries require a canonical non-correctness attempt/terminal capability');
    }
    const attempt = await runDeclaredSecurityAttempt(options, {
        executionVerifier: 'boundaryExecution', grantIdentityVerifier: 'boundaryGrantIdentity',
        // Revalidate immediately before the grant read/spawn; policy/evidence
        // cannot become stale during asynchronous execution-owner verification.
        async admit(context)
        {
            const current = await admitSecurityBoundary({ ...options, context });
            if (current.spawn === false)
            {
                throw new Error('boundary became non-applicable before execution; original terminal receipt is required');
            }
        }
    });
    return Object.freeze({ admission, attempt, qualificationEligible: false });
}

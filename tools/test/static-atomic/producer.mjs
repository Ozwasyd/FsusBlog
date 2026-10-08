import path from 'node:path';

import { staticAtomicDeclarations, staticAtomicProducer } from './declarations.mjs';

const { digestCanonical } = await import(new URL('../attempt-provenance.mjs', import.meta.url));
const { runProducerAttempts } = await import(new URL('../attempt-runner.mjs', import.meta.url));

/** Require the external envelope owner to bind and enforce the exact domain execution. */
export function staticAtomicAuthorityVerifier({ verifyAuthority, producer, binding })
{
    if (typeof verifyAuthority !== 'function')
    {
        throw new Error('static atomic execution requires an external authority verifier');
    }
    return reference =>
    {
        const verification = verifyAuthority(reference);
        if (reference.kind === 'execution-envelope')
        {
            const actual = verification?.staticAtomic;
            if (!actual || Object.entries(binding).some(([field, value]) => actual[field] !== value)
                || actual.network !== producer.network || actual.networkEnforced !== true
                || (producer.network === 'policy-bound'
                    && !/^sha256:[a-f0-9]{64}$/u.test(actual.networkPolicyDigest ?? '')))
            {
                throw new Error(`static atomic execution envelope does not bind inputs/environment/network: ${producer.id}`);
            }
        }
        return verification;
    };
}

/** Execute exactly one declared command with the existing first-attempt runner; never schedule siblings. */
export async function runStaticAtomicProducer({ repositoryRoot, producerId, inputClosureDigest, context })
{
    if (!/^sha256:[a-f0-9]{64}$/u.test(inputClosureDigest ?? ''))
    {
        throw new Error('a verified held input closure digest is required');
    }
    if (!context?.env || typeof context.env !== 'object' || Array.isArray(context.env)
        || Object.values(context.env).some(value => typeof value !== 'string'))
    {
        throw new Error('an explicit string-valued execution environment is required');
    }
    const declarations = staticAtomicDeclarations(repositoryRoot);
    const producer = staticAtomicProducer(declarations, producerId);
    const env = Object.freeze({ ...context.env });
    if (producerId === 'security-network-baseline'
        && env.FSUSBLOG_SKIP_PRODUCTION_EXPOSURE_TOOL_TEST
        && env.FSUSBLOG_SKIP_PRODUCTION_EXPOSURE_TOOL_TEST !== '0')
    {
        throw new Error('static network baseline cannot skip its existing exposure tool tests');
    }
    const cwd = path.resolve(repositoryRoot, producer.cwd);
    const binding = {
        declarationDigest: declarations.contentDigest,
        inputClosureDigest,
        commandDigest: digestCanonical(producer.command),
        environmentDigest: digestCanonical(env),
        resourceContractDigest: digestCanonical(producer.resources),
        prerequisiteSetDigest: digestCanonical(producer.prerequisites),
        cwd
    };
    const verifyAuthority = staticAtomicAuthorityVerifier({
        verifyAuthority: context.verifyAuthority, producer, binding
    });
    const result = await runProducerAttempts({
        evidenceRoot: context.evidenceRoot,
        sourceCommit: context.sourceCommit,
        worktreeFingerprint: context.worktreeFingerprint,
        schedulerRunId: context.schedulerRunId,
        timeoutMs: context.timeoutMs,
        signal: context.signal,
        authorityReferences: context.authorityReferences,
        env,
        verifyAuthority,
        producerId,
        cwd,
        command: producer.command,
        retryPolicyId: 'correctness-first-attempt',
        expectedTestIds: producer.assertionBindings.map(assertion => assertion.sourceTestId)
    });
    return { ...result, binding, declarationDigest: declarations.contentDigest };
}

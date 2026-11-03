import fs from 'node:fs';
import path from 'node:path';

import { staticAtomicDeclarations, staticAtomicProducer } from './declarations.mjs';
import { staticAtomicAuthorityVerifier } from './producer.mjs';

const { digestCanonical, sealContentDigest, validateAttemptReceipt, verifyFileDigest } = await import(new URL('../attempt-provenance.mjs', import.meta.url));

export const staticAtomicSummarySchema = 'fsusblog.static-atomic-summary.v1';

function containedRegularFile(root, relative)
{
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
        || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..'))
    {
        throw new Error('child attempt reference must be a confined relative path');
    }
    let current = path.resolve(root);
    if (fs.lstatSync(current).isSymbolicLink())
    {
        throw new Error('child evidence root must not be a symlink');
    }
    for (const part of relative.split('/'))
    {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink())
        {
            throw new Error('child attempt reference must not follow a symlink');
        }
    }
    if (!fs.statSync(current).isFile())
    {
        throw new Error('child attempt reference must be a regular file');
    }
    return current;
}

/** Read all executed child receipts; no command execution or artifact-existence success inference. */
export function projectStaticAtomicSummary({ repositoryRoot, evidenceRoot, lane, identity, children, verifyAuthority })
{
    const declarations = staticAtomicDeclarations(repositoryRoot);
    const summary = declarations.summaries.find(entry => entry.lane === lane);
    if (!summary || !Array.isArray(children)
        || children.length !== summary.settledDependsOn.length
        || new Set(children.map(child => child.producerId)).size !== children.length
        || digestCanonical(children.map(child => child.producerId).sort())
            !== digestCanonical([...summary.settledDependsOn].sort()))
    {
        throw new Error('static settled projection requires the exact complete child set');
    }
    const statuses = [...children].sort((left, right) => left.producerId.localeCompare(right.producerId)).map(child =>
    {
        const producer = staticAtomicProducer(declarations, child.producerId);
        const file = containedRegularFile(evidenceRoot, child.attemptPath);
        const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
        const binding = child.binding;
        if (!binding || binding.declarationDigest !== declarations.contentDigest
            || binding.commandDigest !== digestCanonical(producer.command)
            || binding.resourceContractDigest !== digestCanonical(producer.resources)
            || binding.prerequisiteSetDigest !== digestCanonical(producer.prerequisites)
            || binding.cwd !== path.resolve(repositoryRoot, producer.cwd)
            || !/^sha256:[a-f0-9]{64}$/u.test(binding.inputClosureDigest ?? '')
            || !/^sha256:[a-f0-9]{64}$/u.test(binding.environmentDigest ?? ''))
        {
            throw new Error(`static child execution binding mismatch: ${child.producerId}`);
        }
        const validated = validateAttemptReceipt(receipt, {
            verifyAuthority: staticAtomicAuthorityVerifier({ verifyAuthority, producer, binding }),
            verifyArtifact: (relative, digest) =>
            {
                containedRegularFile(path.dirname(file), relative);
                return verifyFileDigest(path.dirname(file), relative, digest);
            }
        });
        if (validated.contentDigest !== child.attemptDigest || validated.producerId !== child.producerId
            || validated.attemptNumber !== 1 || validated.maxAttempts !== 1
            || validated.retryPolicyId !== 'correctness-first-attempt'
            || validated.commandDigest !== binding.commandDigest
            || validated.sourceCommit !== identity?.sourceCommit
            || validated.worktreeFingerprint !== identity?.worktreeFingerprint
            || validated.schedulerRunId !== identity?.schedulerRunId
            || digestCanonical(validated.executedTestIds)
                !== digestCanonical(producer.assertionBindings.map(assertion => assertion.sourceTestId).sort()))
        {
            throw new Error(`static child attempt identity/command/membership mismatch: ${child.producerId}`);
        }
        return {
            producerId: producer.id,
            terminalState: validated.status,
            reasonCode: validated.failureKind,
            attemptRef: { path: child.attemptPath, digest: validated.contentDigest },
            executionIdentityDigest: validated.executionEnvelopeDigest,
            inputClosureDigest: binding.inputClosureDigest,
            replayRef: validated.authorityReferences.find(reference => reference.kind === 'replay-plan'),
            primaryFailureRefs: validated.status === 'clean-success' ? [] : [child.attemptPath],
            evidenceRefs: validated.artifactPaths.map(relative => ({
                path: path.posix.join(path.posix.dirname(child.attemptPath), relative),
                digest: validated.artifactDigests[relative]
            })),
            assertionBindings: producer.assertionBindings
        };
    });
    return sealContentDigest({
        schema: staticAtomicSummarySchema,
        producerId: summary.id,
        owner: lane,
        phase: 'static',
        declarationDigest: declarations.contentDigest,
        identity,
        status: statuses.every(child => child.terminalState === 'clean-success') ? 'success' : 'failure',
        qualificationEligible: false,
        membershipStatus: declarations.membershipStatus,
        children: statuses
    });
}

/** Revalidate every referenced attempt and log; a resealed summary cannot rewrite child outcomes. */
export function verifyStaticAtomicSummary(receipt, options)
{
    const expected = projectStaticAtomicSummary(options);
    if (digestCanonical(receipt) !== digestCanonical(expected))
    {
        throw new Error('static atomic summary does not match verified child attempts');
    }
    return expected;
}

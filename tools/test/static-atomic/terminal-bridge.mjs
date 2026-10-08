import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import { verifyStaticAtomicCompilation } from './compiler-bridge.mjs';
import { staticAtomicDeclarations } from './declarations.mjs';
import { staticAtomicAuthorityVerifier } from './producer.mjs';

const { digestCanonical, sealContentDigest, sha256, validateAggregateAttemptReceipt, verifyFileDigest } = await import(new URL('../attempt-provenance.mjs', import.meta.url));
const { resumeCurrentRunEvidenceCheckpoint } = await import(new URL('../current-run-evidence-checkpoint.mjs', import.meta.url));
const { evidenceContentDigest, evidenceProducerReceiptDigest } = await import(new URL('../current-run-evidence-locator.mjs', import.meta.url));
const { readCurrentRunEvidencePublication } = await import(new URL('../current-run-evidence-publication.mjs', import.meta.url));
const { resolveAtomicReplayPlan } = await import(new URL('../../test-matrix/atomic-producers/contract.mjs', import.meta.url));
const { verifyAtomicTerminalVector } = await import(new URL('../../test-matrix/atomic-producers/execution.mjs', import.meta.url));
const { readCanonicalSchedulerCheckpoint } = await import(new URL('../../test-matrix/scheduler.mjs', import.meta.url));
const { buildSettledPhaseJoinEvidence } = await import(new URL('../bundles/bundle-steps.mjs', import.meta.url));

const terminalStates = new Set(['success', 'failed', 'blocked', 'cancelled', 'timed-out', 'internal-error']);

function same(left, right, label)
{
    if (digestCanonical(left) !== digestCanonical(right))
    {
        throw new Error(`static atomic terminal ${label} mismatch`);
    }
}

function ownedFile(root, file)
{
    const relative = path.relative(path.resolve(root), path.resolve(file));
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
        || fs.realpathSync(root) !== path.resolve(root))
    {
        throw new Error('static atomic terminal reference escapes its owned evidence root');
    }
    let current = path.resolve(root);
    for (const part of relative.split(path.sep))
    {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink())
        {
            throw new Error('static atomic terminal reference must not follow symlink aliases');
        }
    }
    if (!fs.statSync(current).isFile())
    {
        throw new Error('static atomic terminal reference must be a regular file');
    }
    return current;
}

function readOwned(root, file)
{
    return JSON.parse(fs.readFileSync(ownedFile(root, file), 'utf8'));
}

function verifyVector(vector, compilation, context, expectedVector)
{
    verifyAtomicTerminalVector(vector, expectedVector);
    same(vector.schema, 'fsusblog.atomic-producer-terminal-vector.v1', 'vector schema');
    same(vector.compiledDagDigest, compilation.compiled.contentDigest, 'compiled DAG');
    same(vector.matrixDigest, compilation.compiled.matrixDigest, 'matrix');
    same(vector.qualificationEligible, false, 'source qualification');
    for (const field of ['schedulerRunId', 'sourceCommit', 'worktreeFingerprint'])
    {
        same(vector[field], context[field], `vector ${field}`);
    }
    same(vector.receipts.map(entry => entry.producerId).sort(), compilation.compiled.steps.map(entry => entry.id).sort(),
        'complete terminal roster');
    for (const receipt of vector.receipts)
    {
        const { contentDigest, ...body } = receipt;
        same(contentDigest, digestCanonical(body), 'child terminal digest');
        const step = compilation.compiled.steps.find(entry => entry.id === receipt.producerId);
        same(receipt.kind, step.kind, 'child kind');
        same(receipt.logicalParentId, step.logicalParentId, 'child parent');
        same(receipt.compiledDagDigest, vector.compiledDagDigest, 'child compiled DAG');
        for (const field of ['schedulerRunId', 'sourceCommit', 'worktreeFingerprint'])
        {
            same(receipt[field], context[field], `child ${field}`);
        }
        if (!terminalStates.has(receipt.terminalState))
        {
            throw new Error('static atomic terminal child is not terminal');
        }
        if (receipt.terminalState === 'blocked')
        {
            const blockedBy = step.dependsOn.filter(id => vector.receipts.find(entry => entry.producerId === id)?.terminalState !== 'success');
            same(receipt.blockedBy, blockedBy, 'actual hard blocked predecessors');
            if (blockedBy.length === 0 || !blockedBy.every(id => receipt.primaryFailureRefs.includes(id))
                || receipt.primaryFailureRefs.some(id => !step.dependsOn.includes(id))
                || receipt.attemptRef !== null || receipt.aggregateAttemptRef !== null || receipt.artifactRefs.length !== 0)
            {
                throw new Error('static atomic terminal blocked child has invalid predecessor or spawned attempt');
            }
        }
        else
        {
            same(receipt.blockedBy, [], 'nonblocked predecessor roster');
        }
    }
    const success = !vector.interruption && vector.receipts.every(entry => entry.terminalState === 'success');
    same(vector.status, success ? 'success' : 'failed', 'honest vector status');
}

/** Consume the canonical executor's whole terminal vector, including zero-spawn blocked children. */
export function projectCompiledStaticAtomicSummary({ compilation, compilationOptions, vector, expectedVector,
    context, producerContexts, lane })
{
    verifyStaticAtomicCompilation(compilation, compilationOptions);
    verifyVector(vector, compilation, context, expectedVector);
    const declarations = staticAtomicDeclarations(compilationOptions.repositoryRoot);
    const summary = declarations.summaries.find(entry => entry.lane === lane);
    if (!summary)
    {
        throw new Error('static atomic terminal projection requires a static domain');
    }
    const compiledSummary = compilation.compiled.steps.find(entry => entry.id === summary.id);
    const children = compiledSummary.settledDependsOn.map(id =>
    {
        const terminal = vector.receipts.find(entry => entry.producerId === id);
        const bound = compilation.binding.producerBindings.find(entry => entry.producerId === id);
        const producer = declarations.producers.find(entry => entry.id === id);
        const replay = resolveAtomicReplayPlan(compilationOptions.authorities.replayPlans, bound.replayPlanRef);
        if (terminal.attemptRef)
        {
            const producerRoot = path.join(context.evidenceRoot, context.schedulerRunId, id);
            const attemptFile = path.join(producerRoot, 'attempt-1', 'receipt.json');
            same(terminal.attemptRef.path, attemptFile, 'current attempt path');
            same(terminal.aggregateAttemptRef?.path, path.join(producerRoot, 'aggregate.json'), 'current aggregate path');
            const aggregate = readOwned(context.evidenceRoot, terminal.aggregateAttemptRef.path);
            const receipt = readOwned(context.evidenceRoot, attemptFile);
            const supplied = producerContexts[id];
            const verifyAuthority = staticAtomicAuthorityVerifier({
                producer, verifyAuthority: supplied?.verifyAuthority,
                binding: {
                    declarationDigest: declarations.contentDigest,
                    inputClosureDigest: bound.inputClosureRef.contentDigest,
                    commandDigest: digestCanonical(producer.command),
                    environmentDigest: replay.plan.command.environmentDigest,
                    resourceContractDigest: digestCanonical(producer.resources),
                    prerequisiteSetDigest: digestCanonical(producer.prerequisites),
                    cwd: path.resolve(compilationOptions.repositoryRoot, producer.cwd)
                }
            });
            validateAggregateAttemptReceipt(aggregate, {
                loadAttempt: reference =>
                {
                    same(reference.path, 'attempt-1/receipt.json', 'sole attempt reference');
                    return receipt;
                },
                verifyAuthority,
                verifyArtifact: (relative, digest) =>
                {
                    ownedFile(context.evidenceRoot, path.join(producerRoot, 'attempt-1', relative));
                    return verifyFileDigest(path.join(producerRoot, 'attempt-1'), relative, digest);
                }
            });
            same(aggregate.attempts.length, 1, 'sole first attempt');
            same([receipt.attemptNumber, receipt.maxAttempts, receipt.retryPolicyId],
                [1, 1, 'correctness-first-attempt'], 'correctness first-attempt policy');
            same(aggregate.contentDigest, terminal.aggregateAttemptRef.contentDigest, 'aggregate digest');
            same(terminal.evidenceRefs, [{ path: terminal.aggregateAttemptRef.path, contentDigest: aggregate.contentDigest }],
                'attempt evidence references');
            same(receipt.contentDigest, terminal.attemptRef.contentDigest, 'attempt digest');
            same(receipt.producerId, id, 'attempt producer');
            same(receipt.command, producer.command, 'original command');
            same(receipt.executedTestIds, bound.membership.replayTestIds, 'original replay membership');
            same(terminal.artifactRefs, receipt.artifactPaths.map(relative => ({
                path: path.join(producerRoot, 'attempt-1', relative), contentDigest: receipt.artifactDigests[relative]
            })), 'attempt artifact references');
            for (const field of ['schedulerRunId', 'sourceCommit', 'worktreeFingerprint'])
            {
                same(receipt[field], context[field], `attempt ${field}`);
            }
            const actualState = aggregate.cleanFirstAttempt ? 'success'
                : receipt.failureKind === 'runner-timeout' ? 'timed-out'
                    : receipt.failureKind === 'runner-cancelled' ? 'cancelled' : 'failed';
            same(terminal.terminalState, actualState, 'attempt outcome');
        }
        else if (terminal.terminalState === 'failed' && terminal.reasonCode === 'required-input-admission-failed')
        {
            const admission = producerContexts[id]?.requiredInputAdmission;
            if (!admission || typeof admission.validate !== 'function')
            {
                throw new Error('static atomic terminal input refusal requires the original admission capability');
            }
            same(admission.inputClosureRef, bound.inputClosureRef, 'refused input admission closure');
            same(terminal.primaryFailureRefs, [id], 'refused input primary failure');
            const file = path.join(context.evidenceRoot, context.schedulerRunId, 'atomic-dag',
                compilation.compiled.contentDigest.slice(7), `${id}.json`);
            same(terminal.evidenceRefs.length, 1, 'sole input refusal observation');
            same(terminal.evidenceRefs[0].path, file, 'current input refusal observation path');
            const observation = readOwned(context.evidenceRoot, file);
            const body = { ...observation };
            delete body.contentDigest;
            same(observation.contentDigest, digestCanonical(body), 'input refusal observation seal');
            same(observation.contentDigest, terminal.evidenceRefs[0].contentDigest, 'input refusal observation digest');
            same(Object.keys(body).sort(), ['producerId', 'compiledDagDigest', 'receiptKind', 'terminalState',
                'reasonCode', 'inputClosureRef', 'attemptAllocationCount', 'physicalSpawnCount', 'reason'].sort(),
            'input refusal observation fields');
            same(observation.producerId, id, 'input refusal producer');
            same(observation.compiledDagDigest, compilation.compiled.contentDigest, 'input refusal compiled DAG');
            same(observation.inputClosureRef, bound.inputClosureRef, 'input refusal held closure');
            same(observation.receiptKind, 'required-input-admission-refused-before-attempt', 'input refusal observation kind');
            same(observation.terminalState, 'failed', 'input refusal state');
            same(observation.reasonCode, terminal.reasonCode, 'input refusal reason');
            same([observation.attemptAllocationCount, observation.physicalSpawnCount], [0, 0], 'input refusal zero allocation');
            if (typeof observation.reason !== 'string' || !observation.reason)
            {
                throw new Error('static atomic terminal input refusal lacks its original error reason');
            }
            if (fs.existsSync(path.join(context.evidenceRoot, context.schedulerRunId, id)))
            {
                throw new Error('static atomic terminal input refusal cannot conceal an allocated attempt');
            }
        }
        else if (!['blocked', 'cancelled', 'internal-error'].includes(terminal.terminalState))
        {
            throw new Error('static atomic terminal executed child requires its verified first attempt');
        }
        if (!terminal.attemptRef && (terminal.aggregateAttemptRef !== null || terminal.artifactRefs.length !== 0))
        {
            throw new Error('static atomic terminal unspawned child cannot carry executed attempt artifacts');
        }
        return { ...terminal, replayPlanRef: bound.replayPlanRef, inputClosureRef: bound.inputClosureRef,
            originalAssertionBindings: bound.membership.originalAssertionBindings,
            legacyPhysicalTestIds: bound.membership.legacyPhysicalTestIds,
            replayTestIds: bound.membership.replayTestIds };
    });
    const aggregate = vector.receipts.find(entry => entry.producerId === summary.id);
    if (aggregate.evidenceRefs.length > 0)
    {
        const expectedPath = path.join(context.evidenceRoot, context.schedulerRunId, 'atomic-dag',
            compilation.compiled.contentDigest.slice(7), `${summary.id}.json`);
        same(aggregate.evidenceRefs.length, 1, 'sole projection evidence');
        same(aggregate.evidenceRefs[0].path, expectedPath, 'current projection evidence path');
        const evidence = readOwned(context.evidenceRoot, expectedPath);
        same(evidence.schema, 'fsusblog.local-production.phase-join.v1', 'canonical projection evidence schema');
        same(evidence.canonicalDependencyOrder, compiledSummary.settledDependsOn, 'projection evidence child roster');
        same(evidence.dependencies.map(entry => ({ id: entry.id, outcome: entry.outcome })),
            children.map(entry => ({ id: entry.producerId, outcome: entry.terminalState })), 'projection evidence outcomes');
        const generated = buildSettledPhaseJoinEvidence({ stepId: summary.id,
            dependencyIds: evidence.canonicalDependencyOrder,
            dependencyOutcomes: Object.fromEntries(evidence.dependencies.map(entry => [entry.id, entry.outcome])),
            dependencyResults: Object.fromEntries(evidence.dependencies.filter(entry => entry.receiptPresent)
                .map(entry => [entry.id, { terminalState: entry.receiptTerminalState, durationMs: entry.durationMs, logFile: entry.logFile }])),
            evidenceRef: expectedPath, generatedAt: evidence.generatedAt }).evidence;
        same(evidence, generated, 'canonical projection evidence bytes');
        same(evidence.contentDigest, aggregate.evidenceRefs[0].contentDigest, 'projection evidence digest');
        same(evidence.terminalState, aggregate.terminalState, 'projection evidence terminal');
    }
    else if (!['cancelled', 'internal-error'].includes(aggregate.terminalState))
    {
        throw new Error('static atomic terminal completed projection requires its canonical evidence');
    }
    const allSuccess = children.every(child => child.terminalState === 'success');
    const status = allSuccess && aggregate.terminalState === 'success' ? 'success' : 'failure';
    if (!allSuccess && aggregate.terminalState === 'success')
    {
        throw new Error('static atomic terminal summary cannot promote non-success children');
    }
    return sealContentDigest({ schema: 'fsusblog.compiled-static-atomic-summary.v1',
        owner: lane, producerId: summary.id, phase: 'static',
        compiledDagDigest: compilation.compiled.contentDigest, terminalVectorDigest: vector.contentDigest,
        compilationBindingDigest: compilation.binding.contentDigest, membershipDigest: compilation.binding.membershipDigest,
        schedulerRunId: context.schedulerRunId, sourceCommit: context.sourceCommit,
        worktreeFingerprint: context.worktreeFingerprint, status,
        aggregateTerminalReceipt: aggregate, children, qualificationEligible: false });
}

/** Read the exact current-attempt vector ref from the existing immutable scheduler journal; never repair a projection. */
export function readCurrentStaticAtomicSummary({ checkpointFile, expectedCheckpointDigest, evidenceContext,
    expectedVectorDigest, consumerId, authorityId, ...options })
{
    const before = readCanonicalSchedulerCheckpoint(checkpointFile);
    same(before?.checkpointDigest, expectedCheckpointDigest, 'canonical checkpoint digest');
    const checkpoint = before.checkpoint;
    if (checkpoint.authoritative !== true || checkpoint.candidateIdentityValidated !== true)
    {
        throw new Error('static atomic terminal requires a canonical current candidate checkpoint');
    }
    if (!consumerId || !authorityId)
    {
        throw new Error('static atomic terminal requires owner-supplied consumer and authority IDs');
    }
    same(checkpoint.runId, evidenceContext.schedulerRunId, 'checkpoint run');
    same(checkpoint.sourceState?.commit, evidenceContext.sourceCommit, 'checkpoint source');
    same(checkpoint.sourceState?.worktreeFingerprint, evidenceContext.worktreeFingerprint, 'checkpoint worktree');
    same(resumeCurrentRunEvidenceCheckpoint(checkpoint, evidenceContext), checkpoint.currentRunEvidenceReferences,
        'current-attempt evidence block');
    for (const field of ['schedulerRunId', 'sourceCommit', 'worktreeFingerprint'])
    {
        same(evidenceContext[field], options.context[field], `current evidence ${field}`);
    }
    const matches = checkpoint.currentRunEvidenceReferences.references.filter(entry => entry.consumerId === consumerId);
    if (matches.length !== 1 || matches[0].producerId !== `${options.lane}-summary`
        || matches[0].authorityId !== authorityId)
    {
        throw new Error('static atomic terminal lacks the exact current vector publication reference');
    }
    const root = options.compilationOptions.repositoryRoot;
    const evidenceRoot = path.resolve(options.context.evidenceRoot);
    if (!evidenceContext.ownedRoots.some(relative =>
    {
        const allowed = path.resolve(root, relative);
        return evidenceRoot === allowed || evidenceRoot.startsWith(`${allowed}${path.sep}`);
    }))
    {
        throw new Error('static atomic terminal evidence root is not held by the current context');
    }
    const file = ownedFile(options.context.evidenceRoot, path.resolve(root, matches[0].path));
    same(sha256(fs.readFileSync(file)), matches[0].inputDigest, 'publication file digest');
    const reference = readOwned(options.context.evidenceRoot, file);
    same(reference.schema, 'fsusblog.current-run-evidence-reference.v1', 'publication reference schema');
    same(reference.contentDigest, evidenceContentDigest(reference), 'publication content seal');
    same(reference.producerReceiptDigest, evidenceProducerReceiptDigest(reference), 'publication producer seal');
    same(reference.contentDigest, matches[0].contentDigest, 'checkpoint publication content');
    same(reference.producerReceiptDigest, matches[0].producerReceiptDigest, 'checkpoint publication producer');
    for (const field of ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint', 'candidateIdentity', 'buildIdentity'])
    {
        same(reference[field], evidenceContext[field], `publication ${field}`);
    }
    same(reference.authorityId, authorityId, 'publication authority');
    same(reference.producerId, matches[0].producerId, 'publication producer');
    const publication = readCurrentRunEvidencePublication({ outputPath: matches[0].path, repositoryRoot: root }).state;
    same(publication.state, 'finalized', 'committed publication');
    for (const field of ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint', 'candidateIdentity', 'buildIdentity'])
    {
        same(publication[field], evidenceContext[field], `committed publication ${field}`);
    }
    same(publication.authorityId, authorityId, 'committed authority');
    same(publication.producerId, reference.producerId, 'committed producer');
    same(publication.outputPath, matches[0].path, 'committed output');
    same(publication.payloadPath, reference.payload?.path, 'committed payload');
    for (const field of ['path', 'inputDigest', 'contentDigest', 'producerReceiptDigest'])
    {
        same(publication.reference[field], matches[0][field], `committed publication ${field}`);
    }
    const payloadFile = ownedFile(options.context.evidenceRoot, path.resolve(root, reference.payload?.path ?? ''));
    same(sha256(fs.readFileSync(payloadFile)), reference.payload.digest, 'vector payload file digest');
    const vector = readOwned(options.context.evidenceRoot, payloadFile);
    same(vector.schema, reference.payload.schema, 'vector payload schema');
    same(vector.contentDigest, expectedVectorDigest, 'current vector digest');
    const result = projectCompiledStaticAtomicSummary({ ...options, vector, expectedVector: vector });
    const after = readCanonicalSchedulerCheckpoint(checkpointFile);
    same(after?.checkpointDigest, before.checkpointDigest, 'current checkpoint readback');
    const body = { ...result };
    delete body.contentDigest;
    return sealContentDigest({ ...body, checkpointRef: before.checkpointDigest, checkpointRevision: checkpoint.revision,
        publicationRef: matches[0] });
}

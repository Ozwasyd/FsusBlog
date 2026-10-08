import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import { loadCoverageAttemptMaterial } from './atomic-coverage-command.mjs';
import { compileCoverageProducerDag, validateCoverageExecutionRequest } from './atomic-coverage-compiler-bridge.mjs';
import { prepareCoverageProducer, readCoverageMaterial } from './atomic-coverage-inputs.mjs';
import { readCoverageBytes, requireCoverage } from './atomic-coverage-plan.mjs';
import { projectCoverageSettled } from './atomic-coverage-projection.mjs';

const { AtomicProducerExecutionError, executeCompiledAtomicProducerDag, verifyAtomicTerminalVector } = await import(new URL('../test-matrix/atomic-producers/execution.mjs', import.meta.url));
const { digestCanonical, sealContentDigest, sha256 } = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));

/** Execute the canonical compiler bridge; retain its original failed vector and account actual owned child launches. */
export async function executeCoverageProducerDag({ root, plan, requests, matrix, authorities, executionOptions })
{
    const compiled = compileCoverageProducerDag({ root, plan, requests, matrix, authorities });
    const context = executionOptions.context;
    requireCoverage(context.schedulerRunId === plan.identity.runId && context.sourceCommit === plan.identity.sourceCommit
        && context.worktreeFingerprint === plan.identity.sourceFingerprint
        && requests.every((item) => path.resolve(root, item.request.evidenceRoot) === context.evidenceRoot), 'coverage execution crosses context');
    const verifyAuthority = (reference) =>
    {
        const replay = authorities.replayPlans.find((item) => item.artifactPath === reference.artifactPath);
        const producerId = replay?.plan?.producer.id ?? Object.keys(executionOptions.producerContexts).find((id) =>
            executionOptions.producerContexts[id].authorityReferences.some((item) => digestCanonical(item) === digestCanonical(reference)));
        return executionOptions.producerContexts[producerId]?.verifyAuthority(reference);
    };
    const producerContexts = { ...executionOptions.producerContexts };
    for (const producer of plan.producers)
    {
        const supplied = producerContexts[producer.id];
        const step = compiled.steps.find((item) => item.id === producer.id);
        const item = requests.find((candidate) => candidate.request.producerId === producer.id);
        const prior = supplied?.requiredInputAdmission;
        requireCoverage(prior === undefined || (prior && Object.keys(prior).sort().join(',') === 'inputClosureRef,validate'
            && typeof prior.validate === 'function' && digestCanonical(prior.inputClosureRef) === digestCanonical(step.inputClosureRef)),
        'supplied input admission differs from compiled closure');
        producerContexts[producer.id] = { ...supplied, requiredInputAdmission: {
            inputClosureRef: step.inputClosureRef,
            validate: async (ready) =>
            {
                // Preserve the run owner's validation and grant; never replace its
                // commands, resource policy, or original runner authority.
                await prior?.validate(ready);
                validateCoverageExecutionRequest(item.request, root);
                requireCoverage(sha256(readCoverageBytes(root, item.request.requestPath)) === sha256(item.bytes), 'request byte drift at admission');
                const inputs = Object.fromEntries(producer.dependsOn.map((id) => [id, loadCoverageAttemptMaterial(root, item.request, id)]));
                prepareCoverageProducer({ root, plan, producerId: producer.id, inputs, verifyAuthority });
            }
        } };
    }
    let vector;
    try
    {
        vector = await executeCompiledAtomicProducerDag(compiled, { ...executionOptions, producerContexts, matrix, authorities });
    }
    catch (error)
    {
        if (!(error instanceof AtomicProducerExecutionError) || error.publicationError)
        {
            throw error;
        }
        vector = error.terminalVector;
    }
    const vectorPath = path.join(context.evidenceRoot, context.schedulerRunId, 'atomic-dag', compiled.contentDigest.slice(7), 'terminal-vector.json');
    const vectorBytes = fs.readFileSync(vectorPath);
    verifyAtomicTerminalVector(JSON.parse(vectorBytes), vector);
    const outcomes = {};
    const blockedRecords = new Map();
    const admissionRecords = new Map();
    const launches = [];
    for (const producer of plan.producers)
    {
        const terminal = vector.receipts.find((receipt) => receipt.producerId === producer.id);
        requireCoverage(terminal, 'canonical terminal member missing');
        const request = requests.find((item) => item.request.producerId === producer.id).request;
        if (terminal.terminalState === 'blocked')
        {
            requireCoverage(terminal.attemptRef === null && terminal.artifactRefs.length === 0, 'blocked producer has an attempt');
            const relative = `${request.evidenceRoot}/${context.schedulerRunId}/coverage-blocked/${producer.id}.json`;
            const file = path.resolve(root, relative);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const bytes = `${JSON.stringify(terminal, null, 4)}\n`;
            fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o444 });
            const reference = { path: relative, digest: sha256(bytes) };
            blockedRecords.set(relative, terminal);
            outcomes[producer.id] = { blockedRef: reference };
            launches.push({ producerId: producer.id, terminalState: 'blocked', attemptSpawnCount: 0, physicalSpawnCount: 0 });
            continue;
        }
        if (terminal.attemptRef === null)
        {
            if (terminal.terminalState === 'failed' && terminal.reasonCode === 'required-input-admission-failed')
            {
                requireCoverage(terminal.aggregateAttemptRef === null && terminal.artifactRefs.length === 0
                    && terminal.evidenceRefs.length === 1, 'input rejection has an attempt or missing evidence');
                const sourceRef = terminal.evidenceRefs[0];
                const expectedPath = path.join(path.dirname(vectorPath), `${producer.id}.json`);
                requireCoverage(sourceRef.path === expectedPath, 'input rejection evidence path differs from canonical vector');
                const relative = path.relative(root, sourceRef.path);
                const bytes = readCoverageBytes(root, relative);
                const evidence = JSON.parse(bytes);
                const { contentDigest, ...body } = evidence;
                const step = compiled.steps.find((item) => item.id === producer.id);
                requireCoverage(digestCanonical(body) === contentDigest && contentDigest === sourceRef.contentDigest
                    && evidence.producerId === producer.id && evidence.compiledDagDigest === compiled.contentDigest
                    && evidence.receiptKind === 'required-input-admission-refused-before-attempt'
                    && evidence.terminalState === 'failed' && evidence.reasonCode === terminal.reasonCode
                    && evidence.attemptAllocationCount === 0 && evidence.physicalSpawnCount === 0
                    && digestCanonical(evidence.inputClosureRef) === digestCanonical(step.inputClosureRef)
                    && typeof evidence.reason === 'string' && evidence.reason.length > 0
                    && terminal.primaryFailureRefs.length > 0, 'invalid canonical input rejection evidence');
                const reference = { path: relative, digest: sha256(bytes) };
                admissionRecords.set(relative, { evidence, terminal });
                outcomes[producer.id] = { admissionRef: reference };
                launches.push({ producerId: producer.id, terminalState: 'failed', reasonCode: terminal.reasonCode,
                    attemptSpawnCount: 0, physicalSpawnCount: 0, admissionRef: reference });
                continue;
            }
            // A cancelled pending node has zero admissions; an internal error has
            // no verified attempt and therefore no usable launch count.
            launches.push({ producerId: producer.id, terminalState: terminal.terminalState,
                attemptSpawnCount: terminal.terminalState === 'cancelled' ? 0 : null, physicalSpawnCount: terminal.terminalState === 'cancelled' ? 0 : null });
            continue;
        }
        const base = `${request.evidenceRoot}/${context.schedulerRunId}/${producer.id}/attempt-1`;
        const receiptPath = `${base}/receipt.json`;
        const attempt = JSON.parse(readCoverageBytes(root, receiptPath));
        requireCoverage(attempt.contentDigest === terminal.attemptRef.contentDigest
            && path.resolve(root, receiptPath) === terminal.attemptRef.path, 'terminal attempt reference mismatch');
        const material = attempt.status === 'clean-success' ? loadCoverageAttemptMaterial(root, request, producer.id)
            : { attemptRef: { path: receiptPath, digest: sha256(readCoverageBytes(root, receiptPath)) }, artifacts: [] };
        const verified = readCoverageMaterial({ root, plan, producerId: producer.id, material,
            verifyAuthority: executionOptions.producerContexts[producer.id].verifyAuthority });
        outcomes[producer.id] = material;
        let physicalSpawnCount = null;
        if (verified.attempt.artifactDigests['coverage-launch.json'])
        {
            const bytes = readCoverageBytes(root, `${base}/coverage-launch.json`);
            requireCoverage(sha256(bytes) === verified.attempt.artifactDigests['coverage-launch.json'], 'launch observation tamper');
            const launch = JSON.parse(bytes);
            const { contentDigest, ...body } = launch;
            requireCoverage(digestCanonical(body) === contentDigest && launch.producerId === producer.id
                && launch.planDigest === plan.contentDigest && digestCanonical(launch.identity) === digestCanonical(plan.identity)
                && [0, 1].includes(launch.physicalSpawnCount), 'launch observation identity mismatch');
            physicalSpawnCount = launch.physicalSpawnCount;
        }
        launches.push({ producerId: producer.id, terminalState: terminal.terminalState, attemptSpawnCount: 1, physicalSpawnCount });
    }
    const verifyAdmission = ({ reference, bytes, producerId }) =>
    {
        const retained = admissionRecords.get(reference.path);
        requireCoverage(retained?.terminal.producerId === producerId
            && digestCanonical(JSON.parse(bytes)) === digestCanonical(retained.evidence), 'input rejection differs from canonical execution evidence');
        return { ...retained.evidence, identity: plan.identity, planDigest: plan.contentDigest,
            primaryFailureRefs: retained.terminal.primaryFailureRefs };
    };
    const verifyBlocked = ({ reference, bytes, producerId }) =>
    {
        const terminal = blockedRecords.get(reference.path);
        requireCoverage(terminal && digestCanonical(JSON.parse(bytes)) === digestCanonical(terminal), 'blocked outcome differs from canonical execution vector');
        return { producerId, terminalState: 'blocked', identity: plan.identity, planDigest: plan.contentDigest,
            blockedBy: terminal.blockedBy, dependsOn: compiled.steps.find((step) => step.id === producerId).dependsOn, primaryFailureRefs: terminal.primaryFailureRefs };
    };
    const projections = plan.projections.map((projection) => projectCoverageSettled({ root, plan, projectionId: projection.id,
        outcomes: Object.fromEntries(projection.settledDependsOn.filter((id) => outcomes[id]).map((id) => [id, outcomes[id]])), verifyAuthority, verifyBlocked, verifyAdmission }));
    return sealContentDigest({ schema: 'fsusblog.atomic-coverage-execution-data.v1', identity: plan.identity,
        compiledDagDigest: compiled.contentDigest, vectorRef: { path: path.relative(root, vectorPath), digest: sha256(vectorBytes) },
        terminalVector: vector, launches, projections, status: vector.status, qualificationEligible: false });
}

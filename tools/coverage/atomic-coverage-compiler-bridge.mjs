import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import { readCoverageBytes, requireCoverage, validateCoveragePlan } from './atomic-coverage-plan.mjs';

const { compileAtomicProducerDag, verifyCompiledAtomicProducerDag } = await import(new URL('../test-matrix/atomic-producers/compiler.mjs', import.meta.url));
const { resolveAtomicReference, resolveAtomicReplayPlan } = await import(new URL('../test-matrix/atomic-producers/contract.mjs', import.meta.url));
const { digestCanonical, sealContentDigest, sha256 } = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));

const bridgeSources = ['tools/coverage/atomic-coverage-command.mjs', 'tools/coverage/atomic-coverage-compiler-bridge.mjs',
    'tools/coverage/atomic-coverage-inputs.mjs', 'tools/coverage/atomic-coverage-plan.mjs'];

/** Prepare run-owned action request files; this does not construct or admit upstream authorities. */
export function createCoverageExecutionRequests({ root, plan, evidenceRoot, requestRoot, replayPlanPaths, authorityVerifier, collectionExecution = {} })
{
    validateCoveragePlan(plan, root);
    for (const relative of [evidenceRoot, requestRoot])
    {
        requireCoverage(typeof relative === 'string' && relative.startsWith('.tmp/')
            && relative.split('/').every((part) => part && part !== '..' && !part.includes('\\')), 'explicit run-local request/evidence root required');
    }
    requireCoverage(authorityVerifier && Object.keys(authorityVerifier).sort().join(',') === 'contentDigest,exportName,path'
        && /^[a-zA-Z][a-zA-Z0-9]*$/u.test(authorityVerifier.exportName)
        && sha256(readCoverageBytes(root, authorityVerifier.path)) === authorityVerifier.contentDigest, 'exact independent authority verifier source required');
    requireCoverage(Object.keys(replayPlanPaths ?? {}).sort().join(',') === plan.producers.map((item) => item.id).sort().join(','), 'exact replay path roster required');
    requireCoverage(new Set(Object.values(replayPlanPaths)).size === plan.producers.length, 'each producer needs its own replay path');
    requireCoverage(Object.keys(collectionExecution).every((id) => ['coverage-backend', 'coverage-frontend'].includes(id)), 'unknown native collection execution');
    const sourceDigests = Object.fromEntries(bridgeSources.map((file) => [file, sha256(readCoverageBytes(root, file))]));
    return plan.producers.map((producer) =>
    {
        const requestPath = `${requestRoot}/${producer.id}.json`;
        const request = sealContentDigest({
            schema: 'fsusblog.atomic-coverage-action-request.v1', requestPath, producerId: producer.id,
            plan, evidenceRoot, replayPlanPath: replayPlanPaths[producer.id], authorityVerifier,
            collectionExecution: collectionExecution[producer.id] ?? null, sourceDigests
        });
        return { request, bytes: `${JSON.stringify(request, null, 4)}\n`,
            command: ['node', 'tools/coverage/atomic-coverage-command.mjs', requestPath] };
    });
}

export function validateCoverageExecutionRequest(request, root)
{
    const { contentDigest, ...body } = request;
    requireCoverage(request.schema === 'fsusblog.atomic-coverage-action-request.v1' && digestCanonical(body) === contentDigest, 'action request digest/schema mismatch');
    requireCoverage(Object.keys(body).sort().join(',') === 'authorityVerifier,collectionExecution,evidenceRoot,plan,producerId,replayPlanPath,requestPath,schema,sourceDigests', 'unknown action request field');
    validateCoveragePlan(request.plan, root);
    requireCoverage(request.plan.producers.some((producer) => producer.id === request.producerId), 'unknown coverage action');
    requireCoverage(Object.keys(request.sourceDigests).sort().join(',') === [...bridgeSources].sort().join(','), 'missing bridge source binding');
    for (const [file, digest] of Object.entries(request.sourceDigests))
    {
        requireCoverage(sha256(readCoverageBytes(root, file)) === digest, `bridge source drift: ${file}`);
    }
    requireCoverage(sha256(readCoverageBytes(root, request.authorityVerifier.path)) === request.authorityVerifier.contentDigest, 'authority verifier source drift');
    return request;
}

export function writeCoverageExecutionRequests(root, requests)
{
    for (const item of requests)
    {
        validateCoverageExecutionRequest(item.request, root);
        const file = path.resolve(root, item.request.requestPath);
        requireCoverage(file.startsWith(`${path.resolve(root)}${path.sep}`), 'request path escapes root');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, item.bytes, { flag: 'wx', mode: 0o444 });
    }
}

/** Verify the sole matrix attachment and supplied upstream ownership/closure/replay references, then use the canonical compiler. */
export function compileCoverageProducerDag({ root, plan, requests, matrix, authorities })
{
    validateCoveragePlan(plan, root);
    requireCoverage(requests.length === plan.producers.length && new Set(requests.map((item) => item.request.producerId)).size === plan.producers.length, 'exact action request roster required');
    const nodes = matrix?.atomicProducerDeclarations?.nodes ?? [];
    for (const producer of plan.producers)
    {
        const matches = nodes.filter((node) => node.producerId === producer.id);
        requireCoverage(matches.length === 1, `missing/duplicate canonical coverage declaration: ${producer.id}`);
        const node = matches[0];
        const request = requests.find((item) => item.request.producerId === producer.id);
        validateCoverageExecutionRequest(request.request, root);
        requireCoverage(digestCanonical(request.request.plan) === digestCanonical(plan), 'request crosses coverage plan');
        requireCoverage(sha256(readCoverageBytes(root, request.request.requestPath)) === sha256(request.bytes), 'request byte drift');
        const expectedParent = producer.id === 'coverage-merge' || ['coverage-backend', 'coverage-frontend'].includes(producer.id)
            ? 'coverage-gate' : 'coverage-threshold';
        requireCoverage(node.kind === 'atomic-producer' && node.logicalParentId === expectedParent
            && node.attemptPolicyId === 'correctness-first-attempt' && node.settledDependsOn.length === 0, 'wrong coverage physical declaration');
        requireCoverage(digestCanonical(node.dependsOn.filter((id) => plan.producers.some((item) => item.id === id)).sort())
            === digestCanonical([...producer.dependsOn].sort()), 'coverage hard dependency drift');
        const source = resolveAtomicReference(authorities.commandSources, node.commandSourceRef, 'coverage command source');
        requireCoverage(digestCanonical(source.command) === digestCanonical(request.command), 'wrong coverage bridge command');
        const replay = resolveAtomicReplayPlan(authorities.replayPlans, node.replayPlanRef);
        requireCoverage(replay.artifactPath === request.request.replayPlanPath, 'request differs from canonical replay artifact path');
        requireCoverage(digestCanonical(node.artifacts) === digestCanonical(producer.outputs.map((output) => `${producer.id}-${output.role}`).sort())
            && digestCanonical(node.evidence) === digestCanonical([`${producer.id}-attempt-receipt`]), 'canonical coverage artifact/evidence ID drift');
        const closure = resolveAtomicReference(authorities.inputClosures, source.inputClosureRef, 'coverage input closure');
        requireCoverage(digestCanonical(closure.coverageBinding) === digestCanonical({
            planDigest: plan.contentDigest, requestPath: request.request.requestPath,
            requestDigest: sha256(request.bytes), sourceDigests: request.request.sourceDigests,
            authorityVerifier: request.request.authorityVerifier
        }), 'coverage request/source/verifier missing from canonical closure');
    }
    for (const projection of plan.projections)
    {
        const parentId = projection.id === 'coverage-gate-summary' ? 'coverage-gate' : 'coverage-threshold';
        const node = nodes.find((item) => item.producerId === projection.id);
        requireCoverage(node?.kind === 'logical-projection' && node.logicalParentId === parentId
            && digestCanonical(node.settledDependsOn) === digestCanonical([...projection.settledDependsOn].sort()), 'coverage settled projection membership drift');
    }
    const compiled = compileAtomicProducerDag(matrix, authorities);
    verifyCompiledAtomicProducerDag(compiled, matrix, authorities);
    return compiled;
}

/** Domain attachment request for the sole matrix writer; all authority references stay supplied by their owners. */
export function createCoverageAtomicAttachment(plan, producerBindings, projectionOwner)
{
    requireCoverage(Object.keys(producerBindings).sort().join(',') === plan.producers.map((item) => item.id).sort().join(','), 'exact supplied producer binding roster required');
    const nodes = plan.producers.map((producer) =>
    {
        const binding = producerBindings[producer.id];
        requireCoverage(Object.keys(binding).sort().join(',') === 'commandSourceRef,dependsOn,executionClass,fixtureProfile,owner,replayOwner,replayPlanRef,resourceContractRef,serviceDependencies,stateAccessRef', 'unknown/missing canonical producer binding');
        const parent = ['coverage-backend', 'coverage-frontend', 'coverage-merge'].includes(producer.id) ? 'coverage-gate' : 'coverage-threshold';
        return { ...binding, kind: 'atomic-producer', producerId: producer.id, logicalParentId: parent,
            projectionOwner, dependsOn: [...binding.dependsOn].sort(), settledDependsOn: [], evidenceClass: 'correctness',
            attemptPolicyId: 'correctness-first-attempt', artifacts: producer.outputs.map((output) => `${producer.id}-${output.role}`).sort(),
            evidence: [`${producer.id}-attempt-receipt`] };
    });
    const tiers = plan.projections.map((projection) =>
    {
        const parent = projection.id === 'coverage-gate-summary' ? 'coverage-gate' : 'coverage-threshold';
        const members = [...projection.settledDependsOn].sort();
        nodes.push({ kind: 'logical-projection', producerId: projection.id, logicalParentId: parent,
            owner: projectionOwner, projectionOwner, dependsOn: [], settledDependsOn: members });
        return { id: parent, executionMode: 'projection', commandKind: 'projection', executionOwner: projectionOwner, projectFrom: members };
    });
    return { tiers, atomicProducerDeclarations: { schema: 'fsusblog.atomic-producer-declarations.v1', nodes } };
}

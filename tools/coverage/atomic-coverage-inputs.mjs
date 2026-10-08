import path from 'node:path';

const {digestCanonical, sha256, validateAttemptReceipt} = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));
const {validateReplayPlan} = await import(new URL('../test/execution-replay-contract.mjs', import.meta.url));
import { readCoverageBytes, requireCoverage, validateCoveragePlan } from './atomic-coverage-plan.mjs';

function readReference(root, reference)
{
    requireCoverage(reference && Object.keys(reference).sort().join(',') === 'digest,path', 'explicit path/digest reference required');
    const bytes = readCoverageBytes(root, reference.path);
    requireCoverage(sha256(bytes) === reference.digest, `artifact tamper: ${reference.path}`);
    return bytes;
}

function requireIdentity(actual, expected)
{
    for (const key of ['runId', 'sourceCommit', 'sourceFingerprint'])
    {
        requireCoverage(actual?.[key] === expected[key], `cross-run/source ${key}`);
    }
}

function validateSummary(document, domain, identity)
{
    requireIdentity(document.producer, identity);
    requireCoverage(document.summary && document.totals, 'missing coverage summary/totals');
    for (const metric of ['linecoverage', 'branchcoverage', 'methodcoverage'])
    {
        requireCoverage(typeof document.summary[metric] === 'number' && Number.isFinite(document.summary[metric])
            && document.summary[metric] >= 0 && document.summary[metric] <= 100, `missing/invalid ${metric}`);
    }
    for (const metric of ['lines', 'branches', 'methods'])
    {
        const value = document.totals[metric];
        requireCoverage(Number.isInteger(value?.covered) && Number.isInteger(value?.total)
            && value.covered >= 0 && value.total >= value.covered, `invalid totals.${metric}`);
    }
    if (domain === 'backend')
    {
        requireCoverage(document.source === 'backend-coverlet-json-authoritative-merge', 'backend authoritative source required');
    }
    else if (domain === 'frontend')
    {
        requireCoverage(document.source === 'frontend-vitest', 'frontend source required');
    }
    else
    {
        requireCoverage(document.sources?.backend === true && document.sources?.frontend === true
            && document.sources?.mergeMethod === 'covered-over-total-weighted', 'partial/foreign merge refused');
    }
}

/**
 * Read canonical attempt/replay evidence and independently rehash every captured output.
 * verifyAuthority is the existing attempt owner's verifier, never a coverage verified flag.
 * Output snapshots belong to the attempt; paths exposed to commands retain existing layout.
 */
export function readCoverageMaterial({ root, plan, producerId, material, verifyAuthority })
{
    validateCoveragePlan(plan, root);
    const producer = plan.producers.find((item) => item.id === producerId);
    requireCoverage(producer && material && Object.keys(material).sort().join(',') === 'artifacts,attemptRef', 'invalid producer material');
    const attemptDirectory = path.posix.dirname(material.attemptRef.path);
    const receipt = JSON.parse(readReference(root, material.attemptRef));
    const attempt = validateAttemptReceipt(receipt, {
        verifyAuthority,
        verifyArtifact: (file, digest) => sha256(readCoverageBytes(root, `${attemptDirectory}/${file}`)) === digest
    });
    requireCoverage(attempt.producerId === producerId && attempt.attemptNumber === 1 && attempt.maxAttempts === 1
        && attempt.retryPolicyId === producer.retryPolicyId, 'wrong producer or repeated/retried attempt');
    requireIdentity({ runId: attempt.schedulerRunId, sourceCommit: attempt.sourceCommit, sourceFingerprint: attempt.worktreeFingerprint }, plan.identity);
    requireCoverage(digestCanonical(attempt.command) === digestCanonical(producer.command), 'attempt command differs from bound producer');
    const replayReference = attempt.authorityReferences.find((reference) => reference.kind === 'replay-plan');
    const replay = validateReplayPlan(JSON.parse(readReference(root, {
        path: replayReference.artifactPath, digest: replayReference.artifactDigest
    })));
    requireIdentity({ runId: replay.run.id, sourceCommit: replay.source.commit, sourceFingerprint: replay.source.worktreeFingerprint }, plan.identity);
    requireCoverage(replay.producer.id === producerId
        && digestCanonical([replay.command.executable, ...replay.command.args]) === digestCanonical(attempt.command), 'wrong replay/command identity');
    requireCoverage(Array.isArray(material.artifacts), 'artifact roster required');
    const roles = new Set();
    const paths = new Set();
    const capturedPaths = new Set();
    const artifacts = {};
    for (const artifact of material.artifacts)
    {
        requireCoverage(Object.keys(artifact).sort().join(',') === 'attemptPath,digest,path,role', 'unknown artifact field');
        const declared = producer.outputs.find((item) => item.role === artifact.role);
        requireCoverage(declared && artifact.path === declared.path && !roles.has(artifact.role)
            && !paths.has(artifact.path) && !capturedPaths.has(artifact.attemptPath), 'duplicate/wrong-domain artifact');
        roles.add(artifact.role);
        paths.add(artifact.path);
        capturedPaths.add(artifact.attemptPath);
        requireCoverage(attempt.artifactDigests[artifact.attemptPath] === artifact.digest, 'output absent from canonical attempt');
        const bytes = readReference(root, { path: artifact.path, digest: artifact.digest });
        requireCoverage(sha256(readCoverageBytes(root, `${attemptDirectory}/${artifact.attemptPath}`)) === artifact.digest, 'captured output tamper');
        artifacts[artifact.role] = { path: artifact.path, digest: artifact.digest, bytes };
    }
    if (attempt.status === 'clean-success')
    {
        requireCoverage(producer.outputs.every((item) => roles.has(item.role)), 'missing required current-run output');
        if (artifacts.summary)
        {
            const domain = producerId.slice('coverage-'.length);
            const summary = JSON.parse(artifacts.summary.bytes);
            validateSummary(summary, domain, plan.identity);
            if (domain === 'backend')
            {
                requireCoverage(summary.authoritativeRaw === artifacts.raw.path
                    && digestCanonical(summary.exchangeFormats) === digestCanonical([artifacts.exchange.path]), 'backend raw/exchange identity mismatch');
            }
        }
        if (artifacts.scope)
        {
            const scope = JSON.parse(artifacts.scope.bytes);
            requireCoverage(scope.status === 'ok' && scope.summaryFile === `${plan.coverageRoot}/merged/Summary.json`, 'wrong scope summary identity');
            requireCoverage(['linecoverage', 'branchcoverage', 'methodcoverage'].every((metric) =>
                typeof scope.summary?.[metric] === 'number' && Number.isFinite(scope.summary[metric])
                && scope.summary[metric] >= 0 && scope.summary[metric] <= 100), 'missing/invalid scope summary');
        }
    }
    return { status: attempt.status, attempt, attemptRef: { ...material.attemptRef }, artifacts };
}

/**
 * Prepare exactly one unchanged leaf command after all its explicit hard inputs verify.
 * The canonical compiler owns spawn, resource grants, attempt invocation and sealing.
 * A thrown missing/failed/tampered input must become blocked with spawn=0 upstream.
 */
export function prepareCoverageProducer({ root, plan, producerId, inputs, verifyAuthority })
{
    validateCoveragePlan(plan, root);
    const producer = plan.producers.find((item) => item.id === producerId);
    requireCoverage(producer && inputs && Object.keys(inputs).sort().join(',') === [...producer.dependsOn].sort().join(','), 'exact hard input roster required');
    const verified = producer.dependsOn.map((id) => readCoverageMaterial({ root, plan, producerId: id, material: inputs[id], verifyAuthority }));
    requireCoverage(verified.every((item) => item.status === 'clean-success'), 'hard input failed; producer blocked');
    return {
        producerId, command: [...producer.command], planDigest: plan.contentDigest,
        inputRefs: verified.map((item) => ({ attemptRef: item.attemptRef, summaryRef: {
            path: item.artifacts.summary.path, digest: item.artifacts.summary.digest
        } })), retryPolicyId: producer.retryPolicyId, attemptNumber: 1, allowedRetries: 0
    };
}

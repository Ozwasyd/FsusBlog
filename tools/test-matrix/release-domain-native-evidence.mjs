import path from 'node:path';

import { loadCommandGroup } from './command-groups.mjs';
import { projectionContentDigest } from './evidence-projection.mjs';
import {
    browserDiagnosticsReleaseAssertionsSchema,
    browserDiagnosticsReleaseProbeIds,
    browserDiagnosticsReleaseRuntimeReceiptSchema,
    identitySlug,
    normalizeSourceArtifact,
    normalizeTestResultPath,
    readJsonArtifact,
    safeRelativePath,
    sortedUnique,
    validateProducerEvidence
} from './release-domain-ledger.mjs';

export function validateNativeAssertionEvidence({
    repositoryRoot,
    entry,
    sourceArtifactPaths,
    sourceState,
    runId,
    namespace,
    policyIdentity
})
{
    const root = path.resolve(repositoryRoot);
    let paths = sortedUnique(
        sourceArtifactPaths,
        `${entry.id}.sourceArtifactPaths`
    );
    let documents = paths.map((relative) => ({
        path: safeRelativePath(relative, `${entry.id}.sourceArtifactPaths`),
        value: readJsonArtifact(root, relative)
    }));
    const selector = validateProducerEvidence(entry);

    if (selector.kind === 'vitest-file' || selector.kind === 'vitest-file-set')
    {
        const runSlug = identitySlug(runId);
        const boundPaths = paths.filter((relative) => relative.split('/').some((segment) =>
            segment === runSlug || segment.endsWith(`-${runSlug}`)));
        if (boundPaths.length === 0)
        {
            throw new Error(`${entry.id} Vitest source artifact is not bound to the current run`);
        }
        paths = boundPaths;
        documents = documents.filter((document) => boundPaths.includes(document.path));
        const targets =
            selector.kind === 'vitest-file' ? [selector.file] : selector.files;
        const usedPaths = new Set();
        for (const target of targets)
        {
            const matches = documents.flatMap((document) =>
                (document.value?.testResults ?? [])
                    .filter((result) =>
                        normalizeTestResultPath(root, result?.name) === target)
                    .map((result) => ({ document: document.path, result })));
            if (matches.length !== 1)
            {
                throw new Error(
                    `${entry.id} expected exactly one Vitest result for ${target}, found ${matches.length}`
                );
            }
            const { document, result } = matches[0];
            const assertions = result.assertionResults;
            if (result.status !== 'passed'
                || !Array.isArray(assertions)
                || assertions.length === 0
                || assertions.some((assertion) => assertion?.status !== 'passed'))
            {
                throw new Error(`${entry.id} Vitest result did not pass: ${target}`);
            }
            usedPaths.add(document);
        }
        if (JSON.stringify([...usedPaths].sort()) !== JSON.stringify(paths))
        {
            throw new Error(
                `${entry.id} contains unrelated or missing Vitest source artifacts`
            );
        }
    }
    else if (selector.kind === 'live-grant-child')
    {
        if (documents.length !== 1)
        {
            throw new Error(`${entry.id} requires exactly one live-grant artifact`);
        }
        const evidence = documents[0].value;
        const child = evidence?.children
            ?.filter((candidate) => candidate?.id === selector.childId) ?? [];
        const sameSchedulerRun = evidence?.schedulerRunId === runId;
        const sameWorkflowRun = Boolean(process.env.GITHUB_RUN_ID)
            && evidence?.workflowRunId === process.env.GITHUB_RUN_ID
            && evidence?.workflowRunAttempt
                === String(process.env.GITHUB_RUN_ATTEMPT ?? '1');
        if (evidence?.schema !== 'fsusblog.live-grant-execution.v1'
            || evidence.lane !== selector.lane
            || (!sameSchedulerRun && !sameWorkflowRun)
            || evidence.status !== 'success'
            || child.length !== 1
            || child[0].status !== 'success')
        {
            throw new Error(
                `${entry.id} live-grant producer assertion is missing or unsuccessful`
            );
        }
        if (selector.nestedId !== undefined)
        {
            const group = loadCommandGroup(root, selector.lane);
            const command = group.commands
                .find((candidate) => candidate.id === selector.childId);
            const expectedNestedIds = (command?.localCommands ?? [])
                .map((candidate) => candidate.id)
                .sort();
            const nestedAssertions = child[0].nestedAssertions;
            const actualNestedIds =
                nestedAssertions?.map((candidate) => candidate?.id) ?? [];
            if (expectedNestedIds.length === 0
                || JSON.stringify(actualNestedIds) !== JSON.stringify(expectedNestedIds)
                || new Set(actualNestedIds).size !== actualNestedIds.length)
            {
                throw new Error(
                    `${entry.id} live-grant nested assertion IDs do not exactly match the command manifest`
                );
            }
            const selected = nestedAssertions
                .filter((candidate) => candidate.id === selector.nestedId);
            if (selected.length !== 1 || selected[0].status !== 'success')
            {
                throw new Error(
                    `${entry.id} live-grant nested assertion is missing or unsuccessful: ${selector.nestedId}`
                );
            }
        }
    }
    else if (selector.kind === 'browser-diagnostics-release-assertion')
    {
        const expectedPaths =
            [selector.assertionArtifactPath, selector.receiptPath].sort();
        if (JSON.stringify(paths) !== JSON.stringify(expectedPaths))
        {
            throw new Error(
                `${entry.id} requires the exact browser diagnostics receipt and assertion artifact`
            );
        }
        const receipt = documents
            .find((document) => document.path === selector.receiptPath)?.value;
        const assertionArtifact = documents.find(
            (document) => document.path === selector.assertionArtifactPath
        )?.value;
        const expectedSource = {
            commit: sourceState.commit,
            worktreeFingerprint: String(sourceState.worktreeFingerprint)
                .replace(/^sha256:/u, '')
        };
        const receiptSource = {
            commit: receipt?.sourceState?.commit,
            worktreeFingerprint: String(
                receipt?.sourceState?.worktreeFingerprint ?? ''
            ).replace(/^sha256:/u, '')
        };
        const artifactSource = {
            commit: assertionArtifact?.sourceState?.commit,
            worktreeFingerprint: String(
                assertionArtifact?.sourceState?.worktreeFingerprint ?? ''
            ).replace(/^sha256:/u, '')
        };
        if (receipt?.schema !== browserDiagnosticsReleaseRuntimeReceiptSchema
            || receipt.status !== 'success'
            || receipt.contentDigest !== projectionContentDigest(receipt)
            || receipt.runId !== runId
            || JSON.stringify(receiptSource) !== JSON.stringify(expectedSource)
            || JSON.stringify(receipt?.buildBinding?.sourceState)
                !== JSON.stringify(receipt?.sourceState)
            || !/^sha256:[a-f0-9]{64}$/u.test(
                String(receipt?.buildBinding?.receiptContentDigest ?? '')
            ))
        {
            throw new Error(
                `${entry.id} browser diagnostics receipt source, run, build, or digest is invalid`
            );
        }
        const category = receipt.category;
        if (category?.id !== selector.categoryId)
        {
            throw new Error(
                `${entry.id} requires the exact browser diagnostics ${selector.categoryId} category`
            );
        }
        const actualProbeIds =
            category.probes?.map((probe) => probe?.id).sort() ?? [];
        if (category.status !== 'success'
            || JSON.stringify(category.plannedProbeIds)
                !== JSON.stringify(browserDiagnosticsReleaseProbeIds)
            || JSON.stringify(actualProbeIds)
                !== JSON.stringify(browserDiagnosticsReleaseProbeIds)
            || new Set(actualProbeIds).size !== actualProbeIds.length)
        {
            throw new Error(
                `${entry.id} release-runtime probe IDs or outcomes are incomplete`
            );
        }
        const probes =
            category.probes.filter((probe) => probe?.id === selector.probeId);
        if (probes.length !== 1)
        {
            throw new Error(
                `${entry.id} expected exactly one diagnostics probe ${selector.probeId}`
            );
        }
        const probe = probes[0];
        const expectedTestIds = [
            `${selector.categoryId}/${selector.probeId}`,
            ...selector.assertionIds
        ].sort();
        const attempt = Array.isArray(probe.attempts) && probe.attempts.length === 1
            ? probe.attempts[0]
            : null;
        if (probe.status !== 'success'
            || probe.finalStatus !== 'success'
            || JSON.stringify(probe.testIds) !== JSON.stringify(expectedTestIds)
            || attempt?.status !== 'success'
            || JSON.stringify(attempt?.testIds) !== JSON.stringify(expectedTestIds))
        {
            throw new Error(
                `${entry.id} diagnostics probe/assertion IDs did not pass exactly once`
            );
        }
        const expectedArtifactPaths = [selector.assertionArtifactPath];
        if (probe.artifactContract?.status !== 'success'
            || JSON.stringify(probe.artifactContract?.declaredPaths)
                !== JSON.stringify(expectedArtifactPaths)
            || JSON.stringify(probe.artifactContract?.materializedPaths)
                !== JSON.stringify(expectedArtifactPaths)
            || JSON.stringify(probe.artifactContract?.missingPaths)
                !== JSON.stringify([])
            || JSON.stringify(probe.copiedArtifacts)
                !== JSON.stringify(expectedArtifactPaths))
        {
            throw new Error(
                `${entry.id} diagnostics probe artifact contract is incomplete`
            );
        }
        const artifactAssertionIds =
            assertionArtifact?.assertions?.map((assertion) => assertion?.id) ?? [];
        if (assertionArtifact?.schema !== browserDiagnosticsReleaseAssertionsSchema
            || assertionArtifact.status !== 'success'
            || assertionArtifact.contentDigest
                !== projectionContentDigest(assertionArtifact)
            || assertionArtifact.categoryId !== selector.categoryId
            || assertionArtifact.probeId !== selector.probeId
            || assertionArtifact.diagnosticsRunId !== runId
            || assertionArtifact.schedulerRunId !== runId
            || assertionArtifact.projectionNamespace !== namespace
            || JSON.stringify(artifactSource) !== JSON.stringify(expectedSource)
            || assertionArtifact.buildReceiptDigest
                !== receipt.buildBinding.receiptContentDigest
            || assertionArtifact.policyIdentity !== policyIdentity
            || !Array.isArray(assertionArtifact.assertions)
            || JSON.stringify(artifactAssertionIds)
                !== JSON.stringify(selector.assertionIds)
            || new Set(artifactAssertionIds).size !== artifactAssertionIds.length
            || assertionArtifact.assertions.some(
                (assertion) => assertion?.outcome !== 'success'
            ))
        {
            throw new Error(
                `${entry.id} browser diagnostics assertion artifact identity or all-of set is invalid`
            );
        }
        const selectedAssertions = assertionArtifact.assertions
            .filter((assertion) => assertion.id === selector.assertionId);
        if (selectedAssertions.length !== 1
            || selectedAssertions[0].outcome !== 'success')
        {
            throw new Error(
                `${entry.id} selected browser diagnostics assertion is missing or unsuccessful`
            );
        }
    }
    return paths;
}

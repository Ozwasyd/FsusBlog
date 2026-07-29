import fs from 'node:fs';
import path from 'node:path';

const { hostDeclarations } = await import(new URL("../../../tools/docs/behavior-doc-minimal-contract-build.mjs", import.meta.url));
const { behaviorDocAdmissionReceiptSchema, validateBehaviorDocStaticAdmissionReceipt } = await import(new URL("../../../tools/docs/behavior-doc-static-admission.mjs", import.meta.url));
const { digestValue, sealSourceIdentity } = await import(new URL("../../../tools/fact-extractors/identity.mjs", import.meta.url));
const { loadRegistry } = await import(new URL("../../../tools/fact-extractors/registry.mjs", import.meta.url));

function seal(value)
{
    const receipt = { ...structuredClone(value), contentDigest: null };
    receipt.contentDigest = digestValue(receipt);
    return receipt;
}

function minimalContractBuildReceipt(runId, source)
{
    return seal({
        schema: 'fsusblog.behavior-doc-minimal-contract-build-receipt.v1',
        runId,
        sourceCommit: source.sourceCommit,
        worktreeFingerprint: source.worktreeFingerprint,
        toolchain: {
            dotnet: '10.0.100',
            configuration: 'Release',
            targetFramework: 'net10.0'
        },
        buildKey: 'b'.repeat(64),
        buildRoot: `.tmp/behavior-doc-contract-builds/${'b'.repeat(64)}`,
        sourceClosureDigests: [{
            path: 'Directory.Build.props',
            digest: 'e'.repeat(64)
        }],
        artifacts: Object.fromEntries(
            Object.entries(hostDeclarations).map(([artifactId, declaration]) => [
                artifactId,
                {
                    project: declaration.project,
                    projectDigest: 'c'.repeat(64),
                    path: path.posix.join(
                        `.tmp/behavior-doc-contract-builds/${'b'.repeat(64)}`,
                        declaration.cacheFile
                    ),
                    artifactDigest: 'd'.repeat(64)
                }
            ])
        ),
        status: 'ok',
        failureReasons: []
    });
}

export function prepareBehaviorDocAdmissionFixtureAuthority({
    sourceRepositoryRoot,
    repositoryRoot
})
{
    const registryRelative = 'config/contracts/behavior-fact-extractors.json';
    const registryFile = path.join(repositoryRoot, registryRelative);
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.copyFileSync(path.join(sourceRepositoryRoot, registryRelative), registryFile);
    return registryFile;
}

export function createBehaviorDocAdmissionFixture({
    sourceRepositoryRoot,
    repositoryRoot,
    runId = 'materialized-runner-admission'
})
{
    const registryFile = prepareBehaviorDocAdmissionFixtureAuthority({
        sourceRepositoryRoot,
        repositoryRoot
    });
    const source = sealSourceIdentity(repositoryRoot);
    const registry = loadRegistry(registryFile);
    const factObservations = Object.fromEntries(registry.extractors.map((extractor) => [
        extractor.id,
        {
            status: 'ok',
            extractorDigest: 'd'.repeat(64),
            semanticDigest: 'e'.repeat(64),
            contentDigest: 'f'.repeat(64)
        }
    ]));
    const receipt = seal({
        schema: behaviorDocAdmissionReceiptSchema,
        run: { id: runId },
        source: {
            commit: source.sourceCommit,
            worktreeFingerprint: source.worktreeFingerprint
        },
        worktree: { root: path.resolve(repositoryRoot) },
        toolchain: {
            node: process.version,
            dotnet: '10.0.100',
            platform: process.platform,
            architecture: process.arch,
            directoryBuildPropsDigest: '1'.repeat(64)
        },
        authorityDigests: {
            catalog: '2'.repeat(64),
            claim: '3'.repeat(64),
            extractorRegistry: '4'.repeat(64),
            generatedSectionCatalog: '5'.repeat(64),
            generatedRenderer: '6'.repeat(64),
            proseRenderer: '7'.repeat(64),
            mutationCatalog: '8'.repeat(64)
        },
        implementationOwner: {
            status: 'ok',
            bindingCount: 1,
            contentDigest: '9'.repeat(64)
        },
        factObservations,
        minimalContractBuild: minimalContractBuildReceipt(runId, source),
        generated: {
            status: 'ok',
            documentCount: 0,
            contentDigest: 'a'.repeat(64)
        },
        prose: {
            status: 'ok',
            verifiedClaimCount: 0,
            contentDigest: 'b'.repeat(64)
        },
        mutationFixtures: {
            status: 'ok',
            caseCount: 1,
            contentDigest: 'c'.repeat(64)
        },
        candidateSpawnCountBeforeReceipt: 0,
        status: 'ok',
        failureReasons: [],
        durationMs: 1
    });
    validateBehaviorDocStaticAdmissionReceipt(receipt, {
        expectedRunId: runId,
        expectedSourceIdentity: source,
        expectedWorktree: repositoryRoot
    });
    const receiptFile = path.join(
        repositoryRoot,
        '.tmp/behavior-doc-static-admission/fixture-receipt.json'
    );
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    return {
        receiptFile,
        runId,
        contentDigest: receipt.contentDigest
    };
}

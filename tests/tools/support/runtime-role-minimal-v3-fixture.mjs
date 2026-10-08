import path from 'node:path';

const { hostDeclarations, runtimeReproduciblePathMapArgument } = await import(new URL('../../../tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs', import.meta.url));
const { digestValue } = await import(new URL('../../../tools/fact-extractors/lib/canonicalize.mjs', import.meta.url));

// Exact canonical test fixture body from c1cf3c7abc; synthetic, never runtime evidence.
function seal(value)
{
    const receipt = { ...structuredClone(value), contentDigest: null };
    receipt.contentDigest = digestValue(receipt);
    return receipt;
}

/** Synthetic static admission envelope shared by value-contract tests only. */
export function createRuntimeRoleStaticV3Fixture(runId, source, {
    repositoryRoot,
    extractorIds = ['runtime-role'],
    minimalContractBuild = createRuntimeRoleMinimalV3Fixture(runId, source)
} = {})
{
    return seal({
        schema: 'fsusblog.behavior-doc-static-admission-receipt.v1',
        run: { id: runId },
        source: { commit: source.sourceCommit, worktreeFingerprint: source.worktreeFingerprint },
        worktree: { root: repositoryRoot },
        toolchain: { node: 'v24.0.0', dotnet: '10.0.100', platform: 'linux', architecture: 'x64', directoryBuildPropsDigest: '1'.repeat(64) },
        authorityDigests: Object.fromEntries(['catalog', 'claim', 'extractorRegistry', 'generatedSectionCatalog',
            'generatedRenderer', 'proseRenderer', 'mutationCatalog'].map((key) => [key, '2'.repeat(64)])),
        implementationOwner: { status: 'ok', bindingCount: 1, contentDigest: '3'.repeat(64) },
        factObservations: Object.fromEntries(extractorIds.map((id) => [id,
            { status: 'ok', extractorDigest: '4'.repeat(64), semanticDigest: '5'.repeat(64), contentDigest: '6'.repeat(64) }])),
        minimalContractBuild,
        generated: { status: 'ok', documentCount: 0, contentDigest: '7'.repeat(64) },
        prose: { status: 'ok', verifiedClaimCount: 0, contentDigest: '8'.repeat(64) },
        mutationFixtures: { status: 'ok', caseCount: 9, contentDigest: '9'.repeat(64) },
        candidateSpawnCountBeforeReceipt: 0, status: 'ok', failureReasons: [], durationMs: 1
    });
}

export function createRuntimeRoleMinimalV3Fixture(runId, source)
{
    const buildRoot = `.tmp/behavior-doc-contract-builds/${'b'.repeat(64)}`;
    const runtimeBuildRoot = `.tmp/runtime-role-reproducible-builds/${'b'.repeat(64)}`;
    const runtimeAssemblyPath = `${runtimeBuildRoot}/bin/FsusBlog.RuntimeRoleObservation/release/FsusBlog.RuntimeRoleObservation.dll`;
    const runtimeDeploymentPath = `${buildRoot}/observations/runtime-role-deployment-observation.json`;
    const sourceClosureDigests = [
        {
            path: 'Directory.Build.props',
            digest: 'e'.repeat(64)
        },
        {
            path: 'Directory.Packages.props',
            digest: 'f'.repeat(64)
        }
    ];
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
        buildRoot,
        sourceClosureDigests,
        artifacts: Object.fromEntries(Object.entries(hostDeclarations).map(([artifactId, declaration]) => [
            artifactId,
            {
                project: declaration.project,
                projectDigest: 'c'.repeat(64),
                path: path.posix.join(
                    buildRoot,
                    declaration.cacheFile
                ),
                artifactPath: declaration.output,
                artifactDigest: 'd'.repeat(64),
                ...(artifactId === 'runtime-role-observation'
                    ? {
                        assemblyPath: runtimeAssemblyPath,
                        assemblyDigest: '3'.repeat(64),
                        deploymentArtifactPath: runtimeDeploymentPath,
                        deploymentArtifactDigest: '4'.repeat(64)
                    }
                    : {}),
                buildReceipt: {
                    schema: declaration.buildReceiptSchema,
                    artifactId,
                    artifactPath: declaration.output,
                    artifactDigest: 'd'.repeat(64),
                    configuration: 'Release',
                    ...(artifactId === 'openapi-aeds-observation'
                        ? {
                            openapiPath: `${buildRoot}/observations/fsusblog.openapi.observed.json`,
                            openapiArtifactPath: '.tmp/contracts/openapi/fsusblog.openapi.observed.json',
                            openapiDigest: '8'.repeat(64)
                        }
                        : {}),
                    ...(artifactId === 'runtime-role-observation'
                        ? {
                            sourceCommit: source.sourceCommit,
                            worktreeFingerprint: source.worktreeFingerprint,
                            projectDigest: 'c'.repeat(64),
                            assemblyPath: runtimeAssemblyPath,
                            assemblyDigest: '3'.repeat(64),
                            reproducibleBuild: {
                                schema: 'fsusblog.runtime-role-reproducible-build-attestation.v1',
                                project: declaration.project,
                                command: [
                                    'dotnet', 'build', declaration.project, '--configuration', 'Release',
                                    '--no-incremental', '--disable-build-servers', '--artifacts-path',
                                    runtimeBuildRoot,
                                    '/p:Deterministic=true', '/p:ContinuousIntegrationBuild=true',
                                    runtimeReproduciblePathMapArgument,
                                    `/p:FsusBlogCommitSha=${source.sourceCommit}`,
                                    '/p:NuGetAudit=false', '/m:1'
                                ],
                                outputRoot: runtimeBuildRoot,
                                assemblyPath: runtimeAssemblyPath,
                                assemblyDigest: '3'.repeat(64),
                                sourceClosureDigest: digestValue(sourceClosureDigests)
                            },
                            deploymentArtifactPath: runtimeDeploymentPath,
                            deploymentArtifactDigest: '4'.repeat(64),
                            producer: 'dotnet-run-content-addressed-minimal-contract-host',
                            externalOracle: 'docker-compose-config-json-no-interpolate',
                            externalOracleVersion: '5.3.1',
                            dockerExecutable: {
                                canonicalPath: '/usr/bin/docker',
                                digest: '6'.repeat(64),
                                version: '29.6.2'
                            },
                            composeImplementation: {
                                canonicalPath: '/usr/lib/docker/cli-plugins/docker-compose',
                                digest: '7'.repeat(64),
                                version: '5.3.1'
                            },
                            effectiveComposeModelDigest: `sha256:${'5'.repeat(64)}`,
                            deploymentAuthoritySchema: 'fsusblog.monolithic-distributed-architecture.v2',
                            deploymentAuthorityContentDigest: `sha256:${'1'.repeat(64)}`,
                            deploymentObservationDigest: `sha256:${'2'.repeat(64)}`
                        }
                        : {})
                }
            }
        ])),
        status: 'ok',
        failureReasons: []
    });
}

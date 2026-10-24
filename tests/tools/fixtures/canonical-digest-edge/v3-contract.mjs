import path from 'node:path';

import { digestValue } from '../fact-extractors/lib/canonicalize.mjs';

// Pure value validator for the canonical BehaviorDoc minimal-contract producer.
// The caller owns pinned artifact reads; this value contract never builds or discovers evidence.
export const minimalContractBuildSchema =
    'fsusblog.behavior-doc-minimal-contract-build-receipt.v1';

export const hostDeclarations = Object.freeze({
    'runtime-role-observation': {
        project: 'tools/contracts/FsusBlog.RuntimeRoleObservation/FsusBlog.RuntimeRoleObservation.csproj',
        output: '.tmp/contracts/runtime-role/runtime-role-observation.json',
        cacheFile: 'observations/runtime-role-observation.json',
        repositoryRootArgument: false,
        assemblyFile: 'artifacts/bin/FsusBlog.RuntimeRoleObservation/release/FsusBlog.RuntimeRoleObservation.dll',
        buildReceiptSchema: 'fsusblog.runtime-role-observation-build-receipt.v3'
    },
    'openapi-aeds-observation': {
        project: 'tools/contracts/FsusBlog.OpenApiObservation/FsusBlog.OpenApiObservation.csproj',
        output: '.tmp/contracts/openapi/api-aeds-observation.json',
        cacheFile: 'observations/openapi-aeds-observation.json',
        projectionOutput: '.tmp/contracts/openapi/fsusblog.openapi.observed.json',
        projectionCacheFile: 'observations/fsusblog.openapi.observed.json',
        repositoryRootArgument: true,
        buildReceiptSchema: 'fsusblog.openapi-aeds-observation-build-receipt.v2'
    },
    'auth-session-permission-observation': {
        project: 'tools/contracts/FsusBlog.AuthSessionObservation/FsusBlog.AuthSessionObservation.csproj',
        output: '.tmp/contracts/auth-session/auth-session-permission-observation.json',
        cacheFile: 'observations/auth-session-permission-observation.json',
        repositoryRootArgument: false,
        buildReceiptSchema: 'fsusblog.auth-session-permission-observation-build-receipt.v1'
    },
    'config-error-security-policy-observation': {
        project: 'tools/contracts/FsusBlog.ConfigErrorSecurityObservation/FsusBlog.ConfigErrorSecurityObservation.csproj',
        output: '.tmp/contracts/config-error-security/config-error-security-policy-observation.json',
        cacheFile: 'observations/config-error-security-policy-observation.json',
        repositoryRootArgument: true,
        buildReceiptSchema: 'fsusblog.config-error-security-policy-observation-build-receipt.v1'
    },
    'content-lifecycle-observation': {
        project: 'tools/contracts/FsusBlog.ContentLifecycleObservation/FsusBlog.ContentLifecycleObservation.csproj',
        output: '.tmp/contracts/content-lifecycle/content-lifecycle-observation.json',
        cacheFile: 'observations/content-lifecycle-observation.json',
        repositoryRootArgument: false,
        buildReceiptSchema: 'fsusblog.content-lifecycle-observation-build-receipt.v1'
    }
});
const runtimeReproducibleBuildRelative = '.tmp/runtime-role-reproducible-builds';
export const runtimeReproduciblePathMapArgument =
    '/p:PathMap={OUTPUT_ROOT}=/_/artifacts%2C{REPOSITORY_ROOT}=/_/src';

function hasExactKeys(value, keys)
{
    return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}


function cachedArtifactPath(buildRoot, declaration)
{
    return path.posix.join(buildRoot, declaration.cacheFile);
}


export function validateMinimalContractBuildReceipt(receipt, {
    expectedRunId = null,
    expectedSourceIdentity = null,
    repositoryRoot = null,
    readArtifactDigest = null
} = {})
{
    if (receipt == null || typeof receipt !== 'object' || Array.isArray(receipt))
    {
        throw new Error('minimal contract build receipt must be an object');
    }
    const sealedKeys = [
        'schema',
        'runId',
        'sourceCommit',
        'worktreeFingerprint',
        'toolchain',
        'buildKey',
        'buildRoot',
        'sourceClosureDigests',
        'artifacts',
        'status',
        'failureReasons',
        'contentDigest'
    ];
    const sealedKeysWithSourceDigest = [
        ...sealedKeys.slice(0, -3),
        'sourceDigest',
        ...sealedKeys.slice(-3)
    ];
    if (!hasExactKeys(receipt, sealedKeys)
    && !hasExactKeys(receipt, sealedKeysWithSourceDigest))
    {
        throw new Error('minimal contract build receipt fields are not sealed');
    }
    const copy = structuredClone(receipt);
    const digest = copy?.contentDigest;
    copy.contentDigest = null;
    if (receipt?.schema !== minimalContractBuildSchema)
    {
        throw new Error(`minimal contract build schema must be ${minimalContractBuildSchema}`);
    }
    if (digest !== digestValue(copy))
    {
        throw new Error('minimal contract build content digest mismatch');
    }
    if (receipt.status !== 'ok' || !Array.isArray(receipt.failureReasons)
    || receipt.failureReasons.length !== 0)
    {
        throw new Error(
            `minimal contract build is not successful: ${(receipt.failureReasons ?? []).join('; ')}`
        );
    }
    if (expectedRunId !== null && receipt.runId !== expectedRunId)
    {
        throw new Error('minimal contract build run id mismatch');
    }
    if (expectedSourceIdentity
    && (receipt.sourceCommit !== expectedSourceIdentity.sourceCommit
      || receipt.worktreeFingerprint !== expectedSourceIdentity.worktreeFingerprint))
    {
        throw new Error('minimal contract build source/worktree identity mismatch');
    }
    if (!/^[a-f0-9]{64}$/u.test(receipt.buildKey ?? '')
    || receipt.buildRoot !== `.tmp/behavior-doc-contract-builds/${receipt.buildKey}`)
    {
        throw new Error('minimal contract build root is not content-addressed');
    }
    if (receipt.toolchain?.configuration !== 'Release'
    || receipt.toolchain?.targetFramework !== 'net10.0'
    || typeof receipt.toolchain?.dotnet !== 'string'
    || receipt.toolchain.dotnet.length === 0)
    {
        throw new Error('minimal contract build toolchain identity is incomplete');
    }
    if (!hasExactKeys(receipt.toolchain, ['dotnet', 'configuration', 'targetFramework']))
    {
        throw new Error('minimal contract build toolchain fields are not sealed');
    }
    if (!Array.isArray(receipt.sourceClosureDigests)
    || receipt.sourceClosureDigests.length === 0
    || new Set(receipt.sourceClosureDigests.map((entry) => entry?.path)).size
      !== receipt.sourceClosureDigests.length
    || receipt.sourceClosureDigests.some((entry) =>
        !hasExactKeys(entry, ['path', 'digest'])
      || typeof entry.path !== 'string'
      || entry.path.length === 0
      || !/^[a-f0-9]{64}$/u.test(entry.digest ?? '')))
    {
        throw new Error('minimal contract build source closure is incomplete');
    }
    if (repositoryRoot !== null && typeof readArtifactDigest !== 'function')
    {
        throw new Error('minimal contract build requires an independent artifact reader');
    }
    const artifactIds = Object.keys(receipt.artifacts ?? {}).sort();
    if (JSON.stringify(artifactIds) !== JSON.stringify(Object.keys(hostDeclarations).sort()))
    {
        throw new Error('minimal contract build artifact roster is incomplete');
    }
    for (const [artifactId, declaration] of Object.entries(hostDeclarations))
    {
        const artifact = receipt.artifacts[artifactId];
        const expectedArtifactPath = cachedArtifactPath(receipt.buildRoot, declaration);
        const expectedArtifactKeys = artifactId === 'runtime-role-observation'
            ? [
          'project', 'projectDigest', 'path', 'artifactPath', 'artifactDigest', 'assemblyPath',
          'assemblyDigest', 'deploymentArtifactPath', 'deploymentArtifactDigest',
          'buildReceipt'
        ]
            : artifactId === 'openapi-aeds-observation'
        ? ['project', 'projectDigest', 'path', 'artifactPath', 'artifactDigest',
            'projectionPath', 'projectionDigest', 'buildReceipt']
        : ['project', 'projectDigest', 'path', 'artifactPath', 'artifactDigest', 'buildReceipt'];
        if (artifact?.project !== declaration.project
      || artifact?.path !== expectedArtifactPath
      || artifact?.artifactPath !== declaration.output
      || !hasExactKeys(artifact, expectedArtifactKeys)
      || !/^[a-f0-9]{64}$/u.test(artifact?.projectDigest ?? '')
      || !/^[a-f0-9]{64}$/u.test(artifact?.artifactDigest ?? ''))
        {
            throw new Error(`minimal contract build artifact ${artifactId} is invalid`);
        }
        const expectedReceiptKeys = artifactId === 'runtime-role-observation'
            ? [
          'schema', 'artifactId', 'artifactPath', 'artifactDigest', 'configuration',
          'sourceCommit', 'worktreeFingerprint', 'projectDigest', 'assemblyPath',
          'assemblyDigest', 'reproducibleBuild', 'deploymentArtifactPath', 'deploymentArtifactDigest',
          'producer', 'externalOracle', 'externalOracleVersion',
          'dockerExecutable', 'composeImplementation',
          'effectiveComposeModelDigest',
          'deploymentAuthoritySchema', 'deploymentAuthorityContentDigest',
          'deploymentObservationDigest'
        ]
            : artifactId === 'openapi-aeds-observation'
        ? ['schema', 'artifactId', 'artifactPath', 'artifactDigest', 'configuration',
            'projectionPath', 'projectionDigest']
        : ['schema', 'artifactId', 'artifactPath', 'artifactDigest', 'configuration'];
        if (!hasExactKeys(artifact.buildReceipt, expectedReceiptKeys)
      || artifact.buildReceipt.schema !== declaration.buildReceiptSchema
      || artifact.buildReceipt.artifactId !== artifactId
      || artifact.buildReceipt.artifactPath !== declaration.output
      || artifact.buildReceipt.artifactDigest !== artifact.artifactDigest
      || artifact.buildReceipt.configuration !== 'Release')
        {
            throw new Error(`minimal contract build artifact ${artifactId} receipt is invalid`);
        }
        if (artifactId === 'openapi-aeds-observation'
      && (artifact.projectionPath !== path.posix.join(receipt.buildRoot, declaration.projectionCacheFile)
        || !/^[a-f0-9]{64}$/u.test(artifact.projectionDigest ?? '')
        || artifact.buildReceipt.projectionPath !== artifact.projectionPath
        || artifact.buildReceipt.projectionDigest !== artifact.projectionDigest))
        {
            throw new Error('minimal contract build OpenAPI projection receipt is incomplete');
        }
        if (artifactId === 'runtime-role-observation'
      && (artifact.buildReceipt.deploymentAuthoritySchema !== 'fsusblog.monolithic-distributed-architecture.v2'
        || artifact.buildReceipt.sourceCommit !== receipt.sourceCommit
        || artifact.buildReceipt.worktreeFingerprint !== receipt.worktreeFingerprint
        || artifact.buildReceipt.projectDigest !== artifact.projectDigest
        || artifact.buildReceipt.assemblyPath !== artifact.assemblyPath
        || artifact.buildReceipt.assemblyDigest !== artifact.assemblyDigest
        || !hasExactKeys(artifact.buildReceipt.reproducibleBuild, [
            'schema', 'project', 'command', 'outputRoot', 'assemblyPath', 'assemblyDigest',
            'sourceClosureDigest'
        ])
        || artifact.buildReceipt.reproducibleBuild.schema
          !== 'fsusblog.runtime-role-reproducible-build-attestation.v1'
        || artifact.buildReceipt.reproducibleBuild.project !== artifact.project
        || artifact.buildReceipt.reproducibleBuild.outputRoot
          !== path.posix.join(runtimeReproducibleBuildRelative, receipt.buildKey)
        || artifact.buildReceipt.reproducibleBuild.assemblyPath !== artifact.assemblyPath
        || artifact.buildReceipt.reproducibleBuild.assemblyDigest !== artifact.assemblyDigest
        || artifact.buildReceipt.reproducibleBuild.sourceClosureDigest
          !== digestValue(receipt.sourceClosureDigests)
        || JSON.stringify(artifact.buildReceipt.reproducibleBuild.command)
          !== JSON.stringify([
              'dotnet', 'build', artifact.project, '--configuration', 'Release',
              '--no-incremental', '--disable-build-servers', '--artifacts-path',
              artifact.buildReceipt.reproducibleBuild.outputRoot,
              '/p:Deterministic=true', '/p:ContinuousIntegrationBuild=true',
              runtimeReproduciblePathMapArgument,
              '/p:NuGetAudit=false', '/m:1'
          ])
        || artifact.buildReceipt.deploymentArtifactPath !== artifact.deploymentArtifactPath
        || artifact.buildReceipt.deploymentArtifactDigest !== artifact.deploymentArtifactDigest
        || artifact.buildReceipt.producer !== 'dotnet-run-content-addressed-minimal-contract-host'
        || artifact.buildReceipt.externalOracle !== 'docker-compose-config-json-no-interpolate'
        || typeof artifact.buildReceipt.externalOracleVersion !== 'string'
        || artifact.buildReceipt.externalOracleVersion.length === 0
        || !hasExactKeys(artifact.buildReceipt.dockerExecutable, ['canonicalPath', 'digest', 'version'])
        || !hasExactKeys(artifact.buildReceipt.composeImplementation, ['canonicalPath', 'digest', 'version'])
        || !/^[a-f0-9]{64}$/u.test(artifact.buildReceipt.dockerExecutable.digest ?? '')
        || !/^[a-f0-9]{64}$/u.test(artifact.buildReceipt.composeImplementation.digest ?? '')
        || !path.isAbsolute(artifact.buildReceipt.dockerExecutable.canonicalPath ?? '')
        || !path.isAbsolute(artifact.buildReceipt.composeImplementation.canonicalPath ?? '')
        || typeof artifact.buildReceipt.dockerExecutable.version !== 'string'
        || artifact.buildReceipt.dockerExecutable.version.length === 0
        || typeof artifact.buildReceipt.composeImplementation.version !== 'string'
        || artifact.buildReceipt.composeImplementation.version.length === 0
        || !/^sha256:[a-f0-9]{64}$/u.test(artifact.buildReceipt.effectiveComposeModelDigest ?? '')
        || !/^sha256:[a-f0-9]{64}$/u.test(artifact.buildReceipt.deploymentAuthorityContentDigest ?? '')
        || !/^sha256:[a-f0-9]{64}$/u.test(artifact.buildReceipt.deploymentObservationDigest ?? '')))
        {
            throw new Error('minimal contract build runtime-role deployment receipt is incomplete');
        }
        if (repositoryRoot !== null
      && (readArtifactDigest(repositoryRoot, artifact.project) !== artifact.projectDigest
        || readArtifactDigest(repositoryRoot, artifact.path) !== artifact.artifactDigest
        || (artifactId === 'openapi-aeds-observation'
          && readArtifactDigest(repositoryRoot, artifact.projectionPath) !== artifact.projectionDigest)
        || (artifactId === 'runtime-role-observation'
          && (readArtifactDigest(repositoryRoot, artifact.assemblyPath) !== artifact.assemblyDigest
            || readArtifactDigest(repositoryRoot, artifact.deploymentArtifactPath)
              !== artifact.deploymentArtifactDigest))))
        {
            throw new Error(`minimal contract build artifact ${artifactId} digest mismatch`);
        }
    }
    return receipt;
}

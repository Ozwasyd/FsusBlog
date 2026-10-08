import { createHash } from 'node:crypto';
import path from 'node:path';

import { digestValue } from '../fact-extractors/lib/canonicalize.mjs';

// Pure value validator for the canonical BehaviorDoc minimal-contract producer.
// The caller owns pinned artifact reads; this value contract never builds or discovers evidence.
export const minimalContractBuildSchema =
    'fsusblog.behavior-doc-minimal-contract-build-receipt.v1';

export const openApiProjectionPaths = Object.freeze({
    cacheFile: 'observations/fsusblog.openapi.observed.json',
    output: '.tmp/contracts/openapi/fsusblog.openapi.observed.json'
});

export const hostDeclarations = Object.freeze({
    'runtime-role-observation': {
        project: 'tools/contracts/FsusBlog.RuntimeRoleObservation/FsusBlog.RuntimeRoleObservation.csproj',
        output: '.tmp/contracts/runtime-role/runtime-role-observation.json',
        cacheFile: 'observations/runtime-role-observation.json',
        repositoryRootArgument: false,
        assemblyFile: 'artifacts/bin/FsusBlog.RuntimeRoleObservation/release/FsusBlog.RuntimeRoleObservation.dll',
        buildReceiptSchema: 'fsusblog.runtime-role-observation-build-receipt.v4'
    },
    'openapi-aeds-observation': {
        project: 'tools/contracts/FsusBlog.OpenApiObservation/FsusBlog.OpenApiObservation.csproj',
        output: '.tmp/contracts/openapi/api-aeds-observation.json',
        cacheFile: 'observations/openapi-aeds-observation.json',
        repositoryRootArgument: true,
        buildReceiptSchema: 'fsusblog.openapi-aeds-observation-build-receipt.v1'
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


/** Validates compiled production-model evidence only; never native qualification. */
export function validateCurrentSchemaCodeContractObservation(value) {
    const expected = {
        "schema": "fsusblog.current-schema-code-contract-observation.v1",
        "evidenceStage": "pre-runtime",
        "evidenceClass": "compiled-production-code-model",
        "receiptFormat": "fsusblog.current-schema-receipt.v1",
        "maximumEncodedBytes": 1048576,
        "fixtureOnly": true,
        "nativeQualification": false,
        "codecType": "FsusBlog.Contracts.SchemaMigration.CurrentSchemaReceiptCodec",
        "admissionType": "FsusBlog.Server.Infrastructure.SchemaMigration.CurrentSchemaReceiptAdmission",
        "contractValidated": true
    };
    const keys = [...Object.keys(expected), 'fixtureArtifactSha256', 'fixtureContentDigest',
        'positiveControls', 'refusalControls', 'observationDigest'];
    if (!hasExactKeys(value, keys)
        || Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)
        || !/^[a-f0-9]{64}$/u.test(value.fixtureArtifactSha256 ?? '')
        || !/^[a-f0-9]{64}$/u.test(value.fixtureContentDigest ?? '')
        || value.fixtureArtifactSha256 === value.fixtureContentDigest
        || JSON.stringify(value.positiveControls) !== JSON.stringify([
            'canonical-codec-roundtrip', 'whole-artifact-admission-contract',
            'artifact-sha-distinct-from-content-seal'
        ])) {
        throw new Error('current-schema compiled contract is incomplete or claims native qualification');
    }
    const expectedRefusals = {
        "old-format": "current_receipt_shape_invalid",
        "empty-bytes": "current_receipt_size_invalid",
        "oversized-bytes": "current_receipt_size_invalid",
        "missing-status": "current_receipt_json_invalid",
        "unknown-member": "current_receipt_json_invalid",
        "duplicate-member": "current_receipt_json_invalid",
        "unknown-status": "current_receipt_json_invalid",
        "unknown-provider": "current_receipt_provider_unknown",
        "missing-plan": "current_receipt_reference_missing",
        "latest-reference": "current_receipt_latest_reference_forbidden",
        "duplicate-checkpoint": "current_receipt_reference_duplicate",
        "semantic-mismatch": "current_receipt_postcondition_failed",
        "content-seal-drift": "current_receipt_digest_mismatch",
        "whole-file-drift": "current_receipt_artifact_digest_mismatch",
        "content-seal-as-file-sha": "current_receipt_artifact_digest_mismatch",
        "target-swap": "current_receipt_live_admission_mismatch",
        "database-swap": "current_receipt_live_admission_mismatch",
        "provider-swap": "current_receipt_live_admission_mismatch",
        "physical-schema-swap": "current_receipt_live_admission_mismatch",
        "rejected-status": "current_receipt_live_admission_mismatch"
    };
    if (!hasExactKeys(value.refusalControls, Object.keys(expectedRefusals))
        || Object.entries(expectedRefusals).some(([key, code]) => value.refusalControls[key] !== code)) {
        throw new Error('current-schema compiled contract refusal vector is incomplete');
    }
    const unsigned = Object.fromEntries(keys.map((key) =>
        [key, key === 'observationDigest' ? '' : value[key]]));
    if (value.observationDigest !== createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')) {
        throw new Error('current-schema compiled contract digest mismatch');
    }
    return value;
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
    if (typeof receipt.runId !== 'string' || receipt.runId.length === 0
    || !/^[a-f0-9]{40}$/u.test(receipt.sourceCommit ?? '')
    || !/^[a-f0-9]{64}$/u.test(receipt.worktreeFingerprint ?? ''))
    {
        throw new Error('minimal contract build run/source identity is incomplete');
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
          'deploymentObservationDigest', 'observationSchema', 'evidenceStage', 'evidenceClass'
        ]
            : artifactId === 'openapi-aeds-observation'
        ? ['schema', 'artifactId', 'artifactPath', 'artifactDigest', 'configuration',
            'openapiPath', 'openapiArtifactPath', 'openapiDigest']
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
        if (artifactId === 'openapi-aeds-observation')
        {
            const projection = artifact.buildReceipt;
            if (projection.openapiPath !== path.posix.join(receipt.buildRoot, openApiProjectionPaths.cacheFile)
        || projection.openapiArtifactPath !== openApiProjectionPaths.output
        || !/^[a-f0-9]{64}$/u.test(projection.openapiDigest ?? ''))
            {
                throw new Error('minimal contract build OpenAPI projection receipt is invalid');
            }
            if (repositoryRoot !== null
        && (readArtifactDigest(repositoryRoot, projection.openapiPath) !== projection.openapiDigest
          || readArtifactDigest(repositoryRoot, projection.openapiArtifactPath) !== projection.openapiDigest))
            {
                throw new Error('minimal contract build OpenAPI projection digest mismatch');
            }
        }
        if (artifactId === 'runtime-role-observation'
      && (artifact.buildReceipt.observationSchema !== 'fsusblog.runtime-role-observation.v3'
        || artifact.buildReceipt.evidenceStage !== 'pre-runtime'
        || artifact.buildReceipt.evidenceClass !== 'compiled-production-code-model'
        || artifact.buildReceipt.deploymentAuthoritySchema !== 'fsusblog.monolithic-distributed-architecture.v2'
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

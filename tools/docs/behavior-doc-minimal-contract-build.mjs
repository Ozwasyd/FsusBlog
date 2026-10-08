import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const {
    buildIdentitySchema,
    computeConsumedInputDigests,
    digestPath,
    digestValue,
    resolveContainedPath,
    resolveDotnetProjectSourceClosure,
    sealSourceIdentity
} = await import(new URL('../fact-extractors/identity.mjs', import.meta.url));
const { loadRegistry } = await import(new URL('../fact-extractors/registry.mjs', import.meta.url));
const { observeRuntimeRoleDeploymentAuthority } = await import(new URL('../governance/check-monolithic-distributed-architecture.mjs', import.meta.url));

import {
    hostDeclarations,
    minimalContractBuildSchema,
    openApiProjectionPaths,
    runtimeReproduciblePathMapArgument,
    validateMinimalContractBuildReceipt as validateMinimalContractBuildReceiptValue
} from './behavior-doc-minimal-contract-build-v3-contract.mjs';
export {
    hostDeclarations,
    minimalContractBuildSchema,
    runtimeReproduciblePathMapArgument
} from './behavior-doc-minimal-contract-build-v3-contract.mjs';

const cacheRelative = '.tmp/behavior-doc-contract-builds';
const runtimeReproducibleBuildRelative = '.tmp/runtime-role-reproducible-builds';

function seal(value)
{
    const receipt = { ...value, contentDigest: null };
    receipt.contentDigest = digestValue(receipt);
    return receipt;
}

function safeSegment(value)
{
    const raw = String(value ?? '');
    const normalized = raw.replace(/[^A-Za-z0-9_.-]+/gu, '-')
        .replace(/^-+|-+$/gu, '');
    if (!normalized || normalized === '.' || normalized === '..' || normalized !== raw)
    {
        throw new Error('minimal contract build requires a safe non-empty run id');
    }
    return normalized;
}

function toolVersion(command, args, repositoryRoot, spawn = spawnSync)
{
    const result = spawn(command, args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000
    });
    if (result.status !== 0)
    {
        throw new Error(`${command} toolchain probe failed: ${String(result.stderr ?? '').trim()}`);
    }
    return String(result.stdout ?? '').trim();
}

function artifactDigest(repositoryRoot, relativePath)
{
    return digestPath(repositoryRoot, relativePath);
}

export function minimalContractSourceClosureDigests(repositoryRoot, compiledExtractors)
{
    const consumedInputs = compiledExtractors.flatMap((extractor) => extractor.consumedInputs);
    const dotnetProjectInputs = resolveDotnetProjectSourceClosure(repositoryRoot, [
        ...Object.values(hostDeclarations).map((entry) => entry.project)
    ]);
    return computeConsumedInputDigests(repositoryRoot, [
        ...consumedInputs,
        ...dotnetProjectInputs,
        'config/contracts/behavior-fact-extractors.json',
        'tools/docs/behavior-doc-minimal-contract-build.mjs',
        'tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs',
        'tools/fact-extractors/identity.mjs',
        'Directory.Build.props',
        'Directory.Packages.props',
        'FsusBlog.slnx',
        'src/backend/FsusBlog.Server.csproj',
        'src/core/FsusBlog.Core.csproj',
        'src/shared/FsusBlog.Shared.csproj'
    ]);
}

function removeCanonicalBuildDirectory(repositoryRoot, relative)
{
    const absolute = path.join(repositoryRoot, relative);
    if (fs.existsSync(absolute))
    {
        resolveContainedPath(repositoryRoot, relative, 'directory');
        fs.rmSync(absolute, { recursive: true, force: true });
    }
}

/** Explicit audit-on project builds retain the canonical admission command by default. */
export function reproduceRuntimeRoleAssembly({
    repositoryRoot,
    buildKey,
    verification = false,
    nuGetAudit = false,
    spawn = spawnSync,
    timeoutMs = 15 * 60_000
})
{
    if (typeof nuGetAudit !== 'boolean')
    {
        throw new Error('runtime-role reproducible build requires a boolean nuGetAudit option');
    }
    if (!/^[a-f0-9]{64}$/u.test(buildKey))
    {
        throw new Error('runtime-role reproducible build requires an exact build key');
    }
    const outputRoot = verification
        ? path.posix.join('.tmp/runtime-role-verifier-builds', `${buildKey}-${process.pid}`)
        : path.posix.join(runtimeReproducibleBuildRelative, buildKey);
    removeCanonicalBuildDirectory(repositoryRoot, outputRoot);
    const outputAbsolute = path.join(repositoryRoot, outputRoot);
    const repositoryAbsolute = path.resolve(repositoryRoot);
    const project = hostDeclarations['runtime-role-observation'].project;
    const physicalPathMapArgument =
        `/p:PathMap=${outputAbsolute}=/_/artifacts%2C${repositoryAbsolute}=/_/src`;
    const commandArguments = [
        'build',
        project,
        '--configuration', 'Release',
        '--no-incremental',
        '--disable-build-servers',
        '--artifacts-path', outputAbsolute,
        '/p:Deterministic=true',
        '/p:ContinuousIntegrationBuild=true',
        physicalPathMapArgument,
        `/p:NuGetAudit=${nuGetAudit}`,
        '/m:1'
    ];
    const result = spawn('dotnet', commandArguments, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            DOTNET_NOLOGO: 'true',
            DOTNET_SKIP_FIRST_TIME_EXPERIENCE: 'true',
            MSBUILDDISABLENODEREUSE: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs
    });
    if (result.status !== 0)
    {
        const diagnostic = [result.stderr, result.stdout]
            .map((value) => String(value ?? '').trim())
            .filter(Boolean)
            .join('\n');
        if (verification && fs.existsSync(outputAbsolute))
        {
            removeCanonicalBuildDirectory(repositoryRoot, outputRoot);
        }
        throw new Error(
            `runtime-role reproducible build failed: ${diagnostic || `exit ${result.status}`}`
        );
    }
    const assemblyPath = path.posix.join(
        outputRoot,
        'bin/FsusBlog.RuntimeRoleObservation/release/FsusBlog.RuntimeRoleObservation.dll'
    );
    const assemblyDigest = digestPath(repositoryRoot, assemblyPath);
    return {
        schema: 'fsusblog.runtime-role-reproducible-build-attestation.v1',
        project,
        command: ['dotnet', ...commandArguments.map((argument) =>
      argument === outputAbsolute
          ? outputRoot
          : argument === physicalPathMapArgument
          ? runtimeReproduciblePathMapArgument
          : argument)],
        outputRoot,
        assemblyPath,
        assemblyDigest
    };
}

export function removeRuntimeRoleVerificationBuild(repositoryRoot, outputRoot)
{
    const expectedPrefix = `.tmp/runtime-role-verifier-builds/`;
    if (!String(outputRoot).startsWith(expectedPrefix)
    || !/^[a-f0-9]{64}-[0-9]+$/u.test(String(outputRoot).slice(expectedPrefix.length)))
    {
        throw new Error('runtime-role verifier cleanup requires an exact verifier output root');
    }
    removeCanonicalBuildDirectory(repositoryRoot, outputRoot);
}

function cachedArtifactPath(buildRoot, declaration)
{
    return path.posix.join(buildRoot, declaration.cacheFile);
}

function processStartToken(pid)
{
    try
    {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
        return fields[19] ?? null;
    }
    catch
    {
        return null;
    }
}

function lockOwnerIsAlive(owner)
{
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0
    || typeof owner?.token !== 'string' || owner.token.length === 0)
    {
        return false;
    }
    try
    {
        process.kill(owner.pid, 0);
    }
    catch (error)
    {
        return error?.code !== 'ESRCH';
    }
    const currentStartToken = processStartToken(owner.pid);
    return owner.processStartToken == null
    || currentStartToken == null
    || owner.processStartToken === currentStartToken;
}

function waitForLock()
{
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}

function acquireBuildLock(cacheRoot, buildKey)
{
    const locksRoot = path.join(cacheRoot, '.locks');
    const lockPath = path.join(locksRoot, `${buildKey}.lock`);
    fs.mkdirSync(locksRoot, { recursive: true });
    const owner = {
        pid: process.pid,
        processStartToken: processStartToken(process.pid),
        token: randomUUID()
    };

    while (true)
    {
        const candidate = path.join(locksRoot, `.candidate-${process.pid}-${randomUUID()}`);
        fs.mkdirSync(candidate);
        fs.writeFileSync(path.join(candidate, 'owner.json'), `${JSON.stringify(owner)}\n`);
        try
        {
            fs.renameSync(candidate, lockPath);
            break;
        }
        catch (error)
        {
            fs.rmSync(candidate, { recursive: true, force: true });
            if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY')
            {
                throw error;
            }
        }

        let currentOwner = null;
        try
        {
            currentOwner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        }
        catch
        {
            // A valid owner directory is prepared completely before its atomic rename.
        }
        if (!lockOwnerIsAlive(currentOwner))
        {
            const stalePath = path.join(locksRoot, `.stale-${buildKey}-${randomUUID()}`);
            try
            {
                fs.renameSync(lockPath, stalePath);
                fs.rmSync(stalePath, { recursive: true, force: true });
            }
            catch (error)
            {
                if (error?.code !== 'ENOENT' && error?.code !== 'EEXIST'
          && error?.code !== 'ENOTEMPTY')
                {
                    throw error;
                }
            }
            continue;
        }
        waitForLock();
    }

    return () =>
    {
        try
        {
            const currentOwner = JSON.parse(
                fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')
            );
            if (currentOwner.token === owner.token)
            {
                fs.rmSync(lockPath, { recursive: true, force: true });
            }
        }
        catch (error)
        {
            if (error?.code !== 'ENOENT')
            {
                throw error;
            }
        }
    };
}

export function validateMinimalContractBuildReceipt(receipt, options = {})
{
    return validateMinimalContractBuildReceiptValue(receipt, {
        ...options,
        readArtifactDigest: options.repositoryRoot == null
            ? null
            : (repositoryRoot, file) => digestPath(repositoryRoot, file)
    });
}

export function buildIdentitiesFromMinimalReceipt(receipt)
{
    validateMinimalContractBuildReceipt(receipt);
    return Object.fromEntries(Object.entries(receipt.artifacts).map(([artifactId, artifact]) =>
    {
        if (hostDeclarations[artifactId] == null)
        {
            throw new Error(`minimal contract build has unknown artifact ${artifactId}`);
        }
        const sourceDigests = structuredClone(receipt.sourceClosureDigests);
        return [
            artifactId,
            {
                schema: buildIdentitySchema,
                artifactId,
                receiptDigest: receipt.contentDigest,
                artifactDigest: artifact.artifactDigest,
                sourceDigests,
                sourceDigest: receipt.sourceDigest ?? digestValue(sourceDigests)
            }
        ];
    }));
}

function reusableReceipt({
    buildRoot,
    buildKey,
    repositoryRoot,
    sourceIdentity,
    sourceClosureDigests,
    toolchain
})
{
    const receiptFile = path.join(buildRoot, 'receipt.json');
    if (!fs.existsSync(receiptFile))
    {
        return null;
    }
    try
    {
        const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        validateMinimalContractBuildReceipt(receipt, {
            expectedSourceIdentity: sourceIdentity,
            repositoryRoot
        });
        if (receipt.buildKey !== buildKey
      || digestValue(receipt.toolchain) !== digestValue(toolchain)
      || digestValue(receipt.sourceClosureDigests) !== digestValue(sourceClosureDigests)
      || receipt.sourceDigest !== digestValue(sourceClosureDigests))
        {
            return null;
        }
        return receipt;
    }
    catch
    {
        return null;
    }
}

function bindReceiptToRun(receipt, runId)
{
    if (receipt.runId === runId)
    {
        return receipt;
    }
    return seal({
        ...receipt,
        runId
    });
}

function publishCanonicalObservations(repositoryRoot, receipt)
{
    for (const [artifactId, declaration] of Object.entries(hostDeclarations))
    {
        const artifact = receipt.artifacts[artifactId];
        const publications = [[artifact.path, declaration.output, artifact.artifactDigest]];
        if (artifactId === 'openapi-aeds-observation')
        {
            publications.push([
                artifact.buildReceipt.openapiPath,
                artifact.buildReceipt.openapiArtifactPath,
                artifact.buildReceipt.openapiDigest
            ]);
        }
        for (const [sourcePath, outputPath, expectedDigest] of publications)
        {
            const source = resolveContainedPath(repositoryRoot, sourcePath, 'file');
            if (artifactDigest(repositoryRoot, sourcePath) !== expectedDigest)
            {
                throw new Error(`minimal contract build artifact ${artifactId} changed before consumption`);
            }
            const destination = path.join(repositoryRoot, outputPath);
            const temporary = `${destination}.next-${process.pid}-${randomUUID()}`;
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            resolveContainedPath(repositoryRoot, path.posix.dirname(outputPath), 'directory');
            fs.copyFileSync(source, temporary);
            fs.renameSync(temporary, destination);
            if (artifactDigest(repositoryRoot, outputPath) !== expectedDigest)
            {
                throw new Error(`minimal contract build artifact ${artifactId} publish digest mismatch`);
            }
        }
    }
}

export function runMinimalContractBuild({
    repositoryRoot,
    runId,
    sourceIdentity = sealSourceIdentity(repositoryRoot),
    spawn = spawnSync,
    hostTimeoutMs = 15 * 60_000
})
{
    const registry = loadRegistry(path.join(repositoryRoot, 'config/contracts/behavior-fact-extractors.json'));
    const compiled = registry.extractors.filter((extractor) => extractor.kind === 'compiled-assembly');
    const expectedArtifactIds = compiled.map((extractor) => extractor.requiredBuildArtifact).sort();
    const declaredArtifactIds = Object.keys(hostDeclarations).sort();
    if (JSON.stringify(expectedArtifactIds) !== JSON.stringify(declaredArtifactIds))
    {
        throw new Error('minimal contract build host roster drifted from the extractor registry');
    }

    const dotnetVersion = toolVersion('dotnet', ['--version'], repositoryRoot, spawn);
    const toolchain = {
        dotnet: dotnetVersion,
        configuration: 'Release',
        targetFramework: 'net10.0'
    };
    const sourceClosureDigests = minimalContractSourceClosureDigests(repositoryRoot, compiled);
    const buildKey = digestValue({
        sourceIdentity,
        toolchain,
        sourceClosureDigests
    });
    const buildRoot = path.join(
        repositoryRoot,
        cacheRelative,
        buildKey
    );
    const cacheRoot = path.join(repositoryRoot, cacheRelative);
    const normalizedRunId = safeSegment(runId);
    const releaseLock = acquireBuildLock(cacheRoot, buildKey);
    let publishedReceipt;
    let cacheHit = false;
    let stagingRoot = null;
    try
    {
        publishedReceipt = reusableReceipt({
            buildRoot,
            buildKey,
            repositoryRoot,
            sourceIdentity,
            sourceClosureDigests,
            toolchain
        });
        if (publishedReceipt)
        {
            cacheHit = true;
        }
        else
        {
            fs.rmSync(buildRoot, { recursive: true, force: true });
            const stagingParent = path.join(cacheRoot, '.staging');
            fs.mkdirSync(stagingParent, { recursive: true });
            stagingRoot = path.join(
                stagingParent,
                `${buildKey}-${normalizedRunId}-${process.pid}-${randomUUID()}`
            );
            fs.mkdirSync(stagingRoot);

            const artifacts = {};
            const deploymentObservation = observeRuntimeRoleDeploymentAuthority({ root: repositoryRoot });
            if (!deploymentObservation.ownership?.claimEligible)
            {
                throw new Error(
                    `minimal contract runtime-role deployment authority is not claim eligible: ${(deploymentObservation.ownership?.failureReasons ?? []).join('; ')}`
                );
            }
            const runtimeReproducibleBuild = reproduceRuntimeRoleAssembly({
                repositoryRoot,
                buildKey,
                spawn,
                timeoutMs: hostTimeoutMs
            });
            for (const artifactId of declaredArtifactIds)
            {
                const declaration = hostDeclarations[artifactId];
                const stagedOutput = path.join(stagingRoot, declaration.cacheFile);
                fs.mkdirSync(path.dirname(stagedOutput), { recursive: true });
                const applicationArgs = ['--output', stagedOutput];
                if (artifactId === 'runtime-role-observation')
                {
                    const deploymentOutput = path.join(
                        stagingRoot,
                        'observations/runtime-role-deployment-observation.json'
                    );
                    fs.mkdirSync(path.dirname(deploymentOutput), { recursive: true });
                    fs.writeFileSync(deploymentOutput, `${JSON.stringify(deploymentObservation, null, 2)}\n`);
                    applicationArgs.push('--deployment-observation', deploymentOutput);
                }
                if (declaration.repositoryRootArgument)
                {
                    applicationArgs.push('--repository-root', repositoryRoot);
                }
                const args = artifactId === 'runtime-role-observation'
                    ? [path.join(repositoryRoot, runtimeReproducibleBuild.assemblyPath), ...applicationArgs]
                    : [
              'run',
              '--project', declaration.project,
              '--configuration', 'Release',
              '--no-launch-profile',
              '--no-cache',
              '--disable-build-servers',
              '--artifacts-path', path.join(stagingRoot, 'artifacts'),
              '--',
              ...applicationArgs
            ];
                const result = spawn('dotnet', args, {
                    cwd: repositoryRoot,
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        DOTNET_NOLOGO: 'true',
                        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: 'true',
                        MSBUILDDISABLENODEREUSE: '1'
                    },
                    stdio: ['ignore', 'pipe', 'pipe'],
                    maxBuffer: 64 * 1024 * 1024,
                    timeout: hostTimeoutMs
                });
                if (result.status !== 0)
                {
                    const stderr = String(result.stderr ?? '').trim();
                    const stdout = String(result.stdout ?? '').trim();
                    const reason = result.error?.code === 'ETIMEDOUT'
                        ? `timed out after ${hostTimeoutMs}ms`
                        : stderr || stdout || `exit ${result.status}`;
                    throw new Error(
                        `minimal contract host ${artifactId} failed: ${reason}`
                    );
                }
                if (!fs.existsSync(stagedOutput))
                {
                    throw new Error(`minimal contract host ${artifactId} produced no observation`);
                }
                const artifactBytes = fs.readFileSync(stagedOutput, 'utf8');
                const artifactObservation = JSON.parse(artifactBytes);
                if (artifactId === 'runtime-role-observation'
          && (artifactObservation.schema !== 'fsusblog.runtime-role-observation.v2'
            || artifactObservation.deploymentAuthority?.authoritySchema
              !== deploymentObservation.authoritySchema
            || artifactObservation.deploymentAuthority?.authorityContentDigest
              !== deploymentObservation.authorityContentDigest
            || artifactObservation.deploymentAuthority?.observationDigest
              !== deploymentObservation.observationDigest))
                {
                    throw new Error('minimal contract runtime-role observation did not bind deployment authority');
                }
                const artifactDigestValue = digestPath(stagingRoot, declaration.cacheFile);
                const projectDigestValue = artifactDigest(repositoryRoot, declaration.project);
                const assemblyPath = artifactId === 'runtime-role-observation'
                    ? runtimeReproducibleBuild.assemblyPath
                    : null;
                const assemblyDigest = artifactId === 'runtime-role-observation'
                    ? runtimeReproducibleBuild.assemblyDigest
                    : null;
                const deploymentArtifactPath = artifactId === 'runtime-role-observation'
                    ? path.posix.join(
              path.posix.join(cacheRelative, buildKey),
              'observations/runtime-role-deployment-observation.json'
            )
                    : null;
                const deploymentArtifactDigest = artifactId === 'runtime-role-observation'
                    ? digestPath(stagingRoot, 'observations/runtime-role-deployment-observation.json')
                    : null;
                const buildReceipt = {
                    schema: declaration.buildReceiptSchema,
                    artifactId,
                    artifactPath: declaration.output,
                    artifactDigest: artifactDigestValue,
                    configuration: 'Release',
                    ...(artifactId === 'openapi-aeds-observation'
                        ? {
                openapiPath: path.posix.join(cacheRelative, buildKey, openApiProjectionPaths.cacheFile),
                openapiArtifactPath: openApiProjectionPaths.output,
                openapiDigest: digestPath(stagingRoot, openApiProjectionPaths.cacheFile)
              }
                        : {}),
                    ...(artifactId === 'runtime-role-observation'
                        ? {
                sourceCommit: sourceIdentity.sourceCommit,
                worktreeFingerprint: sourceIdentity.worktreeFingerprint,
                projectDigest: projectDigestValue,
                assemblyPath,
                assemblyDigest,
                reproducibleBuild: {
                  ...runtimeReproducibleBuild,
                  sourceClosureDigest: digestValue(sourceClosureDigests)
                },
                deploymentArtifactPath,
                deploymentArtifactDigest,
                producer: 'dotnet-run-content-addressed-minimal-contract-host',
                externalOracle: artifactObservation.deploymentAuthority?.effectiveCompose?.oracle,
                externalOracleVersion: artifactObservation.deploymentAuthority?.effectiveCompose?.oracleVersion,
                dockerExecutable: artifactObservation.deploymentAuthority?.effectiveCompose?.dockerExecutable,
                composeImplementation: artifactObservation.deploymentAuthority?.effectiveCompose?.composeImplementation,
                effectiveComposeModelDigest: artifactObservation.deploymentAuthority?.effectiveCompose?.modelDigest,
                deploymentAuthoritySchema: artifactObservation.deploymentAuthority?.authoritySchema,
                deploymentAuthorityContentDigest: artifactObservation.deploymentAuthority?.authorityContentDigest,
                deploymentObservationDigest: artifactObservation.deploymentAuthority?.observationDigest
              }
                        : {})
                };
                artifacts[artifactId] = {
                    project: declaration.project,
                    projectDigest: projectDigestValue,
                    path: cachedArtifactPath(
                        path.posix.join(cacheRelative, buildKey),
                        declaration
                    ),
                    artifactPath: declaration.output,
                    artifactDigest: artifactDigestValue,
                    ...(artifactId === 'runtime-role-observation'
                        ? {
                assemblyPath,
                assemblyDigest,
                deploymentArtifactPath,
                deploymentArtifactDigest
              }
                        : {}),
                    buildReceipt
                };
            }

            publishedReceipt = seal({
                schema: minimalContractBuildSchema,
                runId: normalizedRunId,
                sourceCommit: sourceIdentity.sourceCommit,
                worktreeFingerprint: sourceIdentity.worktreeFingerprint,
                toolchain,
                buildKey,
                buildRoot: path.posix.join(cacheRelative, buildKey),
                sourceClosureDigests,
                sourceDigest: digestValue(sourceClosureDigests),
                artifacts,
                status: 'ok',
                failureReasons: []
            });
            fs.writeFileSync(
                path.join(stagingRoot, 'receipt.json'),
                `${JSON.stringify(publishedReceipt, null, 2)}\n`
            );
            fs.renameSync(stagingRoot, buildRoot);
            stagingRoot = null;
            validateMinimalContractBuildReceipt(publishedReceipt, {
                expectedRunId: normalizedRunId,
                expectedSourceIdentity: sourceIdentity
            });
        }
    }
    finally
    {
        if (stagingRoot !== null)
        {
            fs.rmSync(stagingRoot, { recursive: true, force: true });
        }
        releaseLock();
    }

    const preparedReceipt = bindReceiptToRun(publishedReceipt, normalizedRunId);
    validateMinimalContractBuildReceipt(preparedReceipt, {
        expectedRunId: normalizedRunId,
        expectedSourceIdentity: sourceIdentity
    });
    publishCanonicalObservations(repositoryRoot, preparedReceipt);
    validateMinimalContractBuildReceipt(preparedReceipt, {
        expectedRunId: normalizedRunId,
        expectedSourceIdentity: sourceIdentity,
        repositoryRoot
    });
    if (digestValue(minimalContractSourceClosureDigests(repositoryRoot, compiled))
    !== digestValue(sourceClosureDigests))
    {
        throw new Error('minimal contract build source closure changed before receipt sealing');
    }
    const receipt = seal(preparedReceipt);
    const receiptFile = path.join(buildRoot, 'receipt.json');
    const identityReceiptFile = path.join(buildRoot, 'receipts', `${normalizedRunId}.json`);
    fs.mkdirSync(path.dirname(identityReceiptFile), { recursive: true });
    fs.writeFileSync(identityReceiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    return {
        receipt,
        receiptFile,
        identityReceiptFile,
        buildIdentities: buildIdentitiesFromMinimalReceipt(receipt),
        cacheHit
    };
}

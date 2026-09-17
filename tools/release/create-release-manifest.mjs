#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';

import { createReleaseManifest, writeReleaseManifestAtomic } from './release-manifest.mjs';

function parseArgs(argv)
{
    const options = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value === undefined)
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        options[name.slice(2)] = value;
    }
    return options;
}

try
{
    const options = parseArgs(process.argv.slice(2));
    const required = [
        'output', 'release-id', 'created-at-utc', 'commit-sha', 'image-repository', 'image-tag', 'image-digest',
        'frontend-manifest-hash', 'wasm-artifact-hash',
        'schema-minimum-coordinate', 'schema-maximum-coordinate',
        'dotnet-version', 'node-version', 'docker-version', 'dockerfile-digest'
    ];
    for (const field of required)
    {
        if (!options[field])
        {
            throw new Error(`missing --${field}`);
        }
    }
    const manifest = createReleaseManifest({
        releaseId: options['release-id'],
        commitSha: options['commit-sha'],
        imageRepository: options['image-repository'],
        imageTag: options['image-tag'],
        imageDigest: options['image-digest'],
        registryDigestVerified: true,
        createdAtUtc: options['created-at-utc'],
        frontendManifestHash: options['frontend-manifest-hash'],
        wasmArtifactHash: options['wasm-artifact-hash'],
        schemaMinimumCoordinate: options['schema-minimum-coordinate'],
        schemaMaximumCoordinate: options['schema-maximum-coordinate'],
        dotnetVersion: options['dotnet-version'],
        nodeVersion: options['node-version'],
        dockerVersion: options['docker-version'],
        dockerfileDigest: options['dockerfile-digest'],
        runtimeProfile: options['runtime-profile-id'] ? {
      id: options['runtime-profile-id'],
      manifestDigest: options['runtime-profile-manifest-digest'],
      profileDigest: options['runtime-profile-digest'],
      baseImageFamily: options['runtime-base-family'],
      targetRuntime: options['target-runtime'],
      singleFile: parseBoolean(options['publish-single-file'], '--publish-single-file'),
      readyToRun: parseBoolean(options['publish-ready-to-run'], '--publish-ready-to-run'),
      tieredPgo: parseBoolean(options['tiered-pgo'], '--tiered-pgo'),
      quickJitForLoops: parseBoolean(options['quick-jit-for-loops'], '--quick-jit-for-loops'),
      serverGc: parseBoolean(options['server-gc'], '--server-gc'),
      nativeAot: parseBoolean(options['native-aot'], '--native-aot'),
      threadPoolMode: options['thread-pool-mode'],
      topologyMode: options['topology-mode']
    } : undefined,
        target: 'final'
    });
    const output = path.resolve(options.output);
    writeReleaseManifestAtomic(output, manifest);
    console.log(JSON.stringify({ status: 'ok', releaseId: manifest.releaseId, imageRef: manifest.imageRef, manifest: output }));
}
catch (error)
{
    console.error(`[create-release-manifest] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}

function parseBoolean(value, label)
{
    if (value === 'true')
    {
        return true;
    }
    if (value === 'false')
    {
        return false;
    }
    throw new Error(`${label} must be true or false`);
}

#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';

import { createReleaseManifest, readCurrentSchemaReleaseBinding, writeReleaseManifestAtomic } from './release-manifest.mjs';

function parseArgs(argv)
{
    const options = {};
    const allowed = new Set(['output', 'release-id', 'created-at-utc', 'commit-sha', 'image-repository', 'image-tag', 'image-digest',
        'frontend-manifest-hash', 'wasm-artifact-hash', 'current-receipt', 'current-receipt-reference', 'current-receipt-sha256',
        'current-model-version', 'current-extractor-version', 'current-generator-version', 'current-source-digest',
        'current-content-digest', 'current-provider', 'current-instance-id', 'current-database-id', 'current-actual-schema-digest',
        'dotnet-version', 'node-version', 'docker-version', 'dockerfile-digest', 'runtime-profile-id',
        'runtime-profile-manifest-digest', 'runtime-profile-digest', 'runtime-base-family', 'target-runtime',
        'publish-single-file', 'publish-ready-to-run', 'tiered-pgo', 'quick-jit-for-loops', 'server-gc', 'native-aot',
        'thread-pool-mode', 'topology-mode']);
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value === undefined)
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        const key = name.slice(2);
        if (!allowed.has(key) || Object.hasOwn(options, key) || value.startsWith('--'))
        {
            throw new Error(`unknown, duplicate or missing argument: ${name}`);
        }
        options[key] = value;
    }
    return options;
}

try
{
    const options = parseArgs(process.argv.slice(2));
    const required = [
        'output', 'release-id', 'created-at-utc', 'commit-sha', 'image-repository', 'image-tag', 'image-digest',
        'frontend-manifest-hash', 'wasm-artifact-hash',
        'current-receipt-sha256',
        'dotnet-version', 'node-version', 'docker-version', 'dockerfile-digest'
    ];
    for (const field of required)
    {
        if (!options[field])
        {
            throw new Error(`missing --${field}`);
        }
    }
    const projectedFields = ['current-receipt-reference', 'current-model-version', 'current-extractor-version',
        'current-generator-version', 'current-source-digest', 'current-content-digest', 'current-provider',
        'current-instance-id', 'current-database-id', 'current-actual-schema-digest'];
    if (options['current-receipt'] && projectedFields.some(field => Object.hasOwn(options, field)))
    {
        throw new Error('current receipt artifact and caller-projected fields cannot be combined');
    }
    if (!options['current-receipt'])
    {
        for (const field of projectedFields)
        {
            if (!options[field]) throw new Error(`missing --${field}`);
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
        currentSchema: options['current-receipt']
            ? readCurrentSchemaReleaseBinding(options['current-receipt'], options['current-receipt-sha256']) : {
            receipt: { reference: options['current-receipt-reference'], sha256: options['current-receipt-sha256'] },
            target: {
                modelVersion: options['current-model-version'],
                extractorVersion: options['current-extractor-version'],
                generatorVersion: options['current-generator-version'],
                sourceDigest: options['current-source-digest'],
                contentDigest: options['current-content-digest']
            },
            database: {
                provider: /^[012]$/u.test(options['current-provider']) ? Number(options['current-provider']) : null,
                instanceId: options['current-instance-id'],
                databaseId: options['current-database-id']
            },
            actualSchemaDigest: options['current-actual-schema-digest']
        },
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

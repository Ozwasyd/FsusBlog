#!/usr/bin/env node
import { createPrivateKey } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { RELEASE_ID_CONTRACT } from './release-id.mjs';
import { releaseIdentityRosterArtifacts } from './release-manifest-identity-contract.mjs';
import { signReleaseManifest, verifyReleaseManifestArtifacts } from './release-manifest-signature-contract.mjs';
import { createReleaseManifest, readExplicitReleaseArtifact, readCurrentSchemaReceiptReleaseBinding, writeReleaseManifestAtomic } from './release-manifest.mjs';

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
    if (options['schema-minimum-coordinate'] !== undefined || options['schema-maximum-coordinate'] !== undefined)
    {
        throw new Error('schema compatibility arguments are unsupported');
    }
    const required = [
        'output', 'release-id', 'created-at-utc', 'commit-sha', 'image-repository', 'image-tag', 'image-digest',
        'frontend-manifest-hash', 'wasm-artifact-hash',
        'current-schema-receipt', 'current-schema-receipt-sha256', 'identity-roster', 'identity-roster-sha256',
        'dotnet-version', 'node-version', 'docker-version', 'dockerfile-digest'
    ];
    for (const field of required)
    {
        if (!options[field])
        {
            throw new Error(`missing --${field}`);
        }
    }
    if (options.signature !== undefined)
    {
        throw new Error('handwritten signature inputs are unsupported; provide a process-owned signing key');
    }
    let manifest = createReleaseManifest({
        identity: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readExplicitReleaseArtifact(
            options['identity-roster'], options['identity-roster-sha256']))),
        releaseId: options['release-id'],
        commitSha: options['commit-sha'],
        imageRepository: options['image-repository'],
        imageTag: options['image-tag'],
        imageDigest: options['image-digest'],
        registryDigestVerified: true,
        createdAtUtc: options['created-at-utc'],
        frontendManifestHash: options['frontend-manifest-hash'],
        wasmArtifactHash: options['wasm-artifact-hash'],
        currentSchema: readCurrentSchemaReceiptReleaseBinding(
            options['current-schema-receipt'], options['current-schema-receipt-sha256']),
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
    if (options['signing-key'] !== undefined)
    {
        for (const key of ['signing-key-sha256', 'trust-policy', 'trust-policy-sha256'])
        {
            if (!options[key])
            {
                throw new Error(`signing requires explicit --${key}`);
            }
        }
        const keyBytes = readExplicitReleaseArtifact(options['signing-key'], options['signing-key-sha256'], 64 * 1024);
        try
        {
            manifest = signReleaseManifest(manifest, createPrivateKey(keyBytes));
        }
        finally
        {
            keyBytes.fill(0);
        }
        const artifacts = releaseIdentityRosterArtifacts(manifest.identity);
        verifyReleaseManifestArtifacts({ manifest, releaseIdContract: RELEASE_ID_CONTRACT,
            trustPolicyReference: options['trust-policy'], trustPolicySha256: options['trust-policy-sha256'],
            readBytes: (reference, expectedDigest) => readExplicitReleaseArtifact(reference,
                expectedDigest?.replace(/^sha256:/u, '') ?? (reference === manifest.currentSchema.receipt.reference ? manifest.currentSchema.receipt.sha256
                    : artifacts.find(artifact => artifact.reference === reference)?.sha256.replace(/^sha256:/u, '')),
                64 * 1024 * 1024) });
    }
    const output = path.resolve(options.output);
    writeReleaseManifestAtomic(output, manifest);
    console.log(JSON.stringify({ status: 'ok', qualificationEligible: false, signatureStatus: manifest.signature ? 'signed-artifacts-verified' : 'unsigned-prepared', candidateId: manifest.candidateId, contentDigest: manifest.contentDigest, releaseId: manifest.releaseId, imageRef: manifest.imageRef, manifest: output }));
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

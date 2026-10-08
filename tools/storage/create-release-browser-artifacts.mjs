#!/usr/bin/env node
import { createPrivateKey, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Read the exact artifact bytes through the existing release authority.
// eslint-disable-next-line import-x/no-relative-parent-imports
import { readExplicitReleaseArtifact } from '../release/release-manifest.mjs';

import { sha256Buffer } from './release-assets.mjs';
import { createCurrentReleaseBrowserArtifacts, createReleaseBrowserTrustScript } from './release-browser-projection.mjs';

function parseOptions(argv)
{
    const options = Object.create(null);
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || !value || value.startsWith('--') || Object.hasOwn(options, name.slice(2)))
        {
            throw new Error('browser artifact producer requires unique explicit named values');
        }
        options[name.slice(2)] = value;
    }
    const required = options.mode === 'trust'
        ? ['mode', 'public-key', 'public-key-sha256', 'key-id', 'out']
        : ['mode', 'release-manifest', 'release-manifest-sha256', 'trust-policy', 'trust-policy-sha256',
            'signing-key', 'signing-key-sha256', 'out'];
    if (!['trust', 'projection'].includes(options.mode) || required.some(key => !options[key])
        || Object.keys(options).some(key => !required.includes(key)))
    {
        throw new Error('browser artifact mode requires its closed pinned input roster');
    }
    return options;
}

function installArtifact(reference, bytes)
{
    if (!path.isAbsolute(reference) || path.resolve(reference) !== reference
        || reference.split(path.sep).some(part => ['latest', 'previous', 'stable'].includes(part))
        || fs.realpathSync(path.dirname(reference)) !== path.dirname(reference))
    {
        throw new Error('browser artifact output requires an explicit existing canonical parent');
    }
    const digest = sha256Buffer(bytes);
    const temporary = path.join(path.dirname(reference), `.browser-artifact-${randomUUID()}.tmp`);
    try
    {
        fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o444 });
        try
        {
            fs.linkSync(temporary, reference);
        }
        catch (error)
        {
            if (error.code !== 'EEXIST')
            {
                throw error;
            }
            readExplicitReleaseArtifact(reference, digest.slice(7), 1024 * 1024);
        }
    }
    finally
    {
        fs.rmSync(temporary, { force: true });
    }
    return digest;
}

try
{
    const options = parseOptions(process.argv.slice(2));
    const readBytes = (reference, digest) => readExplicitReleaseArtifact(reference, digest.replace(/^sha256:/u, ''), 64 * 1024 * 1024);
    let bytes;
    let identity = {};
    if (options.mode === 'trust')
    {
        const keyBytes = readExplicitReleaseArtifact(options['public-key'], options['public-key-sha256'].replace(/^sha256:/u, ''), 64 * 1024);
        bytes = Buffer.from(createReleaseBrowserTrustScript(keyBytes, options['key-id'], `sha256:${options['public-key-sha256'].replace(/^sha256:/u, '')}`));
    }
    else
    {
        const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
            readBytes(options['release-manifest'], options['release-manifest-sha256'])));
        const keyBytes = readExplicitReleaseArtifact(options['signing-key'], options['signing-key-sha256'].replace(/^sha256:/u, ''), 64 * 1024);
        try
        {
            const result = createCurrentReleaseBrowserArtifacts({ manifest, readBytes,
                trustPolicyReference: options['trust-policy'], trustPolicySha256: `sha256:${options['trust-policy-sha256'].replace(/^sha256:/u, '')}` }, createPrivateKey(keyBytes));
            bytes = result.projectionBytes;
            identity = { candidateId: result.candidateId, manifestContentDigest: result.manifestContentDigest };
        }
        finally
        {
            keyBytes.fill(0);
        }
    }
    const sha256 = installArtifact(options.out, bytes);
    process.stdout.write(`${JSON.stringify({ status: 'ok', mode: options.mode, out: options.out, sha256,
        ...identity, runtimeQualificationEligible: false })}\n`);
}
catch (error)
{
    process.stdout.write(`${JSON.stringify({ status: 'fail', errors: [error.message], runtimeQualificationEligible: false })}\n`);
    process.exitCode = 1;
}

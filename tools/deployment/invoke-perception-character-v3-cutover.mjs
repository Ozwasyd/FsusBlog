#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function fail(message)
{
    throw new Error(message);
}

function parseArgs(argv)
{
    const options = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!flag?.startsWith('--') || value === undefined)
        {
            fail(`invalid argument near ${flag ?? '<end>'}`);
        }
        options[flag.slice(2)] = value;
    }
    return options;
}

function required(options, name)
{
    const value = options[name]?.trim();
    if (!value)
    {
        fail(`--${name} is required`);
    }
    return value;
}

function positiveInteger(value, name)
{
    if (!/^\d+$/u.test(value) || Number(value) < 1)
    {
        fail(`--${name} must be a positive integer`);
    }
    return Number(value);
}

function digest(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function exactDigest(value, name)
{
    if (!/^[0-9a-f]{64}$/u.test(value ?? ''))
    {
        fail(`${name} must be a lowercase SHA-256 digest`);
    }
    return value;
}

async function adminHeader(file)
{
    const metadata = await stat(file);
    if (![0o400, 0o600].includes(metadata.mode & 0o777))
    {
        fail('deployment admin header file must have mode 0400 or 0600');
    }
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean);
    const match = /^(Authorization|Cookie): (.+)$/u.exec(lines.length === 1 ? lines[0] : '');
    if (!match || [...match[2]].some(character =>
    {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    }))
    {
        fail('deployment admin header file must contain one safe Authorization or Cookie header');
    }
    if (match[1] === 'Authorization' && !match[2].startsWith('Bearer '))
    {
        fail('deployment Authorization header must use Bearer');
    }
    return [match[1], match[2]];
}

async function atomicJson(file, value)
{
    const output = path.resolve(file);
    await mkdir(path.dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, output);
}

async function main()
{
    const options = parseArgs(process.argv.slice(2));
    const port = positiveInteger(required(options, 'port'), 'port');
    const generation = positiveInteger(required(options, 'generation'), 'generation');
    if (port > 65535)
    {
        fail('--port must be at most 65535');
    }
    const origin = required(options, 'origin');
    if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/u.test(origin)
      && !(process.env.FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE === '1'
        && /^http:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/u.test(origin)))
    {
        fail('--origin must be an explicit HTTPS origin');
    }

    const [releaseTargetBytes, poolManifestBytes] = await Promise.all([
        readFile(required(options, 'release-target')),
        readFile(required(options, 'pool-manifest'))
    ]);
    const releaseTarget = JSON.parse(releaseTargetBytes);
    const poolManifest = JSON.parse(poolManifestBytes);
    if (releaseTarget.schema !== 'fsusblog.security.perception-character-v3-release-target.v1')
    {
        fail('V3 release target schema is invalid');
    }
    if (poolManifest.schema !== 'fsusblog.security.perception-character-v3.pool-manifest.v1')
    {
        fail('V3 pool manifest schema is invalid');
    }
    const contractDigest = exactDigest(releaseTarget.contractDigest, 'release target contract digest');
    if (poolManifest.contractDigest !== contractDigest)
    {
        fail('V3 pool manifest does not bind the release target contract');
    }
    const schemaFingerprint = exactDigest(
        releaseTarget.aedsSchemaFingerprint,
        'release target AEDS schema fingerprint');
    const target = {
        ContractDigest: contractDigest,
        PoolGeneration: required({ value: poolManifest.generationId }, 'value'),
        PoolManifestDigest: digest(poolManifestBytes),
        BackendAedsSchemaFingerprint: schemaFingerprint,
        SharedAedsSchemaFingerprint: schemaFingerprint,
        FrontendAedsSchemaFingerprint: schemaFingerprint,
        PolicySnapshotVersion: required(options, 'policy-version'),
        releaseTargetFingerprint: exactDigest(
            releaseTarget.targetFingerprint,
            'release target fingerprint')
    };
    const targetFingerprint = digest(Buffer.from(JSON.stringify(target)));
    const request = {
        operationId: required(options, 'operation-id'),
        releaseId: required(options, 'release-id'),
        slot: required(options, 'slot'),
        generation,
        target: {
            contractDigest: target.ContractDigest,
            poolGeneration: target.PoolGeneration,
            poolManifestDigest: target.PoolManifestDigest,
            backendAedsSchemaFingerprint: target.BackendAedsSchemaFingerprint,
            sharedAedsSchemaFingerprint: target.SharedAedsSchemaFingerprint,
            frontendAedsSchemaFingerprint: target.FrontendAedsSchemaFingerprint,
            policySnapshotVersion: target.PolicySnapshotVersion,
            targetFingerprint
        },
        dryRun: false
    };
    const authorization = await adminHeader(required(options, 'admin-header-file'));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response;
    try
    {
        response = await fetch(
            `http://127.0.0.1:${port}/api/ops/deployment/fence/perception-character-v3-cutover`,
            {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    [authorization[0]]: authorization[1],
                    Origin: origin,
                    Accept: 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            });
    }
    finally
    {
        clearTimeout(timeout);
    }
    const body = await response.text();
    let receipt;
    try
    {
        receipt = JSON.parse(body);
    }
    catch
    {
        fail(`V3 cutover endpoint returned non-JSON HTTP ${response.status}`);
    }
    await atomicJson(required(options, 'receipt'), receipt);
    if (!response.ok
      || receipt?.schemaVersion !== 'fsus.security.perception-character-v3-cutover-receipt.v1'
      || receipt?.accepted !== true
      || receipt?.status !== 'activated'
      || receipt?.dryRun !== false
      || receipt?.targetFingerprint !== targetFingerprint)
    {
        fail(`V3 cutover endpoint rejected activation with HTTP ${response.status}`);
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

main().catch(error =>
{
    process.stderr.write(
        `[perception-character-v3-cutover] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});

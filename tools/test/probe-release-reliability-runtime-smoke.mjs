#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    producerRouteIds,
    routeCatalogDigest,
    routeContract
} from './lanes/runtime-http-route-contract.mjs';
import {
    digestValue
} from './release-reliability-receipt.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const protocolFile = path.join(repositoryRoot, 'src/shared/Contracts/Validation/aeds-protocol.json');
const routeCatalogFile = 'config/testing/runtime-http-route-contracts.json';
const runtimeSmokeSchema = 'fsusblog.release-reliability-runtime-smoke.v1';
const runtimeRouteContracts = Object.freeze(
    producerRouteIds('runtime-load-soak').map((routeId) => routeContract(routeId))
);

function crc16(bytes)
{
    let value = 0xffff;
    for (const byte of bytes)
    {
        value ^= byte;
        for (let bit = 0; bit < 8; bit += 1)
        {
            value = (value & 1) !== 0 ? ((value >>> 1) ^ 0xa001) : (value >>> 1);
        }
    }
    return value & 0xffff;
}

function protocolAuthority()
{
    const protocol = JSON.parse(fs.readFileSync(protocolFile, 'utf8'));
    const frameTypes = new Map(
        (protocol.frameTypes ?? []).map((frame) => [frame.name, frame.value])
    );
    const frameTypeNames = new Map(
        (protocol.frameTypes ?? []).map((frame) => [frame.value, frame.name])
    );
    const magic = Number.parseInt(String(protocol.header?.magic ?? ''), 16);
    if (!Number.isInteger(protocol.header?.size) || protocol.header.size < 16
        || !Number.isInteger(protocol.header?.version)
        || !Number.isInteger(magic)
        || frameTypes.size === 0
        || !Number.isInteger(frameTypes.get('SeoConfig'))
        || [...runtimeRouteContracts]
            .some((contract) => !Number.isInteger(contract.expectedAedsFrameType)
                || !frameTypeNames.has(contract.expectedAedsFrameType)))
    {
        throw new Error('canonical AEDS protocol authority is incomplete');
    }
    return {
        frameTypes,
        frameTypeNames,
        headerLength: protocol.header.size,
        magic,
        version: protocol.header.version,
        seoConfigFrameType: frameTypes.get('SeoConfig')
    };
}

const canonicalProtocolAuthority = protocolAuthority();

export function validateAedsFrame(bytes, expectedFrameType, authority = canonicalProtocolAuthority)
{
    const frameName = authority.frameTypeNames?.get(expectedFrameType);
    if (!Number.isInteger(expectedFrameType) || !frameName)
    {
        throw new Error('canonical AEDS frame type is incomplete');
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < authority.headerLength)
    {
        throw new Error(`binary canary is not one valid ${frameName} AEDS v2 frame`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const payloadLength = view.getUint32(10, true);
    if (view.getUint32(0, true) !== authority.magic
        || view.getUint8(4) !== authority.version
        || view.getUint8(5) !== authority.headerLength
        || view.getUint16(8, true) !== expectedFrameType
        || payloadLength !== bytes.byteLength - authority.headerLength
        || view.getUint16(14, true) !== crc16(bytes.subarray(authority.headerLength)))
    {
        throw new Error(`binary canary is not one valid ${frameName} AEDS v2 frame`);
    }
    return {
        version: view.getUint8(4),
        headerLength: view.getUint8(5),
        frameType: expectedFrameType,
        payloadLength,
        crcValidated: true
    };
}

export function validateSeoConfigFrame(bytes, authority = canonicalProtocolAuthority)
{
    return validateAedsFrame(bytes, authority.seoConfigFrameType, authority);
}

async function fetchResponse(baseUrl, relativePath, method, accept, signal)
{
    const response = await fetch(`${baseUrl}${relativePath}`, {
        method,
        headers: {
            Accept: accept,
            'Accept-Encoding': 'identity'
        },
        redirect: 'error',
        signal
    });
    if (response.status !== 200)
    {
        throw new Error(`${relativePath} returned HTTP ${response.status}`);
    }
    return response;
}

async function liveStatus(baseUrl, signal)
{
    const relativePath = '/health/live';
    const response = await fetchResponse(
        baseUrl,
        relativePath,
        'GET',
        'application/json',
        signal
    );
    const contentType = (response.headers.get('content-type') ?? '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
    if (contentType !== 'application/json')
    {
        throw new Error(`${relativePath} did not return JSON`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    let body;
    try
    {
        body = JSON.parse(new TextDecoder().decode(bytes));
    }
    catch
    {
        throw new Error(`${relativePath} returned invalid JSON`);
    }
    if (body?.status !== 'live'
        || !Number.isFinite(Date.parse(String(body?.checkedAt ?? ''))))
    {
        throw new Error(`${relativePath} returned an invalid live report`);
    }
    return {
        method: 'GET',
        path: relativePath,
        status: response.status,
        contentType,
        bodyBytes: bytes.byteLength,
        reportStatus: body.status,
        checkedAt: body.checkedAt
    };
}

function fsusHeaders(response)
{
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => name.toLowerCase().startsWith('x-fsus-'))
        .map(([name, value]) => [name.toLowerCase(), value])
        .sort(([left], [right]) => left.localeCompare(right)));
}

async function binaryRouteStatus(baseUrl, contract, signal)
{
    const relativePath = contract.pathTemplate;
    const response = await fetchResponse(
        baseUrl,
        relativePath,
        contract.method,
        contract.expectedContentType[0],
        signal
    );
    const contentType = (response.headers.get('content-type') ?? '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
    if (!contract.expectedContentType.includes(contentType)
        || contentType !== 'application/octet-stream')
    {
        throw new Error(`${relativePath} did not return application/octet-stream`);
    }
    const headers = fsusHeaders(response);
    if (headers['x-fsus-frame-version'] !== String(canonicalProtocolAuthority.version))
    {
        throw new Error(`${relativePath} returned an invalid X-Fsus-Frame-Version header`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < contract.minimumBodyBytes
        || bytes.byteLength > contract.maximumBodyBytes)
    {
        throw new Error(`${relativePath} returned an out-of-bounds AEDS frame`);
    }
    const frame = validateAedsFrame(bytes, contract.expectedAedsFrameType);
    return {
        routeId: contract.routeId,
        method: contract.method,
        path: relativePath,
        status: response.status,
        contentType,
        fsusHeaders: headers,
        bodyBytes: bytes.byteLength,
        aeds: frame
    };
}

export async function probeReleaseReliabilityRuntimeSmoke({ baseUrl, timeoutMs = 1000 })
{
    let parsed;
    try
    {
        parsed = new URL(baseUrl);
    }
    catch
    {
        throw new Error('runtime smoke base URL is invalid');
    }
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
        || !parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash
        || parsed.username || parsed.password)
    {
        throw new Error('runtime smoke base URL must be one explicit loopback HTTP origin');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    {
        throw new Error('runtime smoke timeout must be between 1 and 10000 milliseconds');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('runtime smoke probe timed out')), timeoutMs);
    try
    {
        const live = await liveStatus(parsed.origin, controller.signal);
        const binary = [];
        for (const contract of runtimeRouteContracts)
        {
            binary.push(await binaryRouteStatus(parsed.origin, contract, controller.signal));
        }
        const observation = {
            schema: runtimeSmokeSchema,
            status: 'passed',
            producer: {
                id: 'runtime-load-soak',
                routeCatalog: {
                    path: routeCatalogFile,
                    contentDigest: routeCatalogDigest()
                }
            },
            live,
            routes: binary,
            contentDigest: null
        };
        observation.contentDigest = digestValue(observation);
        return observation;
    }
    finally
    {
        clearTimeout(timer);
    }
}

function parseArguments(argumentsList)
{
    const values = {};
    while (argumentsList.length > 0)
    {
        const name = argumentsList.shift();
        const value = argumentsList.shift();
        if (!name?.startsWith('--') || value === undefined)
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        const key = name.slice(2);
        if (!['base-url', 'timeout-ms', 'out'].includes(key))
        {
            throw new Error(`unknown argument --${key}`);
        }
        if (Object.hasOwn(values, key))
        {
            throw new Error(`duplicate argument --${key}`);
        }
        values[key] = value;
    }
    if (!values['base-url'])
    {
        throw new Error('--base-url is required');
    }
    const timeoutMs = Number.parseInt(values['timeout-ms'] ?? '1000', 10);
    if (String(timeoutMs) !== String(values['timeout-ms'] ?? '1000'))
    {
        throw new Error('--timeout-ms must be an integer');
    }
    return { baseUrl: values['base-url'], timeoutMs, out: values.out ?? null };
}

function writeObservation(output, value)
{
    const normalized = String(output).replaceAll('\\', '/').replace(/^\.\//u, '');
    if (!/^\.tmp\/release-reliability\/[A-Za-z0-9][A-Za-z0-9_.-]*\/runtime-smoke-observation\.json$/u
        .test(normalized))
    {
        throw new Error('--out must be one canonical invocation smoke observation path');
    }
    const absolute = path.resolve(repositoryRoot, normalized);
    if (!absolute.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error('--out escapes the repository');
    }
    for (let cursor = path.dirname(absolute); cursor !== repositoryRoot; cursor = path.dirname(cursor))
    {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
        {
            throw new Error('--out contains a symlink');
        }
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    if (fs.existsSync(absolute))
    {
        throw new Error('--out already exists');
    }
    const temporary = `${absolute}.next-${process.pid}-${randomUUID()}`;
    try
    {
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600
        });
        fs.renameSync(temporary, absolute);
    }
    finally
    {
        fs.rmSync(temporary, { force: true });
    }
}

async function main()
{
    const options = parseArguments(process.argv.slice(2));
    const result = await probeReleaseReliabilityRuntimeSmoke(options);
    if (options.out)
    {
        writeObservation(options.out, result);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch((error) =>
    {
        console.error(`[release-reliability-runtime-smoke] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}

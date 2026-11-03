#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    producerRouteIds,
    routeCatalogDigest,
    routeContract
} from './lanes/runtime-http-route-contract.mjs';
import {collectProcessIdentity, processIdentityStatus} from './process-identity.mjs';
import {
    digestValue
} from './release-reliability-receipt.mjs';

const {observeBoundPortLease, verifyListenerIdentityRef} = await import(new URL('../test-matrix/production-fresh-port-lease.mjs', import.meta.url));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const protocolFile = path.join(repositoryRoot, 'src/shared/Contracts/Validation/aeds-protocol.json');
const routeCatalogFile = 'config/testing/runtime-http-route-contracts.json';
const runtimeSmokeSchema = 'fsusblog.release-reliability-runtime-smoke.v1';
const liveTimestampPattern =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d{1,7})?(?<offset>Z|[+-](?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/u;
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

export async function probeBootstrapBinaryRoute({url, managedPid, manifest, role, runId, namespace,
    expectedPayloadDigest, timeoutMs = 5000})
{
    const target = new URL(url);
    const contract = ['system-seo', 'pow-challenge'].map((id) => routeContract(id))
        .find((route) => target.pathname === route.pathTemplate);
    if (!contract || target.protocol !== 'http:' || target.hostname !== '127.0.0.1' ||
        target.username || target.password || target.search || target.hash ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    {
        throw new Error('bootstrap binary probe requires an admitted loopback canonical route');
    }
    const bound = manifest ? await observeBoundPortLease({manifest, role, runId, namespace}) : null;
    if (bound && bound.port !== Number(target.port || 80))
    {
        throw new Error('bootstrap binary probe target differs from its bound listener receipt');
    }
    const pid = bound?.identity?.pid ?? managedPid;
    if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1))
    {
        throw new Error('bootstrap binary probe requires an exact managed process identity');
    }
    const processIdentity = pid === undefined ? null : collectProcessIdentity(Number(pid));
    const unchanged = async () =>
    {
        if (processIdentity && (processIdentity.status !== 'verified' ||
            processIdentityStatus(processIdentity).status !== 'live' ||
            !await verifyListenerIdentityRef({port: Number(target.port || 80), listenerIdentityRef: `pid:${pid}`})))
        {
            throw new Error('bootstrap binary probe managed listener identity drift');
        }
        if (bound && JSON.stringify(await observeBoundPortLease({manifest, role, runId, namespace})) !== JSON.stringify(bound))
        {
            throw new Error('bootstrap binary probe bound listener changed within its attempt');
        }
    };
    await unchanged();
    const response = await fetch(target, {method: contract.method, redirect: 'error',
        headers: {Accept: contract.expectedContentType[0], 'Accept-Encoding': 'identity'},
        signal: AbortSignal.timeout(timeoutMs)});
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (response.status !== contract.expectedStatus || !contract.expectedContentType.includes(contentType))
    {
        throw new Error('bootstrap binary probe status or Content-Type mismatch');
    }
    if (contract.cacheHeaderPolicy === 'no-store' &&
        !/(?:^|,)\s*no-store(?:\s|,|$)/u.test(String(response.headers.get('cache-control') ?? '').toLowerCase()))
    {
        throw new Error('bootstrap binary probe cache policy mismatch');
    }
    const chunks = [];
    let byteLength = 0;
    for await (const chunk of response.body)
    {
        byteLength += chunk.byteLength;
        if (byteLength > contract.maximumBodyBytes)
        {
            throw new Error('bootstrap binary probe body exceeds canonical bound');
        }
        chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (byteLength < contract.minimumBodyBytes)
    {
        throw new Error('bootstrap binary probe body is shorter than its canonical contract');
    }
    const frame = validateAedsFrame(bytes, contract.expectedAedsFrameType);
    const payloadDigest = `sha256:${createHash('sha256').update(bytes.subarray(frame.headerLength)).digest('hex')}`;
    if (expectedPayloadDigest !== undefined && (!/^sha256:[a-f0-9]{64}$/u.test(expectedPayloadDigest) ||
        payloadDigest !== expectedPayloadDigest))
    {
        throw new Error('bootstrap binary probe fixed payload/generation mismatch');
    }
    await unchanged();
    return {routeId: contract.routeId, frame, payloadDigest, bound, processIdentity,
        qualifiedReadiness: false};
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

function canonicalizeLiveTimestamp(value)
{
    if (typeof value !== 'string' || value.length === 0)
    {
        return null;
    }
    const groups = liveTimestampPattern.exec(value)?.groups;
    if (!groups)
    {
        return null;
    }
    const year = Number(groups.year);
    const month = Number(groups.month);
    const day = Number(groups.day);
    const hour = Number(groups.hour);
    const minute = Number(groups.minute);
    const second = Number(groups.second);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const maximumDay = [
        0,
        31,
        leapYear ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31
    ][month] ?? 0;
    if (year < 1
        || month < 1
        || month > 12
        || day < 1
        || day > maximumDay
        || hour > 23
        || minute > 59
        || second > 59)
    {
        return null;
    }
    if (groups.offset !== 'Z')
    {
        const offsetHour = Number(groups.offsetHour);
        const offsetMinute = Number(groups.offsetMinute);
        if (offsetHour > 14 || offsetMinute > 59
            || (offsetHour === 14 && offsetMinute !== 0))
        {
            return null;
        }
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
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
    const checkedAt = canonicalizeLiveTimestamp(body?.checkedAt);
    if (body?.status !== 'live'
        || checkedAt === null)
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
        checkedAt
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
    if (process.argv[2] === '--binary-url')
    {
        if (![4, 6].includes(process.argv.length) || (process.argv.length === 6 && process.argv[4] !== '--managed-pid'))
        {
            throw new Error('binary probe requires --binary-url <url> [--managed-pid <pid>]');
        }
        const result = await probeBootstrapBinaryRoute({url: process.argv[3],
            managedPid: process.argv[5] === undefined ? undefined : Number(process.argv[5])});
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
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

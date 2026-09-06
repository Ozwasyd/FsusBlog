import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const eventSchema = JSON.parse(readFileSync(new URL('../../config/dependencies/fsusui-release-event.schema.json', import.meta.url), 'utf8'));
const registry = eventSchema.properties.registry.const;
const packageName = eventSchema.properties.package.const;
const receiptSchema = 'fsusblog.verified-fsusui-event.v1';
const verifiedEvents = new WeakSet();
const metadataLimit = 4 * 1024 * 1024;
const tarballLimit = 128 * 1024 * 1024;

function digest(bytes, algorithm = 'sha256', encoding = 'hex') {
    return createHash(algorithm).update(bytes).digest(encoding);
}

function requireCondition(condition, field) {
    if (!condition) {
        throw new Error(`FsusUI event verification failed: ${field}`);
    }
}

function parseUniqueJson(text, label) {
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error(`FsusUI event verification failed: ${label} JSON`);
    }
    const stack = [];
    let previous;
    for (const [token] of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,"]+/g)) {
        if (token === '{' || token === '[') {
            stack.push(token === '{' ? new Set() : null);
        } else if (token === '}' || token === ']') {
            stack.pop();
        } else if (token.startsWith('"') && stack.at(-1) && (previous === '{' || previous === ',')) {
            const key = JSON.parse(token);
            requireCondition(!stack.at(-1).has(key), `${label}.${key} duplicate`);
            stack.at(-1).add(key);
        }
        previous = token;
    }
    return value;
}

/** Parses the sender's exact v1 wire schema; no payload URL or unknown field is accepted. */
export function parseFsusuiReleaseEvent(rawPayload) {
    requireCondition(typeof rawPayload === 'string' && Buffer.byteLength(rawPayload) <= metadataLimit, 'raw payload size/type');
    const payload = parseUniqueJson(rawPayload, 'payload');
    requireCondition(payload && typeof payload === 'object' && !Array.isArray(payload), 'payload object');
    requireCondition(Object.keys(payload).length === eventSchema.required.length, 'payload missing/unknown fields');
    for (const [key, rule] of Object.entries(eventSchema.properties)) {
        requireCondition(Object.hasOwn(payload, key), `payload.${key} missing`);
        if (Object.hasOwn(rule, 'const')) {
            requireCondition(payload[key] === rule.const, `payload.${key}`);
        } else {
            requireCondition(typeof payload[key] === rule.type && new RegExp(rule.pattern).test(payload[key]), `payload.${key}`);
        }
    }
    requireCondition(payload.releaseTag === `v${payload.version}`, 'payload.releaseTag/version');
    requireCondition(payload.candidateSha256 === payload.npmTarballSha256, 'payload.candidateSha256/npmTarballSha256');
    requireCondition(Buffer.from(payload.npmIntegrity.slice(7), 'base64').toString('base64') === payload.npmIntegrity.slice(7), 'payload.npmIntegrity encoding');
    return Object.freeze(payload);
}

async function fetchBytes(url, limit, transport) {
    const target = new URL(url);
    requireCondition(target.origin === new URL(registry).origin && !target.username && !target.password && !target.hash && !target.search, 'npm URL origin');
    let response;
    try {
        response = await transport(target.href, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { accept: '*/*' } });
        requireCondition(response.ok && !response.redirected && response.body, 'npm response');
        if (response.url) {
            requireCondition(response.url === target.href, 'npm response URL');
        }
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body) {
            length += chunk.length;
            requireCondition(length <= limit, 'npm response size');
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    } catch {
        throw new Error('FsusUI event verification failed: npm network/registry/response');
    }
}

function readPackage(tarball) {
    let listing;
    let manifest;
    try {
        const options = { input: tarball, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: metadataLimit, timeout: 30000, env: { PATH: process.env.PATH, LC_ALL: 'C' } };
        listing = execFileSync('tar', ['-tzf', '-'], options).trim().split('\n');
        requireCondition(listing.filter((entry) => entry === 'package/package.json').length === 1, 'tarball exact-one package/package.json');
        // Stream only the manifest to stdout. No archive path is written to disk.
        manifest = execFileSync('tar', ['-xOzf', '-', 'package/package.json'], options);
    } catch {
        throw new Error('FsusUI event verification failed: tarball package/package.json');
    }
    return parseUniqueJson(manifest, 'tarball package');
}

function seal(body) {
    const receipt = Object.freeze({ ...body, receiptSha256: digest(JSON.stringify(body)) });
    verifiedEvents.add(receipt);
    return receipt;
}

/** Transport injection is for deterministic fixtures, not a configurable production registry. */
export async function verifyFsusuiReleaseEvent(rawPayload, { transport = fetch, now = () => new Date() } = {}) {
    const payload = parseFsusuiReleaseEvent(rawPayload);
    const packageUrl = `${registry}${encodeURIComponent(packageName)}`;
    const versionBytes = await fetchBytes(`${packageUrl}/${payload.version}`, metadataLimit, transport);
    const latestBytes = await fetchBytes(`${packageUrl}/latest`, metadataLimit, transport);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const version = parseUniqueJson(decoder.decode(versionBytes), 'npm version');
    const latest = parseUniqueJson(decoder.decode(latestBytes), 'npm latest');
    requireCondition(version?.name === packageName && version.version === payload.version, 'npm name/version');
    requireCondition(latest?.name === packageName && latest.version === payload.version, 'npm latest dist-tag');
    requireCondition(version.dist?.integrity === payload.npmIntegrity, 'npm integrity metadata');
    requireCondition(latest.dist?.integrity === version.dist.integrity && latest.dist?.tarball === version.dist.tarball, 'npm latest identity');
    requireCondition(typeof version.dist.tarball === 'string', 'npm dist.tarball');
    const tarball = await fetchBytes(version.dist.tarball, tarballLimit, transport);
    requireCondition(`sha512-${digest(tarball, 'sha512', 'base64')}` === payload.npmIntegrity, 'npm tarball integrity');
    requireCondition(digest(tarball) === payload.npmTarballSha256, 'npm tarball SHA-256');
    const manifest = readPackage(tarball);
    requireCondition(manifest?.name === packageName && manifest.version === payload.version, 'tarball name/version');
    const verifiedAt = now().toISOString();
    return seal({
        schema: receiptSchema,
        rawPayload,
        rawPayloadSha256: digest(rawPayload),
        payload,
        npmVersionMetadataSha256: digest(versionBytes),
        npmLatestMetadataSha256: digest(latestBytes),
        npmTarballSha256: digest(tarball),
        verifiedAt,
        verifierSchema: receiptSchema
    });
}

/** Updaters must use this guard. Serialized objects and raw payloads are not verified capabilities. */
export function requireVerifiedFsusuiEvent(receipt) {
    requireCondition(verifiedEvents.has(receipt), 'sealed verified event required');
    return receipt.payload;
}

/** A persisted receipt is untrusted until its digest and public npm facts are independently reverified. */
export async function reverifyFsusuiEventReceipt(rawReceipt, options) {
    const receipt = parseUniqueJson(rawReceipt, 'receipt');
    requireCondition(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'receipt object');
    const { receiptSha256, ...body } = receipt;
    requireCondition(receiptSha256 === digest(JSON.stringify(body)), 'receipt digest');
    requireCondition(body.schema === receiptSchema && body.verifierSchema === receiptSchema, 'receipt schema');
    requireCondition(typeof body.verifiedAt === 'string' && Number.isFinite(Date.parse(body.verifiedAt)), 'receipt verifiedAt');
    const verified = await verifyFsusuiReleaseEvent(body.rawPayload, options);
    const expected = { ...verified, verifiedAt: body.verifiedAt };
    delete expected.receiptSha256;
    requireCondition(JSON.stringify(body) === JSON.stringify(expected), 'receipt binding');
    return verified;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        requireCondition(process.argv.length === 4 && ['--payload', '--receipt'].includes(process.argv[2]), 'usage: --payload FILE | --receipt FILE');
        const raw = readFileSync(process.argv[3], 'utf8');
        const receipt = process.argv[2] === '--payload'
            ? await verifyFsusuiReleaseEvent(raw)
            : await reverifyFsusuiEventReceipt(raw);
        process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

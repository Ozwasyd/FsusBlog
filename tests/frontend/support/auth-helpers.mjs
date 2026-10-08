#!/usr/bin/env node

import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    decodeAedsFrame,
    encodeAdminChangeStatusRequest,
    encodeAedsFrame,
    encodeArticleWriteRequest,
    encodeCommentCreateRequest,
    encodeAccountConversationReplyRequest,
    encodeConversationCreateRequest,
    encodeConversationReadRequest,
    encodeConversationStatusRequest,
    encodeMfaChallengeVerifyRequest,
    encodeNameMutationRequest,
    encodePageContentPayload,
    encodePasskeyLoginCompleteRequest,
    encodePasskeyRegisterCompleteRequest,
    encodeSeoConfigPayload,
    encodeStringMutationRequest,
    encodeSystemMessageRequest,
    encodeUploadCompleteRequest,
    encodeUploadInitRequest,
    readAedsResponse
} from './aeds-envelope.mjs';
import { fetchWithTimeout, parseTimeoutMs } from './http.mjs';
import {
    ensureAdminFixtureSession,
    ensureUserFixtureSession,
    isFixtureAdminHandle
} from './session-fixtures.mjs';

export const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:7568';
export const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);
const FRAME_CATEGORY_WRITE_REQUEST = 33;
const FRAME_TAG_WRITE_REQUEST = 34;
const FRAME_ARTICLE_WRITE_REQUEST = 41;
const FRAME_PASSKEY_REGISTER_COMPLETE_REQUEST = 66;
const FRAME_PASSKEY_LOGIN_COMPLETE_REQUEST = 67;
const FRAME_PASSKEY_CREDENTIAL_FRIENDLY_NAME_UPDATE_REQUEST = 68;
const FRAME_UPLOAD_INIT_REQUEST = 31;
const FRAME_UPLOAD_COMPLETE_REQUEST = 32;
const FRAME_SEO_CONFIG_UPDATE_REQUEST = 35;
const FRAME_PAGE_CONTENT_UPDATE_REQUEST = 36;
const FRAME_COMMENT_CREATE_V2_REQUEST = 166;
const FRAME_ADMIN_CHANGE_USER_STATUS_REQUEST = 39;
const FRAME_MFA_SETUP_VERIFY_REQUEST = 52;
const FRAME_MFA_CHALLENGE_START_REQUEST = 54;
const FRAME_MFA_CHALLENGE_VERIFY_REQUEST = 55;
const FRAME_CONVERSATION_CREATE_REQUEST = 59;
const FRAME_CONVERSATION_REPLY_REQUEST = 60;
const FRAME_CONVERSATION_STATUS_REQUEST = 61;
const FRAME_SYSTEM_MESSAGE_REQUEST = 62;
const FRAME_CONVERSATION_READ_REQUEST = 201;
const FRAME_ACCOUNT_CONVERSATION_REPLY_REQUEST = 202;
const powWasmRoot = pathToFileURL(`${resolve(process.env.FSUSBLOG_FRONTEND_WASM_ROOT
  || new URL('../../../src/frontend/public/wasm/', import.meta.url).pathname)}/`);
const nodePowAssetKinds = ['relaxed', 'simd', 'basic'];
const nodePowBatchSize = Math.max(
    1,
    Number.parseInt(process.env.FSUSBLOG_NODE_WASM_POW_BATCH_SIZE ?? '262144', 10) || 262144
);
let nodePowModulePromise = null;

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function hasLeadingDifficulty(hash, difficulty)
{
    const fullBytes = Math.floor(difficulty / 8);
    for (let i = 0; i < fullBytes; i += 1)
    {
        if (hash[i] !== 0)
        {
            return false;
        }
    }

    const remainingBits = difficulty % 8;
    if (remainingBits > 0)
    {
        return (hash[fullBytes] >> (8 - remainingBits)) === 0;
    }

    return true;
}

export function solvePowNonce(salt, browserFp, difficulty, deadlineMs = Number.POSITIVE_INFINITY)
{
    let nonce = 0;
    while (true)
    {
        if ((nonce & 0x0fff) === 0 && Date.now() > deadlineMs)
        {
            throw new Error(`node pow solver timed out for difficulty ${difficulty}`);
        }

        const payload = `${salt}:${nonce}:${browserFp}`;
        const hash = createHash('sha256').update(payload, 'utf8').digest();
        if (hasLeadingDifficulty(hash, difficulty))
        {
            return String(nonce);
        }
        nonce += 1;
    }
}

async function loadNodePowModule()
{
    if (process.env.FSUSBLOG_DISABLE_NODE_WASM_POW === '1')
    {
        return null;
    }

    if (!nodePowModulePromise)
    {
        nodePowModulePromise = (async () =>
        {
            for (const assetKind of nodePowAssetKinds)
            {
                try
                {
                    const moduleRef = await import(new URL(`fsus_pow_${assetKind}.js`, powWasmRoot).href);
                    const factory = moduleRef.default ?? moduleRef.createPowModule;
                    if (typeof factory !== 'function')
                    {
                        continue;
                    }

                    const wasmBinary = await readFile(new URL(`fsus_pow_${assetKind}.wasm`, powWasmRoot));
                    const module = await factory({ wasmBinary });
                    if (module?.HEAPU8 && typeof module._solve_pow_limited_c === 'function')
                    {
                        return module;
                    }
                }
                catch
                {
                    // Try the next tier.
                }
            }

            return null;
        })().catch(() => null);
    }

    return await nodePowModulePromise;
}

function writeCStringToPowModule(module, value)
{
    const bytes = new TextEncoder().encode(value);
    const ptr = module._malloc(bytes.length + 1);
    module.HEAPU8.set(bytes, ptr);
    module.HEAPU8[ptr + bytes.length] = 0;
    return ptr;
}

function readCStringFromPowModule(module, ptr, maxLength)
{
    let end = ptr;
    const limit = ptr + maxLength;
    while (end < limit && module.HEAPU8[end] !== 0)
    {
        end += 1;
    }

    return new TextDecoder().decode(module.HEAPU8.subarray(ptr, end));
}

function resolvePowDeadline(timeoutMs)
{
    return Date.now() + Math.max(1000, timeoutMs - 250);
}

function yieldToNodeEventLoop()
{
    return new Promise((resolve) => setImmediate(resolve));
}

async function solvePowNonceOptimized(salt, browserFp, difficulty, timeoutMs = requestTimeoutMs)
{
    const deadlineMs = resolvePowDeadline(timeoutMs);
    const module = await loadNodePowModule();
    if (!module?.HEAPU8 || typeof module._solve_pow_limited_c !== 'function')
    {
        if (difficulty >= 25)
        {
            throw new Error('node wasm pow solver unavailable for high difficulty challenge');
        }

        return solvePowNonce(salt, browserFp, difficulty, deadlineMs);
    }

    const saltPtr = writeCStringToPowModule(module, salt);
    const fpPtr = writeCStringToPowModule(module, browserFp);
    const outputPtr = module._malloc(2048);

    try
    {
        let startNonce = 0;
        while (Date.now() <= deadlineMs)
        {
            const remainingNonceSpace = 0x1_0000_0000 - startNonce;
            const attempts = Math.min(nodePowBatchSize, remainingNonceSpace);
            const resultLength = module._solve_pow_limited_c(saltPtr, fpPtr, difficulty, startNonce, attempts, outputPtr, 2048);
            if (resultLength < 0)
            {
                if (difficulty < 25)
                {
                    return solvePowNonce(salt, browserFp, difficulty, deadlineMs);
                }
                throw new Error(`node wasm pow solver failed: ${resultLength}`);
            }

            if (resultLength > 0)
            {
                const nonce = readCStringFromPowModule(module, outputPtr, Math.min(resultLength + 1, 2048));
                const hash = createHash('sha256').update(`${salt}:${nonce}:${browserFp}`, 'utf8').digest();
                assert(hasLeadingDifficulty(hash, difficulty), `node wasm pow solver returned invalid nonce for difficulty ${difficulty}`);
                return nonce;
            }

            startNonce = (startNonce + attempts) >>> 0;
            if (startNonce === 0 || attempts <= 0)
            {
                break;
            }

            await yieldToNodeEventLoop();
        }

        throw new Error(`node wasm pow solver timed out for difficulty ${difficulty}`);
    }
    finally
    {
        module._free(outputPtr);
        module._free(fpPtr);
        module._free(saltPtr);
    }
}

function readInt32(view, offset)
{
    return view.getInt32(offset, true);
}

function readInt64Number(view, offset)
{
    return Number(view.getBigInt64(offset, true));
}

function readFixedUtf8(bytes, offset, length)
{
    const slice = bytes.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    return new TextDecoder().decode(end >= 0 ? slice.subarray(0, end) : slice);
}

function writeLengthPrefixedUtf8(target, view, offset, value)
{
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength > 0xffff)
    {
        throw new Error('pow proof field too large');
    }

    view.setUint16(offset, bytes.byteLength, true);
    const nextOffset = offset + 2;
    target.set(bytes, nextOffset);
    return nextOffset + bytes.byteLength;
}

function encodePowProofHeader({ salt, nonce, timestamp, difficulty, signature, browserFp })
{
    const encoder = new TextEncoder();
    const parts = [salt, nonce, signature, browserFp].map((value) => encoder.encode(value));
    const totalLength = 4 + 1 + 4 + 8 + parts.reduce((sum, part) => sum + 2 + part.byteLength, 0);
    const bytes = new Uint8Array(totalLength);
    const view = new DataView(bytes.buffer);
    bytes.set([0x46, 0x50, 0x4f, 0x57], 0);
    bytes[4] = 1;
    view.setInt32(5, difficulty, true);
    view.setBigInt64(9, BigInt(timestamp), true);

    let offset = 17;
    offset = writeLengthPrefixedUtf8(bytes, view, offset, salt);
    offset = writeLengthPrefixedUtf8(bytes, view, offset, nonce);
    offset = writeLengthPrefixedUtf8(bytes, view, offset, signature);
    writeLengthPrefixedUtf8(bytes, view, offset, browserFp);
    return Buffer.from(bytes).toString('base64');
}

function decodePowChallenge(buffer)
{
    const frame = decodeAedsFrame(buffer);
    if (frame.frameType !== 30)
    {
        throw new Error(`pow challenge frame mismatch: ${frame.frameType}`);
    }

    if (frame.payload.byteLength !== 204)
    {
        throw new Error(`pow challenge payload size mismatch: ${frame.payload.byteLength}`);
    }

    const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
    return {
        salt: readFixedUtf8(frame.payload, 0, 64),
        difficulty: readInt32(view, 64),
        timestamp: readInt64Number(view, 68),
        signature: readFixedUtf8(frame.payload, 76, 128)
    };
}

/* eslint-disable @stylistic/brace-style, @stylistic/indent */
export async function fetchAedsPayload(path, init = {}, timeoutMs = requestTimeoutMs) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, init, timeoutMs);
  const diagnosticResponse = response.clone();
  let payloadError = null;
  const payload = await readAedsResponse(response).catch((error) => {
    payloadError = error instanceof Error ? error.message : String(error);
    return null;
  });
  const responseBody = payloadError === null
    ? null
    : await diagnosticResponse.text().catch(() => null);
  return {
    response,
    payload,
    payloadError,
    responseBody,
    responseContentType: diagnosticResponse.headers.get('content-type')
  };
}
/* eslint-enable @stylistic/brace-style, @stylistic/indent */

export async function fetchChallenge(timeoutMs = requestTimeoutMs)
{
    const response = await fetchWithTimeout(`${baseUrl}/api/binary/auth/pow-challenge`, {
        headers: {
            Accept: 'application/octet-stream'
        }
    }, timeoutMs);
    assert(response.ok, `pow-challenge failed: ${response.status}`);
    return decodePowChallenge(await response.arrayBuffer());
}

export async function buildPowHeaders(deviceFingerprint, timeoutMs = requestTimeoutMs)
{
    const challenge = await fetchChallenge(timeoutMs);
    const salt = challenge.salt ?? challenge.Salt;
    const difficulty = Number(challenge.difficulty ?? challenge.Difficulty ?? 4);
    const timestamp = Number(challenge.timestamp ?? challenge.Timestamp);
    const signature = challenge.signature ?? challenge.Signature;
    assert(salt && signature, 'invalid pow challenge payload');

    const nonce = await solvePowNonceOptimized(salt, deviceFingerprint, difficulty, timeoutMs);
    const powHeader = encodePowProofHeader({
        salt,
        nonce,
        timestamp,
        difficulty,
        signature,
        browserFp: deviceFingerprint
    });

    return {
        'X-Fsus-Pow-Proof': powHeader,
        'X-Fsus-Device-Fp': deviceFingerprint
    };
}

export function parseCookies(setCookies)
{
    const cookieMap = new Map();
    for (const raw of setCookies)
    {
        const [pair] = raw.split(';', 1);
        const eq = pair.indexOf('=');
        if (eq <= 0)
        {
            continue;
        }
        cookieMap.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return cookieMap;
}

export function toCookieHeader(cookieMap)
{
    return Array.from(cookieMap.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
}

export function extractSessionId(cookieMap)
{
    return cookieMap.get('SessionId') ?? cookieMap.get('__Host-SessionId') ?? null;
}

export async function loginWithFixtureSessionBypass(username, password, rememberMe, deviceFingerprint, timeoutMs = requestTimeoutMs)
{
    void password;
    void timeoutMs;
    if (isFixtureAdminHandle(username))
    {
        return await ensureAdminFixtureSession({
            handle: username,
            rememberMe,
            deviceFingerprint
        });
    }

    return await ensureUserFixtureSession({
        handle: username,
        rememberMe,
        deviceFingerprint
    });
}

export async function loginWithPow()
{
    throw new Error('loginWithPow was retired for test fixtures; use loginWithFixtureSessionBypass explicitly.');
}

export async function registerWithPow(username, password, deviceFingerprint, timeoutMs = requestTimeoutMs)
{
    void username;
    void password;
    void deviceFingerprint;
    void timeoutMs;
    throw new Error('password registration is retired; use anonymous bootstrap + passkey fixture flow');
}

export async function authBinary(path, { method = 'GET', cookieHeader, deviceFingerprint, body, requiresPow = false, headers = {}, timeoutMs = requestTimeoutMs } = {})
{
    const powHeaders = requiresPow ? await buildPowHeaders(deviceFingerprint || 'smoke-fp', timeoutMs) : {
    ...(deviceFingerprint ? { 'X-Fsus-Device-Fp': deviceFingerprint } : {})
  };
    const encodedBody = encodeOptionalBody(path, body);

    const finalHeaders = {
        Accept: 'application/octet-stream',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...powHeaders,
        ...headers
    };

    if (body !== undefined && !Object.keys(finalHeaders).some((key) => key.toLowerCase() === 'content-type'))
    {
        finalHeaders['Content-Type'] = 'application/octet-stream';
    }

    const binaryPath = toBinaryPath(path);
    const result = await fetchAedsPayload(binaryPath, {
        method,
        headers: finalHeaders,
        body: encodedBody
    }, timeoutMs);

    if (!requiresPow || result.response.status !== 403)
    {
        return result;
    }

    const retryPowHeaders = await buildPowHeaders(deviceFingerprint || 'smoke-fp', timeoutMs);
    return await fetchAedsPayload(binaryPath, {
        method,
        headers: {
            ...finalHeaders,
            ...retryPowHeaders
        },
        body: encodedBody
    }, timeoutMs);
}

function toBinaryPath(path)
{
    return path
        .replace(/^\/api\/Auth\b/u, '/api/binary/auth')
        .replace(/^\/api\/Comment\b/u, '/api/binary/comment')
        .replace(/^\/api\/Article\b/u, '/api/binary/admin/article')
        .replace(/^\/api\/Category\b/u, '/api/binary/category')
        .replace(/^\/api\/Tag\b/u, '/api/binary/tag')
        .replace(/^\/api\/System\b/u, '/api/binary/system')
        .replace(/^\/api\/File\/upload\b/u, '/api/binary/upload')
        .replace(/^\/api\/File\/delete\b/u, '/api/binary/file/delete')
        .replace(/^\/api\/admin\/users\b/u, '/api/binary/admin/users')
        .replace(/^\/api\/v1\/admin\/messages\b/u, '/api/binary/admin/messages')
        .replace(/^\/api\/v1\/messages\b/u, '/api/binary/messages');
}

function encodeOptionalBody(path, body)
{
    if (body === undefined)
    {
        return undefined;
    }

    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body))
    {
        return body;
    }

    if (path.endsWith('/login'))
    {
        throw new Error('password login frame is retired');
    }

    if (path.endsWith('/register'))
    {
        throw new Error('password register frame is retired');
    }

    if (path.endsWith('/upload/init'))
    {
        return encodeAedsFrame(FRAME_UPLOAD_INIT_REQUEST, encodeUploadInitRequest(body));
    }

    if (path === '/api/File/upload')
    {
        return typeof body === 'string' ? Buffer.from(body) : Buffer.from('permission-probe');
    }

    if (/\/upload\/[^/]+\/complete$/u.test(path))
    {
        return encodeAedsFrame(FRAME_UPLOAD_COMPLETE_REQUEST, encodeUploadCompleteRequest(body.sha256 ?? body));
    }

    if (/\/upload\/[^/]+\/part$/u.test(path))
    {
        return typeof body === 'string' ? Buffer.from(body) : Buffer.from('permission-probe');
    }

    if (/^(?:\/api\/Category|\/api\/binary\/category)(?:\/\d+)?$/u.test(path))
    {
        return encodeAedsFrame(FRAME_CATEGORY_WRITE_REQUEST, encodeNameMutationRequest(body.name ?? body));
    }

    if (/^(?:\/api\/Tag|\/api\/binary\/tag)(?:\/\d+)?$/u.test(path))
    {
        return encodeAedsFrame(FRAME_TAG_WRITE_REQUEST, encodeNameMutationRequest(body.name ?? body));
    }

    if (/^(?:\/api\/Article|\/api\/binary\/admin\/article)(?:\/\d+)?$/u.test(path))
    {
        return encodeAedsFrame(FRAME_ARTICLE_WRITE_REQUEST, encodeArticleWriteRequest(body));
    }

    if (path === '/api/Comment')
    {
        return encodeAedsFrame(FRAME_COMMENT_CREATE_V2_REQUEST, encodeCommentCreateRequest(body));
    }

    if (path.endsWith('/update-password'))
    {
        throw new Error('password update frame is retired');
    }

    if (path.endsWith('/System/seo'))
    {
        return encodeAedsFrame(FRAME_SEO_CONFIG_UPDATE_REQUEST, encodeSeoConfigPayload(body));
    }

    if (path.endsWith('/System/page'))
    {
        return encodeAedsFrame(FRAME_PAGE_CONTENT_UPDATE_REQUEST, encodePageContentPayload(body));
    }

    if (path.endsWith('/admin/users/status'))
    {
        return encodeAedsFrame(FRAME_ADMIN_CHANGE_USER_STATUS_REQUEST, encodeAdminChangeStatusRequest(body));
    }

    if (path.endsWith('/messages/conversations'))
    {
        return encodeAedsFrame(FRAME_CONVERSATION_CREATE_REQUEST, encodeConversationCreateRequest(body));
    }

    if (/\/messages\/conversations\/\d+\/reply$/u.test(path))
    {
        if (!path.includes('/admin/messages/'))
        {
            return encodeAedsFrame(FRAME_ACCOUNT_CONVERSATION_REPLY_REQUEST, encodeAccountConversationReplyRequest(body));
        }
        return encodeAedsFrame(FRAME_CONVERSATION_REPLY_REQUEST, encodeStringMutationRequest(body.body ?? body));
    }

    if (/\/messages\/conversations\/\d+\/read$/u.test(path))
    {
        return encodeAedsFrame(FRAME_CONVERSATION_READ_REQUEST, encodeConversationReadRequest(body.readThroughMessageId ?? body));
    }

    if (/\/messages\/conversations\/\d+\/status$/u.test(path))
    {
        return encodeAedsFrame(FRAME_CONVERSATION_STATUS_REQUEST, encodeConversationStatusRequest(body));
    }

    if (path.endsWith('/messages/system-send'))
    {
        return encodeAedsFrame(FRAME_SYSTEM_MESSAGE_REQUEST, encodeSystemMessageRequest(body));
    }

    if (path.endsWith('/passkey/register/begin') || path.endsWith('/passkey/login/begin'))
    {
        return undefined;
    }

    if (path.endsWith('/passkey/register/complete'))
    {
        return encodeAedsFrame(FRAME_PASSKEY_REGISTER_COMPLETE_REQUEST, encodePasskeyRegisterCompleteRequest(body));
    }

    if (path.endsWith('/passkey/login/complete'))
    {
        return encodeAedsFrame(FRAME_PASSKEY_LOGIN_COMPLETE_REQUEST, encodePasskeyLoginCompleteRequest(body));
    }

    if (/\/passkey\/credentials\/\d+\/name$/u.test(path))
    {
        return encodeAedsFrame(FRAME_PASSKEY_CREDENTIAL_FRIENDLY_NAME_UPDATE_REQUEST, encodeStringMutationRequest(body.name ?? body));
    }

    if (path.endsWith('/mfa/setup/verify'))
    {
        return encodeAedsFrame(FRAME_MFA_SETUP_VERIFY_REQUEST, encodeStringMutationRequest(body.code ?? body));
    }

    if (path.endsWith('/mfa/challenge/start'))
    {
        return encodeAedsFrame(FRAME_MFA_CHALLENGE_START_REQUEST, encodeStringMutationRequest(body.action ?? body));
    }

    if (path.endsWith('/mfa/challenge'))
    {
        return encodeAedsFrame(FRAME_MFA_CHALLENGE_VERIFY_REQUEST, encodeMfaChallengeVerifyRequest(body));
    }

    throw new Error(`binary body encoder missing for ${path}`);
}

export function createTotp(secret, unixTimeMs = Date.now(), stepSeconds = 30, digits = 6)
{
    const key = decodeBase32(secret);
    const counter = Math.floor(unixTimeMs / 1000 / stepSeconds);
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac('sha1', key).update(buffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = (
        ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
    );
    return String(binary % (10 ** digits)).padStart(digits, '0');
}

function decodeBase32(input)
{
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const normalized = String(input).toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
    let bits = '';
    for (const char of normalized)
    {
        const index = alphabet.indexOf(char);
        if (index < 0)
        {
            throw new Error(`invalid base32 character: ${char}`);
        }
        bits += index.toString(2).padStart(5, '0');
    }

    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8)
    {
        bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
    }
    return Buffer.from(bytes);
}

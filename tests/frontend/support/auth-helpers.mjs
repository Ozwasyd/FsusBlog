#!/usr/bin/env node

import { createHash, createHmac } from 'node:crypto';
import {
  decodeAedsFrame,
  encodeAdminChangeStatusRequest,
  encodeAdminResetPasswordRequest,
  encodeAedsFrame,
  encodeArticleWriteRequest,
  encodeAuthLoginRequest,
  encodeAuthRegisterRequest,
  encodeAuthUpdatePasswordRequest,
  encodeCommentCreateRequest,
  encodeConversationCreateRequest,
  encodeConversationStatusRequest,
  encodeMfaChallengeVerifyRequest,
  encodeMfaPasswordProofRequest,
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

export const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000';
export const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);
const FRAME_AUTH_LOGIN_REQUEST = 43;
const FRAME_AUTH_REGISTER_REQUEST = 44;
const FRAME_CATEGORY_WRITE_REQUEST = 33;
const FRAME_TAG_WRITE_REQUEST = 34;
const FRAME_ARTICLE_WRITE_REQUEST = 41;
const FRAME_PASSKEY_REGISTER_COMPLETE_REQUEST = 66;
const FRAME_PASSKEY_LOGIN_COMPLETE_REQUEST = 67;
const FRAME_PASSKEY_RENAME_REQUEST = 68;
const FRAME_UPLOAD_INIT_REQUEST = 31;
const FRAME_UPLOAD_COMPLETE_REQUEST = 32;
const FRAME_SEO_CONFIG_UPDATE_REQUEST = 35;
const FRAME_PAGE_CONTENT_UPDATE_REQUEST = 36;
const FRAME_COMMENT_CREATE_REQUEST = 37;
const FRAME_ADMIN_CHANGE_USER_STATUS_REQUEST = 39;
const FRAME_ADMIN_RESET_USER_PASSWORD_REQUEST = 40;
const FRAME_AUTH_UPDATE_PASSWORD_REQUEST = 46;
const FRAME_MFA_SETUP_VERIFY_REQUEST = 52;
const FRAME_MFA_PASSWORD_PROOF_REQUEST = 53;
const FRAME_MFA_CHALLENGE_START_REQUEST = 54;
const FRAME_MFA_CHALLENGE_VERIFY_REQUEST = 55;
const FRAME_CONVERSATION_CREATE_REQUEST = 59;
const FRAME_CONVERSATION_REPLY_REQUEST = 60;
const FRAME_CONVERSATION_STATUS_REQUEST = 61;
const FRAME_SYSTEM_MESSAGE_REQUEST = 62;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function hasLeadingDifficulty(hash, difficulty) {
  const fullBytes = Math.floor(difficulty / 2);
  for (let i = 0; i < fullBytes; i += 1) {
    if (hash[i] !== 0) {
      return false;
    }
  }

  if (difficulty % 2 === 1) {
    return (hash[fullBytes] & 0xf0) === 0;
  }

  return true;
}

export function solvePowNonce(salt, browserFp, difficulty) {
  let nonce = 0;
  while (true) {
    const payload = `${salt}:${nonce}:${browserFp}`;
    const hash = createHash('sha256').update(payload, 'utf8').digest();
    if (hasLeadingDifficulty(hash, difficulty)) {
      return String(nonce);
    }
    nonce += 1;
  }
}

function readInt32(view, offset) {
  return view.getInt32(offset, true);
}

function readInt64Number(view, offset) {
  return Number(view.getBigInt64(offset, true));
}

function readFixedUtf8(bytes, offset, length) {
  const slice = bytes.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? slice.subarray(0, end) : slice);
}

function writeLengthPrefixedUtf8(target, view, offset, value) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > 0xffff) {
    throw new Error('pow proof field too large');
  }

  view.setUint16(offset, bytes.byteLength, true);
  const nextOffset = offset + 2;
  target.set(bytes, nextOffset);
  return nextOffset + bytes.byteLength;
}

function encodePowProofHeader({ salt, nonce, timestamp, difficulty, signature, browserFp }) {
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

function decodePowChallenge(buffer) {
  const frame = decodeAedsFrame(buffer);
  if (frame.frameType !== 30) {
    throw new Error(`pow challenge frame mismatch: ${frame.frameType}`);
  }

  if (frame.payload.byteLength !== 204) {
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

export async function fetchAedsPayload(path, init = {}, timeoutMs = requestTimeoutMs) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, init, timeoutMs);
  const payload = await readAedsResponse(response).catch(() => null);
  return { response, payload };
}

export async function fetchChallenge(timeoutMs = requestTimeoutMs) {
  const response = await fetchWithTimeout(`${baseUrl}/api/binary/auth/pow-challenge`, {
    headers: {
      Accept: 'application/octet-stream'
    }
  }, timeoutMs);
  assert(response.ok, `pow-challenge failed: ${response.status}`);
  return decodePowChallenge(await response.arrayBuffer());
}

export async function buildPowHeaders(deviceFingerprint, timeoutMs = requestTimeoutMs) {
  const challenge = await fetchChallenge(timeoutMs);
  const salt = challenge.salt ?? challenge.Salt;
  const difficulty = Number(challenge.difficulty ?? challenge.Difficulty ?? 4);
  const timestamp = Number(challenge.timestamp ?? challenge.Timestamp);
  const signature = challenge.signature ?? challenge.Signature;
  assert(salt && signature, 'invalid pow challenge payload');

  const nonce = solvePowNonce(salt, deviceFingerprint, difficulty);
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

export function parseCookies(setCookies) {
  const cookieMap = new Map();
  for (const raw of setCookies) {
    const [pair] = raw.split(';', 1);
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    cookieMap.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return cookieMap;
}

export function toCookieHeader(cookieMap) {
  return Array.from(cookieMap.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
}

export function extractSessionId(cookieMap) {
  return cookieMap.get('SessionId') ?? cookieMap.get('__Host-SessionId') ?? null;
}

export async function loginWithPow(username, password, rememberMe, deviceFingerprint, timeoutMs = requestTimeoutMs) {
  const powHeaders = await buildPowHeaders(deviceFingerprint, timeoutMs);
  const response = await fetchWithTimeout(`${baseUrl}/api/binary/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      Accept: 'application/octet-stream',
      ...powHeaders
    },
    body: encodeAedsFrame(FRAME_AUTH_LOGIN_REQUEST, encodeAuthLoginRequest({ username, password, rememberMe }))
  }, timeoutMs);

  const payload = await readAedsResponse(response).catch(() => null);
  assert(response.ok, `login failed: ${response.status}`);
  const setCookies = response.headers.getSetCookie();
  assert(setCookies.length > 0, 'missing set-cookie in login response');
  const cookieMap = parseCookies(setCookies);
  const sessionId = extractSessionId(cookieMap);
  assert(sessionId, 'missing session id cookie in login response');

  return {
    cookieMap,
    cookieHeader: toCookieHeader(cookieMap),
    sessionId,
    payload
  };
}

export async function registerWithPow(username, password, deviceFingerprint, timeoutMs = requestTimeoutMs) {
  const powHeaders = await buildPowHeaders(deviceFingerprint, timeoutMs);
  const response = await fetchWithTimeout(`${baseUrl}/api/binary/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      Accept: 'application/octet-stream',
      ...powHeaders
    },
    body: encodeAedsFrame(FRAME_AUTH_REGISTER_REQUEST, encodeAuthRegisterRequest({ username, password, confirmPassword: password }))
  }, timeoutMs);

  const payload = await readAedsResponse(response).catch(() => null);
  assert(response.ok, `register failed: ${response.status}`);
  const setCookies = response.headers.getSetCookie();
  assert(setCookies.length > 0, 'missing set-cookie in register response');
  const cookieMap = parseCookies(setCookies);
  const sessionId = extractSessionId(cookieMap);
  assert(sessionId, 'missing session id cookie in register response');

  return {
    cookieMap,
    cookieHeader: toCookieHeader(cookieMap),
    sessionId,
    payload
  };
}

export async function authBinary(path, { method = 'GET', cookieHeader, deviceFingerprint, body, requiresPow = false, headers = {}, timeoutMs = requestTimeoutMs } = {}) {
  const powHeaders = requiresPow ? await buildPowHeaders(deviceFingerprint || 'smoke-fp', timeoutMs) : {
    ...(deviceFingerprint ? { 'X-Fsus-Device-Fp': deviceFingerprint } : {})
  };

  const finalHeaders = {
    Accept: 'application/octet-stream',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    ...powHeaders,
    ...headers
  };

  if (body !== undefined && !Object.keys(finalHeaders).some((key) => key.toLowerCase() === 'content-type')) {
    finalHeaders['Content-Type'] = 'application/octet-stream';
  }

  return await fetchAedsPayload(toBinaryPath(path), {
    method,
    headers: finalHeaders,
    body: encodeOptionalBody(path, body)
  }, timeoutMs);
}

function toBinaryPath(path) {
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
    .replace(/^\/api\/v1\/messages\b/u, '/api/binary/messages')
}

function encodeOptionalBody(path, body) {
  if (body === undefined) {
    return undefined;
  }

  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return body;
  }

  if (path.endsWith('/login')) {
    return encodeAedsFrame(FRAME_AUTH_LOGIN_REQUEST, encodeAuthLoginRequest(body));
  }

  if (path.endsWith('/register')) {
    return encodeAedsFrame(FRAME_AUTH_REGISTER_REQUEST, encodeAuthRegisterRequest(body));
  }

  if (path.endsWith('/upload/init')) {
    return encodeAedsFrame(FRAME_UPLOAD_INIT_REQUEST, encodeUploadInitRequest(body));
  }

  if (path === '/api/File/upload') {
    return typeof body === 'string' ? Buffer.from(body) : Buffer.from('permission-probe');
  }

  if (/\/upload\/[^/]+\/complete$/u.test(path)) {
    return encodeAedsFrame(FRAME_UPLOAD_COMPLETE_REQUEST, encodeUploadCompleteRequest(body.sha256 ?? body));
  }

  if (/\/upload\/[^/]+\/part$/u.test(path)) {
    return typeof body === 'string' ? Buffer.from(body) : Buffer.from('permission-probe');
  }

  if (/^\/api\/Category(?:\/\d+)?$/u.test(path)) {
    return encodeAedsFrame(FRAME_CATEGORY_WRITE_REQUEST, encodeNameMutationRequest(body.name ?? body));
  }

  if (/^\/api\/Tag(?:\/\d+)?$/u.test(path)) {
    return encodeAedsFrame(FRAME_TAG_WRITE_REQUEST, encodeNameMutationRequest(body.name ?? body));
  }

  if (/^\/api\/Article(?:\/\d+)?$/u.test(path)) {
    return encodeAedsFrame(FRAME_ARTICLE_WRITE_REQUEST, encodeArticleWriteRequest(body));
  }

  if (path === '/api/Comment') {
    return encodeAedsFrame(FRAME_COMMENT_CREATE_REQUEST, encodeCommentCreateRequest(body));
  }

  if (path.endsWith('/update-password')) {
    return encodeAedsFrame(FRAME_AUTH_UPDATE_PASSWORD_REQUEST, encodeAuthUpdatePasswordRequest(body));
  }

  if (path.endsWith('/System/seo')) {
    return encodeAedsFrame(FRAME_SEO_CONFIG_UPDATE_REQUEST, encodeSeoConfigPayload(body));
  }

  if (path.endsWith('/System/page')) {
    return encodeAedsFrame(FRAME_PAGE_CONTENT_UPDATE_REQUEST, encodePageContentPayload(body));
  }

  if (path.endsWith('/admin/users/status')) {
    return encodeAedsFrame(FRAME_ADMIN_CHANGE_USER_STATUS_REQUEST, encodeAdminChangeStatusRequest(body));
  }

  if (path.endsWith('/admin/users/reset-pwd')) {
    return encodeAedsFrame(FRAME_ADMIN_RESET_USER_PASSWORD_REQUEST, encodeAdminResetPasswordRequest(body));
  }

  if (path.endsWith('/messages/conversations')) {
    return encodeAedsFrame(FRAME_CONVERSATION_CREATE_REQUEST, encodeConversationCreateRequest(body));
  }

  if (/\/messages\/conversations\/\d+\/reply$/u.test(path)) {
    return encodeAedsFrame(FRAME_CONVERSATION_REPLY_REQUEST, encodeStringMutationRequest(body.body ?? body));
  }

  if (/\/messages\/conversations\/\d+\/status$/u.test(path)) {
    return encodeAedsFrame(FRAME_CONVERSATION_STATUS_REQUEST, encodeConversationStatusRequest(body.status ?? body));
  }

  if (path.endsWith('/messages/system-send')) {
    return encodeAedsFrame(FRAME_SYSTEM_MESSAGE_REQUEST, encodeSystemMessageRequest(body));
  }

  if (path.endsWith('/passkey/register/begin') || path.endsWith('/passkey/login/begin')) {
    return undefined;
  }

  if (path.endsWith('/passkey/register/complete')) {
    return encodeAedsFrame(FRAME_PASSKEY_REGISTER_COMPLETE_REQUEST, encodePasskeyRegisterCompleteRequest(body));
  }

  if (path.endsWith('/passkey/login/complete')) {
    return encodeAedsFrame(FRAME_PASSKEY_LOGIN_COMPLETE_REQUEST, encodePasskeyLoginCompleteRequest(body));
  }

  if (/\/passkey\/credentials\/\d+\/name$/u.test(path)) {
    return encodeAedsFrame(FRAME_PASSKEY_RENAME_REQUEST, encodeStringMutationRequest(body.name ?? body));
  }

  if (path.endsWith('/mfa/setup/verify')) {
    return encodeAedsFrame(FRAME_MFA_SETUP_VERIFY_REQUEST, encodeStringMutationRequest(body.code ?? body));
  }

  if (path.endsWith('/mfa/disable') || path.endsWith('/mfa/recovery/regenerate')) {
    return encodeAedsFrame(FRAME_MFA_PASSWORD_PROOF_REQUEST, encodeMfaPasswordProofRequest(body));
  }

  if (path.endsWith('/mfa/challenge/start')) {
    return encodeAedsFrame(FRAME_MFA_CHALLENGE_START_REQUEST, encodeStringMutationRequest(body.action ?? body));
  }

  if (path.endsWith('/mfa/challenge')) {
    return encodeAedsFrame(FRAME_MFA_CHALLENGE_VERIFY_REQUEST, encodeMfaChallengeVerifyRequest(body));
  }

  throw new Error(`binary body encoder missing for ${path}`);
}

export function createTotp(secret, unixTimeMs = Date.now(), stepSeconds = 30, digits = 6) {
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

function decodeBase32(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = String(input).toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index < 0) {
      throw new Error(`invalid base32 character: ${char}`);
    }
    bits += index.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

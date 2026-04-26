#!/usr/bin/env node

import { createHash, createHmac } from 'node:crypto';
import { readJsonLikeResponse } from './aeds-envelope.mjs';
import { fetchWithTimeout, parseTimeoutMs } from './http.mjs';

export const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000';
export const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);

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

function toSafeBase64(payloadObject) {
  const json = JSON.stringify(payloadObject);
  return Buffer.from(json, 'utf8').toString('base64');
}

export async function fetchJsonLike(path, init = {}, timeoutMs = requestTimeoutMs) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, init, timeoutMs);
  const payload = await readJsonLikeResponse(response).catch(() => null);
  return { response, payload };
}

export async function fetchChallenge(timeoutMs = requestTimeoutMs) {
  const { response, payload } = await fetchJsonLike('/api/Auth/pow-challenge', {
    headers: {
      Accept: 'application/json'
    }
  }, timeoutMs);
  assert(response.ok, `pow-challenge failed: ${response.status}`);
  return payload?.data ?? payload;
}

export async function buildPowHeaders(deviceFingerprint, timeoutMs = requestTimeoutMs) {
  const challenge = await fetchChallenge(timeoutMs);
  const salt = challenge.salt ?? challenge.Salt;
  const difficulty = Number(challenge.difficulty ?? challenge.Difficulty ?? 4);
  const timestamp = Number(challenge.timestamp ?? challenge.Timestamp);
  const signature = challenge.signature ?? challenge.Signature;
  assert(salt && signature, 'invalid pow challenge payload');

  const nonce = solvePowNonce(salt, deviceFingerprint, difficulty);
  const powHeader = toSafeBase64({
    powSalt: salt,
    powNonce: nonce,
    powTimestamp: timestamp,
    difficulty,
    powSignature: signature,
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
  const response = await fetchWithTimeout(`${baseUrl}/api/Auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...powHeaders
    },
    body: JSON.stringify({ username, password, rememberMe })
  }, timeoutMs);

  const payload = await readJsonLikeResponse(response).catch(() => null);
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

export async function authJson(path, { method = 'GET', cookieHeader, deviceFingerprint, body, requiresPow = false, headers = {}, timeoutMs = requestTimeoutMs } = {}) {
  const powHeaders = requiresPow ? await buildPowHeaders(deviceFingerprint || 'smoke-fp', timeoutMs) : {
    ...(deviceFingerprint ? { 'X-Fsus-Device-Fp': deviceFingerprint } : {})
  };

  const finalHeaders = {
    Accept: 'application/json',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    ...powHeaders,
    ...headers
  };

  if (body !== undefined && !Object.keys(finalHeaders).some((key) => key.toLowerCase() === 'content-type')) {
    finalHeaders['Content-Type'] = 'application/json';
  }

  return await fetchJsonLike(path, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  }, timeoutMs);
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

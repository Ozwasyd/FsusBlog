#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readJsonLikeResponse } from '../../support/aeds-envelope.mjs';
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000';
const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD || 'BinaryUserPass123!';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);
const baseDeviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'auth-session-smoke-node';

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

function solvePowNonce(salt, browserFp, difficulty) {
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

async function fetchChallenge() {
  const response = await fetchWithTimeout(`${baseUrl}/api/Auth/pow-challenge`, {
    headers: { Accept: 'application/json' }
  }, requestTimeoutMs);
  assert(response.ok, `pow-challenge failed: ${response.status}`);
  const challenge = await readJsonLikeResponse(response);
  return challenge.data ?? challenge;
}

function parseCookies(setCookies) {
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

function toCookieHeader(cookieMap) {
  return Array.from(cookieMap.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
}

function extractSessionId(cookieMap) {
  return cookieMap.get('SessionId') ?? cookieMap.get('__Host-SessionId') ?? null;
}

async function loginWithPow(username, password, rememberMe, deviceFingerprint) {
  const challenge = await fetchChallenge();
  const salt = challenge.salt ?? challenge.Salt;
  const difficulty = Number(challenge.difficulty ?? challenge.Difficulty ?? 4);
  const timestamp = Number(challenge.timestamp ?? challenge.Timestamp);
  const signature = challenge.signature ?? challenge.Signature;
  assert(salt && signature, 'invalid challenge payload');

  const nonce = solvePowNonce(salt, deviceFingerprint, difficulty);
  const powHeader = toSafeBase64({
    powSalt: salt,
    powNonce: nonce,
    powTimestamp: timestamp,
    difficulty,
    powSignature: signature,
    browserFp: deviceFingerprint
  });

  const response = await fetchWithTimeout(`${baseUrl}/api/Auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Fsus-Pow-Proof': powHeader,
      'X-Fsus-Device-Fp': deviceFingerprint
    },
    body: JSON.stringify({ username, password, rememberMe })
  }, requestTimeoutMs);
  assert(response.ok, `login failed: ${response.status}`);
  const setCookies = response.headers.getSetCookie();
  assert(setCookies.length > 0, 'missing set-cookie in login response');
  const cookieMap = parseCookies(setCookies);
  const sessionId = extractSessionId(cookieMap);
  assert(sessionId, 'missing session id cookie in login response');

  return {
    cookieHeader: toCookieHeader(cookieMap),
    sessionId
  };
}

async function callJson(path, cookieHeader, deviceFingerprint, init = {}) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Cookie: cookieHeader,
      'X-Fsus-Device-Fp': deviceFingerprint,
      ...(init.headers || {})
    }
  }, requestTimeoutMs);

  const payload = await readJsonLikeResponse(response).catch(() => null);
  return { response, payload };
}

async function main() {
  await probeReachable(`${baseUrl}/api/Auth/pow-challenge`, '[auth-session-smoke backend]', requestTimeoutMs);

  const standardFp = `${baseDeviceFingerprint}-standard`;
  const rememberFp = `${baseDeviceFingerprint}-remember`;

  const standard = await loginWithPow(userName, userPassword, false, standardFp);
  const remembered = await loginWithPow(userName, userPassword, true, rememberFp);

  const sessionsResult = await callJson('/api/Auth/sessions', remembered.cookieHeader, rememberFp);
  assert(sessionsResult.response.ok, `list sessions failed: ${sessionsResult.response.status}`);
  const sessions = sessionsResult.payload?.data ?? sessionsResult.payload ?? [];
  assert(Array.isArray(sessions), 'sessions payload is not an array');

  const standardSession = sessions.find((item) => item.sessionId === standard.sessionId);
  const rememberedSession = sessions.find((item) => item.sessionId === remembered.sessionId);
  assert(standardSession, 'standard session not found in session list');
  assert(rememberedSession, 'remember-me session not found in session list');

  assert(standardSession.isCurrent === false, 'standard session should not be current when listing via remember-me cookie');
  assert(rememberedSession.isCurrent === true, 'remember-me session should be current when listing via remember-me cookie');
  assert(typeof standardSession.mfaVerified === 'boolean', 'standard session mfaVerified should be boolean');
  assert(typeof rememberedSession.mfaVerified === 'boolean', 'remember-me session mfaVerified should be boolean');

  const refreshResult = await callJson('/api/Auth/refresh-token', remembered.cookieHeader, rememberFp, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert(refreshResult.response.ok, `remember-me refresh failed: ${refreshResult.response.status}`);

  const revokeResult = await callJson(`/api/Auth/sessions/${encodeURIComponent(remembered.sessionId)}/revoke`, standard.cookieHeader, standardFp, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert(revokeResult.response.ok, `revoke session failed: ${revokeResult.response.status}`);

  const revokedRefreshResult = await callJson('/api/Auth/refresh-token', remembered.cookieHeader, rememberFp, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert(revokedRefreshResult.response.status === 401, `revoked session refresh should return 401, got ${revokedRefreshResult.response.status}`);

  console.log('[auth-session-smoke] ok: standard and remember-me sessions created');
  console.log('[auth-session-smoke] ok: remember-me session refresh succeeded before revoke');
  console.log('[auth-session-smoke] ok: revoked remember-me session can no longer refresh');
}

main().catch((error) => {
  console.error('[auth-session-smoke] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

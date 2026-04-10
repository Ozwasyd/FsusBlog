#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from './http.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000';
const userName = process.env.FSUSBLOG_USER_USERNAME || '';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD || '';
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || '';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || '';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);

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

function readCookieHeader(response) {
  const values = response.headers.getSetCookie();
  if (!values || values.length === 0) {
    throw new Error('missing set-cookie in login response');
  }

  const pairs = [];
  for (const raw of values) {
    const idx = raw.indexOf(';');
    pairs.push(idx >= 0 ? raw.slice(0, idx) : raw);
  }

  return pairs.join('; ');
}

async function fetchChallenge() {
  const response = await fetchWithTimeout(`${baseUrl}/api/Auth/pow-challenge`, {
    headers: { Accept: 'application/json' }
  }, requestTimeoutMs);
  assert(response.ok, `pow-challenge failed: ${response.status}`);
  const challenge = await response.json();
  return challenge.data ?? challenge;
}

async function loginWithPow(username, password) {
  const challenge = await fetchChallenge();
  const salt = challenge.salt ?? challenge.Salt;
  const difficulty = Number(challenge.difficulty ?? challenge.Difficulty ?? 4);
  const timestamp = Number(challenge.timestamp ?? challenge.Timestamp);
  const signature = challenge.signature ?? challenge.Signature;
  assert(salt && signature, 'invalid challenge payload');

  const browserFp = 'binary-smoke-node';
  const nonce = solvePowNonce(salt, browserFp, difficulty);
  const powHeader = toSafeBase64({
    powSalt: salt,
    powNonce: nonce,
    powTimestamp: timestamp,
    difficulty,
    powSignature: signature,
    browserFp
  });

  const response = await fetchWithTimeout(`${baseUrl}/api/Auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Fsus-Pow-Proof': powHeader
    },
    body: JSON.stringify({ username, password })
  }, requestTimeoutMs);

  assert(response.ok, `login failed: ${response.status}`);
  return readCookieHeader(response);
}

async function checkBinary(path, cookieHeader, expectedStatus = 200) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    headers: {
      Accept: 'application/octet-stream',
      Cookie: cookieHeader
    }
  }, requestTimeoutMs);
  assert(response.status === expectedStatus, `expected status ${expectedStatus}, got ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  assert(contentType.includes('application/octet-stream'), `expected octet-stream, got ${contentType || 'none'}`);
}

async function runUserChecks() {
  if (!userName || !userPassword) {
    console.log('[binary-smoke-auth] skip user checks (missing FSUSBLOG_USER_USERNAME/FSUSBLOG_USER_PASSWORD)');
    return true;
  }

  const cookie = await loginWithPow(userName, userPassword);
  await checkBinary('/api/binary/comment/me?limit=10', cookie, 200);
  console.log('[binary-smoke-auth] ok: user comment/me');
  return true;
}

async function runAdminChecks() {
  if (!adminName || !adminPassword) {
    console.log('[binary-smoke-auth] skip admin checks (missing FSUSBLOG_ADMIN_USERNAME/FSUSBLOG_ADMIN_PASSWORD)');
    return true;
  }

  const cookie = await loginWithPow(adminName, adminPassword);
  await checkBinary('/api/binary/stats', cookie, 200);
  console.log('[binary-smoke-auth] ok: admin stats');
  return true;
}

async function main() {
  await probeReachable(`${baseUrl}/api/Auth/pow-challenge`, '[binary-smoke-auth backend]', requestTimeoutMs);

  const userOk = await runUserChecks();
  const adminOk = await runAdminChecks();
  if (!userOk || !adminOk) {
    process.exit(1);
  }
  console.log('[binary-smoke-auth] completed');
}

main().catch((error) => {
  console.error('[binary-smoke-auth] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readJsonLikeResponse } from '../support/aeds-envelope.mjs';
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../support/http.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000';
const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD || 'BinaryUserPass123!';
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!';
const promoteAdmin = (process.env.FSUSBLOG_PROMOTE_ADMIN ?? '1') !== '0';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);
const deviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'binary-smoke-node';

const pgContainer = process.env.FSUSBLOG_PG_CONTAINER || 'fsusblog-postgres';
const pgUser = process.env.FSUSBLOG_PG_USER || 'fsusblog';
const pgDb = process.env.FSUSBLOG_PG_DB || 'fsusblog';

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

async function registerUser(username, password) {
  const challenge = await fetchChallenge();
  const salt = challenge.salt ?? challenge.Salt;
  const difficulty = Number(challenge.difficulty ?? challenge.Difficulty ?? 4);
  const timestamp = Number(challenge.timestamp ?? challenge.Timestamp);
  const signature = challenge.signature ?? challenge.Signature;
  assert(salt && signature, 'invalid challenge payload');

  const browserFp = deviceFingerprint;
  const nonce = solvePowNonce(salt, browserFp, difficulty);
  const powHeader = toSafeBase64({
    powSalt: salt,
    powNonce: nonce,
    powTimestamp: timestamp,
    difficulty,
    powSignature: signature,
    browserFp
  });

  const response = await fetchWithTimeout(`${baseUrl}/api/Auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Fsus-Pow-Proof': powHeader,
      'X-Fsus-Device-Fp': deviceFingerprint
    },
    body: JSON.stringify({
      username,
      password,
      confirmPassword: password
    })
  }, requestTimeoutMs);

  const payload = await readJsonLikeResponse(response).catch(() => ({}));
  if (response.ok) {
    console.log(`[prepare-auth-users] registered: ${username}`);
    return;
  }

  const message = payload?.message ?? payload?.Message ?? `status ${response.status}`;
  if (String(message).includes('已存在')) {
    console.log(`[prepare-auth-users] exists: ${username}`);
    return;
  }

  throw new Error(`register ${username} failed: ${message}`);
}

function promoteAdminRole(username) {
  const sql = `update sys_user set role='admin' where username='${username}';`;
  const result = spawnSync('docker', [
    'exec',
    '-i',
    pgContainer,
    'psql',
    '-U',
    pgUser,
    '-d',
    pgDb,
    '-c',
    sql
  ], { encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`promote admin failed: ${result.stderr || result.stdout}`);
  }

  console.log(`[prepare-auth-users] promoted admin: ${username}`);
}

async function main() {
  await probeReachable(`${baseUrl}/api/Auth/pow-challenge`, '[prepare-auth-users backend]', requestTimeoutMs);

  await registerUser(userName, userPassword);
  await registerUser(adminName, adminPassword);

  if (promoteAdmin) {
    promoteAdminRole(adminName);
  } else {
    console.log('[prepare-auth-users] skip admin promotion');
  }

  console.log('[prepare-auth-users] done');
  console.log(`[prepare-auth-users] export FSUSBLOG_USER_USERNAME=${userName}`);
  console.log(`[prepare-auth-users] export FSUSBLOG_USER_PASSWORD=${userPassword}`);
  console.log(`[prepare-auth-users] export FSUSBLOG_ADMIN_USERNAME=${adminName}`);
  console.log(`[prepare-auth-users] export FSUSBLOG_ADMIN_PASSWORD=${adminPassword}`);
}

main().catch((error) => {
  console.error('[prepare-auth-users] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

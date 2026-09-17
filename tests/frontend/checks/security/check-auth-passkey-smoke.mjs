#!/usr/bin/env node

import {
  authBinary,
  baseUrl,
  loginWithFixtureSessionBypass,
  requestTimeoutMs
} from '../../support/auth-helpers.mjs';
import { isDirectExecution, reportDirectFailure } from '../../support/direct-execution.mjs';

const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD ?? '';
const deviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'auth-passkey-smoke-node';
const trustedOrigin = process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_DEBUG_FRONTEND_URL || baseUrl;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function describePayload(payload) {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function assertOk(result, message) {
  assert(result.response.ok, `${message}: ${result.response.status} ${describePayload(result.payload)}`);
}

async function cleanupExistingPasskeys(session) {
  // Prevent CI accumulation: binaryuser may already have passkeys from prior runs.
  // List and delete all before the test suite begins so register/begin always succeeds.
  const list = await authBinary('/api/Auth/passkey/credentials', {
    method: 'GET',
    cookieHeader: session.cookieHeader,
    deviceFingerprint
  });
  if (!list.response.ok) return;
  const items = list.payload?.data ?? list.payload;
  if (!Array.isArray(items)) return;
  for (const cred of items) {
    if (typeof cred?.id === 'number') {
      await authBinary(`/api/Auth/passkey/credentials/${cred.id}`, {
        method: 'DELETE',
        cookieHeader: session.cookieHeader,
        deviceFingerprint,
        headers: { Origin: trustedOrigin }
      });
    }
  }
}

export async function runAuthPasskeySmoke() {
  // ── 1. Unauthenticated enforcement: auth-required endpoints must return 401 ──

  const unauthCases = [
    ['GET /api/Auth/passkey/credentials (no auth)', '/api/Auth/passkey/credentials', 'GET', undefined],
    ['POST /api/Auth/passkey/register/begin (no auth)', '/api/Auth/passkey/register/begin', 'POST', {}],
    ['POST /api/Auth/passkey/register/complete (no auth)', '/api/Auth/passkey/register/complete', 'POST', { sessionKey: 'x', attestation: {} }],
    ['DELETE /api/Auth/passkey/credentials/1 (no auth)', '/api/Auth/passkey/credentials/1', 'DELETE', undefined],
    ['PUT /api/Auth/passkey/credentials/1/name (no auth)', '/api/Auth/passkey/credentials/1/name', 'PUT', { name: 'test' }]
  ];

  for (const [label, path, method, body] of unauthCases) {
    const { response } = await authBinary(path, { method, deviceFingerprint, body });
    assert(response.status === 401, `${label}: expected 401, got ${response.status}`);
  }

  // ── 2. Anonymous login/begin must succeed and return a valid challenge ──────

  const loginBeginResult = await authBinary('/api/Auth/passkey/login/begin', {
    method: 'POST',
    deviceFingerprint
  });
  assert(loginBeginResult.response.ok,
    `passkey login/begin must return 2xx, got ${loginBeginResult.response.status}`);

  const loginBeginData = loginBeginResult.payload?.data ?? loginBeginResult.payload;
  assert(
    typeof loginBeginData?.challengeToken === 'string' && loginBeginData.challengeToken.length > 0,
    `passkey login/begin: missing challengeToken (keys: ${Object.keys(loginBeginData ?? {}).join(',')})`
  );
  assert(
    loginBeginData?.options && typeof loginBeginData.options === 'object',
    'passkey login/begin: missing binary-decoded options'
  );

  const loginOptions = loginBeginData.options;
  assert(typeof loginOptions?.challenge === 'string', 'passkey login/begin: options.challenge must be a string');
  assert(Number(loginOptions?.timeout) > 0, 'passkey login/begin: options.timeout must be a positive number');

  // ── 3. login/complete with a completely invalid token must not 2xx or 5xx ──

  const badTokenResult = await authBinary('/api/Auth/passkey/login/complete', {
    method: 'POST',
    deviceFingerprint,
    body: {
      challengeToken: 'ffffffffffffffffffffffffffffffffffffffff',
      assertion: {},
      rememberMe: false
    }
  });
  assert(!badTokenResult.response.ok,
    `passkey login/complete with invalid token must not return 2xx, got ${badTokenResult.response.status}`);
  assert(badTokenResult.response.status < 500,
    `passkey login/complete must not return 5xx, got ${badTokenResult.response.status}`);

  // ── 4. login/complete with a fresh token but malformed assertion body ───────

  const loginBeginResult2 = await authBinary('/api/Auth/passkey/login/begin', {
    method: 'POST',
    deviceFingerprint
  });
  const challengeToken2 = (loginBeginResult2.payload?.data ?? loginBeginResult2.payload)?.challengeToken;
  assert(typeof challengeToken2 === 'string', 'passkey login/begin (second call): missing challengeToken');

  const badAssertionResult = await authBinary('/api/Auth/passkey/login/complete', {
    method: 'POST',
    deviceFingerprint,
    body: {
      challengeToken: challengeToken2,
      assertion: {
        type: 'public-key',
        id: 'notreal',
        rawId: '',
        response: {}
      },
      rememberMe: false
    }
  });
  assert(!badAssertionResult.response.ok,
    `passkey login/complete with bad assertion must fail, got ${badAssertionResult.response.status}`);
  assert(badAssertionResult.response.status < 500,
    `passkey login/complete with bad assertion must not return 5xx, got ${badAssertionResult.response.status}`);

  // ── 5. Authenticated operations ───────────────────────────────────────────

  const session = await loginWithFixtureSessionBypass(userName, userPassword, false, deviceFingerprint, requestTimeoutMs);

  // Pre-cleanup: remove any passkeys accumulated from prior CI runs
  await cleanupExistingPasskeys(session);

  // 5a. credentials list returns 2xx array (may be empty after cleanup)
  const credsResult = await authBinary('/api/Auth/passkey/credentials', {
    method: 'GET',
    cookieHeader: session.cookieHeader,
    deviceFingerprint
  });
  assertOk(credsResult, 'passkey credentials list must return 2xx');
  const credsData = credsResult.payload?.data ?? credsResult.payload;
  assert(Array.isArray(credsData),
    `passkey credentials list must return array, got ${typeof credsData}`);

  // 5b. register/begin returns sessionKey + binary-decoded WebAuthn options
  const regBeginResult = await authBinary('/api/Auth/passkey/register/begin', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    headers: { Origin: trustedOrigin }
  });
  assertOk(regBeginResult, 'passkey register/begin must return 2xx');

  const regBeginData = regBeginResult.payload?.data ?? regBeginResult.payload;
  assert(
    typeof regBeginData?.sessionKey === 'string' && regBeginData.sessionKey.length > 0,
    `passkey register/begin: missing sessionKey (keys: ${Object.keys(regBeginData ?? {}).join(',')})`
  );
  assert(
    regBeginData?.options && typeof regBeginData.options === 'object',
    'passkey register/begin: missing binary-decoded options'
  );

  const regOptions = regBeginData.options;
  assert(typeof regOptions?.challenge === 'string', 'passkey register/begin: options must contain challenge');
  assert(typeof regOptions?.rp?.name === 'string', 'passkey register/begin: options must contain rp.name');
  assert(typeof regOptions?.user?.name === 'string', 'passkey register/begin: options must contain user.name');
  assert(
    regOptions?.authenticatorSelection?.residentKey === 'required',
    `passkey register/begin: authenticatorSelection.residentKey must be "required", got "${regOptions?.authenticatorSelection?.residentKey}"`
  );

  // 5c. register/complete with an expired/invalid sessionKey returns non-2xx, not 5xx
  const expiredSessionResult = await authBinary('/api/Auth/passkey/register/complete', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    headers: { Origin: trustedOrigin },
    body: {
      sessionKey: 'nonexistent-session-key-00000000',
      attestation: {},
      friendlyName: null,
      mfaProofToken: null
    }
  });
  assert(!expiredSessionResult.response.ok,
    `passkey register/complete with invalid session must fail, got ${expiredSessionResult.response.status}`);
  assert(expiredSessionResult.response.status < 500,
    `passkey register/complete with invalid session must not return 5xx, got ${expiredSessionResult.response.status}`);

  // 5d. credential mutation without step-up is rejected before resource lookup
  const deleteResult = await authBinary('/api/Auth/passkey/credentials/999999', {
    method: 'DELETE',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    headers: { Origin: trustedOrigin }
  });
  assert(deleteResult.response.status === 428,
    `passkey delete without step-up must return 428, got ${deleteResult.response.status}`);

  // 5e. credential rename without step-up is rejected before resource lookup
  const renameResult = await authBinary('/api/Auth/passkey/credentials/999999/name', {
    method: 'PUT',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    headers: { Origin: trustedOrigin },
    body: { name: 'Test Name' }
  });
  assert(renameResult.response.status === 428,
    `passkey rename without step-up must return 428, got ${renameResult.response.status}`);

  // 5f. rename with empty string name returns non-2xx, not 5xx
  const renameEmptyResult = await authBinary('/api/Auth/passkey/credentials/999999/name', {
    method: 'PUT',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    headers: { Origin: trustedOrigin },
    body: { name: '' }
  });
  assert(!renameEmptyResult.response.ok,
    `passkey rename with empty name must fail, got ${renameEmptyResult.response.status}`);
  assert(renameEmptyResult.response.status < 500,
    `passkey rename with empty name must not return 5xx, got ${renameEmptyResult.response.status}`);

  console.log(`[check-auth-passkey-smoke] ok | base=${baseUrl}`);
}

if (isDirectExecution(import.meta.url)) {
  runAuthPasskeySmoke().catch((error) => reportDirectFailure('check-auth-passkey-smoke', error));
}

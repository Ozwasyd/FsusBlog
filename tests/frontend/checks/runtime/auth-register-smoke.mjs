#!/usr/bin/env node

import { authBinary, registerWithPow, requestTimeoutMs } from '../../support/auth-helpers.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const randomSuffix = Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
const username = `registersmoke${randomSuffix}`;
const password = 'RegisterSmokePass123!';
const deviceFingerprint = `register-smoke-${Date.now()}`;

async function main() {
  const registered = await registerWithPow(username, password, deviceFingerprint, requestTimeoutMs);
  const flow = registered.payload?.data ?? registered.payload;

  assert(flow?.authPhase === 'authenticated', `register authPhase mismatch: ${flow?.authPhase ?? 'missing'}`);
  assert(typeof flow?.user?.id === 'number' && flow.user.id > 0, 'register response missing user.id');
  assert(flow?.user?.username === username, `register response username mismatch: expected ${username}, got ${flow?.user?.username}`);
  assert(typeof registered.sessionId === 'string' && registered.sessionId.length > 0, 'register response missing session cookie');

  console.log('[auth-register-smoke] ok: register response created authenticated flow');

  const me = await authBinary('/api/Auth/me', {
    method: 'GET',
    cookieHeader: registered.cookieHeader,
    deviceFingerprint,
    timeoutMs: requestTimeoutMs
  });

  assert(me.response.ok, `GET /api/Auth/me after register failed: ${me.response.status}`);
  const user = me.payload?.data ?? me.payload;
  assert(user?.username === username, `GET /api/Auth/me username mismatch: expected ${username}, got ${user?.username}`);

  console.log('[auth-register-smoke] ok: register session can access /api/Auth/me');

  const duplicate = await authBinary('/api/Auth/register', {
    method: 'POST',
    body: {
      username,
      password,
      confirmPassword: password
    },
    requiresPow: true,
    deviceFingerprint: `${deviceFingerprint}-duplicate`,
    timeoutMs: requestTimeoutMs
  });

  assert(duplicate.response.status === 409, `duplicate register should return 409, got ${duplicate.response.status}`);
  const duplicateMessage = duplicate.payload?.message ?? duplicate.payload?.Message ?? '';
  assert(String(duplicateMessage).includes('已'), `duplicate register message should be explicit, got ${duplicateMessage}`);

  console.log('[auth-register-smoke] ok: duplicate register returns explicit conflict');
}

main().catch((error) => {
  console.error('[auth-register-smoke] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

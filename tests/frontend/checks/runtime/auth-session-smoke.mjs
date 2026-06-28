#!/usr/bin/env node
import { authBinary, loginWithFixtureSessionBypass } from '../../support/auth-helpers.mjs';
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:7568';
const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD ?? '';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);
const baseDeviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'auth-session-smoke-node';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function callBinary(path, cookieHeader, deviceFingerprint, init = {}) {
  return await authBinary(path, {
    ...init,
    cookieHeader,
    deviceFingerprint,
    timeoutMs: requestTimeoutMs
  });
}

async function main() {
  await probeReachable(`${baseUrl}/api/binary/auth/pow-challenge`, '[auth-session-smoke backend]', requestTimeoutMs);

  const standardFp = `${baseDeviceFingerprint}-standard`;
  const rememberFp = `${baseDeviceFingerprint}-remember`;

  const standard = await loginWithFixtureSessionBypass(userName, userPassword, false, standardFp, requestTimeoutMs);
  const remembered = await loginWithFixtureSessionBypass(userName, userPassword, true, rememberFp, requestTimeoutMs);

  const sessionsResult = await callBinary('/api/Auth/sessions', remembered.cookieHeader, rememberFp);
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

  const refreshResult = await callBinary('/api/Auth/refresh-token', remembered.cookieHeader, rememberFp, {
    method: 'POST'
  });
  assert(refreshResult.response.ok, `remember-me refresh failed: ${refreshResult.response.status}`);

  const revokeResult = await callBinary(`/api/Auth/sessions/${encodeURIComponent(remembered.sessionId)}/revoke`, standard.cookieHeader, standardFp, {
    method: 'POST'
  });
  assert(revokeResult.response.ok, `revoke session failed: ${revokeResult.response.status}`);

  const revokedRefreshResult = await callBinary('/api/Auth/refresh-token', remembered.cookieHeader, rememberFp, {
    method: 'POST'
  });
  assert(revokedRefreshResult.response.status === 401, `revoked session refresh should return 401, got ${revokedRefreshResult.response.status}`);

  const logoutResult = await callBinary('/api/Auth/logout', standard.cookieHeader, standardFp, {
    method: 'POST'
  });
  assert(logoutResult.response.ok, `logout failed: ${logoutResult.response.status}`);

  console.log('[auth-session-smoke] ok: standard and remember-me sessions created');
  console.log('[auth-session-smoke] ok: remember-me session refresh succeeded before revoke');
  console.log('[auth-session-smoke] ok: revoked remember-me session can no longer refresh');
  console.log('[auth-session-smoke] ok: logout endpoint completes for authenticated session');
}

main().catch((error) => {
  console.error('[auth-session-smoke] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

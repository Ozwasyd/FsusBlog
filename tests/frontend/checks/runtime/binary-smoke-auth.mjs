#!/usr/bin/env node
import { loginWithPow } from '../../support/auth-helpers.mjs';
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:7568';
const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD || 'BinaryUserPass123!';
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);
const deviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'binary-smoke-node';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function checkBinary(path, cookieHeader, expectedStatus = 200) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    headers: {
      Accept: 'application/octet-stream',
      Cookie: cookieHeader,
      'X-Fsus-Device-Fp': deviceFingerprint
    }
  }, requestTimeoutMs);
  assert(response.status === expectedStatus, `expected status ${expectedStatus}, got ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  assert(contentType.includes('application/octet-stream'), `expected octet-stream, got ${contentType || 'none'}`);
}

async function runUserChecks() {
  const { cookieHeader: cookie } = await loginWithPow(userName, userPassword, false, deviceFingerprint, requestTimeoutMs);
  await checkBinary('/api/binary/comment/me?limit=10', cookie, 200);
  console.log('[binary-smoke-auth] ok: user comment/me');
  return true;
}

async function runAdminChecks() {
  const { cookieHeader: cookie } = await loginWithPow(adminName, adminPassword, false, deviceFingerprint, requestTimeoutMs);
  await checkBinary('/api/binary/stats', cookie, 200);
  console.log('[binary-smoke-auth] ok: admin stats');
  return true;
}

async function main() {
  await probeReachable(`${baseUrl}/api/binary/auth/pow-challenge`, '[binary-smoke-auth backend]', requestTimeoutMs);

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

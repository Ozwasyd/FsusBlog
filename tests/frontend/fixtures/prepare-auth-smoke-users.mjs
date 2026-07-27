#!/usr/bin/env node
// fixture-catalog: consumer auth-smoke-fixture auth-basic
import { persistAuthFixtureManifest, prepareAuthSmokeFixtures } from '../support/session-fixtures.mjs';
import { probeReachable, parseTimeoutMs } from '../support/http.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:7568';
const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);
const deviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'binary-smoke-node';

async function main() {
  await probeReachable(`${baseUrl}/api/binary/auth/pow-challenge`, '[prepare-auth-users backend]', requestTimeoutMs);

  const fixtures = await prepareAuthSmokeFixtures({
    userHandle: userName,
    adminHandle: adminName,
    deviceFingerprint
  });
  const manifest = fixtures.manifest ?? await persistAuthFixtureManifest({
    user: fixtures.user,
    admin: fixtures.admin
  });

  console.log('[prepare-auth-users] done');
  console.log(`[prepare-auth-users] prepared anonymous account fixture: ${userName} (id=${fixtures.user.userId})`);
  console.log(`[prepare-auth-users] prepared admin principal fixture: ${adminName} (id=${fixtures.admin.adminId})`);
  if (manifest) {
    console.log('[prepare-auth-users] wrote namespaced persistent fixture storage states');
  }
}

main().catch((error) => {
  console.error('[prepare-auth-users] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

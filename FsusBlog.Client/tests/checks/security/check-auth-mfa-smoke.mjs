#!/usr/bin/env node

import {
  authJson,
  baseUrl,
  createTotp,
  loginWithPow,
  requestTimeoutMs
} from '../../support/auth-helpers.mjs';

const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD || 'BinaryUserPass123!';
const deviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'auth-mfa-smoke-node';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const session = await loginWithPow(userName, userPassword, false, deviceFingerprint, requestTimeoutMs);

  const startSetup = await authJson('/api/Auth/mfa/setup/start', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint
  });
  assert(startSetup.response.ok, `mfa setup start failed: ${startSetup.response.status}`);
  const setupData = startSetup.payload?.data ?? startSetup.payload;
  assert(typeof setupData?.secret === 'string' && setupData.secret.length > 0, 'mfa setup secret missing');

  const setupCode = createTotp(setupData.secret);
  const verifySetup = await authJson('/api/Auth/mfa/setup/verify', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    body: { code: setupCode }
  });
  assert(verifySetup.response.ok, `mfa setup verify failed: ${verifySetup.response.status}`);
  const verifyData = verifySetup.payload?.data ?? verifySetup.payload;
  assert(Array.isArray(verifyData?.recoveryCodes) && verifyData.recoveryCodes.length > 0, 'mfa recovery codes missing after setup');

  const profileEnabled = await authJson('/api/Auth/mfa/profile', {
    method: 'GET',
    cookieHeader: session.cookieHeader,
    deviceFingerprint
  });
  assert(profileEnabled.response.ok, `mfa profile failed: ${profileEnabled.response.status}`);
  assert((profileEnabled.payload?.data ?? profileEnabled.payload)?.enabled === true, 'mfa profile should be enabled after setup');

  const startChallenge = await authJson('/api/Auth/mfa/challenge/start', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    body: { action: 'security_smoke' }
  });
  assert(startChallenge.response.ok, `mfa challenge start failed: ${startChallenge.response.status}`);
  const challengeData = startChallenge.payload?.data ?? startChallenge.payload;
  assert(challengeData?.verified === false, 'mfa challenge should require verification while enabled');
  assert(typeof challengeData?.proofToken === 'string' && challengeData.proofToken.length > 0, 'mfa challenge token missing');

  const badChallenge = await authJson('/api/Auth/mfa/challenge', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    body: { challengeToken: challengeData.proofToken, code: '000000', action: 'security_smoke' }
  });
  assert(!badChallenge.response.ok, 'mfa challenge with invalid code should fail');

  const verifyChallenge = await authJson('/api/Auth/mfa/challenge', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    body: {
      challengeToken: challengeData.proofToken,
      code: createTotp(setupData.secret),
      action: 'security_smoke'
    }
  });
  assert(verifyChallenge.response.ok, `mfa challenge verify failed: ${verifyChallenge.response.status}`);
  const challengeResult = verifyChallenge.payload?.data ?? verifyChallenge.payload;
  assert(challengeResult?.verified === true, 'mfa challenge should verify with valid totp');

  const regenRecovery = await authJson('/api/Auth/mfa/recovery/regenerate', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    body: {
      password: userPassword,
      code: createTotp(setupData.secret)
    }
  });
  assert(regenRecovery.response.ok, `mfa recovery regenerate failed: ${regenRecovery.response.status}`);
  const recoveryData = regenRecovery.payload?.data ?? regenRecovery.payload;
  assert(Array.isArray(recoveryData?.recoveryCodes) && recoveryData.recoveryCodes.length > 0, 'regenerated recovery codes missing');

  const disableMfa = await authJson('/api/Auth/mfa/disable', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    body: {
      password: userPassword,
      recoveryCode: recoveryData.recoveryCodes[0]
    }
  });
  assert(disableMfa.response.ok, `mfa disable failed: ${disableMfa.response.status}`);

  const profileDisabled = await authJson('/api/Auth/mfa/profile', {
    method: 'GET',
    cookieHeader: session.cookieHeader,
    deviceFingerprint
  });
  assert(profileDisabled.response.ok, `mfa profile after disable failed: ${profileDisabled.response.status}`);
  assert((profileDisabled.payload?.data ?? profileDisabled.payload)?.enabled === false, 'mfa profile should be disabled after teardown');

  console.log(`[check-auth-mfa-smoke] ok | base=${baseUrl}`);
}

main().catch((error) => {
  console.error('[check-auth-mfa-smoke] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

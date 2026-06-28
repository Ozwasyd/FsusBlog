#!/usr/bin/env node

import {
  authBinary,
  baseUrl,
  createTotp,
  loginWithFixtureSessionBypass,
  requestTimeoutMs
} from '../../support/auth-helpers.mjs';

const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD ?? '';
const deviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'auth-mfa-smoke-node';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function mintMfaProof({ action, cookieHeader, code, recoveryCode }) {
  const start = await authBinary('/api/Auth/mfa/challenge/start', {
    method: 'POST',
    cookieHeader,
    deviceFingerprint,
    body: { action }
  });
  assert(start.response.ok, `mfa ${action} challenge start failed: ${start.response.status}`);
  const challenge = start.payload?.data ?? start.payload;
  assert(challenge?.verified === false, `mfa ${action} challenge should require verification`);
  assert(typeof challenge?.proofToken === 'string' && challenge.proofToken.length > 0, `mfa ${action} challenge token missing`);

  const verify = await authBinary('/api/Auth/mfa/challenge', {
    method: 'POST',
    cookieHeader,
    deviceFingerprint,
    body: {
      challengeToken: challenge.proofToken,
      action,
      code,
      recoveryCode
    }
  });
  assert(verify.response.ok, `mfa ${action} challenge verify failed: ${verify.response.status}`);
  const result = verify.payload?.data ?? verify.payload;
  assert(result?.verified === true, `mfa ${action} challenge should verify`);
  assert(typeof result?.proofToken === 'string' && result.proofToken.length > 0, `mfa ${action} proof token missing`);
  return result.proofToken;
}

async function main() {
  const session = await loginWithFixtureSessionBypass(userName, userPassword, false, deviceFingerprint, requestTimeoutMs);

  const startSetup = await authBinary('/api/Auth/mfa/setup/start', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint
  });
  assert(startSetup.response.ok, `mfa setup start failed: ${startSetup.response.status}`);
  const setupData = startSetup.payload?.data ?? startSetup.payload;
  assert(typeof setupData?.secret === 'string' && setupData.secret.length > 0, 'mfa setup secret missing');

  const setupCode = createTotp(setupData.secret);
  const verifySetup = await authBinary('/api/Auth/mfa/setup/verify', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    body: { code: setupCode }
  });
  assert(verifySetup.response.ok, `mfa setup verify failed: ${verifySetup.response.status}`);
  const verifyData = verifySetup.payload?.data ?? verifySetup.payload;
  assert(Array.isArray(verifyData?.recoveryCodes) && verifyData.recoveryCodes.length > 0, 'mfa recovery codes missing after setup');

  const profileEnabled = await authBinary('/api/Auth/mfa/profile', {
    method: 'GET',
    cookieHeader: session.cookieHeader,
    deviceFingerprint
  });
  assert(profileEnabled.response.ok, `mfa profile failed: ${profileEnabled.response.status}`);
  assert((profileEnabled.payload?.data ?? profileEnabled.payload)?.enabled === true, 'mfa profile should be enabled after setup');

  const startChallenge = await authBinary('/api/Auth/mfa/challenge/start', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    body: { action: 'security_smoke' }
  });
  assert(startChallenge.response.ok, `mfa challenge start failed: ${startChallenge.response.status}`);
  const challengeData = startChallenge.payload?.data ?? startChallenge.payload;
  assert(challengeData?.verified === false, 'mfa challenge should require verification while enabled');
  assert(typeof challengeData?.proofToken === 'string' && challengeData.proofToken.length > 0, 'mfa challenge token missing');

  const badChallenge = await authBinary('/api/Auth/mfa/challenge', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    body: { challengeToken: challengeData.proofToken, code: '000000', action: 'security_smoke' }
  });
  assert(!badChallenge.response.ok, 'mfa challenge with invalid code should fail');

  const verifyChallenge = await authBinary('/api/Auth/mfa/challenge', {
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

  const regenerateProofToken = await mintMfaProof({
    action: 'mfa_recovery_regenerate',
    cookieHeader: session.cookieHeader,
    code: createTotp(setupData.secret)
  });

  const regenRecovery = await authBinary('/api/Auth/mfa/recovery/regenerate', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    headers: { 'X-Fsus-Mfa-Proof': regenerateProofToken }
  });
  assert(regenRecovery.response.ok, `mfa recovery regenerate failed: ${regenRecovery.response.status}`);
  const recoveryData = regenRecovery.payload?.data ?? regenRecovery.payload;
  assert(Array.isArray(recoveryData?.recoveryCodes) && recoveryData.recoveryCodes.length > 0, 'regenerated recovery codes missing');

  const disableProofToken = await mintMfaProof({
    action: 'mfa_disable',
    cookieHeader: session.cookieHeader,
    recoveryCode: recoveryData.recoveryCodes[0]
  });

  const disableMfa = await authBinary('/api/Auth/mfa/disable', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    headers: { 'X-Fsus-Mfa-Proof': disableProofToken }
  });
  assert(disableMfa.response.ok, `mfa disable failed: ${disableMfa.response.status}`);

  const profileDisabled = await authBinary('/api/Auth/mfa/profile', {
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

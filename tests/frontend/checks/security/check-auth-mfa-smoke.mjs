#!/usr/bin/env node

import {
  authBinary,
  baseUrl,
  createTotp,
  loginWithFixtureSessionBypass,
  requestTimeoutMs
} from '../../support/auth-helpers.mjs';
import { encodeAedsFrame, encodeMfaPasswordProofRequest } from '../../support/aeds-envelope.mjs';

const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD ?? '';
const deviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'auth-mfa-smoke-node';
const trustedOrigin = process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_DEBUG_FRONTEND_URL || baseUrl;
const anonymousMfaMutationBody = encodeAedsFrame(
  53,
  encodeMfaPasswordProofRequest({ password: '', code: '', recoveryCode: '' })
);

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

async function mintMfaProof({ action, cookieHeader, code, recoveryCode }) {
  const start = await authBinary('/api/Auth/mfa/challenge/start', {
    method: 'POST',
    cookieHeader,
    deviceFingerprint,
    headers: { Origin: trustedOrigin },
    body: { action }
  });
  assertOk(start, `mfa ${action} challenge start failed`);
  const challenge = start.payload?.data ?? start.payload;
  if (challenge?.verified === true) {
    assert(typeof challenge?.proofToken === 'string' && challenge.proofToken.length > 0, `mfa ${action} immediate proof token missing`);
    return challenge.proofToken;
  }

  assert(challenge?.verified === false, `mfa ${action} challenge should require verification`);
  assert(typeof challenge?.proofToken === 'string' && challenge.proofToken.length > 0, `mfa ${action} challenge token missing`);

  const verify = await authBinary('/api/Auth/mfa/challenge', {
    method: 'POST',
    cookieHeader,
    deviceFingerprint,
    headers: { Origin: trustedOrigin },
    body: {
      challengeToken: challenge.proofToken,
      action,
      code,
      recoveryCode
    }
  });
  assertOk(verify, `mfa ${action} challenge verify failed`);
  const result = verify.payload?.data ?? verify.payload;
  assert(result?.verified === true, `mfa ${action} challenge should verify`);
  assert(typeof result?.proofToken === 'string' && result.proofToken.length > 0, `mfa ${action} proof token missing`);
  return result.proofToken;
}

async function main() {
  const session = await loginWithFixtureSessionBypass(userName, userPassword, false, deviceFingerprint, requestTimeoutMs);

  const setupProofToken = await mintMfaProof({
    action: 'mfa_setup',
    cookieHeader: session.cookieHeader
  });
  let startSetup = await authBinary('/api/Auth/mfa/setup/start', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    headers: { Origin: trustedOrigin, 'Content-Type': 'application/octet-stream', 'X-Fsus-Mfa-Proof': setupProofToken },
    body: anonymousMfaMutationBody
  });
  if (!startSetup.response.ok) {
    const rebindProofToken = await mintMfaProof({
      action: 'mfa_setup_rebind',
      cookieHeader: session.cookieHeader
    });
    startSetup = await authBinary('/api/Auth/mfa/setup/start', {
      method: 'POST',
      cookieHeader: session.cookieHeader,
      deviceFingerprint,
      headers: { Origin: trustedOrigin, 'Content-Type': 'application/octet-stream', 'X-Fsus-Mfa-Proof': rebindProofToken },
      body: anonymousMfaMutationBody
    });
  }
  assertOk(startSetup, 'mfa setup start failed');
  const setupData = startSetup.payload?.data ?? startSetup.payload;
  assert(typeof setupData?.secret === 'string' && setupData.secret.length > 0, 'mfa setup secret missing');

  const setupCode = createTotp(setupData.secret);
  const verifySetup = await authBinary('/api/Auth/mfa/setup/verify', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    headers: { Origin: trustedOrigin },
    body: { code: setupCode }
  });
  assertOk(verifySetup, 'mfa setup verify failed');
  const verifyData = verifySetup.payload?.data ?? verifySetup.payload;
  assert(Array.isArray(verifyData?.recoveryCodes) && verifyData.recoveryCodes.length > 0, 'mfa recovery codes missing after setup');

  const profileEnabled = await authBinary('/api/Auth/mfa/profile', {
    method: 'GET',
    cookieHeader: session.cookieHeader,
    deviceFingerprint
  });
  assertOk(profileEnabled, 'mfa profile failed');
  assert((profileEnabled.payload?.data ?? profileEnabled.payload)?.enabled === true, 'mfa profile should be enabled after setup');

  const startChallenge = await authBinary('/api/Auth/mfa/challenge/start', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    headers: { Origin: trustedOrigin },
    body: { action: 'security_smoke' }
  });
  assertOk(startChallenge, 'mfa challenge start failed');
  const challengeData = startChallenge.payload?.data ?? startChallenge.payload;
  assert(challengeData?.verified === false, 'mfa challenge should require verification while enabled');
  assert(typeof challengeData?.proofToken === 'string' && challengeData.proofToken.length > 0, 'mfa challenge token missing');

  const badChallenge = await authBinary('/api/Auth/mfa/challenge', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    headers: { Origin: trustedOrigin },
    body: { challengeToken: challengeData.proofToken, code: '000000', action: 'security_smoke' }
  });
  assert(!badChallenge.response.ok, 'mfa challenge with invalid code should fail');

  const verifyChallenge = await authBinary('/api/Auth/mfa/challenge', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    headers: { Origin: trustedOrigin },
    body: {
      challengeToken: challengeData.proofToken,
      code: createTotp(setupData.secret),
      action: 'security_smoke'
    }
  });
  assertOk(verifyChallenge, 'mfa challenge verify failed');
  const challengeResult = verifyChallenge.payload?.data ?? verifyChallenge.payload;
  assert(challengeResult?.verified === true, 'mfa challenge should verify with valid totp');

  const regenerateProofToken = await mintMfaProof({
    action: 'mfa_recovery_regenerate',
    cookieHeader: session.cookieHeader,
    recoveryCode: verifyData.recoveryCodes[0]
  });

  const regenRecovery = await authBinary('/api/Auth/mfa/recovery/regenerate', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    headers: { Origin: trustedOrigin, 'Content-Type': 'application/octet-stream', 'X-Fsus-Mfa-Proof': regenerateProofToken },
    body: anonymousMfaMutationBody
  });
  assertOk(regenRecovery, 'mfa recovery regenerate failed');
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
    headers: { Origin: trustedOrigin, 'Content-Type': 'application/octet-stream', 'X-Fsus-Mfa-Proof': disableProofToken },
    body: anonymousMfaMutationBody
  });
  assertOk(disableMfa, 'mfa disable failed');

  const profileDisabled = await authBinary('/api/Auth/mfa/profile', {
    method: 'GET',
    cookieHeader: session.cookieHeader,
    deviceFingerprint
  });
  assertOk(profileDisabled, 'mfa profile after disable failed');
  assert((profileDisabled.payload?.data ?? profileDisabled.payload)?.enabled === false, 'mfa profile should be disabled after teardown');

  console.log(`[check-auth-mfa-smoke] ok | base=${baseUrl}`);
}

main().catch((error) => {
  console.error('[check-auth-mfa-smoke] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

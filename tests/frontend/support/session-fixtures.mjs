#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const CLAIM_NAME_IDENTIFIER = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier';
const CLAIM_NAME = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name';
const ACCOUNT_SUBJECT_HASH_CLAIM = 'account_subject_hash';
const ACCOUNT_SUBJECT_HASH_PREFIX = 'fsus:account-subject:v1';
const ANONYMOUS_ACCOUNT_KIND = 'anonymous_account';
const ADMIN_PRINCIPAL_KIND = 'admin_principal';
const ADMIN_PERMISSION_CLAIM = 'admin_permission';

const defaultAdminPermissions = [
  'article.write',
  'article.publish',
  'comment.moderate',
  'anonymous.comment.configure',
  'anonymous.nullifier.block',
  'anonymous.credential.revoke',
  'audit.read',
  'system.config',
  'admin.manage'
];

const pgContainer = process.env.FSUSBLOG_PG_CONTAINER || 'fsusblog-postgres';
const pgUser = process.env.FSUSBLOG_PG_USER || 'fsusblog';
const pgDb = process.env.FSUSBLOG_PG_DB || 'fsusblog';
const testSession = process.env.FSUSBLOG_TEST_SESSION || '';

const jwtSecret = process.env.Jwt__SecretKey
  || process.env.JWT_SECRET
  || process.env.FSUSBLOG_JWT_SECRET
  || 'local-dev-secret-key-32-chars-min-aaaaaa';
const jwtIssuer = process.env.Jwt__Issuer
  || process.env.FSUSBLOG_JWT_ISSUER
  || 'fsusblog-dev';
const jwtAudience = process.env.Jwt__Audience
  || process.env.FSUSBLOG_JWT_AUDIENCE
  || 'fsusblog-client';
const accessTokenExpiresMinutes = Number.parseInt(
  process.env.Jwt__AccessTokenExpiresMinutes
  || process.env.FSUSBLOG_JWT_ACCESS_TOKEN_EXPIRES_MINUTES
  || '15',
  10
) || 15;

function sessionSchema() {
  if (!testSession) {
    return '';
  }

  return `fsus_e2e_${testSession.replaceAll('-', '_')}`;
}

function sqlString(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

function searchPathSql() {
  const schema = sessionSchema();
  return schema ? `set search_path to "${schema}", public;` : '';
}

function runPsql(sql) {
  const result = spawnSync('docker', [
    'exec',
    '-i',
    pgContainer,
    'psql',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    pgUser,
    '-d',
    pgDb,
    '-c',
    `${searchPathSql()} ${sql}`
  ], { encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`psql fixture command failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout.trim();
}

function runPsqlNumber(sql, description) {
  const output = runPsql(sql);
  const match = output.match(/^\s*(\d+)\s*$/mu);
  const value = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`failed to read ${description}: ${output || 'empty psql output'}`);
  }

  return value;
}

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase();
}

function signJwt(payload) {
  const header = {
    alg: 'HS256',
    typ: 'JWT'
  };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', jwtSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  return `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`;
}

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function expiresAtEpochSeconds() {
  return nowEpochSeconds() + accessTokenExpiresMinutes * 60;
}

function accountSubjectHash(identityKind, subject) {
  const normalizedKind = String(identityKind || ANONYMOUS_ACCOUNT_KIND).trim();
  const normalizedSubject = String(subject || '').trim().toLowerCase();
  return createHash('sha256')
    .update(`${ACCOUNT_SUBJECT_HASH_PREFIX}:${normalizedKind}:${normalizedSubject}`, 'utf8')
    .digest('hex');
}

function randomToken(byteLength = 32) {
  return randomBytes(byteLength).toString('base64url');
}

function randomSessionId() {
  return randomBytes(16).toString('hex').toUpperCase();
}

function buildUserCookieHeader({ accessToken, refreshToken, sessionId }) {
  return [
    `__Host-AccessToken=${accessToken}`,
    `__Host-RefreshToken=${refreshToken}`,
    `__Host-SessionId=${sessionId}`,
    `AccessToken=${accessToken}`,
    `RefreshToken=${refreshToken}`,
    `SessionId=${sessionId}`
  ].join('; ');
}

function buildAdminCookieHeader({ accessToken, sessionId }) {
  return [
    `__Host-AdminAccessToken=${accessToken}`,
    `__Host-AdminSessionId=${sessionId}`,
    `AdminAccessToken=${accessToken}`,
    `AdminSessionId=${sessionId}`
  ].join('; ');
}

export function isFixtureAdminHandle(handle) {
  const normalized = String(handle || '').trim().toLowerCase();
  const expected = String(process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin').trim().toLowerCase();
  return normalized === expected || normalized.startsWith('admin');
}

export async function ensureUserFixtureSession({
  handle,
  rememberMe = false,
  deviceFingerprint = 'binary-smoke-node'
}) {
  const normalizedHandle = String(handle || 'binaryuser').trim() || 'binaryuser';
  const userId = runPsqlNumber(`
WITH existing AS (
  SELECT id
  FROM sys_user
  WHERE public_handle = ${sqlString(normalizedHandle)}
    AND deleted_at IS NULL
  ORDER BY id
  LIMIT 1
),
inserted AS (
  INSERT INTO sys_user (
    public_handle,
    identity_kind,
    passkey_enabled,
    recovery_enabled,
    privacy_initialized_at,
    anonymous_credential_level,
    anonymous_credential_status,
    status,
    createtime,
    mfaenabled,
    riskflags
  )
  SELECT
    ${sqlString(normalizedHandle)},
    ${sqlString(ANONYMOUS_ACCOUNT_KIND)},
    false,
    false,
    now(),
    'basic',
    'active',
    0,
    now(),
    false,
    0
  WHERE NOT EXISTS (SELECT 1 FROM existing)
  RETURNING id
)
SELECT id FROM inserted
UNION ALL
SELECT id FROM existing
LIMIT 1;
`, `fixture user ${normalizedHandle}`);

  const sessionId = randomSessionId();
  const refreshToken = randomToken();
  const accessToken = signJwt({
    [CLAIM_NAME_IDENTIFIER]: String(userId),
    identity_kind: ANONYMOUS_ACCOUNT_KIND,
    [ACCOUNT_SUBJECT_HASH_CLAIM]: accountSubjectHash(ANONYMOUS_ACCOUNT_KIND, normalizedHandle),
    sid: sessionId,
    mfa: '0',
    iss: jwtIssuer,
    aud: jwtAudience,
    iat: nowEpochSeconds(),
    nbf: nowEpochSeconds(),
    exp: expiresAtEpochSeconds()
  });

  runPsql(`
INSERT INTO sys_user_session (
  sessionid,
  userid,
  refreshtokenhash,
  devicefingerprint,
  lastip,
  useragent,
  createdat,
  lastseenat,
  idleexpiresat,
  absoluteexpiresat,
  revokedat,
  revokereason,
  mfaverified,
  rememberme
)
VALUES (
  ${sqlString(sessionId)},
  ${userId},
  ${sqlString(sha256Hex(refreshToken))},
  ${sqlString(deviceFingerprint)},
  '127.0.0.1',
  'fsusblog-test-session-fixture',
  now(),
  now(),
  now() + interval '${rememberMe ? '30 days' : '2 hours'}',
  now() + interval '30 days',
  NULL,
  NULL,
  false,
  ${rememberMe ? 'true' : 'false'}
)
ON CONFLICT (sessionid) DO NOTHING;
`);

  return {
    kind: 'user',
    userId,
    sessionId,
    accessToken,
    refreshToken,
    cookieHeader: buildUserCookieHeader({ accessToken, refreshToken, sessionId })
  };
}

export async function ensureAdminFixtureSession({
  handle,
  rememberMe = false,
  deviceFingerprint = 'binary-smoke-node'
}) {
  void rememberMe;
  const normalizedHandle = String(handle || 'binaryadmin').trim() || 'binaryadmin';
  const permissions = defaultAdminPermissions.join('\n');
  const adminId = runPsqlNumber(`
INSERT INTO admin_principal (
  handle,
  displayname,
  status,
  isroot,
  permissions,
  createdatutc,
  lastloginatutc,
  totpenabled,
  totpsecretencrypted,
  totpverifiedatutc
)
VALUES (
  ${sqlString(normalizedHandle)},
  ${sqlString('Local fixture admin')},
  'active',
  false,
  ${sqlString(permissions)},
  now(),
  now(),
  false,
  NULL,
  NULL
)
ON CONFLICT (handle) DO UPDATE SET
  displayname = EXCLUDED.displayname,
  status = 'active',
  permissions = EXCLUDED.permissions,
  lastloginatutc = now()
RETURNING id;
`, `fixture admin ${normalizedHandle}`);

  const sessionId = randomSessionId();
  const accessToken = signJwt({
    [CLAIM_NAME_IDENTIFIER]: String(adminId),
    [CLAIM_NAME]: normalizedHandle,
    identity_kind: ADMIN_PRINCIPAL_KIND,
    admin_id: String(adminId),
    admin_handle: normalizedHandle,
    admin_sid: sessionId,
    sid: sessionId,
    admin_step_up: '1',
    mfa: '1',
    [ADMIN_PERMISSION_CLAIM]: defaultAdminPermissions,
    iss: jwtIssuer,
    aud: jwtAudience,
    iat: nowEpochSeconds(),
    nbf: nowEpochSeconds(),
    exp: expiresAtEpochSeconds()
  });

  runPsql(`
INSERT INTO admin_session (
  sessionid,
  adminprincipalid,
  accesstokenhash,
  devicefingerprint,
  lastip,
  useragent,
  createdatutc,
  lastseenatutc,
  idleexpiresatutc,
  absoluteexpiresatutc,
  revokedatutc,
  revokereason,
  stepupverified
)
VALUES (
  ${sqlString(sessionId)},
  ${adminId},
  ${sqlString(sha256Hex(accessToken))},
  ${sqlString(deviceFingerprint)},
  '127.0.0.1',
  'fsusblog-test-session-fixture',
  now(),
  now(),
  now() + interval '2 hours',
  now() + interval '12 hours',
  NULL,
  NULL,
  true
)
ON CONFLICT (sessionid) DO NOTHING;
`);

  return {
    kind: 'admin',
    adminId,
    sessionId,
    accessToken,
    cookieHeader: buildAdminCookieHeader({ accessToken, sessionId })
  };
}

export async function prepareAuthSmokeFixtures({
  userHandle = 'binaryuser',
  adminHandle = 'binaryadmin',
  deviceFingerprint = 'binary-smoke-node'
} = {}) {
  const user = await ensureUserFixtureSession({
    handle: userHandle,
    rememberMe: false,
    deviceFingerprint
  });
  const admin = await ensureAdminFixtureSession({
    handle: adminHandle,
    rememberMe: false,
    deviceFingerprint
  });

  return { user, admin };
}

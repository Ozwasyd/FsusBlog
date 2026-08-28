#!/usr/bin/env node
// fixture-catalog: consumer auth-session-runtime auth-basic
// fixture-catalog: producer security-state

import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
    playwrightSessionModes,
    resolveAuthFixtureDirectory,
    resolvePlaywrightSessionMode
} from './fixture-paths.mjs';
import { resolveTestSession } from './test-session.mjs';
import {
    loadResolvedTemporalRoles,
    requireResolvedTemporalRole
} from '../../../tools/test/temporal-role-resolver.mjs';

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

const pgContainer = process.env.FSUSBLOG_PG_CONTAINER || '';
const pgUser = process.env.FSUSBLOG_PG_USER || 'fsusblog';
const pgDb = process.env.FSUSBLOG_PG_DB || 'fsusblog';
const testSession = resolveTestSession();
const playwrightSessionMode = resolvePlaywrightSessionMode();
const persistAuthFixtures = process.env.FSUSBLOG_PERSIST_AUTH_FIXTURES !== '0';
const redisContainer = process.env.FSUSBLOG_REDIS_CONTAINER || process.env.FSUSBLOG_REDIS_CONTAINER_NAME || '';

const jwtSecret = process.env.Jwt__SecretKey
  || process.env.JWT_SECRET
  || process.env.FSUSBLOG_JWT_SECRET
  || process.env.FSUSBLOG_TEST_SESSION_SECRET
  || '';
const jwtIssuer = process.env.Jwt__Issuer
  || process.env.FSUSBLOG_JWT_ISSUER
  || 'fsusblog-dev';
const jwtAudience = process.env.Jwt__Audience
  || process.env.FSUSBLOG_JWT_AUDIENCE
  || 'fsusblog-client';
const jwtKeyVersion = process.env.Jwt__KeyVersion || '';
const anonymousCredentialSubjectHashPepper = process.env.AnonymousCredentialIssuer__SubjectHashPepper
  || process.env.FSUSBLOG_DEV_ANONYMOUS_SUBJECT_HASH_PEPPER
  || '';
const resetAnonymousCredentialIssuanceFixture = process.env.FSUSBLOG_RESET_ANONYMOUS_ISSUANCE_FIXTURE !== '0';

function schemaForSession(session)
{
    if (!session)
    {
        return '';
    }
    const normalized = String(session).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/u.test(normalized))
    {
        throw new Error('fixture session schema requires a sanitized test session id');
    }
    return `fsus_e2e_${normalized.replaceAll('-', '_')}`;
}

function sqlString(value)
{
    return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

export function fixtureSessionSearchPathSql({
    session = testSession,
    mode = playwrightSessionMode
} = {})
{
    const schema = schemaForSession(session);
    if (mode === playwrightSessionModes.browserContract)
    {
        if (!schema)
        {
            throw new Error('browser-contract fixtures require one explicit FSUSBLOG_TEST_SESSION schema');
        }
        return `set search_path to "${schema}";`;
    }
    return schema ? `set search_path to "${schema}", public;` : '';
}

function assertSafeFixtureContainer()
{
    if (!/^fsusblog-(?:dev|test|ci)(?:[-_.a-zA-Z0-9]*)$/.test(pgContainer))
    {
        throw new Error('FSUSBLOG_PG_CONTAINER must name a dev/test/ci fixture container before SQL fixtures can run.');
    }
}

function assertTestJwtSecretConfigured()
{
    if (jwtSecret.length < 32)
    {
        throw new Error('FSUSBLOG_TEST_SESSION_SECRET or Jwt__SecretKey must be set to a test-only secret with at least 32 characters.');
    }
    if (!jwtKeyVersion)
    {
        throw new Error('Jwt__KeyVersion must be set so fixture tokens carry the same signing key id as the test backend.');
    }
}

function runPsql(sql)
{
    assertSafeFixtureContainer();
    assertTestJwtSecretConfigured();
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
        `${fixtureSessionSearchPathSql()} ${sql}`
    ], { encoding: 'utf8' });

    if (result.status !== 0)
    {
        throw new Error(`psql fixture command failed: ${result.stderr || result.stdout}`);
    }

    return result.stdout.trim();
}

function runPsqlNumber(sql, description)
{
    const output = runPsql(sql);
    const match = output.match(/^\s*(\d+)\s*$/mu);
    const value = match ? Number(match[1]) : Number.NaN;
    if (!Number.isFinite(value) || value <= 0)
    {
        throw new Error(`failed to read ${description}: ${output || 'empty psql output'}`);
    }

    return value;
}

function runRedisCli(args, description)
{
    if (!/^fsusblog-(?:dev|test|ci)(?:[-_.a-zA-Z0-9]*)$/.test(redisContainer))
    {
        throw new Error('FSUSBLOG_REDIS_CONTAINER must name a dev/test/ci fixture container before Redis fixtures can run.');
    }

    const result = spawnSync('docker', [
        'exec',
        redisContainer,
        'redis-cli',
        ...args
    ], { encoding: 'utf8' });

    if (result.status !== 0)
    {
        throw new Error(`${description} redis fixture command failed: ${result.stderr || result.stdout}`);
    }

    return result.stdout.trim();
}

function clearFixtureUserBanCache(handle)
{
    if (!redisContainer)
    {
        return;
    }

    const subjectHash = accountSubjectHash(ANONYMOUS_ACCOUNT_KIND, handle);
    const key = `fsus:sec:blacklist-user:account:${subjectHash}`;
    runRedisCli(['DEL', key, runtimeCacheKey(key)], `clear fixture user ban cache ${handle}`);
}

function base64Url(input)
{
    return Buffer.from(input)
        .toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '');
}

function sha256Hex(value)
{
    return createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase();
}

function signJwt(payload)
{
    assertTestJwtSecretConfigured();
    const header = {
        alg: 'HS256',
        kid: jwtKeyVersion,
        typ: 'JWT'
    };
    const encodedHeader = base64Url(JSON.stringify(header));
    const encodedPayload = base64Url(JSON.stringify(payload));
    const signature = createHmac('sha256', jwtSecret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest();
    return `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`;
}

let loadedTemporalArtifact;
let loadedTemporalArtifactDigest;

function resolvedTemporalArtifact()
{
    const digest = String(process.env.FSUSBLOG_TEMPORAL_ROLE_ARTIFACT_DIGEST ?? '').trim();
    if (!loadedTemporalArtifact || loadedTemporalArtifactDigest !== digest)
    {
        loadedTemporalArtifact = loadResolvedTemporalRoles();
        loadedTemporalArtifactDigest = loadedTemporalArtifact.contentDigest;
    }
    return loadedTemporalArtifact;
}

function temporalRole(roleId)
{
    return requireResolvedTemporalRole(resolvedTemporalArtifact(), roleId);
}

function temporalRoleEpochSeconds(roleId)
{
    const role = temporalRole(roleId);
    if (role.epochMilliseconds % 1000 !== 0)
    {
        throw new Error(`${roleId} cannot be represented as an exact JWT epoch second`);
    }
    return role.epochMilliseconds / 1000;
}

function temporalRoleSql(roleId)
{
    return `timestamptz '${temporalRole(roleId).instantUtc}'`;
}

function exactTemporalTtlSeconds(roleId, requestedSeconds)
{
    const expiresAt = temporalRole(roleId).epochMilliseconds;
    const startsAt = temporalRole('session.authenticated').epochMilliseconds;
    const durationMilliseconds = expiresAt - startsAt;
    if (durationMilliseconds <= 0 || durationMilliseconds % 1000 !== 0)
    {
        throw new Error(`${roleId} does not define an exact positive TTL`);
    }
    const expectedSeconds = durationMilliseconds / 1000;
    if (Number(requestedSeconds) !== expectedSeconds)
    {
        throw new Error(`${roleId} TTL must exact-match the resolved temporal role`);
    }
    return expectedSeconds;
}

function accountSubjectHash(identityKind, subject)
{
    const normalizedKind = String(identityKind || ANONYMOUS_ACCOUNT_KIND).trim();
    const normalizedSubject = String(subject || '').trim().toLowerCase();
    return createHash('sha256')
        .update(`${ACCOUNT_SUBJECT_HASH_PREFIX}:${normalizedKind}:${normalizedSubject}`, 'utf8')
        .digest('hex');
}

function anonymousCredentialIssuanceSubjectHash(userId)
{
    const pepper = String(anonymousCredentialSubjectHashPepper || '').trim();
    if (pepper.length < 32)
    {
        return '';
    }

    const key = createHash('sha256').update(pepper, 'utf8').digest();
    return createHmac('sha256', key)
        .update(`fsusblog:anonymous-credential-issuance:v1:${userId}`, 'utf8')
        .digest('hex');
}

function clearFixtureAnonymousCredentialIssuanceAudit(userId)
{
    if (!resetAnonymousCredentialIssuanceFixture)
    {
        return;
    }

    const subjectHash = anonymousCredentialIssuanceSubjectHash(userId);
    if (!subjectHash)
    {
        return;
    }

    runPsql(`
DO $$
BEGIN
  IF to_regclass('anonymous_credential_issuance_audit') IS NOT NULL THEN
    DELETE FROM anonymous_credential_issuance_audit
    WHERE subject_hash = ${sqlString(subjectHash)};
  END IF;
END $$;
`);
}

function runtimeCacheKey(key)
{
    return testSession ? `e2e:${testSession}:${key}` : key;
}

function randomToken(byteLength = 32)
{
    return randomBytes(byteLength).toString('base64url');
}

export function stableFixtureSessionId(kind, handle, sessionScope = 'default')
{
    const seed = [
        'fsusblog-test-session-v1',
        String(kind || '').trim().toLowerCase(),
        String(testSession || 'default').trim().toLowerCase(),
        String(handle || '').trim().toLowerCase(),
        String(sessionScope || 'default').trim().toLowerCase()
    ].join(':');
    return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32).toUpperCase();
}

function fixtureSessionScope({ rememberMe, deviceFingerprint })
{
    return [
    rememberMe ? 'remember' : 'standard',
    String(deviceFingerprint || 'default').trim().toLowerCase()
    ].join(':');
}

function buildUserCookieHeader({ accessToken, refreshToken, sessionId })
{
    return [
        `__Host-AccessToken=${accessToken}`,
        `__Host-RefreshToken=${refreshToken}`,
        `__Host-SessionId=${sessionId}`,
        `AccessToken=${accessToken}`,
        `RefreshToken=${refreshToken}`,
        `SessionId=${sessionId}`
    ].join('; ');
}

function buildAdminCookieHeader({ accessToken, sessionId })
{
    return [
        `__Host-AdminAccessToken=${accessToken}`,
        `__Host-AdminSessionId=${sessionId}`,
        `AdminAccessToken=${accessToken}`,
        `AdminSessionId=${sessionId}`
    ].join('; ');
}

export function isFixtureAdminHandle(handle)
{
    const normalized = String(handle || '').trim().toLowerCase();
    const expected = String(process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin').trim().toLowerCase();
    return normalized === expected || normalized.startsWith('admin');
}

export async function ensureUserFixtureSession({
    handle,
    rememberMe = false,
    deviceFingerprint = 'binary-smoke-node'
})
{
    const normalizedHandle = String(handle || 'binaryuser').trim() || 'binaryuser';
    const accountSubjectHashValue = accountSubjectHash(ANONYMOUS_ACCOUNT_KIND, normalizedHandle);
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
    account_subject_hash,
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
    ${sqlString(accountSubjectHashValue)},
    false,
    false,
    ${temporalRoleSql('session.created')},
    'basic',
    'active',
    0,
    ${temporalRoleSql('session.created')},
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

    runPsql(`
UPDATE sys_user
SET status = 0,
    account_subject_hash = ${sqlString(accountSubjectHashValue)},
    banreason = NULL,
    deleted_at = NULL,
    deleted_reason = NULL,
    mfaenabled = false
WHERE id = ${userId};

DELETE FROM user_mfa_profile
WHERE user_id = ${userId};
`, `reset fixture user MFA ${normalizedHandle}`);
    clearFixtureUserBanCache(normalizedHandle);
    clearFixtureAnonymousCredentialIssuanceAudit(userId);

    const sessionId = stableFixtureSessionId(
        ANONYMOUS_ACCOUNT_KIND,
        normalizedHandle,
        fixtureSessionScope({ rememberMe, deviceFingerprint }));
    const refreshToken = randomToken();
    // Session validation binds JWT auth_method/auth_strength/auth_time to the
    // sys_user_session authentication context. Keep the DB row and token claims
    // on the same unix second so UserSessionValidationService accepts fixtures.
    const authenticatedAtEpochSeconds = temporalRoleEpochSeconds('session.authenticated');
    const authenticatedAtSql = temporalRoleSql('session.authenticated');
    const authenticationMethod = 'other';
    const authenticationStrength = 'legacy_unverified';
    const sessionModeClaim = 'normal';
    const accessTokenExpiresAtEpochSeconds = temporalRoleEpochSeconds('session.access-token-expiry');
    const accessToken = signJwt({
        [CLAIM_NAME_IDENTIFIER]: String(userId),
        identity_kind: ANONYMOUS_ACCOUNT_KIND,
        [ACCOUNT_SUBJECT_HASH_CLAIM]: accountSubjectHashValue,
        sid: sessionId,
        mfa: '0',
        auth_method: authenticationMethod,
        auth_strength: authenticationStrength,
        session_mode: sessionModeClaim,
        auth_time: String(authenticatedAtEpochSeconds),
        iss: jwtIssuer,
        aud: jwtAudience,
        iat: authenticatedAtEpochSeconds,
        nbf: authenticatedAtEpochSeconds,
        exp: accessTokenExpiresAtEpochSeconds
    });

    runPsql(`
UPDATE sys_user_session
SET revokedat = ${temporalRoleSql('session.revoked')},
    revokereason = 'login_replaced'
WHERE userid = ${userId}
  AND sessionid <> ${sqlString(sessionId)}
  AND revokedat IS NULL;
`);

    runPsql(`
INSERT INTO sys_user_session (
  sessionid,
  userid,
  refreshtokenhash,
  refresh_family_id,
  refresh_generation,
  refresh_rotated_at_utc,
  device_signal_hash,
  browser_family,
  os_family,
  form_factor,
  createdat,
  lastseenat,
  idleexpiresat,
  absoluteexpiresat,
  revokedat,
  revokereason,
  session_mode,
  mfaverified,
  rememberme,
  authentication_method,
  authentication_strength,
  authenticated_at_utc,
  duration_policy
)
VALUES (
  ${sqlString(sessionId)},
  ${userId},
  ${sqlString(sha256Hex(refreshToken))},
  ${sqlString(sessionId)},
  0,
  ${authenticatedAtSql},
  ${sqlString(deviceFingerprint)},
  'Unknown',
  'Unknown',
  'Unknown',
  ${temporalRoleSql('session.created')},
  ${temporalRoleSql('session.last-seen')},
  ${temporalRoleSql(rememberMe ? 'session.persistent-idle-expiry' : 'session.idle-expiry')},
  ${temporalRoleSql(rememberMe ? 'session.persistent-absolute-expiry' : 'session.absolute-expiry')},
  NULL,
  NULL,
  0,
  false,
  ${rememberMe ? 'true' : 'false'},
  ${sqlString(authenticationMethod)},
  ${sqlString(authenticationStrength)},
  ${authenticatedAtSql},
  ${rememberMe ? sqlString('persistent_30d') : sqlString('browser_session')}
)
ON CONFLICT (sessionid) DO UPDATE SET
  userid = EXCLUDED.userid,
  refreshtokenhash = EXCLUDED.refreshtokenhash,
  refresh_family_id = EXCLUDED.refresh_family_id,
  refresh_generation = EXCLUDED.refresh_generation,
  refresh_rotated_at_utc = EXCLUDED.refresh_rotated_at_utc,
  device_signal_hash = EXCLUDED.device_signal_hash,
  browser_family = EXCLUDED.browser_family,
  os_family = EXCLUDED.os_family,
  form_factor = EXCLUDED.form_factor,
  lastseenat = EXCLUDED.lastseenat,
  idleexpiresat = EXCLUDED.idleexpiresat,
  absoluteexpiresat = EXCLUDED.absoluteexpiresat,
  revokedat = NULL,
  revokereason = NULL,
  session_mode = EXCLUDED.session_mode,
  mfaverified = EXCLUDED.mfaverified,
  rememberme = EXCLUDED.rememberme,
  authentication_method = EXCLUDED.authentication_method,
  authentication_strength = EXCLUDED.authentication_strength,
  authenticated_at_utc = EXCLUDED.authenticated_at_utc,
  duration_policy = EXCLUDED.duration_policy;
`);

    return {
        kind: 'user',
        userId,
        sessionId,
        accessToken,
        accessTokenExpiresAtEpochSeconds,
        refreshToken,
        cookieHeader: buildUserCookieHeader({ accessToken, refreshToken, sessionId })
    };
}

export async function ensureAdminFixtureSession({
    handle,
    rememberMe = false,
    deviceFingerprint = 'binary-smoke-node'
})
{
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
  ${temporalRoleSql('session.created')},
  ${temporalRoleSql('session.last-seen')},
  false,
  NULL,
  NULL
)
ON CONFLICT (handle) DO UPDATE SET
  displayname = EXCLUDED.displayname,
  status = 'active',
  permissions = EXCLUDED.permissions,
  lastloginatutc = ${temporalRoleSql('session.last-seen')}
RETURNING id;
`, `fixture admin ${normalizedHandle}`);

    const sessionId = stableFixtureSessionId(
        ADMIN_PRINCIPAL_KIND,
        normalizedHandle,
        fixtureSessionScope({ rememberMe, deviceFingerprint }));
    const authenticatedAtEpochSeconds = temporalRoleEpochSeconds('session.authenticated');
    const accessTokenExpiresAtEpochSeconds = temporalRoleEpochSeconds('session.access-token-expiry');
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
        iat: authenticatedAtEpochSeconds,
        nbf: authenticatedAtEpochSeconds,
        exp: accessTokenExpiresAtEpochSeconds
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
  ${temporalRoleSql('session.created')},
  ${temporalRoleSql('session.last-seen')},
  ${temporalRoleSql(rememberMe ? 'session.admin-persistent-idle-expiry' : 'session.admin-standard-idle-expiry')},
  ${temporalRoleSql(rememberMe ? 'session.admin-persistent-absolute-expiry' : 'session.admin-standard-absolute-expiry')},
  NULL,
  NULL,
  true
)
ON CONFLICT (sessionid) DO UPDATE SET
  adminprincipalid = EXCLUDED.adminprincipalid,
  accesstokenhash = EXCLUDED.accesstokenhash,
  devicefingerprint = EXCLUDED.devicefingerprint,
  lastip = EXCLUDED.lastip,
  useragent = EXCLUDED.useragent,
  lastseenatutc = ${temporalRoleSql('session.last-seen')},
  idleexpiresatutc = EXCLUDED.idleexpiresatutc,
  absoluteexpiresatutc = EXCLUDED.absoluteexpiresatutc,
  revokedatutc = NULL,
  revokereason = NULL,
  stepupverified = EXCLUDED.stepupverified;
`);

    return {
        kind: 'admin',
        adminId,
        sessionId,
        accessToken,
        accessTokenExpiresAtEpochSeconds,
        cookieHeader: buildAdminCookieHeader({ accessToken, sessionId })
    };
}

export function createAdminStepUpProofToken({
    adminId,
    sessionId,
    action = 'admin-sensitive',
    ttlSeconds = 45
})
{
    if (!Number.isFinite(Number(adminId)) || Number(adminId) <= 0)
    {
        throw new Error('admin step-up proof requires a valid admin id');
    }
    if (!String(sessionId || '').trim())
    {
        throw new Error('admin step-up proof requires a valid session id');
    }

    const token = randomToken();
    const identity = [
        'admin',
        Number(adminId),
        String(sessionId).trim(),
        String(action).trim(),
        token
    ].join(':');
    const key = `fsus:sec:mfa-proof:${identity}`;
    runRedisCli([
        'SET',
        runtimeCacheKey(key),
        '1',
        'EX',
        String(exactTemporalTtlSeconds('mfa.proof-expiry', ttlSeconds))
    ], 'admin step-up proof');
    return token;
}

export function createUserMfaProofToken({
    userId,
    handle,
    action,
    ttlSeconds = 45
})
{
    if (!Number.isFinite(Number(userId)) || Number(userId) <= 0)
    {
        throw new Error('user MFA proof requires a valid user id');
    }
    const normalizedHandle = String(handle || '').trim().toLowerCase();
    if (!normalizedHandle)
    {
        throw new Error('user MFA proof requires a valid handle');
    }
    const normalizedAction = String(action || '').trim().toLowerCase();
    if (!normalizedAction)
    {
        throw new Error('user MFA proof requires a valid action');
    }

    const token = randomToken();
    const subject = accountSubjectHash(ANONYMOUS_ACCOUNT_KIND, normalizedHandle);
    const identity = createHash('sha256')
        .update([
            'mfa-proof',
            String(Number(userId)),
            subject,
            normalizedAction,
            token
        ].join(':'), 'utf8')
        .digest('hex')
        .toUpperCase();
    const key = `fsus:sec:mfa-proof:${identity}`;
    runRedisCli([
        'SET',
        runtimeCacheKey(key),
        '1',
        'EX',
        String(exactTemporalTtlSeconds('mfa.proof-expiry', ttlSeconds))
    ], 'user MFA proof');
    return token;
}

function cookieEntries(cookieHeader, url)
{
    return cookieHeader
        .split(';')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) =>
        {
            const separator = item.indexOf('=');
            const name = item.slice(0, separator);
            const isHostPrefixed = name.startsWith('__Host-');
            return {
                name,
                value: item.slice(separator + 1),
                url,
                path: '/',
                httpOnly: true,
                secure: isHostPrefixed,
                sameSite: isHostPrefixed ? 'Strict' : 'Lax'
            };
        });
}

function fixtureStorageState(fixture, url)
{
    return {
        // Browser cookie expiry follows the host clock, while fixture JWT
        // lifetime validation follows the sealed business clock. Persist
        // session cookies here so the browser cannot discard an otherwise
        // valid fixed-time JWT before the backend validates its exp claim.
        cookies: cookieEntries(fixture.cookieHeader, url),
        origins: []
    };
}

async function writePrivateJson(file, value)
{
    await writeFile(file, JSON.stringify(value, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o600
    });
    await chmod(file, 0o600);
}

export async function persistAuthFixtureManifest({
    user,
    admin,
    baseUrl = process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_BASE_URL || 'http://localhost:3000'
})
{
    if (!persistAuthFixtures)
    {
        return null;
    }

    const fixturesDir = resolveAuthFixtureDirectory();
    await mkdir(fixturesDir, { recursive: true, mode: 0o700 });
    await chmod(fixturesDir, 0o700);
    const manifest = {
        generatedAt: new Date().toISOString(),
        baseUrl,
        user: {
            id: user.userId,
            sessionId: user.sessionId,
            storageStateFile: 'user.storage-state.json'
        },
        admin: {
            id: admin.adminId,
            sessionId: admin.sessionId,
            storageStateFile: 'admin.storage-state.json'
        }
    };

    await writePrivateJson(path.join(fixturesDir, 'auth-fixtures.json'), manifest);
    await writePrivateJson(
        path.join(fixturesDir, manifest.user.storageStateFile),
        fixtureStorageState(user, baseUrl));
    await writePrivateJson(
        path.join(fixturesDir, manifest.admin.storageStateFile),
        fixtureStorageState(admin, baseUrl));
    if (testSession)
    {
        const sessionPrefix = testSession.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
        if (sessionPrefix)
        {
            await writePrivateJson(
                path.join(fixturesDir, `${sessionPrefix}.user.storage-state.json`),
                fixtureStorageState(user, baseUrl));
            await writePrivateJson(
                path.join(fixturesDir, `${sessionPrefix}.admin.storage-state.json`),
                fixtureStorageState(admin, baseUrl));
        }
    }
    return manifest;
}

export async function prepareAuthSmokeFixtures({
    userHandle = 'binaryuser',
    adminHandle = 'binaryadmin',
    deviceFingerprint = 'binary-smoke-node'
} = {})
{
    const user = await ensureUserFixtureSession({
        handle: userHandle,
        rememberMe: true,
        deviceFingerprint
    });
    const admin = await ensureAdminFixtureSession({
        handle: adminHandle,
        rememberMe: true,
        deviceFingerprint
    });

    const manifest = await persistAuthFixtureManifest({ user, admin });
    return { user, admin, manifest };
}

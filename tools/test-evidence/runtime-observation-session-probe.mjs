import { createHash } from 'node:crypto'

import { stable } from '../fact-extractors/lib/canonicalize.mjs'
import {
  authBinary,
  loginWithFixtureSessionBypass
} from '../../tests/frontend/support/auth-helpers.mjs'
import { refreshHashDigest } from './runtime-observation-probe-facts.mjs'
import {
  digest,
  fail,
  frontendUrl,
  psqlJson,
  sha,
  timeoutMs
} from './runtime-observation-probe-io.mjs'

function parseCookieHeader(header)
{
  return Object.fromEntries(String(header).split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const offset = entry.indexOf('=')
    return [entry.slice(0, offset), entry.slice(offset + 1)]
  }))
}

function decodeJwt(token)
{
  const parts = String(token).split('.')
  if (parts.length !== 3) fail('fixture access token is not a JWT')
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
}


export async function sessionProbe(context)
{
  const deviceFingerprint = `session-probe-${context.identity.runId}`
  const session = await loginWithFixtureSessionBypass('binaryuser', '', true, deviceFingerprint, timeoutMs)
  const cookies = parseCookieHeader(session.cookieHeader)
  const claims = decodeJwt(session.accessToken)
  if (!/^[A-F0-9]{32}$/u.test(session.sessionId)) fail('fixture session id is invalid')
  const row = await psqlJson(`SELECT row_to_json(observed) FROM (SELECT sessionid, userid, refreshtokenhash,
    refresh_family_id, refresh_generation, refresh_rotated_at_utc, device_signal_hash, browser_family,
    os_family, form_factor, createdat, lastseenat, idleexpiresat, absoluteexpiresat, revokedat,
    session_mode, mfaverified, rememberme, authentication_method, authentication_strength,
    authenticated_at_utc, duration_policy FROM sys_user_session WHERE sessionid = '${session.sessionId}') observed;`)
  const sessionsResult = await authBinary('/api/Auth/sessions', {
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    timeoutMs
  })
  const meResult = await authBinary('/api/Auth/me', {
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    timeoutMs
  })
  const sessions = sessionsResult.payload?.data ?? sessionsResult.payload ?? []
  const serviceSession = Array.isArray(sessions) ? sessions.find((item) => item.sessionId === session.sessionId) : null
  const presentedRefreshHash = createHash('sha256').update(session.refreshToken).digest('hex')
  const authenticatedAtEpochSeconds = Math.floor(Date.parse(`${String(row.authenticated_at_utc).replace(/Z$/u, '')}Z`) / 1000)
  const replacementFingerprint = `${deviceFingerprint}-replacement`
  const replacement = await loginWithFixtureSessionBypass('binaryuser', '', true, replacementFingerprint, timeoutMs)
  const replacedRefresh = await authBinary('/api/Auth/refresh-token', {
    method: 'POST', cookieHeader: session.cookieHeader, deviceFingerprint,
    headers: { Origin: frontendUrl }, timeoutMs
  })
  const revoke = await authBinary(`/api/Auth/sessions/${encodeURIComponent(replacement.sessionId)}/revoke`, {
    method: 'POST', cookieHeader: replacement.cookieHeader, deviceFingerprint: replacementFingerprint,
    headers: { Origin: frontendUrl }, timeoutMs
  })
  const revokedRefresh = await authBinary('/api/Auth/refresh-token', {
    method: 'POST', cookieHeader: replacement.cookieHeader, deviceFingerprint: replacementFingerprint,
    headers: { Origin: frontendUrl }, timeoutMs
  })
  const releaseIdFor = (result) => result.response.headers.get('x-fsus-release-id')
  const denied = (result) => result.response.status === 401 || result.response.status === 403
  const facts = {
    schema: 'fsusblog.session-cookie-runtime-probe-facts.v1',
    database: {
      projection: { ...row, sessionid: sha(row.sessionid), refreshtokenhash: refreshHashDigest(row.refreshtokenhash),
        refresh_family_id: sha(row.refresh_family_id), device_signal_hash: sha(row.device_signal_hash) },
      sessionDigest: digest({ ...row, sessionid: sha(row.sessionid), refreshtokenhash: refreshHashDigest(row.refreshtokenhash),
        refresh_family_id: sha(row.refresh_family_id), device_signal_hash: sha(row.device_signal_hash) }),
      sessionIdDigest: sha(row.sessionid),
      refreshTokenHashDigest: refreshHashDigest(row.refreshtokenhash),
      refreshGeneration: Number(row.refresh_generation),
      revoked: row.revokedat != null
    },
    credential: {
      presentedRefreshHashDigest: refreshHashDigest(presentedRefreshHash),
      storedRefreshHashDigest: refreshHashDigest(row.refreshtokenhash),
      matches: presentedRefreshHash.toLowerCase() === String(row.refreshtokenhash).toLowerCase()
    },
    authContext: {
      projection: { authenticationMethod: row.authentication_method, authenticationStrength: row.authentication_strength,
        authenticatedAtUtc: row.authenticated_at_utc, sessionMode: row.session_mode, mfaVerified: row.mfaverified },
      digest: digest({ authenticationMethod: row.authentication_method, authenticationStrength: row.authentication_strength,
        authenticatedAtUtc: row.authenticated_at_utc, sessionMode: row.session_mode, mfaVerified: row.mfaverified }),
      jwtMatches: claims.auth_method === row.authentication_method && claims.auth_strength === row.authentication_strength
        && Number(claims.auth_time) === authenticatedAtEpochSeconds
    },
    jwt: {
      projection: { subjectDigest: sha(String(claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'] ?? claims.sub)),
        sessionIdDigest: sha(claims.sid), identity_kind: claims.identity_kind, auth_method: claims.auth_method,
        auth_strength: claims.auth_strength, session_mode: claims.session_mode, auth_time: claims.auth_time,
        iat: claims.iat, nbf: claims.nbf, exp: claims.exp, iss: claims.iss, aud: claims.aud },
      tokenDigest: sha(session.accessToken),
      claimsDigest: digest({ sub: claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'] ?? claims.sub,
        sid: sha(claims.sid), identity_kind: claims.identity_kind, auth_method: claims.auth_method,
        auth_strength: claims.auth_strength, session_mode: claims.session_mode, auth_time: claims.auth_time,
        iat: claims.iat, nbf: claims.nbf, exp: claims.exp, iss: claims.iss, aud: claims.aud }),
      sessionMatches: claims.sid === session.sessionId && Number(claims.exp) === session.accessTokenExpiresAtEpochSeconds
    },
    cookie: {
      projection: { surface: 'http-request-cookie', values: Object.fromEntries(
        Object.entries(cookies).map(([name, value]) => [name, { valueDigest: sha(value) }])) },
      names: Object.keys(cookies).sort(),
      digest: digest(Object.fromEntries(Object.entries(cookies).map(([name, value]) => [name, sha(value)]))),
      sessionMatches: cookies.SessionId === session.sessionId && cookies['__Host-SessionId'] === session.sessionId
        && cookies.AccessToken === session.accessToken && cookies['__Host-AccessToken'] === session.accessToken
    },
    expiry: {
      projection: { accessTokenExp: claims.exp, issuedAt: claims.iat, idleExpiresAt: row.idleexpiresat,
        absoluteExpiresAt: row.absoluteexpiresat, durationPolicy: row.duration_policy },
      digest: digest({ accessTokenExp: claims.exp, idleExpiresAt: row.idleexpiresat,
        absoluteExpiresAt: row.absoluteexpiresat, durationPolicy: row.duration_policy }),
      ordered: Number(claims.exp) > Number(claims.iat)
        && new Date(row.absoluteexpiresat).getTime() >= new Date(row.idleexpiresat).getTime()
    },
    revision: {
      projection: { refreshGeneration: row.refresh_generation, refreshRotatedAtUtc: row.refresh_rotated_at_utc,
        familyDigest: sha(row.refresh_family_id) },
      digest: digest({ refreshGeneration: row.refresh_generation, refreshRotatedAtUtc: row.refresh_rotated_at_utc,
        family: sha(row.refresh_family_id) }),
      current: Number(row.refresh_generation) === 0 && row.revokedat == null
    },
    device: {
      projection: { observedDigest: sha(row.device_signal_hash), presentedDigest: sha(deviceFingerprint),
        browserFamily: row.browser_family, osFamily: row.os_family, formFactor: row.form_factor },
      digest: digest({ observed: sha(row.device_signal_hash), presented: sha(deviceFingerprint),
        browserFamily: row.browser_family, osFamily: row.os_family, formFactor: row.form_factor }),
      matches: row.device_signal_hash === deviceFingerprint
    },
    service: {
      projection: { meStatus: meResult.response.status, sessionsStatus: sessionsResult.response.status,
        mePayloadDigest: digest(meResult.payload), session: serviceSession == null ? null : {
          sessionIdDigest: sha(serviceSession.sessionId), isCurrent: serviceSession.isCurrent,
          authenticationMethod: serviceSession.authenticationMethod,
          authenticationStrength: serviceSession.authenticationStrength } },
      digest: digest({ me: meResult.payload, session: serviceSession == null ? null : { ...serviceSession, sessionId: sha(serviceSession.sessionId) } }),
      status: { me: meResult.response.status, sessions: sessionsResult.response.status },
      releaseIds: [meResult.response.headers.get('x-fsus-release-id'),
        sessionsResult.response.headers.get('x-fsus-release-id')],
      currentSessionMatches: serviceSession?.isCurrent === true
        && serviceSession?.authenticationMethod === row.authentication_method
        && serviceSession?.authenticationStrength === row.authentication_strength
    },
    modeOutcomes: {
      positive: { caseId: 'current-session-coherence', status: meResult.response.status,
        releaseId: releaseIdFor(meResult), passed: meResult.response.status === 200 },
      negative: { caseId: 'replaced-session-refresh-denied', status: replacedRefresh.response.status,
        releaseId: releaseIdFor(replacedRefresh), passed: denied(replacedRefresh) },
      failure: { caseId: 'revoked-session-refresh-denied', revokeStatus: revoke.response.status,
        refreshStatus: revokedRefresh.response.status, releaseIds: [releaseIdFor(revoke), releaseIdFor(revokedRefresh)],
        passed: revoke.response.ok && denied(revokedRefresh) }
    }
  }
  facts.storage = { projection: { surface: 'postgresql-session-storage',
    sessionIdDigest: sha(row.sessionid), refreshTokenHashDigest: refreshHashDigest(row.refreshtokenhash),
    refreshGeneration: row.refresh_generation, revokedAt: row.revokedat } }
  facts.coherent = facts.credential.matches && facts.authContext.jwtMatches && facts.jwt.sessionMatches
    && facts.cookie.sessionMatches && facts.expiry.ordered && facts.revision.current && facts.device.matches
    && facts.service.status.me === 200 && facts.service.status.sessions === 200 && facts.service.currentSessionMatches
    && facts.service.releaseIds.every((value) => value === context.identity.releaseId)
    && facts.modeOutcomes.positive.passed && facts.modeOutcomes.negative.passed && facts.modeOutcomes.failure.passed
    && facts.modeOutcomes.positive.releaseId === context.identity.releaseId
    && facts.modeOutcomes.negative.releaseId === context.identity.releaseId
    && facts.modeOutcomes.failure.releaseIds.every((value) => value === context.identity.releaseId)
  if (!facts.coherent)
  {
    fail(`session probe observed a DB/JWT/cookie/service mismatch: ${JSON.stringify({
      credential: facts.credential.matches,
      authContext: facts.authContext.jwtMatches,
      jwt: facts.jwt.sessionMatches,
      cookie: facts.cookie.sessionMatches,
      expiry: facts.expiry.ordered,
      revision: facts.revision.current,
      device: facts.device.matches,
      serviceStatus: facts.service.status,
      serviceSession: facts.service.currentSessionMatches,
      modeOutcomes: facts.modeOutcomes
    })}`)
  }
  return stable(facts)
}

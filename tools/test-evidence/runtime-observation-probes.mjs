#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
import {
  explicitJson as explicitPostRuntimeJson,
  seal,
  observationSourceState,
  validateCandidatePlan,
  writeReceipt
} from '../fact-extractors/post-runtime/adapter.mjs'
import {
  authBinary,
  loginWithFixtureSessionBypass
} from '../../tests/frontend/support/auth-helpers.mjs'
import {
  decodeKnownFrame,
  decodePublicAotPayload
} from '../../tests/frontend/support/aeds-envelope.mjs'
import { projectPreparedPublicIds } from '../test-fixtures/receipt/projection.mjs'
import { loadPostRuntimeProducerRegistry } from '../test-matrix/post-runtime-producer-registry.mjs'
import { deriveProbeRawFacts, refreshHashDigest, verifyFacts } from './runtime-observation-probe-facts.mjs'
export { deriveProbeRawFacts, verifyFacts } from './runtime-observation-probe-facts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const execFileAsync = promisify(execFile)
const receiptSchema = 'fsusblog.runtime-observation-probe.v1'
const failureReceiptSchema = 'fsusblog.runtime-observation-probe-failure.v1'
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const probeKinds = new Set(['route-response-error', 'cache-search-outbox-convergence', 'session-cookie-runtime'])
const baseUrl = String(process.env.FSUSBLOG_BASE_URL || process.env.FSUSBLOG_DEBUG_BACKEND_URL || '').replace(/\/+$/u, '')
const frontendUrl = String(process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_DEBUG_FRONTEND_URL || baseUrl).replace(/\/+$/u, '')
const pgContainer = process.env.FSUSBLOG_PG_CONTAINER || process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME || ''
const redisContainer = process.env.FSUSBLOG_REDIS_CONTAINER || process.env.FSUSBLOG_REDIS_CONTAINER_NAME || ''
const pgUser = process.env.FSUSBLOG_PG_USER || 'fsusblog'
const pgDatabase = process.env.FSUSBLOG_PG_DB || 'fsusblog'
const timeoutMs = Number.parseInt(process.env.FSUSBLOG_RUNTIME_OBSERVATION_TIMEOUT_MS || '90000', 10)

const fail = (message) => { throw new Error(`[runtime-observation-probe] ${message}`) }
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const digest = (value) => `sha256:${digestValue(stable(value))}`
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function options(argv)
{
  const parsed = { _: [] }
  for (let index = 0; index < argv.length; index += 1)
  {
    const argument = argv[index]
    if (!argument.startsWith('--'))
    {
      parsed._.push(argument)
      continue
    }
    const key = argument.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(`${argument} requires a value`)
    parsed[key] = value
    index += 1
  }
  return parsed
}

function explicitJson(relative, label)
{
  if (typeof relative !== 'string' || !relative.endsWith('.json')) fail(`${label} path is required`)
  const absolute = path.resolve(root, relative)
  if (!absolute.startsWith(`${root}${path.sep}`) || /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu.test(relative))
  {
    fail(`${label} must be an explicit current-run path`)
  }
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(absolute) !== absolute)
  {
    fail(`${label} must be a regular non-symlink single-link current-run file`)
  }
  const bytes = fs.readFileSync(absolute)
  return {
    value: JSON.parse(bytes.toString('utf8')),
    ref: {
      path: path.relative(root, absolute).replaceAll(path.sep, '/'),
      contentDigest: sha(bytes)
    }
  }
}

function sourceIdentity(parsed, build, fixture, candidatePlan)
{
  const commit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT || parsed['source-commit'] || '')
  const fingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT || parsed['source-fingerprint'] || '').replace(/^sha256:/u, '')
  const runId = String(process.env.FSUSBLOG_TEST_RUN_ID || parsed['run-id'] || '')
  const attemptId = String(process.env.FSUSBLOG_TEST_ATTEMPT_ID || parsed['attempt-id'] || 'attempt-1')
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^[a-f0-9]{64}$/u.test(fingerprint) || !runId || !attemptId)
  {
    fail('source commit, worktree fingerprint, run id, and attempt id are required')
  }
  const buildSource = build.value.sourceState ?? {}
  if (buildSource.commit !== commit || String(buildSource.worktreeFingerprint ?? '').replace(/^sha256:/u, '') !== fingerprint)
  {
    fail('production build receipt does not match probe source identity')
  }
  const fixtureSource = fixture.value.plan?.executionIdentity?.sourceIdentity ?? {}
  if (fixtureSource.commit !== commit || String(fixtureSource.worktreeFingerprint ?? '').replace(/^sha256:/u, '') !== fingerprint
    || fixture.value.plan?.executionIdentity?.runId !== runId || fixture.value.terminalState !== 'prepared')
  {
    fail('fixture prepare receipt does not match the prepared current run')
  }
  const plan = candidatePlan.value
  if (plan.sourceState?.commit !== commit
    || plan.sourceState?.worktreeFingerprint !== `sha256:${fingerprint}`
    || plan.candidate?.runId !== runId
    || plan.candidate?.attemptId !== attemptId
    || plan.build?.receiptContentDigest !== build.value.contentDigest)
  {
    fail('candidate plan does not match the live probe run, attempt, source, and build')
  }
  return {
    sourceCommit: commit,
    worktreeFingerprint: `sha256:${fingerprint}`,
    runId,
    attemptId,
    buildIdentity: String(build.value.contentDigest ?? ''),
    fixtureIdentity: fixture.ref.contentDigest,
    candidateId: plan.candidate.candidateId,
    runtimeId: plan.candidate.runtimeId,
    releaseId: plan.candidate.releaseId,
    candidatePlanDigest: plan.contentDigest
  }
}

function dependencyReference(input, role)
{
  return {
    path: input.ref.path,
    fileDigest: input.ref.contentDigest,
    contentDigest: input.value.contentDigest ?? null,
    schema: input.value.schema,
    role
  }
}

function fixtureProjection(fixture)
{
  let projection
  try { projection = projectPreparedPublicIds(fixture.value) }
  catch (error) { fail(`prepared fixture has no canonical public-content authority: ${error.message}`) }
  return {
    articleId: Number(projection.articleId),
    categoryId: Number(projection.categoryId),
    tagId: Number(projection.tagId),
    articleTitle: projection.articleTitle,
    searchKeyword: projection.searchKeyword,
    projectionDigest: projection.projectionDigest,
    prepareStateDigest: fixture.ref.contentDigest
  }
}

function configureTemporalFixture(fixture)
{
  const temporal = fixture.value.producerOutputs?.['auth-session']?.temporalArtifacts?.resolvedTemporalRoles
  if (!temporal || temporal.schema !== 'fsusblog.resolved-temporal-roles.v1'
    || !digestPattern.test(String(temporal.contentDigest ?? '')))
  {
    fail('prepared auth-session fixture has no sealed resolved temporal roles')
  }
  process.env.FSUSBLOG_RESOLVED_TEMPORAL_ROLES_JSON = JSON.stringify(temporal)
  process.env.FSUSBLOG_TEMPORAL_ROLE_ARTIFACT_DIGEST = temporal.contentDigest
}

function selectedHeaders(headers)
{
  const names = [
    'cache-control', 'content-type', 'etag', 'vary', 'x-fsus-frame-encoding',
    'x-fsus-frame-version', 'x-fsus-generation', 'x-fsus-hotread-artifact',
    'x-fsus-hotread-key', 'x-fsus-hotread-version', 'x-fsus-public-aot-state',
    'x-fsus-release-derived', 'x-fsus-release-id', 'x-fsus-release-slot'
  ]
  return Object.fromEntries(names.map((name) => [name, headers.get(name)]).filter(([, value]) => value != null))
}

async function directAeds(requestPath, init = {})
{
  const response = await fetch(`${baseUrl}${requestPath}`, {
    ...init,
    headers: { Accept: 'application/octet-stream', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs)
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  let payload = null
  let decodeError = null
  if (bytes.byteLength > 0)
  {
    try { payload = decodeKnownFrame(bytes) }
    catch (error) { decodeError = error instanceof Error ? error.message : String(error) }
  }
  return {
    requestObservation: { method: init.method ?? 'GET', url: response.url,
      accept: new Headers(init.headers).get('accept') ?? 'application/octet-stream',
      ifNoneMatch: new Headers(init.headers).get('if-none-match'),
      deviceFingerprintDigest: new Headers(init.headers).has('x-fsus-device-fp')
        ? sha(new Headers(init.headers).get('x-fsus-device-fp')) : null },
    status: response.status,
    headers: selectedHeaders(response.headers),
    bodyDigest: sha(bytes),
    byteLength: bytes.byteLength,
    payload,
    decodeError
  }
}

function publicCase(value, { id, role, expectation })
{
  return stable({
    id,
    role,
    expectation,
    requestObservation: value.requestObservation,
    typedPayloadProjection: safeErrorProjection(value.payload),
    status: value.status,
    headers: value.headers,
    bodyDigest: value.bodyDigest,
    byteLength: value.byteLength,
    typedPayloadDigest: value.payload == null ? null : digest(value.payload),
    typedKind: value.payload?.code != null ? 'typed-error' : 'payload',
    typedEntityId: Number.isSafeInteger(value.payload?.id) ? value.payload.id : null,
    typedTitleDigest: typeof value.payload?.title === 'string' ? sha(value.payload.title) : null,
    typedCode: Number.isSafeInteger(value.payload?.code) ? value.payload.code : null,
    typedCategory: Number.isSafeInteger(value.payload?.category) ? value.payload.category : null,
    typedStatusCode: Number.isSafeInteger(value.payload?.statusCode) ? value.payload.statusCode : null,
    typedMessageDigest: typeof value.payload?.message === 'string' ? sha(value.payload.message) : null,
    decodeError: value.decodeError
  })
}

async function binaryCase(id, role, expectation, result)
{
  const response = result.response
  return stable({
    id,
    role,
    expectation,
    requestObservation: { method: 'GET', url: response.url },
    typedPayloadProjection: safeErrorProjection(result.payload),
    status: response.status,
    headers: selectedHeaders(response.headers),
    typedPayloadDigest: result.payload == null ? null : digest(result.payload),
    typedKind: result.payload?.code != null ? 'typed-error' : 'payload',
    typedCode: Number.isSafeInteger(result.payload?.code) ? result.payload.code : null,
    typedCategory: Number.isSafeInteger(result.payload?.category) ? result.payload.category : null,
    typedStatusCode: Number.isSafeInteger(result.payload?.statusCode) ? result.payload.statusCode : null,
    typedMessageDigest: typeof result.payload?.message === 'string' ? sha(result.payload.message) : null,
    decodeError: result.payloadError ?? null
  })
}

function safeErrorProjection(payload)
{
  if (payload?.code == null) return null
  return { code: payload.code, category: payload.category, statusCode: payload.statusCode,
    messageDigest: typeof payload.message === 'string' ? sha(payload.message) : null }
}

async function routeProbe(context)
{
  if (!baseUrl) fail('route probe requires FSUSBLOG_BASE_URL')
  const fixture = fixtureProjection(context.fixture)
  const { articleId } = fixture
  const user = await loginWithFixtureSessionBypass('binaryuser', '', false, `route-user-${context.identity.runId}`, timeoutMs)
  const admin = await loginWithFixtureSessionBypass('binaryadmin', '', false, `route-admin-${context.identity.runId}`, timeoutMs)
  const publicFirst = await directAeds(`/api/binary/article/${articleId}.aeds`, {
    headers: { 'X-Fsus-Device-Fp': `route-public-${context.identity.runId}` }
  })
  const publicSecond = await directAeds(`/api/binary/article/${articleId}.aeds`, {
    headers: {
      'X-Fsus-Device-Fp': `route-public-${context.identity.runId}`,
      ...(publicFirst.headers.etag ? { 'If-None-Match': publicFirst.headers.etag } : {})
    }
  })
  const missing = await directAeds('/api/binary/article/2147483647.aeds', {
    headers: { 'X-Fsus-Device-Fp': `route-missing-${context.identity.runId}` }
  })
  const anonymousMe = await directAeds('/api/binary/auth/me', {
    headers: { 'X-Fsus-Device-Fp': `route-anonymous-${context.identity.runId}` }
  })
  const userMe = await authBinary('/api/Auth/me', {
    cookieHeader: user.cookieHeader,
    deviceFingerprint: `route-user-${context.identity.runId}`,
    timeoutMs
  })
  const userAdmin = await authBinary('/api/Article?page=1&size=1&isDeleted=false', {
    cookieHeader: user.cookieHeader,
    deviceFingerprint: `route-user-${context.identity.runId}`,
    timeoutMs
  })
  const adminList = await authBinary('/api/Article?page=1&size=1&isDeleted=false', {
    cookieHeader: admin.cookieHeader,
    deviceFingerprint: `route-admin-${context.identity.runId}`,
    timeoutMs
  })
  const cases = [
    publicCase(publicFirst, { id: 'public-visible-first-read', role: 'anonymous', expectation: 'visible-public-payload' }),
    publicCase(publicSecond, { id: 'public-visible-cache-revalidation', role: 'anonymous', expectation: 'same-cache-identity-or-304' }),
    publicCase(missing, { id: 'public-missing-typed-error', role: 'anonymous', expectation: 'typed-not-found' }),
    publicCase(anonymousMe, { id: 'anonymous-auth-denied', role: 'anonymous', expectation: 'typed-auth-denial' }),
    await binaryCase('user-self-visible', 'user', 'own-auth-context-payload', userMe),
    await binaryCase('user-admin-denied', 'user', 'admin-permission-denial', userAdmin),
    await binaryCase('admin-list-visible', 'admin', 'admin-permission-payload', adminList)
  ]
  const byId = new Map(cases.map((item) => [item.id, item]))
  const first = byId.get('public-visible-first-read')
  const second = byId.get('public-visible-cache-revalidation')
  const firstFrameVersion = first.headers['x-fsus-frame-version']
  const firstGeneration = first.headers['x-fsus-generation']
  const coherent = first.status === 200 && first.typedKind === 'payload' && first.decodeError === null
    && first.typedEntityId === articleId && first.typedTitleDigest === sha(fixture.articleTitle)
    && first.headers['content-type']?.toLowerCase().includes('application/octet-stream')
    && firstFrameVersion === '2' && /^[0-9]+$/u.test(String(firstGeneration ?? ''))
    && typeof first.headers.etag === 'string' && first.headers.etag.length > 0
    && second.status === 304 && second.headers.etag === first.headers.etag
    && byId.get('public-missing-typed-error').status === 404
    && byId.get('public-missing-typed-error').typedKind === 'typed-error'
    && byId.get('public-missing-typed-error').typedCode === 2
    && byId.get('public-missing-typed-error').typedCategory === 4
    && byId.get('public-missing-typed-error').typedStatusCode === 404
    && byId.get('public-missing-typed-error').typedMessageDigest === sha('article_not_found')
    && [401, 403].includes(byId.get('anonymous-auth-denied').status)
    && byId.get('user-self-visible').status === 200
    && [401, 403].includes(byId.get('user-admin-denied').status)
    && byId.get('admin-list-visible').status === 200
  if (!coherent) fail('route probe did not observe the required role/auth/visibility/cache semantics')
  return {
    schema: 'fsusblog.route-response-error-probe-facts.v1',
    fixtureAuthority: {
      prepareStateDigest: fixture.prepareStateDigest,
      projectionDigest: fixture.projectionDigest,
      articleIdDigest: sha(String(articleId)),
      articleTitleDigest: sha(fixture.articleTitle),
      searchCanaryDigest: sha(fixture.searchKeyword)
    },
    cases,
    coherent
  }
}

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

async function psqlJson(sql)
{
  if (!pgContainer) fail('probe requires FSUSBLOG_PG_CONTAINER')
  const result = await execFileAsync('docker', [
    'exec', '-i', pgContainer, 'psql', '-U', pgUser, '-d', pgDatabase,
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql
  ], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  const text = result.stdout.trim()
  if (!text) fail('database observation returned no row')
  return JSON.parse(text)
}

async function sessionProbe(context)
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

async function redis(command)
{
  if (!redisContainer) fail('probe requires FSUSBLOG_REDIS_CONTAINER')
  const result = await execFileAsync('docker', ['exec', redisContainer, 'redis-cli', '--raw', ...command], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024
  })
  return result.stdout.trim()
}

async function eventually(label, operation)
{
  const deadline = Date.now() + timeoutMs
  let lastError
  do
  {
    try { return await operation() }
    catch (error) { lastError = error; await sleep(500) }
  } while (Date.now() < deadline)
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function cacheProbe(context)
{
  if (!baseUrl) fail('cache probe requires FSUSBLOG_BASE_URL')
  const { categoryId, tagId } = fixtureProjection(context.fixture)
  const deviceFingerprint = `cache-probe-${context.identity.runId}`
  const admin = await loginWithFixtureSessionBypass('binaryadmin', '', false, deviceFingerprint, timeoutMs)
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const marker = `dc${stamp}alpha`
  const title = `Distribution Coherence ${stamp} Alpha`
  const create = await authBinary('/api/Article', {
    method: 'POST',
    cookieHeader: admin.cookieHeader,
    requiresPow: true,
    deviceFingerprint,
    timeoutMs,
    headers: { Origin: frontendUrl, 'X-Fsus-Client-Mutation-Id': randomUUID() },
    body: {
      title,
      content: `# ${title}\n\n这是一段普通的文章内容，用于验证发布版本一致性。标识：${marker}`,
      summary: `用于验证订阅与搜索版本一致性的普通摘要。标识：${marker}`,
      categoryId,
      tagIds: [tagId],
      status: 2,
      scheduledPublishAt: null
    }
  })
  if (!create.response.ok || !Number.isSafeInteger(Number(create.payload?.id)))
  {
    fail(`article mutation failed HTTP ${create.response.status}: ${JSON.stringify({
      payload: create.payload,
      payloadError: create.payloadError,
      responseBody: create.responseBody
    })}`)
  }
  const articleId = Number(create.payload.id)
  const terminal = await eventually('cache/search/outbox convergence', async () => {
    const outbox = await psqlJson(`SELECT COALESCE(json_agg(observed ORDER BY id), '[]'::json) FROM
      (SELECT id, event_id, aggregate_id, schema_version, article_revision_id, revision_no,
       article_publication_id, publication_no, event_type, status, retry_count, processed_at, last_error
       FROM article_mutation_outbox WHERE aggregate_type = 'article' AND aggregate_id = ${articleId}) observed;`)
    const projection = await psqlJson(`SELECT row_to_json(observed) FROM
      (SELECT article_id, version, visible, etag, content_hash, unavailable_reason,
       updated_at_utc, projection_schema_version FROM public_article_projection WHERE article_id = ${articleId}) observed;`)
    const detail = await directAeds(`/api/binary/article/${articleId}.aeds`, {
      headers: { 'X-Fsus-Device-Fp': `cache-public-${context.identity.runId}` }
    })
    const releaseId = detail.headers['x-fsus-release-id']
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/u.test(String(releaseId ?? '')))
    {
      throw new Error('public detail response did not bind an immutable release id')
    }
    const searchPath = `/release-derived/${releaseId}/search/index.bin`
    const searchResponse = await fetch(`${baseUrl}${searchPath}`, { signal: AbortSignal.timeout(timeoutMs) })
    const searchBytes = new Uint8Array(await searchResponse.arrayBuffer())
    const navigationResponse = await fetch(`${baseUrl}/api/public/navigation-snapshot.aeds?path=${encodeURIComponent(`/article/${articleId}`)}`, {
      headers: { Accept: 'application/octet-stream', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(timeoutMs)
    })
    const navigationBytes = new Uint8Array(await navigationResponse.arrayBuffer())
    const envelope = decodePublicAotPayload(Buffer.from(navigationBytes).toString('base64url'))
    const bootstrap = decodePublicAotPayload(envelope.bootstrapPayload)
    const hydration = decodePublicAotPayload(envelope.hydrationPropsPayload)
    const generation = await redis(['GET', 'public-aot:invalidation-generation:v1'])
    const keys = (await redis(['--scan', '--pattern', `*${articleId}*`])).split('\n').filter(Boolean).sort()
    const processed = Array.isArray(outbox) && outbox.length > 0
      && outbox.every((item) => item.status === 'processed' && item.last_error == null)
    const searchContains = searchResponse.ok && Buffer.from(searchBytes).includes(Buffer.from(marker))
    const navigationText = JSON.stringify({ envelope, bootstrap, hydration })
    const navigationContains = navigationResponse.ok && navigationText.includes(marker)
    const detailMatches = detail.status === 200 && detail.payload?.title === title
    if (!processed || projection?.visible !== true || !projection.etag || !projection.content_hash
      || !detailMatches || !searchContains || !navigationContains || !generation)
    {
      throw new Error(`partial processed=${processed} projection=${projection?.visible} detail=${detailMatches} search=${searchContains} navigation=${navigationContains} generation=${Boolean(generation)}`)
    }
    return { outbox, projection, detail, searchBytes, searchPath, navigationBytes,
      envelope: { envelope, bootstrap, hydration }, generation, keys,
      searchContains, navigationContains, searchStatus: searchResponse.status,
      navigationStatus: navigationResponse.status, processed, detailMatches }
  })
  return stable({
    schema: 'fsusblog.cache-search-outbox-probe-facts.v1',
    authorityCoordinate: { articleIdDigest: sha(String(articleId)), mutationIdDigest: digest(create.payload),
      projectionVersion: terminal.projection.version },
    events: terminal.outbox.map((item) => ({ ...item, event_id: sha(item.event_id), aggregate_id: sha(String(item.aggregate_id)) })),
    edges: { eventTypes: terminal.outbox.map((item) => item.event_type).sort(), redisKeyDigests: terminal.keys.map(sha) },
    generation: { value: terminal.generation, valueDigest: sha(terminal.generation), present: Boolean(terminal.generation) },
    query: { searchIndexDigest: sha(terminal.searchBytes), releaseScopedPath: terminal.searchPath,
      releaseId: terminal.detail.headers['x-fsus-release-id'], containsMarker: terminal.searchContains,
      responseStatus: terminal.searchStatus, markerDigest: sha(marker) },
    readModel: { projectionDigest: digest(terminal.projection), detailDigest: terminal.detail.bodyDigest,
      detailTitleDigest: sha(terminal.detail.payload.title), visible: terminal.projection.visible,
      projection: terminal.projection, responseStatus: terminal.detail.status },
    output: { navigationDigest: sha(terminal.navigationBytes), envelopeDigest: digest(terminal.envelope),
      containsMarker: terminal.navigationContains, responseStatus: terminal.navigationStatus, markerDigest: sha(marker) },
    terminal: { state: terminal.processed && terminal.detailMatches && terminal.searchContains
      && terminal.navigationContains ? 'converged' : 'partial',
      processedEvents: terminal.outbox.filter((entry) => entry.status === 'processed').length,
      poisonEvents: terminal.outbox.filter((entry) => entry.last_error != null).length },
    coherent: terminal.processed && terminal.detailMatches && terminal.searchContains && terminal.navigationContains
  })
}


function buildReceipt(kind, context, facts)
{
  const plan = context.candidatePlan.value
  const producer = loadPostRuntimeProducerRegistry(root).producers.find((entry) => entry.producerId === plan.producerId)
  const canonicalRerunCommand = `node tools/test-evidence/runtime-observation-probes.mjs probe --kind ${kind} --candidate-plan ${context.candidatePlan.relative} --build ${context.build.ref.path} --fixture ${context.fixture.ref.path} --out ${context.output}`
  const independentVerifyCommand = `node tools/test-evidence/runtime-observation-raw.mjs verify --candidate-plan ${context.candidatePlan.relative} --receipt ${plan.observations.find((entry) => entry.classId === kind).receiptPath}`
  return seal({
    schema: receiptSchema,
    kind,
    producerId: 'production-correctness-scheduler',
    toolVersion: producer.toolVersion,
    sourceState: observationSourceState({ classId: kind, plan, artifactDigest: digest(facts), repositoryRoot: root }),
    canonicalRerunCommand,
    independentVerifyCommand,
    rawFacts: deriveProbeRawFacts(kind, facts),
    candidatePlanRef: {
      path: context.candidatePlan.relative,
      fileDigest: context.candidatePlan.fileDigest,
      contentDigest: context.candidatePlan.value.contentDigest,
      schema: context.candidatePlan.value.schema,
      role: 'candidate-plan'
    },
    buildReceipt: dependencyReference(context.build, 'production-build'),
    fixtureReceipt: dependencyReference(context.fixture, 'fixture'),
    provenance: {
      mode: 'local-real-runtime',
      semanticAuthority: 'current-candidate-application-and-owned-services',
      simulatedInfrastructure: ['docker-postgresql', 'docker-redis', 'loopback-network'],
      syntheticSemanticResult: false,
      rerunCommand: canonicalRerunCommand
    },
    facts,
    terminalStatus: 'verified'
  })
}

function buildFailureReceipt(kind, context, error)
{
  const message = error instanceof Error ? error.message : String(error)
  return seal({
    schema: failureReceiptSchema,
    kind,
    producerId: 'production-correctness-scheduler',
    sourceState: context.identity,
    candidatePlanRef: {
      path: context.candidatePlan.relative,
      fileDigest: context.candidatePlan.fileDigest,
      contentDigest: context.candidatePlan.value.contentDigest,
      schema: context.candidatePlan.value.schema
    },
    buildReceipt: context.build.ref,
    fixtureReceipt: context.fixture.ref,
    provenance: {
      mode: 'local-real-runtime',
      semanticAuthority: 'current-candidate-application-and-owned-services',
      simulatedInfrastructure: ['docker-postgresql', 'docker-redis', 'loopback-network'],
      syntheticSemanticResult: false,
      rerunCommand: `node tools/test-evidence/runtime-observation-probes.mjs probe --kind ${kind} --candidate-plan ${context.candidatePlan.relative} --build ${context.build.ref.path} --fixture ${context.fixture.ref.path} --out <new-current-run-output.json>`
    },
    qualificationEligible: false,
    terminalStatus: 'failed',
    failure: {
      name: error instanceof Error ? error.name : 'Error',
      message: message.slice(0, 2048),
      messageDigest: sha(message)
    }
  })
}


export function verifyReceipt(receipt)
{
  if (receipt?.schema !== receiptSchema || !probeKinds.has(receipt.kind)
    || receipt.producerId !== 'production-correctness-scheduler' || receipt.terminalStatus !== 'verified'
    || receipt.provenance?.syntheticSemanticResult !== false || receipt.provenance?.mode !== 'local-real-runtime')
  {
    fail('probe receipt authority/schema/status mismatch')
  }
  const replay = seal(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest')))
  if (receipt.contentDigest !== replay.contentDigest) fail('probe receipt content digest mismatch')
  for (const [reference, schema, role] of [
    [receipt.buildReceipt, 'fsusblog.ci-production-build-receipt.v1', 'production-build'],
    [receipt.fixtureReceipt, 'fsusblog.fixture-prepare-state.v1', 'fixture']
  ])
  {
    const current = explicitJson(reference?.path, 'probe dependency')
    if (Object.keys(reference).sort().join(',') !== 'contentDigest,fileDigest,path,role,schema'
      || reference.schema !== schema || current.value.schema !== schema || reference.role !== role
      || current.ref.contentDigest !== reference.fileDigest
      || (current.value.contentDigest ?? null) !== reference.contentDigest)
    {
      fail(`probe dependency digest/schema mismatch: ${reference?.path}`)
    }
  }
  const build = explicitJson(receipt.buildReceipt.path, 'production build receipt')
  const fixture = explicitJson(receipt.fixtureReceipt.path, 'fixture prepare receipt')
  const source = receipt.sourceState ?? {}
  const buildSource = build.value.sourceState ?? {}
  const fixtureSource = fixture.value.plan?.executionIdentity?.sourceIdentity ?? {}
  if (buildSource.commit !== source.sourceCommit
    || `sha256:${String(buildSource.worktreeFingerprint ?? '').replace(/^sha256:/u, '')}` !== source.worktreeFingerprint
    || build.value.contentDigest !== source.buildIdentity)
  {
    fail('probe build dependency identity mismatch')
  }
  if (fixture.value.terminalState !== 'prepared'
    || fixtureSource.commit !== source.sourceCommit
    || `sha256:${String(fixtureSource.worktreeFingerprint ?? '').replace(/^sha256:/u, '')}` !== source.worktreeFingerprint
    || fixture.value.plan?.executionIdentity?.runId !== source.runId)
  {
    fail('probe fixture dependency identity mismatch')
  }
  const candidatePlanInput = explicitPostRuntimeJson(receipt.candidatePlanRef?.path,
    'probe candidate plan')
  const candidatePlan = validateCandidatePlan(candidatePlanInput.value)
  if (receipt.candidatePlanRef?.fileDigest !== candidatePlanInput.fileDigest
    || receipt.candidatePlanRef?.contentDigest !== candidatePlan.contentDigest
    || receipt.candidatePlanRef?.schema !== candidatePlan.schema
    || receipt.candidatePlanRef?.role !== 'candidate-plan'
    || source.candidateId !== candidatePlan.candidate.candidateId
    || source.runtimeId !== candidatePlan.candidate.runtimeId)
  {
    fail('probe candidate identity does not replay from the candidate plan')
  }
  const producer = loadPostRuntimeProducerRegistry(root).producers.find((entry) => entry.producerId === receipt.producerId)
  const expectedSource = observationSourceState({ classId: receipt.kind, plan: candidatePlan,
    artifactDigest: digest(receipt.facts), repositoryRoot: root })
  if (!producer || receipt.toolVersion !== producer.toolVersion || digest(source) !== digest(expectedSource)
    || receipt.canonicalRerunCommand !== receipt.provenance.rerunCommand
    || receipt.independentVerifyCommand !== `node tools/test-evidence/runtime-observation-raw.mjs verify --candidate-plan ${receipt.candidatePlanRef.path} --receipt ${candidatePlan.observations.find((entry) => entry.classId === receipt.kind).receiptPath}`
    || digest(receipt.rawFacts) !== digest(deriveProbeRawFacts(receipt.kind, receipt.facts)))
  {
    fail('probe raw facts, source identity, tool or commands do not replay')
  }
  verifyFacts(receipt.kind, receipt.facts, { fixture, fixtureProjection: fixtureProjection(fixture),
    expectedReleaseId: candidatePlan.candidate.releaseId })
  return receipt
}

async function main()
{
  const parsed = options(process.argv.slice(2))
  const command = parsed._[0]
  if (command === 'verify')
  {
    const receipt = explicitJson(parsed.receipt, 'probe receipt').value
    verifyReceipt(receipt)
    process.stdout.write(`[runtime-observation-probe] verified kind=${receipt.kind} digest=${receipt.contentDigest}\n`)
    return
  }
  if (command !== 'probe' || !probeKinds.has(parsed.kind)) fail('usage: probe --kind <canonical-kind> ... or verify --receipt <path>')
  const build = explicitJson(parsed.build, 'production build receipt')
  const fixture = explicitJson(parsed.fixture, 'fixture prepare receipt')
  const candidatePlan = explicitPostRuntimeJson(
    process.env.FSUSBLOG_POST_RUNTIME_CANDIDATE_PLAN || parsed['candidate-plan'], 'probe candidate plan')
  validateCandidatePlan(candidatePlan.value)
  configureTemporalFixture(fixture)
  const identity = sourceIdentity(parsed, build, fixture, candidatePlan)
  const context = { build, fixture, candidatePlan, identity, output: parsed.out }
  let facts
  try
  {
    facts = parsed.kind === 'route-response-error'
      ? await routeProbe(context)
      : parsed.kind === 'session-cookie-runtime'
        ? await sessionProbe(context)
        : await cacheProbe(context)
  }
  catch (error)
  {
    const failure = buildFailureReceipt(parsed.kind, context, error)
    writeReceipt(`${parsed.out}.failure.json`, failure, root)
    throw error
  }
  const receipt = buildReceipt(parsed.kind, context, facts)
  writeReceipt(parsed.out, receipt, root)
  verifyReceipt(receipt)
  process.stdout.write(`[runtime-observation-probe] ok kind=${parsed.kind} digest=${receipt.contentDigest}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
}

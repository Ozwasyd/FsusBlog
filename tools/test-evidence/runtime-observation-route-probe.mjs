import { stable } from '../fact-extractors/lib/canonicalize.mjs'
import {
  authBinary,
  loginWithFixtureSessionBypass
} from '../../tests/frontend/support/auth-helpers.mjs'
import {
  baseUrl,
  digest,
  directAeds,
  fail,
  fixtureProjection,
  selectedHeaders,
  sha,
  timeoutMs
} from './runtime-observation-probe-io.mjs'

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

export async function routeProbe(context)
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

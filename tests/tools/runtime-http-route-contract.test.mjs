import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeAedsFrame } from '../../tests/frontend/support/aeds-envelope.mjs'
import { assertExactRouteSet, fetchRouteSample, producerRouteIds, routeCatalogDigest, validateRouteCatalog } from '../../tools/test/lanes/runtime-http-route-contract.mjs'

function response(status, contentType, body, headers = {}) { return new Response(body, { status, headers: { 'content-type': contentType, ...headers } }) }
const request = (reply, count) => async () => { count.value += 1; return reply }
const valid = () => encodeAedsFrame(13, new Uint8Array(16))
function validSearchManifest() {
  const bytes = new Uint8Array(41); const view = new DataView(bytes.buffer); let offset = 0
  const u32 = (value) => { view.setUint32(offset, value, true); offset += 4 }
  const i32 = (value) => { view.setInt32(offset, value, true); offset += 4 }
  u32(0x4d495346); u32(1); i32(1); view.setBigInt64(offset, 62135596800000n * 10000n, true); offset += 8
  i32(1); bytes[offset++] = 'v'.charCodeAt(0); i32(0); i32(0); i32(0); i32(0)
  return bytes
}

test('route oracle rejects redirect, HTML, wrong frame, truncation and body bounds', async () => {
  for (const [label, reply, expected] of [
    ['redirect', response(302, 'application/octet-stream', valid(), { location: '/login' }), 'redirect-forbidden'],
    ['html', response(200, 'text/html', '<html>error</html>'), 'unexpected-content-type'],
    ['wrong-frame', response(200, 'application/octet-stream', encodeAedsFrame(1, new Uint8Array(16))), 'unexpected-frame-type'],
    ['truncated', response(200, 'application/octet-stream', new Uint8Array(16)), 'aeds-integrity:'],
    ['too-large', response(200, 'application/octet-stream', encodeAedsFrame(13, new Uint8Array(70_000))), 'body-size-out-of-bounds']
  ]) {
    const count = { value: 0 }; const sample = await fetchRouteSample({ routeId: 'system-seo', baseUrl: 'http://fixture', timeoutMs: 100, fetchImpl: request(reply, count) })
    assert.equal(count.value, 1, label); assert.equal(sample.ok, false, label); assert.match(sample.failureKind, new RegExp(expected));
  }
})
test('route oracle rejects a binary business-error envelope and required cache policy', async () => {
  const business = await fetchRouteSample({ routeId: 'system-seo', baseUrl: 'http://fixture', timeoutMs: 100, fetchImpl: request(response(200, 'application/octet-stream', encodeAedsFrame(255, new Uint8Array(16))), { value: 0 }) })
  assert.equal(business.failureKind, 'business-error-envelope')
  const cache = await fetchRouteSample({ routeId: 'pow-challenge', baseUrl: 'http://fixture', timeoutMs: 100, fetchImpl: request(response(200, 'application/octet-stream', encodeAedsFrame(30, new Uint8Array(16))), { value: 0 }) })
  assert.equal(cache.failureKind, 'cache-header-policy-failed')
})
test('HTML requires a real document and search manifest has dedicated semantics', async () => {
  const html = await fetchRouteSample({ routeId: 'public-home', baseUrl: 'http://fixture', timeoutMs: 100, fetchImpl: request(response(200, 'text/html', 'random text/html payload '.repeat(4)), { value: 0 }) })
  assert.equal(html.failureKind, 'html-document-invalid')
  const manifest = await fetchRouteSample({ routeId: 'search-manifest', baseUrl: 'http://fixture', timeoutMs: 100, fetchImpl: request(response(200, 'application/octet-stream', new Uint8Array(32)), { value: 0 }) })
  assert.match(manifest.failureKind, /^search-manifest-invalid:/)
  const validManifest = await fetchRouteSample({ routeId: 'search-manifest', baseUrl: 'http://fixture', timeoutMs: 100, fetchImpl: request(response(200, 'application/octet-stream', validSearchManifest()), { value: 0 }) })
  assert.equal(validManifest.ok, true)
})
test('catalog validation rejects missing, extra, duplicate and malformed route entries', () => {
  const validCatalog = {
    schema: 'fsusblog.runtime-http-route-contracts.v1',
    producers: { probe: ['system-seo'] },
    routes: [{ routeId: 'system-seo', method: 'GET', pathTemplate: '/api/binary/system/seo', expectedStatus: 200, redirectPolicy: 'forbid', expectedContentType: ['application/octet-stream'], expectedAedsFrameType: 13, minimumBodyBytes: 16, maximumBodyBytes: 64, semanticValidatorId: 'non-error-frame', cacheHeaderPolicy: 'any', authPolicy: 'anonymous' }]
  }
  assert.equal(validateRouteCatalog(validCatalog), validCatalog)
  const missing = structuredClone(validCatalog); delete missing.routes[0].authPolicy
  const extra = structuredClone(validCatalog); extra.producers.probe.push('unknown')
  const duplicate = structuredClone(validCatalog); duplicate.routes.push(structuredClone(duplicate.routes[0]))
  const malformed = structuredClone(validCatalog); malformed.routes[0].expectedStatus = '200'
  const unsupported = structuredClone(validCatalog); unsupported.routes[0].legacyPath = '/legacy'
  assert.throws(() => validateRouteCatalog(missing), /missing authPolicy/)
  assert.throws(() => validateRouteCatalog(extra), /unknown route/)
  assert.throws(() => validateRouteCatalog(duplicate), /duplicate routeId/)
  assert.throws(() => validateRouteCatalog(malformed), /expectedStatus is invalid/)
  assert.throws(() => validateRouteCatalog(unsupported), /unsupported fields/)
})
test('unknown route fails before a request and catalog exactness is fail closed', async () => {
  const count = { value: 0 }
  await assert.rejects(fetchRouteSample({ routeId: 'missing', baseUrl: 'http://fixture', timeoutMs: 1, fetchImpl: request(response(200, 'application/octet-stream', valid()), count) }), /unknown_route_contract/)
  await assert.rejects(fetchRouteSample({ routeId: 'article-list-home-10', baseUrl: 'http://fixture', requestPath: '/api/binary/article/list/home/1/5.aeds', timeoutMs: 1, fetchImpl: request(response(200, 'application/octet-stream', encodeAedsFrame(1, new Uint8Array(16))), count) }), /route_path_contract_mismatch/)
  assert.equal(count.value, 0)
  assert.throws(() => assertExactRouteSet(['system-seo']), /exact_match/)
  assert.throws(() => assertExactRouteSet(['system-seo', 'system-seo']), /duplicate routeId/)
  assert.throws(() => assertExactRouteSet(['system-seo', 'extra']), /exact_match/)
  assert.match(routeCatalogDigest(), /^sha256:/)
  assert.equal(producerRouteIds('runtime-load-soak').length, 6)
  assert.equal(producerRouteIds('frontend-load-public-api').length, 10)
})

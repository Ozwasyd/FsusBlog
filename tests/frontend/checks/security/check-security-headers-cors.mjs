#!/usr/bin/env node

import { baseUrl, requestTimeoutMs } from '../../support/auth-helpers.mjs';
import { isDirectExecution, reportDirectFailure } from '../../support/direct-execution.mjs';
import { fetchWithTimeout } from '../../support/http.mjs';

const frontendBaseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const allowedOrigin = new URL(frontendBaseUrl).origin;
const deniedOrigin = 'https://attacker.invalid';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function header(response, name) {
  return response.headers.get(name) ?? '';
}

function assertHeaderEquals(response, name, expected, label) {
  const actual = header(response, name);
  assert(actual.toLowerCase() === expected.toLowerCase(), `${label}: ${name} expected "${expected}", got "${actual}"`);
}

function assertHeaderContains(response, name, expected, label) {
  const actual = header(response, name);
  assert(actual.toLowerCase().includes(expected.toLowerCase()), `${label}: ${name} missing "${expected}", got "${actual}"`);
}

function assertHeaderNotContains(response, name, unexpected, label) {
  const actual = header(response, name);
  assert(!actual.toLowerCase().includes(unexpected.toLowerCase()), `${label}: ${name} should not contain "${unexpected}", got "${actual}"`);
}

function assertCommonSecurityHeaders(response, label) {
  assertHeaderEquals(response, 'x-content-type-options', 'nosniff', label);
  assertHeaderEquals(response, 'x-frame-options', 'DENY', label);
  assertHeaderEquals(response, 'referrer-policy', 'strict-origin-when-cross-origin', label);
  assertHeaderContains(response, 'permissions-policy', 'camera=()', label);
  assertHeaderContains(response, 'permissions-policy', 'microphone=()', label);
  assertHeaderContains(response, 'content-security-policy', "default-src 'self'", label);
  assertHeaderContains(response, 'content-security-policy', "form-action 'self'", label);
  assertHeaderContains(response, 'content-security-policy', "frame-ancestors 'none'", label);
  assertHeaderContains(response, 'content-security-policy', "object-src 'none'", label);
  assertHeaderContains(response, 'content-security-policy', "style-src 'self'", label);
  assertHeaderContains(response, 'content-security-policy', "style-src-attr 'none'", label);
  assertHeaderContains(response, 'content-security-policy', 'report-uri /api/security/csp-report', label);
  assertHeaderNotContains(response, 'content-security-policy', "style-src-attr 'unsafe-inline'", label);
  assertHeaderContains(response, 'content-security-policy', "img-src 'self' data: blob:", label);
  assertHeaderNotContains(response, 'content-security-policy', "style-src 'self' 'unsafe-inline'", label);
  assertHeaderNotContains(response, 'content-security-policy', 'img-src http:', label);
  assertHeaderNotContains(response, 'content-security-policy', 'img-src https:', label);
}

function assertHtmlSecurityHeaders(response, label) {
  assertCommonSecurityHeaders(response, label);
  assertHeaderContains(response, 'content-security-policy', "'wasm-unsafe-eval'", label);
  assertHeaderContains(response, 'content-security-policy', "style-src 'self' 'nonce-", label);
}

function assertNonHtmlSecurityHeaders(response, label) {
  assertCommonSecurityHeaders(response, label);
  assertHeaderNotContains(response, 'content-security-policy', "'nonce-", label);
  assertHeaderNotContains(response, 'content-security-policy', "'wasm-unsafe-eval'", label);
}

export async function runSecurityHeadersCors() {
  const publicResponse = await fetchWithTimeout(`${baseUrl}/`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (FsusBlog Security Header Check)',
      Accept: 'text/html'
    }
  }, requestTimeoutMs);
  assert(publicResponse.status < 500, `public shell must not return 5xx, got ${publicResponse.status}`);
  assertHtmlSecurityHeaders(publicResponse, 'public shell');

  const authResponse = await fetchWithTimeout(`${baseUrl}/api/binary/auth/pow-challenge`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (FsusBlog Security Header Check)',
      Accept: 'application/octet-stream'
    }
  }, requestTimeoutMs);
  assert(authResponse.ok, `pow challenge must be reachable, got ${authResponse.status}`);
  assertNonHtmlSecurityHeaders(authResponse, 'binary auth');
  assertHeaderContains(authResponse, 'cache-control', 'no-store', 'binary auth');
  assertHeaderContains(authResponse, 'pragma', 'no-cache', 'binary auth');

  const allowedPreflight = await fetchWithTimeout(`${baseUrl}/api/binary/system/seo`, {
    method: 'OPTIONS',
    headers: {
      Origin: allowedOrigin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'content-type,x-fsus-device-fp'
    }
  }, requestTimeoutMs);
  assert(allowedPreflight.status < 500, `allowed CORS preflight must not return 5xx, got ${allowedPreflight.status}`);
  assertHeaderEquals(allowedPreflight, 'access-control-allow-origin', allowedOrigin, 'allowed CORS preflight');
  assertHeaderEquals(allowedPreflight, 'access-control-allow-credentials', 'true', 'allowed CORS preflight');

  const deniedPreflight = await fetchWithTimeout(`${baseUrl}/api/binary/system/seo`, {
    method: 'OPTIONS',
    headers: {
      Origin: deniedOrigin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'content-type,x-fsus-device-fp'
    }
  }, requestTimeoutMs);
  assert(deniedPreflight.status < 500, `denied CORS preflight must not return 5xx, got ${deniedPreflight.status}`);
  assert(
    header(deniedPreflight, 'access-control-allow-origin') !== deniedOrigin,
    'denied CORS preflight must not echo untrusted origin'
  );

  console.log(`[check-security-headers-cors] ok | base=${baseUrl} allowedOrigin=${allowedOrigin}`);
}

if (isDirectExecution(import.meta.url)) {
  runSecurityHeadersCors().catch((error) => reportDirectFailure('check-security-headers-cors', error));
}

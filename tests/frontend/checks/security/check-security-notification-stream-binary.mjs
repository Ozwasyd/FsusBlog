#!/usr/bin/env node

import { baseUrl, requestTimeoutMs } from '../../support/auth-helpers.mjs';
import {
  decodeAedsFrame,
  encodeAedsFrame,
  readAedsResponse
} from '../../support/aeds-envelope.mjs';
import { fetchWithTimeout } from '../../support/http.mjs';

const FRAME_AUTH_ANONYMOUS_BOOTSTRAP_REQUEST = 189;
const AUTH_BINARY_MUTATION_PATH = '/api/binary/auth/anonymous/bootstrap';
const deniedStatuses = new Set([400, 401, 403, 404, 406, 409, 415, 422, 426, 428, 429]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertDenied(name, response) {
  assert(response.status < 500, `${name} must not return 5xx, got ${response.status}`);
  assert(!response.ok, `${name} must not return 2xx, got ${response.status}`);
  assert(deniedStatuses.has(response.status), `${name} returned unexpected denial status ${response.status}`);
}

async function assertAedsError(name, response, expectedStatus) {
  assert(response.status === expectedStatus, `${name} expected ${expectedStatus}, got ${response.status}`);
  assert((response.headers.get('content-type') ?? '').includes('application/octet-stream'), `${name} must return AEDS content-type`);
  assert(response.headers.get('x-fsus-frame-version') === '2', `${name} must return AEDS v2 frame header`);
  const payload = await readAedsResponse(response);
  assert(payload?.statusCode === expectedStatus, `${name} AEDS error status mismatch`);
}

function makeWrongVersionFrame() {
  const payload = new Uint8Array(4);
  const bytes = new Uint8Array(16 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x53444541, true);
  bytes[4] = 1;
  bytes[5] = 16;
  view.setUint16(8, FRAME_AUTH_ANONYMOUS_BOOTSTRAP_REQUEST, true);
  view.setUint32(10, payload.byteLength, true);
  bytes.set(payload, 16);
  return bytes;
}

async function main() {
  const noUpgrade = await fetchWithTimeout(`${baseUrl}/api/notifications/stream`, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'Mozilla/5.0 (FsusBlog Notification Stream Security Check)'
    }
  }, requestTimeoutMs);
  await assertAedsError('notification stream without websocket upgrade', noUpgrade, 426);

  const authHeaderWithoutIdentity = await fetchWithTimeout(`${baseUrl}/api/notifications/stream`, {
    headers: {
      Accept: 'application/octet-stream',
      Authorization: 'Bearer not-a-valid-token',
      'User-Agent': 'Mozilla/5.0 (FsusBlog Notification Stream Security Check)'
    }
  }, requestTimeoutMs);
  await assertAedsError('notification stream forged authorization', authHeaderWithoutIdentity, 426);

  const incompatibleAccept = await fetchWithTimeout(`${baseUrl}/api/binary/system/seo`, {
    headers: {
      Accept: 'text/html'
    }
  }, requestTimeoutMs);
  assertDenied('binary endpoint incompatible Accept', incompatibleAccept);
  const incompatibleAcceptFrame = decodeAedsFrame(await incompatibleAccept.arrayBuffer());
  assert(incompatibleAcceptFrame.frameType === 251, 'binary endpoint incompatible Accept must return ApiError frame');

  const incompatibleContentType = await fetchWithTimeout(`${baseUrl}${AUTH_BINARY_MUTATION_PATH}`, {
    method: 'POST',
    headers: {
      Accept: 'application/octet-stream',
      'Content-Type': 'application/json'
    },
    body: '{}'
  }, requestTimeoutMs);
  assertDenied('binary endpoint incompatible Content-Type', incompatibleContentType);

  const truncatedFrame = await fetchWithTimeout(`${baseUrl}${AUTH_BINARY_MUTATION_PATH}`, {
    method: 'POST',
    headers: {
      Accept: 'application/octet-stream',
      'Content-Type': 'application/octet-stream',
      'X-Fsus-Device-Fp': 'binary-truncated-frame'
    },
    body: new Uint8Array([0x41, 0x45, 0x44])
  }, requestTimeoutMs);
  assertDenied('binary endpoint truncated frame', truncatedFrame);

  const wrongVersionFrame = await fetchWithTimeout(`${baseUrl}${AUTH_BINARY_MUTATION_PATH}`, {
    method: 'POST',
    headers: {
      Accept: 'application/octet-stream',
      'Content-Type': 'application/octet-stream',
      'X-Fsus-Device-Fp': 'binary-wrong-version'
    },
    body: makeWrongVersionFrame()
  }, requestTimeoutMs);
  assertDenied('binary endpoint wrong AEDS version', wrongVersionFrame);

  const wrongFrameType = await fetchWithTimeout(`${baseUrl}${AUTH_BINARY_MUTATION_PATH}`, {
    method: 'POST',
    headers: {
      Accept: 'application/octet-stream',
      'Content-Type': 'application/octet-stream',
      'X-Fsus-Device-Fp': 'binary-wrong-frame-type'
    },
    body: encodeAedsFrame(65500, new Uint8Array(0))
  }, requestTimeoutMs);
  assertDenied('binary endpoint wrong frame type', wrongFrameType);

  console.log(`[check-security-notification-stream-binary] ok | base=${baseUrl}`);
}

main().catch((error) => {
  console.error('[check-security-notification-stream-binary] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

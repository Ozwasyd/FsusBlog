#!/usr/bin/env node

import {
  authBinary,
  baseUrl,
  buildPowHeaders,
  loginWithFixtureSessionBypass,
  requestTimeoutMs
} from '../../support/auth-helpers.mjs';
import { isDirectExecution, reportDirectFailure } from '../../support/direct-execution.mjs';

const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD ?? '';
const deviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'upload-resilience-node';
const trustedOrigin = process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_DEBUG_FRONTEND_URL || process.env.FSUSBLOG_PUBLIC_BASE_URL || baseUrl;
const pngSample = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64'
);
const tinySample = Buffer.from([0x00]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchBinaryFrame(path, cookieHeader, expectedFrameType) {
  const result = await authBinary(path, {
    method: 'GET',
    cookieHeader,
    deviceFingerprint,
    requiresPow: true
  });
  assert(result.response.ok, `binary request failed: ${path} -> ${result.response.status}`);
  assert(result.payload?.frameType === undefined, `${path} returned undecoded frame instead of expected ${expectedFrameType}`);
  return result.payload;
}

async function uploadPart(uploadId, uploadToken, session, partNumber, offset, payload, expectOk = true) {
  const powHeaders = await buildPowHeaders(deviceFingerprint, requestTimeoutMs);
  const response = await fetch(`${baseUrl}/api/binary/upload/${uploadId}/part`, {
    method: 'PUT',
    headers: {
      Accept: 'application/octet-stream',
      'Content-Type': 'application/octet-stream',
      Cookie: session.cookieHeader,
      Origin: trustedOrigin,
      'X-Fsus-Upload-Token': uploadToken,
      'X-Fsus-Upload-Part': String(partNumber),
      'X-Fsus-Upload-Offset': String(offset),
      ...powHeaders
    },
    body: payload
  });
  assert(expectOk ? response.ok : !response.ok, `upload part expectation failed: part=${partNumber} offset=${offset} status=${response.status}`);
  return response;
}

export async function runUploadResilience() {
  const session = await loginWithFixtureSessionBypass(adminName, adminPassword, false, deviceFingerprint, requestTimeoutMs);
  const invalidMime = await authBinary('/api/File/upload/init', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    requiresPow: true,
    headers: { Origin: trustedOrigin },
    body: {
      fileName: '../invalid<script>.exe',
      mimeType: 'application/x-msdownload',
      targetFormat: 'png',
      totalBytes: pngSample.length,
      chunkSize: pngSample.length
    }
  });
  assert(!invalidMime.response.ok, 'invalid mime upload init must fail');

  const init = await authBinary('/api/File/upload/init', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    requiresPow: true,
    headers: { Origin: trustedOrigin },
    body: {
      fileName: 'resilience-check.png',
      mimeType: 'image/png',
      targetFormat: 'png',
      totalBytes: pngSample.length,
      chunkSize: pngSample.length
    }
  });
  assert(init.response.ok, `upload init failed: ${init.response.status}`);
  const initData = init.payload?.data ?? init.payload;
  const uploadId = initData?.uploadId;
  const uploadToken = initData?.uploadToken;
  assert(typeof uploadId === 'string' && uploadId.length > 0, 'upload init missing uploadId');
  assert(typeof uploadToken === 'string' && uploadToken.length > 0, 'upload init missing uploadToken');

  await uploadPart(uploadId, uploadToken, session, 0, 0, pngSample, true);
  await uploadPart(uploadId, uploadToken, session, 0, 0, pngSample, true);
  await uploadPart(uploadId, uploadToken, session, 1, pngSample.length + 16, pngSample, false);

  const status = await authBinary(`/api/File/upload/${uploadId}/status`, {
    method: 'GET',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    requiresPow: true
  });
  assert(status.response.ok, `upload status failed: ${status.response.status}`);
  const statusData = status.payload?.data ?? status.payload;
  assert(statusData.uploadedPartCount >= 1, 'upload status should report uploaded part count');

  const binaryStatus = await fetchBinaryFrame(`/api/binary/upload/${uploadId}/status`, session.cookieHeader, 21);
  assert(binaryStatus.uploadId === uploadId, 'binary upload status should return matching uploadId');

  const binaryPartMap = await fetchBinaryFrame(`/api/binary/upload/${uploadId}/status/parts`, session.cookieHeader, 24);
  assert(Array.isArray(binaryPartMap.uploadedRanges) && binaryPartMap.uploadedRanges.length > 0, 'binary upload part map should include uploaded ranges');

  const abort = await authBinary(`/api/File/upload/${uploadId}`, {
    method: 'DELETE',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    requiresPow: true,
    headers: { Origin: trustedOrigin }
  });
  assert(abort.response.ok, `abort upload failed: ${abort.response.status}`);

  const afterAbort = await authBinary(`/api/File/upload/${uploadId}/status`, {
    method: 'GET',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    requiresPow: true
  });
  assert(!afterAbort.response.ok, 'aborted upload status should no longer be retrievable');

  const secondInit = await authBinary('/api/File/upload/init', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    requiresPow: true,
    headers: { Origin: trustedOrigin },
    body: {
      fileName: 'resilience-check-2.png',
      mimeType: 'image/png',
      targetFormat: 'png',
      totalBytes: pngSample.length,
      chunkSize: pngSample.length
    }
  });
  assert(secondInit.response.ok, `second upload init failed: ${secondInit.response.status}`);
  const secondUploadId = (secondInit.payload?.data ?? secondInit.payload)?.uploadId;
  assert(typeof secondUploadId === 'string' && secondUploadId.length > 0, 'second upload init missing uploadId');

  const cleanupSecond = await authBinary(`/api/File/upload/${secondUploadId}`, {
    method: 'DELETE',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    requiresPow: true,
    headers: { Origin: trustedOrigin }
  });
  assert(cleanupSecond.response.ok, `second upload cleanup failed: ${cleanupSecond.response.status}`);

  const tinyInit = await authBinary('/api/File/upload/init', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    requiresPow: true,
    headers: { Origin: trustedOrigin },
    body: {
      fileName: 'tiny-boundary.png',
      mimeType: 'image/png',
      targetFormat: 'png',
      totalBytes: tinySample.length,
      chunkSize: tinySample.length
    }
  });
  assert(tinyInit.response.ok, `tiny upload init failed: ${tinyInit.response.status}`);
  const tinyUploadId = (tinyInit.payload?.data ?? tinyInit.payload)?.uploadId;
  const tinyUploadToken = (tinyInit.payload?.data ?? tinyInit.payload)?.uploadToken;
  assert(typeof tinyUploadId === 'string' && tinyUploadId.length > 0, 'tiny upload init missing uploadId');
  assert(typeof tinyUploadToken === 'string' && tinyUploadToken.length > 0, 'tiny upload init missing uploadToken');
  await uploadPart(tinyUploadId, tinyUploadToken, session, 0, 0, tinySample, true);
  const cleanupTiny = await authBinary(`/api/File/upload/${tinyUploadId}`, {
    method: 'DELETE',
    cookieHeader: session.cookieHeader,
    deviceFingerprint,
    requiresPow: true,
    headers: { Origin: trustedOrigin }
  });
  assert(cleanupTiny.response.ok, `tiny upload cleanup failed: ${cleanupTiny.response.status}`);

  console.log(`[check-upload-resilience] ok | base=${baseUrl}`);
}

if (isDirectExecution(import.meta.url)) {
  runUploadResilience().catch((error) => reportDirectFailure('check-upload-resilience', error));
}

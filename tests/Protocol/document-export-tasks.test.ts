import { deepEqual, equal, rejects, throws } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  decodeDocumentExportCreate, decodeDocumentExportTask, decodeDocumentExportTaskList, decodeDocumentExportTaskRef,
  downloadDocumentExportTask, encodeDocumentExportCreate, encodeDocumentExportTaskRef,
  type DocumentExportCreate, type DocumentExportTask,
} from '../../src/Contracts/document-export-tasks.ts';
import { FrameType, WireHeaders } from '../../src/Contracts/wire.generated.ts';

const creation: DocumentExportCreate = {
  id: 'fedcba98-7654-4321-8fed-0123456789ab', article: 0x12345678, revision: 0x20_0000_0000_0003n,
  sourceRevision: 0x20_0000_0000_0001n, format: 'docx',
};
const creationBytes = Buffer.from('fedcba98765443218fed0123456789ab785634120300000000002000010000000000200003', 'hex');
const taskBytes = Buffer.concat([
  creationBytes,
  // Succeeded, no failure, provider one, and four signed little-endian millisecond dates.
  Buffer.from('03000105040302010000000d0403020100000017040302010000001c04030201000000', 'hex'),
  Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex'),
  Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf00100000', 'hex'),
]);

test('document export creation and task reference preserve closed formats and RFC UUID bytes', () => {
  equal(FrameType.DocumentExportCreate, 33044);
  equal(FrameType.DocumentExportTaskRef, 33045);
  const frame = encodeDocumentExportCreate(creation);
  const reference = encodeDocumentExportTaskRef(creation.id);
  deepEqual(Buffer.from(decodeFrame(frame, FrameType.DocumentExportCreate).payload), creationBytes);
  deepEqual(decodeDocumentExportCreate(creationBytes), creation);
  deepEqual(Buffer.from(decodeFrame(reference, FrameType.DocumentExportTaskRef).payload), creationBytes.subarray(0, 16));
  equal(decodeDocumentExportTaskRef(creationBytes.subarray(0, 16)), creation.id);
  throws(() => decodeFrame(frame, FrameType.DocumentExportTaskRef), ProtocolError);
  throws(() => decodeFrame(reference, FrameType.DocumentExportCreate), ProtocolError);
  throws(() => decodeDocumentExportTaskRef(new Uint8Array(16)), ProtocolError);
  throws(() => decodeDocumentExportTaskRef(creationBytes.subarray(0, 17)), ProtocolError);
  for (const [index, format] of (['html', 'pdf', 'docx', 'epub'] as const).entries()) {
    const bytes = Buffer.from(creationBytes);
    bytes[36] = index + 1;
    deepEqual(decodeDocumentExportCreate(bytes), { ...creation, format });
  }
  for (const value of [
    { ...creation, article: 0 }, { ...creation, article: 2_147_483_648 },
    { ...creation, sourceRevision: 0n }, { ...creation, sourceRevision: creation.revision + 1n },
    { ...creation, revision: 9_223_372_036_854_775_808n }, { ...creation, id: '00000000-0000-0000-0000-000000000000' },
  ]) throws(() => encodeDocumentExportCreate(value), ProtocolError);
  const unknown = Buffer.from(creationBytes);
  unknown[36] = 5;
  throws(() => decodeDocumentExportCreate(unknown), ProtocolError);
  throws(() => decodeDocumentExportCreate(creationBytes.subarray(0, -1)), ProtocolError);
  throws(() => decodeDocumentExportCreate(Buffer.concat([creationBytes, Uint8Array.of(0)])), ProtocolError);
});

test('document export receipt has exact timestamps, hashes and byte count', () => {
  equal(FrameType.DocumentExportTask, 33046);
  equal(taskBytes.length, 140);
  const frame = encodeFrame(FrameType.DocumentExportTask, taskBytes);
  const task = decodeDocumentExportTask(decodeFrame(frame, FrameType.DocumentExportTask).payload);
  deepEqual(task, {
    ...creation, status: 'succeeded', failure: 'none', provider: 1,
    createdUnixMs: 0x1_0203_0405n, startedUnixMs: 0x1_0203_040dn,
    finishedUnixMs: 0x1_0203_0417n, expiresUnixMs: 0x1_0203_041cn,
    sourceHash: Uint8Array.from({ length: 32 }, (_, index) => index),
    outputHash: Uint8Array.from({ length: 32 }, (_, index) => 0xa0 + index),
    outputBytes: 4096,
  });
  for (const [offset, value] of [[36, 0], [37, 8], [38, 5], [39, 2]]) {
    const unknown = Buffer.from(taskBytes);
    unknown[offset] = value;
    throws(() => decodeDocumentExportTask(unknown), ProtocolError);
  }
  const noOutput = Buffer.from(taskBytes);
  noOutput.writeInt32LE(0, 136);
  throws(() => decodeDocumentExportTask(noOutput), ProtocolError);
  const oldStart = Buffer.from(taskBytes);
  oldStart.writeBigInt64LE(task.createdUnixMs - 1n, 48);
  throws(() => decodeDocumentExportTask(oldStart), ProtocolError);
  throws(() => decodeDocumentExportTask(taskBytes.subarray(0, -1)), ProtocolError);
  throws(() => decodeDocumentExportTask(Buffer.concat([taskBytes, Uint8Array.of(0)])), ProtocolError);

  const queued = Buffer.from(taskBytes);
  queued[37] = 1;
  queued.fill(0, 48, 64);
  queued.fill(0, 104, 140);
  equal(decodeDocumentExportTask(queued).status, 'queued');
  equal(decodeDocumentExportTask(queued).finishedUnixMs, 0n);
  equal(decodeDocumentExportTask(queued).outputBytes, 0);
  const leakedOutput = Buffer.from(queued);
  leakedOutput[104] = 1;
  throws(() => decodeDocumentExportTask(leakedOutput), ProtocolError);
  const expiredAtCreation = Buffer.from(queued);
  expiredAtCreation.writeBigInt64LE(task.createdUnixMs, 64);
  throws(() => decodeDocumentExportTask(expiredAtCreation), ProtocolError);
  const running = Buffer.from(queued);
  running[37] = 2;
  throws(() => decodeDocumentExportTask(running), ProtocolError);
  running.writeBigInt64LE(task.startedUnixMs, 48);
  equal(decodeDocumentExportTask(running).status, 'running');
  const failed = Buffer.from(running);
  failed[37] = 4;
  failed.writeBigInt64LE(task.finishedUnixMs, 56);
  throws(() => decodeDocumentExportTask(failed), ProtocolError);
  failed[38] = 2;
  equal(decodeDocumentExportTask(failed).failure, 'provider-unavailable');
  failed[37] = 7;
  throws(() => decodeDocumentExportTask(failed), ProtocolError);
});

test('document export task list has one bounded count byte and fixed-size receipts', () => {
  equal(FrameType.DocumentExportTaskList, 33047);
  const receipts = Array.from({ length: 4 }, (_, index) => {
    const bytes = Buffer.from(taskBytes);
    bytes[15] = index + 1;
    return bytes;
  });
  const payload = Buffer.concat([Uint8Array.of(4), ...receipts]);
  const frame = encodeFrame(FrameType.DocumentExportTaskList, payload);
  deepEqual(decodeDocumentExportTaskList(decodeFrame(frame, FrameType.DocumentExportTaskList).payload),
    receipts.map(decodeDocumentExportTask));
  deepEqual(decodeDocumentExportTaskList(Uint8Array.of(0)), []);
  throws(() => decodeFrame(frame, FrameType.DocumentExportTask), ProtocolError);
  throws(() => decodeDocumentExportTaskList(payload.subarray(0, -1)), ProtocolError);
  throws(() => decodeDocumentExportTaskList(Buffer.concat([Uint8Array.of(5), ...receipts, taskBytes])), ProtocolError);
  throws(() => decodeDocumentExportTaskList(Uint8Array.of(0, 0)), ProtocolError);
});

test('download binds the current handle and validates MIME, exact bytes and digest', async t => {
  const handle = 'a'.repeat(64);
  const attachment = Buffer.from('test document bytes');
  const task: DocumentExportTask = {
    ...decodeDocumentExportTask(taskBytes), format: 'html', outputBytes: attachment.byteLength,
    outputHash: new Uint8Array(createHash('sha256').update(attachment).digest()),
  };
  let type = 'text/html; charset=utf-8';
  let body = attachment;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    equal(url, '/api/v2/authoring/document-exports/download.aeds');
    equal(options.method, 'POST');
    equal(options.credentials, 'same-origin');
    equal(options.redirect, 'error');
    equal(new Headers(options.headers).get(WireHeaders.CurrentSession), handle);
    equal(decodeDocumentExportTaskRef(decodeFrame(options.body as Uint8Array, FrameType.DocumentExportTaskRef).payload), task.id);
    return new Response(new Uint8Array(body), { headers: { 'Content-Type': type } });
  });

  const signal = new AbortController().signal;
  const blob = await downloadDocumentExportTask(task, handle, signal);
  equal(blob.type, 'text/html');
  deepEqual(Buffer.from(await blob.arrayBuffer()), attachment);
  type = 'application/pdf';
  await rejects(downloadDocumentExportTask(task, handle, signal), ProtocolError);
  type = 'text/html';
  body = Buffer.concat([attachment, Uint8Array.of(1)]);
  await rejects(downloadDocumentExportTask(task, handle, signal), ProtocolError);
  body = Buffer.from(attachment);
  body[0] ^= 1;
  await rejects(downloadDocumentExportTask(task, handle, signal), ProtocolError);
});

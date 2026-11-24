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
import { appendByte, captureFetch, hexBytes, rejectBytes, rejectInputs, rejectPatches, rejectWrongLength, withByte, withI32, withI64 } from './fixture-source.ts';

const creation: DocumentExportCreate = {
  id: 'fedcba98-7654-4321-8fed-0123456789ab', article: 0x12345678, revision: 0x20_0000_0000_0003n,
  sourceRevision: 0x20_0000_0000_0001n, format: 'docx',
};
const creationBytes = hexBytes('fedcba98765443218fed0123456789ab785634120300000000002000010000000000200003');
const taskBytes = Buffer.concat([
  creationBytes,
  hexBytes('03000105040302010000000d0403020100000017040302010000001c04030201000000'),
  hexBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
  hexBytes('a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf00100000'),
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
  rejectInputs(decodeDocumentExportTaskRef, [new Uint8Array(16), creationBytes.subarray(0, 17)]);
  for (const [index, format] of (['html', 'pdf', 'docx', 'epub'] as const).entries())
    deepEqual(decodeDocumentExportCreate(withByte(creationBytes, 36, index + 1)), { ...creation, format });
  rejectPatches(encodeDocumentExportCreate, creation, [
    { article: 0 }, { article: 2_147_483_648 }, { sourceRevision: 0n }, { sourceRevision: creation.revision + 1n },
    { revision: 9_223_372_036_854_775_808n }, { id: '00000000-0000-0000-0000-000000000000' },
  ]);
  throws(() => decodeDocumentExportCreate(withByte(creationBytes, 36, 5)), ProtocolError);
  rejectWrongLength(decodeDocumentExportCreate, creationBytes);
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
  for (const provider of [2, 3]) equal(decodeDocumentExportTask(withByte(taskBytes, 39, provider)).provider, provider);
  rejectBytes(decodeDocumentExportTask, taskBytes, [[36, 0], [37, 8], [38, 5], [39, 5]]);
  const provider4 = withByte(taskBytes, 39, 4);
  for (const [index, format] of (['html', 'pdf', 'docx', 'epub'] as const).entries())
    deepEqual(decodeDocumentExportTask(withByte(provider4, 36, index + 1)), { ...task, format, provider: 4 });
  throws(() => decodeDocumentExportTask(withI32(taskBytes, 136, 0)), ProtocolError);
  throws(() => decodeDocumentExportTask(withI64(taskBytes, 48, task.createdUnixMs - 1n)), ProtocolError);
  rejectWrongLength(decodeDocumentExportTask, taskBytes);

  const queued = withByte(taskBytes, 37, 1);
  queued.fill(0, 48, 64);
  queued.fill(0, 104, 140);
  const decodedQueued = decodeDocumentExportTask(queued);
  equal(decodedQueued.status, 'queued');
  equal(decodedQueued.finishedUnixMs, 0n);
  equal(decodedQueued.outputBytes, 0);
  throws(() => decodeDocumentExportTask(withByte(queued, 104, 1)), ProtocolError);
  throws(() => decodeDocumentExportTask(withI64(queued, 64, task.createdUnixMs)), ProtocolError);
  throws(() => decodeDocumentExportTask(withByte(queued, 37, 2)), ProtocolError);
  const running = withI64(withByte(queued, 37, 2), 48, task.startedUnixMs);
  equal(decodeDocumentExportTask(running).status, 'running');
  const failed = withI64(withByte(running, 37, 4), 56, task.finishedUnixMs);
  throws(() => decodeDocumentExportTask(failed), ProtocolError);
  const unavailable = withByte(failed, 38, 2);
  equal(decodeDocumentExportTask(unavailable).failure, 'provider-unavailable');
  throws(() => decodeDocumentExportTask(withByte(unavailable, 37, 7)), ProtocolError);
});

test('document export task list has one bounded count byte and fixed-size receipts', () => {
  equal(FrameType.DocumentExportTaskList, 33047);
  const receipts = Array.from({ length: 4 }, (_, index) => withByte(taskBytes, 15, index + 1));
  const payload = Buffer.concat([Uint8Array.of(4), ...receipts]);
  const frame = encodeFrame(FrameType.DocumentExportTaskList, payload);
  deepEqual(decodeDocumentExportTaskList(decodeFrame(frame, FrameType.DocumentExportTaskList).payload), receipts.map(decodeDocumentExportTask));
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
  let body: Uint8Array = attachment;
  captureFetch(t, ({ url, method, headers, body: reqBody }, init) => {
    equal(url, '/api/v2/authoring/document-exports/download.aeds');
    equal(method, 'POST');
    equal(init?.credentials, 'same-origin');
    equal(init?.redirect, 'error');
    equal(headers.get(WireHeaders.CurrentSession), handle);
    equal(decodeDocumentExportTaskRef(decodeFrame(reqBody, FrameType.DocumentExportTaskRef).payload), task.id);
    return new Response(new Uint8Array(body), { headers: { 'Content-Type': type } });
  });

  const signal = new AbortController().signal;
  const blob = await downloadDocumentExportTask(task, handle, signal);
  equal(blob.type, 'text/html');
  deepEqual(Buffer.from(await blob.arrayBuffer()), attachment);
  const rejectResponse = async (nextType: string, nextBody: Uint8Array) => {
    type = nextType;
    body = nextBody;
    await rejects(downloadDocumentExportTask(task, handle, signal), ProtocolError);
  };
  await rejectResponse('application/pdf', attachment);
  await rejectResponse('text/html', appendByte(attachment, 1));
  await rejectResponse('text/html', withByte(attachment, 0, attachment[0] ^ 1));
});

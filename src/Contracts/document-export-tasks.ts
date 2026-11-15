import { ApiError, encodeFrame, ProtocolError } from './aeds.ts';
import { PodReader, PodWriter } from './binary.ts';
import { request, siteSessionHeader } from './client.ts';
import { FrameType, WireRoutes } from './wire.generated.ts';

const formats = ['html', 'pdf', 'docx', 'epub'] as const;
const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked', 'cancelling'] as const;
const failures = ['none', 'unsupported-input', 'provider-unavailable', 'permission', 'interruption'] as const;
const maximumOutput = 4 * 1024 * 1024;
const outputs = {
  html: { type: 'text/html', limit: 2 * 1024 * 1024 },
  pdf: { type: 'application/pdf', limit: maximumOutput },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', limit: 2 * 1024 * 1024 },
  epub: { type: 'application/epub+zip', limit: 2 * 1024 * 1024 },
} as const;

const nilUuid = '00000000-0000-0000-0000-000000000000';
const maximumRevision = 9_223_372_036_854_775_807n;
const taskBytes = 140;
const hashBytes = 32;
const listCapacity = 4;

export type DocumentExportFormat = typeof formats[number];
export type DocumentExportStatus = typeof statuses[number];
export type DocumentExportFailure = typeof failures[number];

export type DocumentExportCreate = Readonly<{
  id: string;
  article: number;
  revision: bigint;
  sourceRevision: bigint;
  format: DocumentExportFormat;
}>;

export type DocumentExportTask = DocumentExportCreate & Readonly<{
  status: DocumentExportStatus;
  failure: DocumentExportFailure;
  provider: 1;
  createdUnixMs: bigint;
  startedUnixMs: bigint;
  finishedUnixMs: bigint;
  expiresUnixMs: bigint;
  sourceHash: Uint8Array;
  outputHash: Uint8Array;
  outputBytes: number;
}>;

function requireArticle(article: number): void {
  if (!Number.isInteger(article) || article <= 0 || article > 2_147_483_647)
    throw new ProtocolError('Invalid document export article');
}

function requireCoordinates(request: DocumentExportCreate): void {
  requireArticle(request.article);
  if (request.id === nilUuid || request.revision > maximumRevision ||
      request.sourceRevision <= 0n || request.sourceRevision > request.revision || !formats.includes(request.format))
    throw new ProtocolError('Invalid document export coordinates');
}

function readCoordinates(reader: PodReader): DocumentExportCreate {
  const id = reader.uuid(), article = reader.i32(), revision = reader.i64(), sourceRevision = reader.i64();
  const format = formats[reader.fixedBytes(1)[0] - 1];
  if (!format) throw new ProtocolError('Invalid document export format');
  const value = { id, article, revision, sourceRevision, format };
  requireCoordinates(value);
  return value;
}

export function encodeDocumentExportCreate(value: DocumentExportCreate): Uint8Array<ArrayBuffer> {
  requireCoordinates(value);
  const writer = new PodWriter();
  writer.uuid(value.id);
  writer.i32(value.article);
  writer.i64(value.revision);
  writer.i64(value.sourceRevision);
  writer.fixedBytes(Uint8Array.of(formats.indexOf(value.format) + 1));
  return encodeFrame(FrameType.DocumentExportCreate, writer.finish());
}

export function decodeDocumentExportCreate(payload: Uint8Array): DocumentExportCreate {
  const reader = new PodReader(payload);
  const value = readCoordinates(reader);
  reader.finish();
  return value;
}

export function encodeDocumentExportTaskRef(id: string): Uint8Array<ArrayBuffer> {
  if (id === nilUuid) throw new ProtocolError('Invalid document export task');
  const writer = new PodWriter();
  writer.uuid(id);
  return encodeFrame(FrameType.DocumentExportTaskRef, writer.finish());
}

export function decodeDocumentExportTaskRef(payload: Uint8Array): string {
  const reader = new PodReader(payload);
  const id = reader.uuid();
  reader.finish();
  if (id === nilUuid) throw new ProtocolError('Invalid document export task');
  return id;
}

function requireOutput(task: DocumentExportTask): void {
  const { outputBytes, outputHash, status } = task;
  if (outputHash.length !== hashBytes || !Number.isInteger(outputBytes) ||
      (status === 'succeeded' ? outputBytes <= 0 || outputBytes > maximumOutput :
        outputBytes !== 0 || outputHash.some(byte => byte !== 0)))
    throw new ProtocolError('Invalid document export output metadata');
}

function readTask(reader: PodReader): DocumentExportTask {
  const coordinates = readCoordinates(reader);
  const [statusCode, failureCode, provider] = reader.fixedBytes(3);
  const status = statuses[statusCode - 1], failure = failures[failureCode];
  if (!status || !failure || provider !== 1) throw new ProtocolError('Invalid document export task state');
  const createdUnixMs = reader.i64(), startedUnixMs = reader.i64(), finishedUnixMs = reader.i64(), expiresUnixMs = reader.i64();
  const failed = status === 'failed' || status === 'blocked';
  const terminal = failed || status === 'succeeded' || status === 'cancelled';
  const requiresStart = status === 'running' || status === 'cancelling' || status === 'succeeded';
  if (createdUnixMs <= 0n || expiresUnixMs <= createdUnixMs ||
      (startedUnixMs !== 0n && startedUnixMs < createdUnixMs) ||
      (finishedUnixMs !== 0n && (finishedUnixMs < createdUnixMs || finishedUnixMs < startedUnixMs)) ||
      (requiresStart && startedUnixMs === 0n) || terminal !== (finishedUnixMs !== 0n) || failed !== (failure !== 'none'))
    throw new ProtocolError('Invalid document export lifecycle');
  const sourceHash = new Uint8Array(reader.fixedBytes(hashBytes));
  const outputHash = new Uint8Array(reader.fixedBytes(hashBytes));
  const outputBytes = reader.i32();
  const value: DocumentExportTask = {
    ...coordinates, status, failure, provider, createdUnixMs, startedUnixMs, finishedUnixMs, expiresUnixMs,
    sourceHash, outputHash, outputBytes,
  };
  requireOutput(value);
  return value;
}

export function decodeDocumentExportTask(payload: Uint8Array): DocumentExportTask {
  const reader = new PodReader(payload);
  const value = readTask(reader);
  reader.finish();
  return value;
}

export function decodeDocumentExportTaskList(payload: Uint8Array): readonly DocumentExportTask[] {
  const reader = new PodReader(payload);
  const count = reader.fixedBytes(1)[0];
  if (count > listCapacity || payload.length !== 1 + count * taskBytes)
    throw new ProtocolError('Invalid document export task count');
  const tasks = Array.from({ length: count }, () => readTask(reader));
  reader.finish();
  return tasks;
}

function exportHeaders(session: string): HeadersInit {
  const headers = siteSessionHeader(session);
  if (!headers) throw new ProtocolError('Missing current site session');
  return headers;
}

export function listDocumentExportTasks(article: number, session: string, signal: AbortSignal): Promise<readonly DocumentExportTask[]> {
  requireArticle(article);
  const path = WireRoutes.DocumentExportTaskList.replace('{id:int}', String(article));
  return request(path, FrameType.DocumentExportTaskList, payload => {
    const tasks = decodeDocumentExportTaskList(payload);
    if (tasks.some(task => task.article !== article) || new Set(tasks.map(task => task.id)).size !== tasks.length)
      throw new ProtocolError('Unexpected document export task list');
    return tasks;
  }, signal, 'GET', undefined, exportHeaders(session));
}

export function createDocumentExportTask(input: DocumentExportCreate, session: string, signal: AbortSignal): Promise<DocumentExportTask> {
  const { id, article, revision, sourceRevision, format } = input;
  return request(WireRoutes.DocumentExportCreate, FrameType.DocumentExportTask, payload => {
    const task = decodeDocumentExportTask(payload);
    if (task.id !== id.toLowerCase() || task.article !== article || task.revision !== revision ||
        task.sourceRevision !== sourceRevision || task.format !== format)
      throw new ProtocolError('Unexpected document export task');
    return task;
  }, signal, 'POST', encodeDocumentExportCreate(input), exportHeaders(session));
}

export function cancelDocumentExportTask(id: string, session: string, signal: AbortSignal): Promise<DocumentExportTask> {
  return request(WireRoutes.DocumentExportCancel, FrameType.DocumentExportTask, payload => {
    const task = decodeDocumentExportTask(payload);
    if (task.id !== id.toLowerCase()) throw new ProtocolError('Unexpected document export task');
    return task;
  }, signal, 'POST', encodeDocumentExportTaskRef(id), exportHeaders(session));
}

export async function downloadDocumentExportTask(task: DocumentExportTask, session: string, signal: AbortSignal): Promise<Blob> {
  requireOutput(task);
  const output = outputs[task.format];
  if (task.status !== 'succeeded' || !output || task.outputBytes > output.limit)
    throw new ProtocolError('Document export is not ready');
  const { type } = output;
  const bytes = new Uint8Array(task.outputBytes);
  const expectedHash = task.outputHash.slice();
  const headers = new Headers(exportHeaders(session));
  headers.set('Accept', type);
  headers.set('Content-Type', 'application/octet-stream');
  signal.throwIfAborted();
  const response = await fetch(WireRoutes.DocumentExportDownload, {
    method: 'POST', headers, body: encodeDocumentExportTaskRef(task.id),
    credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError('Document export download failed', response.status);
  }
  if (response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== type || !response.body) {
    await response.body?.cancel();
    throw new ProtocolError('Expected a document attachment');
  }

  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > bytes.byteLength - size) {
        await reader.cancel();
        throw new ProtocolError('Document export exceeds its recorded size');
      }
      bytes.set(next.value, size);
      size += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  signal.throwIfAborted();
  if (size !== bytes.length) throw new ProtocolError('Document export differs from its recorded size');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  signal.throwIfAborted();
  if (!hash.every((byte, index) => byte === expectedHash[index]))
    throw new ProtocolError('Document export differs from its recorded digest');
  return new Blob([bytes], { type });
}

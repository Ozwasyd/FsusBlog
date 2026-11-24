import { ApiError, encodePod, ProtocolError } from './aeds.ts';
import { decodePod, PodReader, toHex, ZERO_UUID } from './binary.ts';
import { post, request, siteSessionHeader } from './internal/http.ts';
import { consumeBounded } from './bounded-stream.ts';
import { FrameType, WireHeaders, WireLimits, WireRoutes } from './wire.generated.ts';

const formats = ['html', 'pdf', 'docx', 'epub'] as const;
const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked', 'cancelling'] as const;
const failures = ['none', 'unsupported-input', 'provider-unavailable', 'permission', 'interruption'] as const;
const maximumOutput = 4 * 1024 * 1024;
export const documentOutputs = {
  html: { type: 'text/html', limit: 2 * 1024 * 1024 },
  pdf: { type: 'application/pdf', limit: maximumOutput },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', limit: 2 * 1024 * 1024 },
  epub: { type: 'application/epub+zip', limit: 2 * 1024 * 1024 },
} as const;

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
  provider: 1 | 2 | 3 | 4;
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
  if (request.id === ZERO_UUID || request.revision > maximumRevision ||
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
  return encodePod(FrameType.DocumentExportCreate, writer => writer.uuid(value.id).i32(value.article)
    .i64(value.revision).i64(value.sourceRevision).u8(formats.indexOf(value.format) + 1));
}

export const decodeDocumentExportCreate = (payload: Uint8Array): DocumentExportCreate => decodePod(payload, readCoordinates);

export function encodeDocumentExportTaskRef(id: string): Uint8Array<ArrayBuffer> {
  if (id === ZERO_UUID) throw new ProtocolError('Invalid document export task');
  return encodePod(FrameType.DocumentExportTaskRef, writer => writer.uuid(id));
}

export function decodeDocumentExportTaskRef(payload: Uint8Array): string {
  const id = decodePod(payload, reader => reader.uuid());
  if (id === ZERO_UUID) throw new ProtocolError('Invalid document export task');
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
  if (!status || !failure || (provider !== 1 && provider !== 2 && provider !== 3 && provider !== 4))
    throw new ProtocolError('Invalid document export task state');
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

export const decodeDocumentExportTask = (payload: Uint8Array): DocumentExportTask => decodePod(payload, readTask);

export function decodeDocumentExportTaskList(payload: Uint8Array): readonly DocumentExportTask[] {
  return decodePod(payload, reader => {
    const count = reader.fixedBytes(1)[0];
    if (count > listCapacity || payload.length !== 1 + count * taskBytes)
      throw new ProtocolError('Invalid document export task count');
    return Array.from({ length: count }, () => readTask(reader));
  });
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

export function createDocumentExportTask(input: DocumentExportCreate, session: string, signal: AbortSignal,
  attachment?: string): Promise<DocumentExportTask> {
  const { id, article, revision, sourceRevision, format } = input;
  const headers = new Headers(exportHeaders(session));
  if (attachment !== undefined) headers.set(WireHeaders.HtmlExportAttachment, attachment);
  return post(WireRoutes.DocumentExportCreate, FrameType.DocumentExportTask, payload => {
    const task = decodeDocumentExportTask(payload);
    if (task.id !== id.toLowerCase() || task.article !== article || task.revision !== revision ||
        task.sourceRevision !== sourceRevision || task.format !== format ||
        (attachment === undefined ? task.provider > 2 : task.provider !== (attachment.includes(',') ? 4 : 3)))
      throw new ProtocolError('Unexpected document export task');
    return task;
  }, signal, encodeDocumentExportCreate(input), headers);
}

export function cancelDocumentExportTask(id: string, session: string, signal: AbortSignal): Promise<DocumentExportTask> {
  return post(WireRoutes.DocumentExportCancel, FrameType.DocumentExportTask, payload => {
    const task = decodeDocumentExportTask(payload);
    if (task.id !== id.toLowerCase()) throw new ProtocolError('Unexpected document export task');
    return task;
  }, signal, encodeDocumentExportTaskRef(id), exportHeaders(session));
}

const receiptType = 'application/vnd.fsus.document-export-receipt+json';
const formattingReceiptType = 'application/vnd.fsus.document-export-receipt.v2+json';
const wordWarningLabels = {
  'heading-level-reduced': 'Deep headings use the Word Heading 3 style.',
  'heading-markup-as-text': 'Heading markup is preserved as text.',
  'list-as-text': 'List markers are preserved as text.',
  'quote-as-text': 'Quote markers are preserved as text.',
  'inline-image-as-text': 'Markdown image references are preserved as text.',
  'link-as-text': 'Links are preserved as text.',
  'emphasis-as-text': 'Emphasis markers are preserved as text.',
  'inline-code-as-text': 'Inline code markers are preserved as text.',
  'rule-as-text': 'Thematic breaks are preserved as text.',
  'render-directive-as-code': 'Render directives are preserved as code.',
  'code-language-omitted': 'Code blocks use plain monospace without language highlighting.',
} as const;
const epubWarningLabels = {
  'epub-headings-outside-contents': 'Section headings stay in the chapter. The EPUB table of contents lists only the article title.',
  'epub-code-unhighlighted': 'EPUB preserves code language labels without bundling syntax highlighting.',
} as const;
export const documentWarningLabels = { ...wordWarningLabels, ...epubWarningLabels };
export type DocumentExportWarning = Readonly<{
  code: keyof typeof documentWarningLabels;
  start: number;
  length: number;
  occurrences: number;
}>;

export async function downloadDocumentExportTask(task: DocumentExportTask, session: string, signal: AbortSignal, receipt = false): Promise<Blob> {
  return (await fetchDocumentExport(task, session, signal, receipt ? 1 : 0)).file;
}

export function hasExportWarnings(format: DocumentExportFormat): boolean {
  return format === 'docx' || format === 'epub';
}

export function readExportFormattingReceipt(task: DocumentExportTask, session: string, signal: AbortSignal) {
  if (!hasExportWarnings(task.format)) throw new ProtocolError('This format has no formatting report');
  return fetchDocumentExport(task, session, signal, 2);
}

async function fetchDocumentExport(task: DocumentExportTask, session: string, signal: AbortSignal, version: 0 | 1 | 2) {
  requireOutput(task);
  const output = documentOutputs[task.format];
  if (task.status !== 'succeeded' || !output || task.outputBytes > output.limit)
    throw new ProtocolError('Document export is not ready');
  const type = version === 2 ? formattingReceiptType : version === 1 ? receiptType : output.type;
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

  if (version) {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    await consumeBounded(response.body, 16 * 1024, 'Document export receipt is too large', chunk => { chunks.push(chunk); });
    const file = new Blob(chunks, { type });
    const document = JSON.parse(await file.text());
    signal.throwIfAborted();
    if (document?.version !== version || document.taskId !== task.id || document.article !== task.article ||
        document.expectedRevision !== String(task.revision) || document.sourceRevision !== String(task.sourceRevision) ||
        document.format !== task.format || document.provider !== task.provider || document.sourceSha256 !== toHex(task.sourceHash) ||
        document.output?.mime !== output.type || document.output.bytes !== task.outputBytes ||
        document.output.sha256 !== toHex(expectedHash))
      throw new ProtocolError('Document export receipt differs from the task');
    const warnings: DocumentExportWarning[] = [];
    if (version === 2) {
      if (!Array.isArray(document.warnings)) throw new ProtocolError('Invalid document export warnings');
      const allowed = task.format === 'docx' ? wordWarningLabels : epubWarningLabels;
      const codes = new Set<string>();
      for (const warning of document.warnings) {
        if (typeof warning?.code !== 'string' || !Object.hasOwn(allowed, warning.code) ||
            codes.has(warning.code) || !Number.isSafeInteger(warning.start) || warning.start < 0 ||
            !Number.isSafeInteger(warning.length) || warning.length < 1 || warning.start + warning.length > WireLimits.BodyBytes ||
            !Number.isSafeInteger(warning.occurrences) || warning.occurrences < 1 || warning.occurrences > WireLimits.BodyBytes)
          throw new ProtocolError('Invalid document export warnings');
        codes.add(warning.code);
        warnings.push(warning);
      }
    }
    return { file, warnings };
  }

  const bytes = new Uint8Array(task.outputBytes);
  const size = await consumeBounded(response.body, bytes.length, 'Document export exceeds its recorded size',
    (chunk, offset) => bytes.set(chunk, offset));
  signal.throwIfAborted();
  if (size !== bytes.length) throw new ProtocolError('Document export differs from its recorded size');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  signal.throwIfAborted();
  if (!hash.every((byte, index) => byte === expectedHash[index]))
    throw new ProtocolError('Document export differs from its recorded digest');
  return { file: new Blob([bytes], { type }), warnings: [] };
}

import { encodeFrame, ProtocolError } from './aeds.ts';
import { request, siteSessionHeader, type Draft } from './client.ts';
import { PodReader, PodWriter } from './binary.ts';
import {
  decodeDraft, decodeDraftRevisionBodyInsertion, encodeArticleBodyInsertionCommand,
  FrameType, WireHeader, WireLimits, WireRoutes, type ArticleBodyInsertionCommand, type DraftRevisionBodyInsertion,
} from './wire.generated.ts';

export type BodyInsertion = Readonly<{offset: number; length: number}>;

export function saveWithBodyInsertion(input: ArticleBodyInsertionCommand, session: string,
  signal: AbortSignal): Promise<Draft> {
  const frame = encodeFrame(FrameType.ArticleBodyInsertionCommand, encodeArticleBodyInsertionCommand(input));
  return request(WireRoutes.Save, FrameType.Draft, payload => {
    const draft = decodeDraft(payload);
    if (draft.id !== input.id || draft.revision !== input.expectedRevision + 1n)
      throw new ProtocolError('Invalid saved body insertion coordinates');
    return draft;
  }, signal, 'POST', frame, siteSessionHeader(session));
}

export function readBodyInsertion(id: number, revision: bigint, sourceRevision: bigint, session: string,
  signal: AbortSignal): Promise<DraftRevisionBodyInsertion> {
  const path = WireRoutes.DraftRevisionComparison.replace('{id:int}', String(id))
    .replace('{sourceRevision:long}', String(sourceRevision));
  return request(`${path}?revision=${revision}&map=body-insertion`, FrameType.DraftRevisionBodyInsertion, payload => {
    const map = decodeDraftRevisionBodyInsertion(payload);
    if (map.id !== id || map.revision !== revision || map.sourceRevision !== sourceRevision)
      throw new ProtocolError('Invalid revision body map coordinates');
    if (!map.available && (map.offset !== 0 || map.length !== 0 || map.body || map.sourceBody || map.digest || map.sourceDigest))
      throw new ProtocolError('Invalid missing revision body map');
    return map;
  }, signal, 'GET', undefined, siteSessionHeader(session));
}

export type ArticleBodyInsertionsCommand = Readonly<Omit<ArticleBodyInsertionCommand, 'offset' | 'length'> & {
  insertions: readonly BodyInsertion[];
}>;
export type DraftRevisionBodyInsertionEdge = Readonly<{
  sourceDigest: string;
  digest: string;
  insertions: readonly BodyInsertion[];
}>;
export type DraftRevisionBodyInsertionChain = Readonly<{
  id: number;
  revision: bigint;
  sourceRevision: bigint;
  available: boolean;
  sourceBody: string;
  body: string;
  edges: readonly DraftRevisionBodyInsertionEdge[];
}>;

export function encodeArticleBodyInsertionsCommand(value: ArticleBodyInsertionsCommand): Uint8Array<ArrayBuffer> {
  validateCommand(value);
  const writer = new PodWriter();
  writer.i32(value.id);
  writer.i64(value.expectedRevision);
  writer.uuid(value.idempotencyKey);
  writer.text(value.title, WireLimits.TitleBytes);
  writer.text(value.body, WireLimits.BodyBytes);
  writer.i32(value.insertions.length);
  for (const { offset, length } of value.insertions) {
    writer.i32(offset);
    writer.i32(length);
  }
  return encodeFrame(FrameType.ArticleBodyInsertionsCommand, writer.finish());
}

export function decodeArticleBodyInsertionsCommand(payload: Uint8Array): ArticleBodyInsertionsCommand {
  if (payload.length > WireLimits.MaxArticleBodyInsertionsCommandFrameBytes - WireHeader.HeaderSize) throw invalidChain();
  const reader = new PodReader(payload);
  const value = {
    id: reader.i32(), expectedRevision: reader.i64(), idempotencyKey: reader.uuid(),
    title: reader.text(WireLimits.TitleBytes), body: reader.text(WireLimits.BodyBytes), insertions: readInsertions(reader),
  };
  reader.finish();
  validateCommand(value);
  return value;
}

export function decodeDraftRevisionBodyInsertionChain(payload: Uint8Array): DraftRevisionBodyInsertionChain {
  if (payload.length > WireLimits.MaxDraftRevisionBodyInsertionChainFrameBytes - WireHeader.HeaderSize) throw invalidChain();
  const reader = new PodReader(payload);
  const id = reader.i32(), revision = reader.i64(), sourceRevision = reader.i64(), available = reader.bool();
  const sourceBody = reader.text(WireLimits.BodyBytes), body = reader.text(WireLimits.BodyBytes), count = reader.i32();
  if (id <= 0 || sourceRevision <= 0n || sourceRevision >= revision || count < 0 || count > WireLimits.ArticleBodyInsertionChainEdges ||
      (available ? BigInt(count) !== revision - sourceRevision : count !== 0 || sourceBody !== '' || body !== '')) throw invalidChain();

  const edges: DraftRevisionBodyInsertionEdge[] = [];
  let bodyLength = sourceBody.length;
  let previousDigest = '';
  const hexDigest = /^[0-9a-f]{64}$/;
  for (let index = 0; index < count; index++) {
    const sourceDigest = reader.text(WireLimits.ArticleBodyInsertionDigestBytes);
    const digest = reader.text(WireLimits.ArticleBodyInsertionDigestBytes);
    const insertions = readInsertions(reader);
    if (!hexDigest.test(sourceDigest) || !hexDigest.test(digest) || (index !== 0 && sourceDigest !== previousDigest) ||
        (insertions.length === 0 && sourceDigest !== digest)) throw invalidChain();
    bodyLength = lengthAfterInsertions(bodyLength, insertions);
    previousDigest = digest;
    edges.push({ sourceDigest, digest, insertions });
  }
  if (bodyLength !== body.length) throw invalidChain();
  reader.finish();
  return { id, revision, sourceRevision, available, sourceBody, body, edges };
}

export function saveWithBodyInsertions(input: ArticleBodyInsertionsCommand, session: string, signal: AbortSignal): Promise<Draft> {
  return request(WireRoutes.Save, FrameType.Draft, payload => {
    const draft = decodeDraft(payload);
    if (draft.id !== input.id || draft.revision !== input.expectedRevision + 1n || draft.body !== input.body)
      throw invalidChain();
    return draft;
  }, signal, 'POST', encodeArticleBodyInsertionsCommand(input), siteSessionHeader(session));
}

export function readBodyInsertionChain(id: number, revision: bigint, sourceRevision: bigint, session: string,
  signal: AbortSignal): Promise<DraftRevisionBodyInsertionChain> {
  const path = WireRoutes.DraftRevisionComparison.replace('{id:int}', String(id))
    .replace('{sourceRevision:long}', String(sourceRevision));
  return request(`${path}?revision=${revision}&map=body-chain`, FrameType.DraftRevisionBodyInsertionChain, payload => {
    const chain = decodeDraftRevisionBodyInsertionChain(payload);
    if (chain.id !== id || chain.revision !== revision || chain.sourceRevision !== sourceRevision) throw invalidChain();
    return chain;
  }, signal, 'GET', undefined, siteSessionHeader(session));
}

function readInsertions(reader: PodReader): BodyInsertion[] {
  const count = reader.i32();
  if (count < 0 || count > WireLimits.ArticleBodyInsertionOperations) throw invalidChain();
  return Array.from({ length: count }, () => ({ offset: reader.i32(), length: reader.i32() }));
}

function validateCommand(value: ArticleBodyInsertionsCommand): void {
  if (value.id <= 0 || value.expectedRevision <= 0n || value.idempotencyKey === '00000000-0000-0000-0000-000000000000' ||
      value.insertions.length < 1 || value.insertions.length > WireLimits.ArticleBodyInsertionOperations) throw invalidChain();
  const sourceLength = value.body.length - value.insertions.reduce((total, operation) => total + operation.length, 0);
  if (lengthAfterInsertions(sourceLength, value.insertions) !== value.body.length) throw invalidChain();
}

function lengthAfterInsertions(length: number, insertions: readonly BodyInsertion[]): number {
  if (!Number.isSafeInteger(length) || length < 0 || length > WireLimits.BodyBytes) throw invalidChain();
  for (const insertion of insertions) {
    if (!Number.isSafeInteger(insertion.offset) || !Number.isSafeInteger(insertion.length) || insertion.offset < 0 ||
        insertion.offset > length || insertion.length <= 0 || insertion.length > WireLimits.BodyBytes - length) throw invalidChain();
    length += insertion.length;
  }
  return length;
}

function invalidChain(): ProtocolError {
  return new ProtocolError('Invalid saved body insertion chain');
}

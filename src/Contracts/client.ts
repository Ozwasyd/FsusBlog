import { ApiError, decodeApiError, decodeFrame, decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import { decodeInboxReplay, validReplayCursor } from './inbox-replay.ts';
import { decodeInboxList, decodeInboxThread, type InboxFilter } from './inbox.ts';
import { PodWriter } from './binary.ts';
import { decodeArticle, decodeArticleList, decodeSearch } from './public-articles.ts';
import {
  type ArticleCommand,
  type Draft,
  FrameType,
  type Session as WireSession,
  WireHeader,
  WireHeaders,
  WireLimits,
  WireRoutes,
  decodeDraft,
  decodeSession,
  encodeArticleCommand,
  encodeSignIn,
} from './wire.generated.ts';

export { ApiError, ProtocolError } from './aeds.ts';
export type { Article, ArticleCard } from './public-articles.ts';
export type { ArticleCommand, Draft } from './wire.generated.ts';
export type { InboxReplay, InboxReplayEvent } from './inbox-replay.ts';
export type { InboxFilter, InboxListItem, InboxListPage, InboxMessage, InboxThread } from './inbox.ts';
export type Session = Readonly<WireSession & { expiresAt: number }>;

export async function request<T>(
  path: string,
  expected: FrameType,
  decode: (payload: Uint8Array, headers: Headers) => T,
  signal: AbortSignal | undefined,
  method = 'GET',
  body?: Uint8Array<ArrayBuffer> | Blob,
  headersInit?: HeadersInit,
): Promise<T> {
  const contentType = 'application/octet-stream';
  const headers = new Headers(headersInit);
  headers.set('Accept', contentType);
  if (body && !headers.has('Content-Type')) headers.set('Content-Type', contentType);
  const options: RequestInit = { method, credentials: 'same-origin', redirect: 'error', headers };
  if (body) options.body = body;
  if (signal) options.signal = signal;

  const response = await fetch(path, options);
  if (response.headers.get('Content-Type')?.split(';')[0].trim() !== contentType) {
    if (!response.ok) throw new ApiError(response.statusText || 'Request failed', response.status);
    throw new ProtocolError('Expected an AEDS response');
  }

  const frame = decodeFrame(await readResponse(response));
  if (frame.type === FrameType.ApiError) throw decodeApiError(frame.payload, response.status);
  if (!response.ok || frame.type !== expected) throw new ProtocolError('Unexpected AEDS response');
  return decode(frame.payload, response.headers);
}

async function readResponse(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new ProtocolError('Missing AEDS response body');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > WireHeader.HeaderSize + WireLimits.MaxPayloadBytes) {
        await reader.cancel();
        throw new ProtocolError('AEDS response exceeds its byte limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function commandFrame(command: ArticleCommand): Uint8Array<ArrayBuffer> {
  return encodeFrame(FrameType.ArticleCommand, encodeArticleCommand(command));
}

function command(path: string, value: ArticleCommand, signal?: AbortSignal): Promise<Draft> {
  return request(path, FrameType.Draft, readDraft, signal, 'POST', commandFrame(value));
}

function readSession(payload: Uint8Array, headers: Headers): Session {
  const session = decodeSession(payload);
  const rawExpiry = headers.get(WireHeaders.AccessExpiresAtUtc);
  const expiresAt = rawExpiry && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$/.test(rawExpiry)
    ? Date.parse(rawExpiry)
    : NaN;
  if (session.name.length === 0 || session.generation <= 0n || !Number.isFinite(expiresAt))
    throw new ProtocolError('Invalid operator session');
  return { ...session, expiresAt };
}

function readDraft(payload: Uint8Array): Draft {
  const draft = decodeDraft(payload);
  if (draft.id <= 0 || draft.revision <= 0n)
    throw new ProtocolError('Invalid draft coordinates');
  return draft;
}

async function indexPage(page: number, generation: string | undefined, signal?: AbortSignal) {
  const query = new URLSearchParams({ page: String(page) });
  if (generation) query.set('generation', generation);
  return request(`${WireRoutes.PublicIndex}?${query}`, FrameType.ArticleSearch, (payload, headers) => {
    const indexGeneration = headers.get(WireHeaders.SearchIndexGeneration);
    const pageCount = headers.get(WireHeaders.SearchIndexPages);
    if (indexGeneration === null || !/^(0|[1-9][0-9]{0,18})$/.test(indexGeneration) ||
        (generation !== undefined && generation !== indexGeneration) ||
        pageCount === null || !/^[1-9][0-9]{0,2}$/.test(pageCount) ||
        Number(pageCount) > WireLimits.SearchIndexMaxPages)
      throw new ProtocolError('Invalid public search index coordinates');
    const { articles } = decodeSearch(payload);
    if (articles.length > WireLimits.SearchIndexPageSize)
      throw new ProtocolError('Public search index exceeds its page size');
    return { items: articles, pages: Number(pageCount), generation: indexGeneration };
  }, signal);
}

export type PublicListOptions = {
  archive?: boolean;
  cursor?: string;
  keyword?: string;
  sort?: 'latest' | 'relevance' | 'hot';
};

export const api = {
  publicList(page = 1, size = 10, signal?: AbortSignal, options?: PublicListOptions) {
    const route = options?.archive ? WireRoutes.PublicArchive : WireRoutes.PublicList;
    const query = new URLSearchParams();
    if (options?.cursor !== undefined) query.set('cursor', options.cursor);
    if (options?.keyword !== undefined) query.set('keyword', options.keyword);
    if (options?.sort !== undefined) query.set('sort', options.sort);
    const path = route.replace('{page:int}', String(page)).replace('{size:int}', String(size)) +
      (query.size === 0 ? '' : `?${query}`);
    return request(path, FrameType.ArticleList, payload => {
      const { articles, total, nextCursor } = decodeArticleList(payload);
      return { items: articles, total, nextCursor };
    }, signal);
  },

  publicArticle(id: number, signal?: AbortSignal) {
    return request(WireRoutes.PublicArticle.replace('{id}', String(id)), FrameType.ArticleDetail, decodeArticle, signal);
  },

  search(query: string, signal?: AbortSignal) {
    const search = new URLSearchParams({ q: query });
    return request(`${WireRoutes.PublicSearch}?${search}`, FrameType.ArticleSearch, payload => {
      const { articles, total } = decodeSearch(payload);
      return { items: articles, total };
    }, signal);
  },

  async publicIndex(signal?: AbortSignal) {
    const first = await indexPage(1, undefined, signal);
    const items = [...first.items];
    const articleIds = new Set(items.map(article => article.id));
    if (articleIds.size !== items.length) throw new ProtocolError('Duplicate articles in public search index');
    for (let page = 2; page <= first.pages; page++) {
      const next = await indexPage(page, first.generation, signal);
      if (next.pages !== first.pages || next.items.length === 0)
        throw new ProtocolError('Public search index pages changed');
      for (const article of next.items) {
        if (articleIds.has(article.id)) throw new ProtocolError('Duplicate articles in public search index');
        articleIds.add(article.id);
        items.push(article);
      }
    }
    return { items, total: items.length, generation: first.generation };
  },

  inboxReplay(after?: string, signal?: AbortSignal) {
    if (after !== undefined && !validReplayCursor(after)) throw new ProtocolError('Invalid inbox replay cursor');
    const path = after === undefined ? WireRoutes.InboxReplay : `${WireRoutes.InboxReplay}?${new URLSearchParams({ after })}`;
    return request(path, FrameType.InboxReplay, decodeInboxReplay, signal);
  },

  inboxList(filter: InboxFilter, cursor?: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ size: '20', filter });
    if (cursor) query.set('cursor', cursor);
    return request(`${WireRoutes.InboxList}?${query}`, FrameType.ConversationList, decodeInboxList, signal);
  },

  inboxThread(id: bigint, before?: bigint, signal?: AbortSignal) {
    const path = WireRoutes.InboxDetail.replace('{id:long}', String(id));
    return request(before ? `${path}?beforeMessageId=${before}` : path, FrameType.ConversationDetailV3, decodeInboxThread, signal);
  },

  inboxRead(id: bigint, through: bigint, signal?: AbortSignal) {
    const path = WireRoutes.InboxRead.replace('{id:long}', String(id));
    const fields = new PodWriter();
    fields.i64(through);
    return request(path, FrameType.EmptySuccess, decodeSuccess, signal, 'POST',
      encodeFrame(FrameType.ConversationReadRequest, fields.finish()));
  },

  signIn(ticket: string, signal?: AbortSignal): Promise<Session> {
    const frame = encodeFrame(FrameType.OperatorSignIn, encodeSignIn({ ticket }));
    return request(WireRoutes.SignIn, FrameType.OperatorSession, readSession, signal, 'POST', frame);
  },

  session(signal?: AbortSignal): Promise<Session> {
    return request(WireRoutes.Session, FrameType.OperatorSession, readSession, signal);
  },

  signOut(signal?: AbortSignal): Promise<void> {
    return request(WireRoutes.SignOut, FrameType.EmptySuccess, decodeSuccess, signal, 'POST');
  },

  draft(id: number, signal?: AbortSignal): Promise<Draft> {
    const path = WireRoutes.Draft.replace('{id:int}', String(id));
    return request(path, FrameType.Draft, readDraft, signal);
  },

  save(value: ArticleCommand, signal?: AbortSignal) {
    return command(WireRoutes.Save, value, signal);
  },

  publish(value: ArticleCommand, signal?: AbortSignal) {
    return command(WireRoutes.Publish, value, signal);
  },

  retract(value: ArticleCommand, signal?: AbortSignal) {
    return command(WireRoutes.Retract, value, signal);
  },

  delete(value: ArticleCommand, signal?: AbortSignal): Promise<void> {
    return request(WireRoutes.Delete, FrameType.EmptySuccess, decodeSuccess, signal, 'POST', commandFrame(value));
  },
};

import { encodeFrame } from './aeds.ts';
import { PodReader, ProtocolError } from './binary.ts';
import { getWithSession, postWithSession } from './internal/http-methods.ts';
import {
  decodeAuthorRecentOpenReceipt, encodeAuthorRecentOpenCommand, FrameType, WireLimits, WireRoutes,
  type AuthorRecentOpenCommand,
} from './wire.generated.ts';

export type RecentOpen = Readonly<{ articleId: number; articleRevision: bigint; sequence: bigint; openedAt: number; title: string }>;
export type RecentOpens = Readonly<{ revision: bigint; next: string; items: readonly RecentOpen[] }>;
export type RecentOpenCursor = Readonly<{ revision: bigint; token: string }>;

export async function listRecentOpens(session: string, signal: AbortSignal, cursor?: RecentOpenCursor) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor.token)}` : '';
  return getWithSession(WireRoutes.AuthorRecentOpens + query, FrameType.AuthorRecentOpenPage, payload => {
    const page = decodeRecentOpens(payload);
    if (cursor && page.revision !== cursor.revision)
      throw new ProtocolError('Recent opens cursor did not match the response');
    return page;
  }, signal, session);
}

export async function recordRecentOpen(session: string, signal: AbortSignal, action: Omit<AuthorRecentOpenCommand, 'schemaVersion'>) {
  const command = encodeAuthorRecentOpenCommand({ ...action, schemaVersion: 1 });
  return postWithSession(WireRoutes.AuthorRecentOpens, FrameType.AuthorRecentOpenReceipt, payload => {
    const receipt = decodeAuthorRecentOpenReceipt(payload);
    if (receipt.schemaVersion !== 1 || receipt.revision !== action.expectedRevision + 1n || receipt.requestId !== action.requestId ||
        receipt.articleId !== action.articleId || receipt.articleRevision !== action.articleRevision || receipt.openedAtUnixMs <= 0n)
      throw new ProtocolError('Recent opens receipt did not match the command');
    return receipt;
  }, signal, encodeFrame(FrameType.AuthorRecentOpenCommand, command), session);
}

export function decodeRecentOpens(payload: Uint8Array): RecentOpens {
  const input = new PodReader(payload);
  const schema = input.i32(), revision = input.i64(), next = input.text(WireLimits.AuthorRecentOpenCursorChars), count = input.i32();
  if (schema !== 1 || revision < 0n || count < 0 || count > WireLimits.AuthorRecentOpenPageSize ||
      (revision === 0n && count !== 0) || (next && (next.length !== WireLimits.AuthorRecentOpenCursorChars ||
        !/^[A-Za-z0-9_-]+$/.test(next) || count !== WireLimits.AuthorRecentOpenPageSize)))
    throw new ProtocolError('Invalid recent opens page');
  const items: RecentOpen[] = [];
  const articles = new Set<number>();
  for (let index = 0; index < count; index++) {
    const articleId = input.i32(), articleRevision = input.i64(), sequence = input.i64();
    const openedAt = Number(input.i64()), title = input.text(WireLimits.TitleBytes);
    if (articleId <= 0 || articles.has(articleId) || articleRevision <= 0n || sequence <= 0n || sequence > revision ||
        index > 0 && sequence >= items[index - 1].sequence || !Number.isSafeInteger(openedAt) ||
        openedAt <= 0 || openedAt > 8_640_000_000_000_000 || !title)
      throw new ProtocolError('Invalid recent article open');
    articles.add(articleId);
    items.push({ articleId, articleRevision, sequence, openedAt, title });
  }
  input.finish();
  return { revision, next, items };
}

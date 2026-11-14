import { ApiError, decodeSuccess, ProtocolError } from './aeds.ts';
import { PodReader } from './binary.ts';
import { request } from './client.ts';
import { requestPasskeyAssertion, requestPasskeyAttestation } from './passkey.ts';
import {
  decodeAdminOperationsStatus,
  decodeAdminSessionSnapshot,
  FrameType,
  WireHeaders,
  WireLimits,
  WireRoutes,
  type AdminOperationsStatus as WireAdminOperationsStatus,
} from './wire.generated.ts';

export type AdminSession = Readonly<{ handle: string; generation: bigint; expiresAt: number }>;
export type AdminAuthority = { status: 'unavailable' } | { status: 'signed-out' } | { status: 'active'; session: AdminSession };
export type AdminOperationsStatus = Readonly<Omit<WireAdminOperationsStatus, 'oldestPendingAt'> & { oldestPendingAt: number | null }>;
export type AdminCommentCursor = Readonly<{ articleId: number; commentId: bigint }>;
type AdminQueuedComment = Readonly<AdminCommentCursor & { createdAt: number; displayName: string; body: string }>;
export type AdminCommentQueue = Readonly<{ comments: readonly AdminQueuedComment[]; next: AdminCommentCursor | null }>;

export function validAdminBootstrapToken(ticket: string): boolean {
  return /^[0-9a-f]{64}$/.test(ticket);
}

export async function readAdminAuthority(signal?: AbortSignal): Promise<AdminAuthority> {
  try {
    const session = await request(WireRoutes.AdminSession, FrameType.AdminSessionSnapshot, readAdminSession, signal);
    return { status: 'active', session };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) return { status: 'signed-out' };
      if (error.status === 404) return { status: 'unavailable' };
    }
    throw error;
  }
}

export async function bootstrapAdminPasskey(ticket: string, signal?: AbortSignal): Promise<void> {
  if (!validAdminBootstrapToken(ticket)) throw new ProtocolError('Invalid administrator bootstrap key.');
  const headers = { [WireHeaders.AdminBootstrapToken]: ticket };
  const attestation = await requestPasskeyAttestation(WireRoutes.AdminBootstrapBegin, signal, undefined, headers);
  await request(WireRoutes.AdminBootstrapComplete, FrameType.EmptySuccess, decodeSuccess, signal, 'POST', attestation, headers);
}

export async function signInAdmin(signal?: AbortSignal): Promise<AdminSession> {
  const assertion = await requestPasskeyAssertion(WireRoutes.AdminPasskeyBegin, signal);
  await request(WireRoutes.AdminPasskeyComplete, FrameType.EmptySuccess, decodeSuccess, signal, 'POST', assertion);
  const authority = await readAdminAuthority(signal);
  if (authority.status !== 'active') throw new ProtocolError('The administrator session is unavailable.');
  return authority.session;
}

export async function signOutAdmin(signal?: AbortSignal): Promise<void> {
  await request(WireRoutes.AdminSignOut, FrameType.EmptySuccess, decodeSuccess, signal, 'POST');
}

export function readAdminOperations(signal?: AbortSignal): Promise<AdminOperationsStatus> {
  return request(WireRoutes.AdminOperationsStatus, FrameType.AdminOperationsStatus, readOperationsStatus, signal);
}

export function readAdminCommentQueue(after: AdminCommentCursor | null, signal?: AbortSignal): Promise<AdminCommentQueue> {
  const path = after === null ? WireRoutes.AdminCommentQueue : `${WireRoutes.AdminCommentQueue}?${new URLSearchParams({
    afterComment: String(after.commentId), afterArticle: String(after.articleId),
  })}`;
  return request(path, FrameType.AdminCommentQueue, payload => readCommentQueue(payload, after), signal);
}

function readCommentQueue(payload: Uint8Array, after: AdminCommentCursor | null): AdminCommentQueue {
  const reader = new PodReader(payload);
  const hasMore = reader.bool();
  const count = reader.i32();
  if (count < 0 || count > WireLimits.AdminCommentQueueSize || (hasMore && count !== WireLimits.AdminCommentQueueSize))
    throw new ProtocolError('Invalid administrator moderation queue size.');

  const comments: AdminQueuedComment[] = [];
  let previous = after;
  for (let index = 0; index < count; index++) {
    const articleId = reader.i32();
    const commentId = reader.i64();
    const createdAt = Number(reader.i64());
    const displayName = reader.text(WireLimits.PublicCommentHandleBytes);
    const body = reader.text(WireLimits.AdminCommentQueueBodyBytes);
    if (articleId <= 0 || commentId <= 0n || !Number.isSafeInteger(createdAt) || createdAt <= 0 || createdAt > 8.64e15 ||
        displayName.length === 0 || body.length === 0 ||
        (previous !== null && (commentId < previous.commentId || (commentId === previous.commentId && articleId <= previous.articleId))))
      throw new ProtocolError('Invalid administrator moderation queue row.');

    previous = { articleId, commentId };
    comments.push({ ...previous, createdAt, displayName, body });
  }
  reader.finish();
  return { comments, next: hasMore ? previous : null };
}

function readOperationsStatus(payload: Uint8Array): AdminOperationsStatus {
  const status = decodeAdminOperationsStatus(payload);
  const oldestPendingAt = Number(status.oldestPendingAt);
  if (status.publicationWatermark < 0n || status.pendingPublicationEvents < 0n || !Number.isSafeInteger(oldestPendingAt) ||
      oldestPendingAt < 0 || oldestPendingAt > 8.64e15) throw new ProtocolError('Invalid administrator operations status.');
  return { ...status, oldestPendingAt: oldestPendingAt || null };
}

function readAdminSession(payload: Uint8Array): AdminSession {
  const snapshot = decodeAdminSessionSnapshot(payload);
  const expiresAt = Number(snapshot.expiresAt);
  if (snapshot.handle.length === 0 || snapshot.generation <= 0n || !Number.isSafeInteger(expiresAt) ||
      expiresAt <= 0 || expiresAt > 8.64e15) throw new ProtocolError('Invalid administrator session.');
  return { ...snapshot, expiresAt };
}

import type { HumanReadChallenge, HumanReadSubmitResult } from '@/api/readProof';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { BinaryReader, readInt32, readInt64Number, readSliceRef, readSliceText } from './reader';
import { HUMAN_READ_CHALLENGE_RESPONSE_POD_SIZE, HUMAN_READ_SUBMIT_RESPONSE_POD_SIZE } from './types';

export function mapHumanReadChallengeFromPayload(payload: Uint8Array): HumanReadChallenge {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(HUMAN_READ_CHALLENGE_RESPONSE_POD_SIZE);
  const hasArticleId = pod[24] ?? 0;
  if (hasArticleId > 1) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'human_read_challenge_article_flag_invalid');
  }

  const blob = reader.readBlob();
  if (reader.remaining() !== 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'human_read_challenge_trailing_payload_invalid');
  }

  return {
    token: readSliceText(blob, readSliceRef(pod, 28)),
    scope: readSliceText(blob, readSliceRef(pod, 36)) as HumanReadChallenge['scope'],
    routeKey: readSliceText(blob, readSliceRef(pod, 44)),
    articleId: hasArticleId === 1 ? readInt32(pod, 0) : null,
    minDwellMs: readInt32(pod, 4),
    issuedAt: new Date(readInt64Number(pod, 8)).toISOString(),
    expiresAt: new Date(readInt64Number(pod, 16)).toISOString()
  };
}

export function mapHumanReadSubmitFromPayload(payload: Uint8Array): HumanReadSubmitResult {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(HUMAN_READ_SUBMIT_RESPONSE_POD_SIZE);
  const counted = pod[0] ?? 0;
  if (counted > 1) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'human_read_submit_counted_flag_invalid');
  }

  const blob = reader.readBlob();
  if (reader.remaining() !== 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'human_read_submit_trailing_payload_invalid');
  }

  return {
    counted: counted === 1,
    status: readSliceText(blob, readSliceRef(pod, 4))
  };
}

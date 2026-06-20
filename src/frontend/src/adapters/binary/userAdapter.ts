import type { AdminAccountListItem, PageResult } from '@/api/admin';
import { readPageEnvelope } from './envelopeReaders';
import { BinaryReader, readByte, readFixedUtf8, readInt32, readIsoDate64 } from './reader';
import { USER_LIST_ITEM_POD_SIZE } from './types';

export function mapAdminUserPageFromPayload(payload: Uint8Array): PageResult<AdminAccountListItem> {
  const reader = new BinaryReader(payload);
  return readPageEnvelope(reader, () => readAdminAccountListItem(reader), 'admin_account_page_count_invalid', 'admin_account_page_trailing_payload_invalid');
}

function readAdminAccountListItem(reader: BinaryReader): AdminAccountListItem {
  const pod = reader.readSpan(USER_LIST_ITEM_POD_SIZE);
  const hasPublicHandle = readByte(pod, 200) === 1;
  const passkeyInitialized = readByte(pod, 201) === 1;
  const recoveryInitialized = readByte(pod, 202) === 1;
  const hasPrivacyInitializedAt = readByte(pod, 203) === 1;
  const hasDeletedAt = readByte(pod, 204) === 1;

  return {
    accountId: readInt32(pod, 0),
    status: readInt32(pod, 4),
    riskFlags: readInt32(pod, 8),
    createTime: readIsoDate64(pod, 16),
    privacyInitializedAt: hasPrivacyInitializedAt ? readIsoDate64(pod, 24) : null,
    deletedAt: hasDeletedAt ? readIsoDate64(pod, 32) : null,
    identityKind: readFixedUtf8(pod, 40, 32),
    publicHandle: hasPublicHandle ? readFixedUtf8(pod, 72, 64) : null,
    anonymousCredentialStatus: readFixedUtf8(pod, 136, 32),
    anonymousCredentialLevel: readFixedUtf8(pod, 168, 32),
    passkeyInitialized,
    recoveryInitialized
  };
}

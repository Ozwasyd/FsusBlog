import type { PageResult, UserListItem } from '@/api/admin';
import { readPageEnvelope } from './envelopeReaders';
import { BinaryReader, readByte, readFixedUtf8, readInt32, readIsoDate64 } from './reader';
import { USER_LIST_ITEM_POD_SIZE } from './types';

export function mapAdminUserPageFromPayload(payload: Uint8Array): PageResult<UserListItem> {
  const reader = new BinaryReader(payload);
  return readPageEnvelope(reader, () => readUserListItem(reader), 'admin_user_page_count_invalid', 'admin_user_page_trailing_payload_invalid');
}

function readUserListItem(reader: BinaryReader): UserListItem {
  const pod = reader.readSpan(USER_LIST_ITEM_POD_SIZE);
  const hasLastLoginIp = readByte(pod, 184) === 1;
  const hasLastLoginTime = readByte(pod, 185) === 1;
  const hasDeletedAt = readByte(pod, 196) === 1;

  return {
    id: readInt32(pod, 0),
    status: readInt32(pod, 4),
    createTime: readIsoDate64(pod, 8),
    lastLoginTime: hasLastLoginTime ? readIsoDate64(pod, 16) : undefined,
    username: readFixedUtf8(pod, 24, 64),
    role: readFixedUtf8(pod, 88, 32),
    lastLoginIp: hasLastLoginIp ? readFixedUtf8(pod, 120, 64) : undefined,
    deletedAt: hasDeletedAt ? readIsoDate64(pod, 188) : null
  };
}

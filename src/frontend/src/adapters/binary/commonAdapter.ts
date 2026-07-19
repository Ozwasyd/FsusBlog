import { readInt64Number } from '@/codecs/binary/reader';
import { AppErrorCode, createAppError } from '@/utils/appError';

export function mapEmptySuccessFromPayload(payload: Uint8Array): null
{
    if (payload.byteLength !== 4 || payload[0] !== 1)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'empty_success_payload_invalid');
    }

    return null;
}

export function mapMutationIdFromPayload(payload: Uint8Array): { id: number; rightsSnapshotId?: number; rightsRevisionNo?: number; }
{
    if (payload.byteLength !== 8 && payload.byteLength !== 16)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'mutation_id_payload_invalid');
    }

    if (payload.byteLength === 8)
    {
        return { id: readInt64Number(payload, 0) };
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
        id: view.getInt32(0, true),
        rightsSnapshotId: readInt64Number(payload, 4),
        rightsRevisionNo: view.getInt32(12, true)
    };
}

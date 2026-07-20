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

export function mapMutationIdFromPayload(payload: Uint8Array): { id: number; articleId?: number; revisionId?: number; revisionNo?: number; releaseId?: number; releaseNo?: number; status?: number; rightsSnapshotId?: number; rightsRevisionNo?: number; idempotencyReplay?: boolean; errorCode?: number; }
{
    if (payload.byteLength !== 8 && payload.byteLength !== 16 && payload.byteLength !== 28 && payload.byteLength !== 48)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'mutation_id_payload_invalid');
    }

    if (payload.byteLength === 8)
    {
        return { id: readInt64Number(payload, 0) };
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    if (payload.byteLength === 48)
    {
        const articleId = view.getInt32(0, true);
        return {
            id: articleId,
            articleId,
            revisionId: readInt64Number(payload, 4),
            revisionNo: view.getInt32(12, true),
            releaseId: readInt64Number(payload, 16),
            releaseNo: view.getInt32(24, true),
            status: view.getInt32(28, true),
            rightsSnapshotId: readInt64Number(payload, 32),
            rightsRevisionNo: view.getInt32(40, true),
            idempotencyReplay: payload[44] !== 0,
            errorCode: payload[45]
        };
    }
    if (payload.byteLength === 28)
    {
        return {
            id: view.getInt32(0, true),
            revisionId: readInt64Number(payload, 4),
            revisionNo: view.getInt32(12, true),
            rightsSnapshotId: readInt64Number(payload, 16),
            rightsRevisionNo: view.getInt32(24, true)
        };
    }

    return {
        id: view.getInt32(0, true),
        rightsSnapshotId: readInt64Number(payload, 4),
        rightsRevisionNo: view.getInt32(12, true)
    };
}

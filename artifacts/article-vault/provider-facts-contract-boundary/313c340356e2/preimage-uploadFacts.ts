import type { UploadAssetFactsViewModel } from '@/adapters/binary/uploadAdapter';
import { requestBinaryOnly } from '@/composition/binaryTransport';
import { AppErrorCode, createAppError } from '@/utils/appError';

import { FrameType } from '@wasm/protocol/frame';

import { encodeAedsFrame, writeFixedUtf8 } from './binaryFrame';

/** Read actual committed facts under the original session grant; never fetch preview bytes or issue a reference receipt. */
export async function readCommittedUploadFacts(uploadId: string, uploadToken: string, sha256: string, signal?: AbortSignal): Promise<UploadAssetFactsViewModel>
{
    signal?.throwIfAborted();
    if (!/^[0-9a-f]{32}$/u.test(uploadId) || !/^[0-9a-f]{64}$/u.test(sha256) || !uploadToken)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'upload_asset_facts_request_invalid');
    }
    const payload = new Uint8Array(64);
    writeFixedUtf8(payload, 0, 64, sha256);
    const result = await requestBinaryOnly<UploadAssetFactsViewModel>({
        binaryRoute: { operationId: 'binary_post_upload_uploadId_facts', params: { uploadId } },
        privateScope: 'admin', frameType: FrameType.UploadAssetFacts, signal,
        requestOptions: {
            method: 'POST', requiresPow: true,
            headers: { 'Content-Type': 'application/octet-stream', 'X-Fsus-Upload-Token': uploadToken },
            body: encodeAedsFrame(FrameType.UploadCompleteRequest, payload)
        }
    });
    signal?.throwIfAborted();
    if (result.uploadId !== uploadId || result.sha256 !== sha256)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'upload_asset_facts_binding_invalid');
    }
    return result;
}

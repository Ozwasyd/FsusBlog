import { requestBinaryOnly } from '@/composition/binaryTransport';
import type {
    UploadCompleteViewModel,
    UploadInitViewModel,
    UploadPartMapViewModel,
    UploadPartAckViewModel,
    UploadStatusViewModel
} from '@/contracts/binaryApi';

import { FrameType } from '@wasm/protocol/frame';

import { encodeAedsFrame, writeFixedUtf8 } from './binaryFrame';


export type {
    UploadCompleteViewModel,
    UploadInitViewModel,
    UploadPartMapViewModel,
    UploadPartAckViewModel,
    UploadStatusViewModel
} from '@/contracts/binaryApi';

export interface UploadSessionInitRequest {
    fileName: string;
    mimeType: string;
    targetFormat: string;
    totalBytes: number;
    chunkSize: number;
    sha256?: string;
}

export interface ImageCompressionOptions {
    format: 'webp' | 'avif' | 'png' | 'jpeg' | 'gif';
    quality: number;
    scaleRatio: number;
    maxEdge: number;
    preserveAlpha: boolean;
}

export function initUploadSession(payload: UploadSessionInitRequest, signal?: AbortSignal): Promise<UploadInitViewModel>
{
    const body = encodeAedsFrame(FrameType.UploadInitRequest, encodeUploadInitRequest(payload));
    return requestBinaryOnly<UploadInitViewModel>({
        binaryRoute: { operationId: 'binary_post_upload_init' },
        frameType: FrameType.UploadInit,
        signal,
        requestOptions: {
            headers: {
                'Content-Type': 'application/octet-stream'
            },
            body
        }
    });
}

export function getUploadStatus(uploadId: string, signal?: AbortSignal): Promise<UploadStatusViewModel>
{
    return requestBinaryOnly<UploadStatusViewModel>({
        binaryRoute: { operationId: 'binary_get_upload_uploadId_status', params: { uploadId } },
        frameType: FrameType.UploadStatus,
        signal,
        requestOptions: {
        }
    });
}

export function getUploadPartMap(uploadId: string, signal?: AbortSignal): Promise<UploadPartMapViewModel>
{
    return requestBinaryOnly<UploadPartMapViewModel>({
        binaryRoute: { operationId: 'binary_get_upload_uploadId_status_parts', params: { uploadId } },
        frameType: FrameType.UploadPartMap,
        signal,
        requestOptions: {
        }
    });
}

export function uploadPart(
    uploadId: string,
    uploadToken: string,
    partNumber: number,
    offset: number,
    chunk: Blob,
    payloadHash?: string,
    signal?: AbortSignal
): Promise<UploadPartAckViewModel>
{
    return requestBinaryOnly<UploadPartAckViewModel>({
        binaryRoute: { operationId: 'binary_put_upload_uploadId_part', params: { uploadId } },
        frameType: FrameType.UploadPartAck,
        signal,
        requestOptions: {
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Fsus-Upload-Token': uploadToken,
                'X-Fsus-Upload-Part': String(partNumber),
                'X-Fsus-Upload-Offset': String(offset),
                ...(payloadHash ? { 'X-Fsus-Upload-Payload-Hash': payloadHash } : {})
            },
            body: chunk
        }
    });
}

export function completeUpload(uploadId: string, uploadToken: string, sha256?: string, signal?: AbortSignal): Promise<UploadCompleteViewModel>
{
    const body = encodeAedsFrame(FrameType.UploadCompleteRequest, encodeUploadCompleteRequest(sha256));
    return requestBinaryOnly<UploadCompleteViewModel>({
        binaryRoute: { operationId: 'binary_post_upload_uploadId_complete', params: { uploadId } },
        frameType: FrameType.UploadComplete,
        signal,
        requestOptions: {
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Fsus-Upload-Token': uploadToken
            },
            body
        }
    });
}

export function abortUpload(uploadId: string, signal?: AbortSignal): Promise<UploadStatusViewModel>
{
    return requestBinaryOnly<UploadStatusViewModel>({
        binaryRoute: { operationId: 'binary_delete_upload_uploadId', params: { uploadId } },
        frameType: FrameType.UploadStatus,
        signal,
        requestOptions: {
        }
    });
}

function encodeUploadInitRequest(payload: UploadSessionInitRequest): Uint8Array
{
    const bytes = new Uint8Array(428);
    writeFixedUtf8(bytes, 0, 256, payload.fileName);
    writeFixedUtf8(bytes, 256, 64, payload.mimeType);
    writeFixedUtf8(bytes, 320, 32, payload.targetFormat);
    const view = new DataView(bytes.buffer);
    view.setBigInt64(352, BigInt(payload.totalBytes), true);
    view.setInt32(360, payload.chunkSize, true);
    writeFixedUtf8(bytes, 364, 64, payload.sha256 ?? '');
    return bytes;
}

function encodeUploadCompleteRequest(sha256?: string): Uint8Array
{
    const bytes = new Uint8Array(64);
    writeFixedUtf8(bytes, 0, 64, sha256 ?? '');
    return bytes;
}

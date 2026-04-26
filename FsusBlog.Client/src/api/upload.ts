import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/services/binaryTransport'
import type {
  UploadCompleteViewModel,
  UploadInitViewModel,
  UploadPartMapViewModel,
  UploadPartAckViewModel,
  UploadStatusViewModel
} from '@/adapters/binary/uploadAdapter'

export interface UploadSessionInitRequest {
  fileName: string
  mimeType: string
  targetFormat: string
  totalBytes: number
  chunkSize: number
  sha256?: string
}

export interface ImageCompressionOptions {
  format: 'webp' | 'avif' | 'png' | 'jpeg' | 'gif'
  quality: number
  scaleRatio: number
  maxEdge: number
  preserveAlpha: boolean
}

export function initUploadSession(payload: UploadSessionInitRequest, signal?: AbortSignal): Promise<UploadInitViewModel> {
  return requestBinaryOnly<UploadInitViewModel>({
    binaryUrl: '/api/binary/upload/init',
    frameType: FrameType.UploadInit,
    signal,
    requestOptions: {
      method: 'POST',
      requiresPow: true,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  })
}

export function getUploadStatus(uploadId: string, signal?: AbortSignal): Promise<UploadStatusViewModel> {
  return requestBinaryOnly<UploadStatusViewModel>({
    binaryUrl: `/api/binary/upload/${uploadId}/status`,
    frameType: FrameType.UploadStatus,
    signal,
    requestOptions: {
      method: 'GET',
      requiresPow: true
    }
  })
}

export function getUploadPartMap(uploadId: string, signal?: AbortSignal): Promise<UploadPartMapViewModel> {
  return requestBinaryOnly<UploadPartMapViewModel>({
    binaryUrl: `/api/binary/upload/${uploadId}/status/parts`,
    frameType: FrameType.UploadPartMap,
    signal,
    requestOptions: {
      method: 'GET',
      requiresPow: true
    }
  })
}

export function uploadPart(
  uploadId: string,
  partNumber: number,
  offset: number,
  chunk: Blob,
  payloadHash?: string,
  signal?: AbortSignal
): Promise<UploadPartAckViewModel> {
  const formData = new FormData()
  formData.append('file', chunk, `${uploadId}-${partNumber}.part`)
  formData.append('partNumber', String(partNumber))
  formData.append('offset', String(offset))
  if (payloadHash) {
    formData.append('payloadHash', payloadHash)
  }

  return requestBinaryOnly<UploadPartAckViewModel>({
    binaryUrl: `/api/binary/upload/${uploadId}/part`,
    frameType: FrameType.UploadPartAck,
    signal,
    requestOptions: {
      method: 'PUT',
      requiresPow: true,
      body: formData
    }
  })
}

export function completeUpload(uploadId: string, sha256?: string, signal?: AbortSignal): Promise<UploadCompleteViewModel> {
  return requestBinaryOnly<UploadCompleteViewModel>({
    binaryUrl: `/api/binary/upload/${uploadId}/complete`,
    frameType: FrameType.UploadComplete,
    signal,
    requestOptions: {
      method: 'POST',
      requiresPow: true,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sha256 })
    }
  })
}

export function abortUpload(uploadId: string, signal?: AbortSignal): Promise<UploadStatusViewModel> {
  return requestBinaryOnly<UploadStatusViewModel>({
    binaryUrl: `/api/binary/upload/${uploadId}`,
    frameType: FrameType.UploadStatus,
    signal,
    requestOptions: {
      method: 'DELETE',
      requiresPow: true
    }
  })
}

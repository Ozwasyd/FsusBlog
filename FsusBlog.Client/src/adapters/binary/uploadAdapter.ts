import { decodeJsonPayload } from './jsonPayload';

export interface UploadInitViewModel {
  uploadId: string
  fileName: string
  mimeType: string
  targetFormat: string
  totalBytes: number
  chunkSize: number
  totalParts: number
  expiresAt: string
}

export interface UploadStatusViewModel {
  uploadId: string
  status: string
  totalBytes: number
  uploadedBytes: number
  chunkSize: number
  totalParts: number
  uploadedPartCount: number
  nextPartHint: number
  expiresAt: string
}

export interface UploadPartRangeViewModel {
  start: number
  end: number
}

export interface UploadPartMapViewModel {
  uploadId: string
  uploadedRanges: UploadPartRangeViewModel[]
}

export interface UploadPartAckViewModel {
  uploadId: string
  partNumber: number
  offset: number
  size: number
  uploadedBytes: number
  uploadedPartCount: number
}

export interface UploadCompleteViewModel {
  uploadId: string
  url: string
  relativeUrl: string
  mimeType: string
  totalBytes: number
}

export function mapUploadInitFromPayload(payload: Uint8Array): UploadInitViewModel {
  return decodeJsonPayload<UploadInitViewModel>(payload)
}

export function mapUploadStatusFromPayload(payload: Uint8Array): UploadStatusViewModel {
  return decodeJsonPayload<UploadStatusViewModel>(payload)
}

export function mapUploadPartMapFromPayload(payload: Uint8Array): UploadPartMapViewModel {
  return decodeJsonPayload<UploadPartMapViewModel>(payload)
}

export function mapUploadPartAckFromPayload(payload: Uint8Array): UploadPartAckViewModel {
  return decodeJsonPayload<UploadPartAckViewModel>(payload)
}

export function mapUploadCompleteFromPayload(payload: Uint8Array): UploadCompleteViewModel {
  return decodeJsonPayload<UploadCompleteViewModel>(payload)
}

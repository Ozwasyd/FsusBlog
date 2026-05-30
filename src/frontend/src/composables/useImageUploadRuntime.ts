import { computed, reactive, ref } from 'vue'
import {
  abortUpload,
  completeUpload,
  getUploadPartMap,
  getUploadStatus,
  initUploadSession,
  type ImageCompressionOptions,
  uploadPart
} from '@/api/upload'
import { compressImageFileWithRuntime, sha256Hex, type ImageCompressionPreview } from '@/utils/imageCompression'
import { AppErrorCode, createAppError, toAppError } from '@/utils/appError'
import { getWasmSupportedFormats } from '@/utils/wasmImageCodec'
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'

type UploadPhase = 'idle' | 'compressing' | 'uploading' | 'retrying' | 'paused' | 'error' | 'completed'

interface ResumeSessionSnapshot {
  uploadId: string
  resumeKey: string
  fileName: string
  sha256: string
}

interface PendingAttempt {
  file: File
  options: ImageCompressionOptions
  wasmOnly: boolean
}

const STORAGE_PREFIX = 'fsus:image-upload-session:'
const MAX_RETRIES = 3

function buildResumeKey(file: File, options: ImageCompressionOptions): string {
  return [
    file.name,
    file.size,
    file.lastModified,
    options.format,
    options.quality,
    options.scaleRatio,
    options.maxEdge,
    options.preserveAlpha ? 1 : 0
  ].join(':')
}

function persistSnapshot(snapshot: ResumeSessionSnapshot): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_PREFIX + snapshot.resumeKey, encodePublicAotPayload(snapshot))
}

function readSnapshot(resumeKey: string): ResumeSessionSnapshot | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(STORAGE_PREFIX + resumeKey)
  if (!raw) return null
  try {
    return decodePublicAotPayload<ResumeSessionSnapshot>(raw)
  } catch {
    return null
  }
}

function clearSnapshot(resumeKey: string): void {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(STORAGE_PREFIX + resumeKey)
}

function expandUploadedRanges(ranges: readonly { start: number; end: number }[] | null | undefined): Set<number> {
  const uploadedParts = new Set<number>()
  if (!Array.isArray(ranges)) {
    return uploadedParts
  }

  for (const range of ranges) {
    const start = Number(range.start)
    const end = Number(range.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      continue
    }

    for (let value = start; value <= end; value += 1) {
      uploadedParts.add(value)
    }
  }

  return uploadedParts
}

async function retry<T>(task: () => Promise<T>, onRetry: (attempt: number) => void): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      if (attempt > 0) {
        onRetry(attempt)
      }
      return await task()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }

  if (lastError) {
    throw toAppError(lastError, 'upload_retry_exhausted')
  }

  throw createAppError(AppErrorCode.InfraFailure, 'upload_retry_exhausted')
}

export function useImageUploadRuntime() {
  const phase = ref<UploadPhase>('idle')
  const progress = ref(0)
  const errorMessage = ref('')
  const preview = ref<ImageCompressionPreview | null>(null)
  const pendingAttempt = ref<PendingAttempt | null>(null)
  const wasmSupportedFormats = ref<ImageCompressionOptions['format'][]>(['png'])
  const activeSession = reactive<{ uploadId: string; resumeKey: string; fileName: string }>({
    uploadId: '',
    resumeKey: '',
    fileName: ''
  })

  const statusText = computed(() => {
    switch (phase.value) {
      case 'compressing':
        return '图片压缩中'
      case 'uploading':
        return `上传中 ${progress.value}%`
      case 'retrying':
        return `上传重试中 ${progress.value}%`
      case 'paused':
        return '上传已暂停，可继续'
      case 'error':
        return errorMessage.value || '上传失败'
      case 'completed':
        return '上传完成'
      default:
        return ''
    }
  })

  const canResume = computed(() => phase.value === 'paused' || phase.value === 'error')

  const uploadFile = async (file: File, options: ImageCompressionOptions, runtimeOptions?: { wasmOnly?: boolean }): Promise<string> => {
    phase.value = 'compressing'
    errorMessage.value = ''
    progress.value = 0
    const wasmOnly = runtimeOptions?.wasmOnly ?? false
    pendingAttempt.value = {
      file,
      options: { ...options },
      wasmOnly
    }

    const compressed = await compressImageFileWithRuntime(file, options, { wasmOnly })
    preview.value = compressed.preview

    const resumeKey = buildResumeKey(file, options)
    const fullHash = await sha256Hex(compressed.file)
    let snapshot = readSnapshot(resumeKey)
    let uploadId = ''
    let uploadedParts = new Set<number>()

    if (snapshot?.sha256 === fullHash) {
      try {
        const status = await getUploadStatus(snapshot.uploadId)
        uploadId = status.uploadId
        if (status.uploadedPartCount > 0) {
          const map = await getUploadPartMap(snapshot.uploadId)
          uploadedParts = expandUploadedRanges(map.uploadedRanges)
        }
      } catch {
        snapshot = null
      }
    }

    if (!snapshot || !uploadId) {
      const init = await initUploadSession({
        fileName: compressed.file.name,
        mimeType: compressed.file.type,
        targetFormat: options.format,
        totalBytes: compressed.file.size,
        chunkSize: 512 * 1024,
        sha256: fullHash
      })
      uploadId = init.uploadId
      snapshot = {
        uploadId,
        resumeKey,
        fileName: compressed.file.name,
        sha256: fullHash
      }
      persistSnapshot(snapshot)
    }

    activeSession.uploadId = uploadId
    activeSession.resumeKey = resumeKey
    activeSession.fileName = compressed.file.name

    const chunkSize = 512 * 1024
    const totalParts = Math.ceil(compressed.file.size / chunkSize)
    let uploadedBytes = 0
    uploadedParts.forEach((partNumber) => {
      const start = partNumber * chunkSize
      const end = Math.min(start + chunkSize, compressed.file.size)
      uploadedBytes += Math.max(0, end - start)
    })
    progress.value = Math.min(99, Math.round((uploadedBytes / compressed.file.size) * 100))
    phase.value = 'uploading'

    for (let partNumber = 0; partNumber < totalParts; partNumber += 1) {
      if (uploadedParts.has(partNumber)) {
        continue
      }

      const start = partNumber * chunkSize
      const end = Math.min(start + chunkSize, compressed.file.size)
      const chunk = compressed.file.slice(start, end)
      const payloadHash = await sha256Hex(chunk)

      try {
        const ack = await retry(
          () => uploadPart(uploadId, partNumber, start, chunk, payloadHash),
          () => {
            phase.value = 'retrying'
          }
        )

        uploadedBytes = ack.uploadedBytes
        progress.value = Math.min(99, Math.round((uploadedBytes / compressed.file.size) * 100))
        phase.value = 'uploading'
        uploadedParts.add(partNumber)
      } catch (error) {
        const normalized = toAppError(error, '上传失败，可继续恢复')
        phase.value = 'paused'
        errorMessage.value = normalized.message || '上传失败，可继续恢复'
        persistSnapshot(snapshot)
        throw normalized
      }
    }

    const complete = await completeUpload(uploadId, fullHash)
    phase.value = 'completed'
    progress.value = 100
    errorMessage.value = ''
    clearSnapshot(resumeKey)
    pendingAttempt.value = null
    activeSession.uploadId = ''
    activeSession.resumeKey = ''
    activeSession.fileName = ''
    return complete.url
  }

  const resumeLatest = async (): Promise<string> => {
    const attempt = pendingAttempt.value
    if (!attempt) {
      throw createAppError(AppErrorCode.Validation, '没有可恢复的上传任务')
    }

    return uploadFile(attempt.file, attempt.options, { wasmOnly: attempt.wasmOnly })
  }

  const abandon = async (): Promise<void> => {
    if (!activeSession.uploadId) {
      return
    }

    try {
      await abortUpload(activeSession.uploadId)
    } finally {
      if (activeSession.resumeKey) {
        clearSnapshot(activeSession.resumeKey)
      }
      phase.value = 'idle'
      progress.value = 0
      errorMessage.value = ''
      preview.value = null
      activeSession.uploadId = ''
      activeSession.resumeKey = ''
      activeSession.fileName = ''
    }
  }

  void getWasmSupportedFormats().then((formats) => {
    if (formats.length > 0) {
      wasmSupportedFormats.value = formats
    }
  }).catch(() => {
    wasmSupportedFormats.value = ['png']
  })

  return reactive({
    phase,
    progress,
    errorMessage,
    preview,
    wasmSupportedFormats,
    statusText,
    canResume,
    activeSession,
    uploadFile,
    resumeLatest,
    abandon
  })
}

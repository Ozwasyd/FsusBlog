// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, effectScope } from 'vue'
import { ElMarkdownEditor, type MarkdownEditorDispatchResult, type MarkdownEditorTransaction } from '@ozwasyd/element-plus'
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime'

import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import ImageUploadOptionsPanel from '@/components/ui/ImageUploadOptionsPanel.vue'
import { useImageUploadRuntime, type ImageUploadSessionBorrow } from '@/composables/useImageUploadRuntime'
import { useImageUploadFlow } from '@/composables/useImageUploadFlow'
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext'
import { ArticleAttachmentContextAdapter, type ArticleAttachmentTransactionPort } from '@/services/authoring/articleAttachmentContext'
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext'
import type { ImageCompressionOptions } from '@/api/upload'

const api = vi.hoisted(() => ({
  abortUpload: vi.fn(),
  completeUpload: vi.fn(),
  getUploadPartMap: vi.fn(),
  getUploadStatus: vi.fn(),
  initUploadSession: vi.fn(),
  uploadPart: vi.fn()
}))

const compression = vi.hoisted(() => ({
  compressImageFileWithRuntime: vi.fn(),
  sha256Hex: vi.fn()
}))

vi.mock('@/api/upload', () => api)
vi.mock('@/utils/imageCompression', () => compression)
vi.mock('@/utils/wasmImageCodec', () => ({
  getWasmSupportedFormats: vi.fn().mockResolvedValue(['png', 'webp'])
}))

const options: ImageCompressionOptions = {
  format: 'webp',
  quality: 82,
  scaleRatio: 1,
  maxEdge: 1920,
  preserveAlpha: true
}

const preview = {
  width: 1200,
  height: 800,
  format: 'webp' as const,
  originalBytes: 600_000,
  compressedBytes: 600_000,
  pipeline: 'wasm' as const,
  wasmCapability: 'wasm' as const
}

function fileOf(size: number, name = 'cover.png'): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png', lastModified: 1_700_000_000_000 })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

const borrowCleanup: (() => void)[] = []
afterEach(() => borrowCleanup.splice(0).forEach(dispose => dispose()))

/** Genuine original pending handle, document lease and upstream source/map dispatch. */
function boundAttempt(file: File) {
  let source = 'paragraph'
  const documentOwner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
    editorSessionId: 'session:runtime-borrow', siteScope: 'site:test', userScope: 'user:test', content: source })
  const anchors = new ArticleAnchorContextAdapter(documentOwner)
  const owner = new ArticleAttachmentContextAdapter(documentOwner, 'article-assets', 'version:1', anchors)
  const getBinding = () => ({ document: documentOwner.context,
    map: createMarkdownAnchorMap({ identity: documentOwner.documentIdentity, source }) })
  let commands: { dispatchTransaction(input: MarkdownEditorTransaction): MarkdownEditorDispatchResult }
  const port: ArticleAttachmentTransactionPort = {
    dispatch: transaction => commands.dispatchTransaction(transaction),
    commitSource: result => { source = result.value; if (documentOwner.context.sourceRevision < result.revision)
      documentOwner.updateSource(source, result.revision) },
    binding: getBinding
  }
  const wrapper = mount(ElMarkdownEditor, { props: { mode: 'source', modelValue: source,
    documentIdentity: documentOwner.documentIdentity,
    'onUpdate:modelValue': (value: string) => { source = value; documentOwner.updateSource(value) },
    onTransaction: (result: MarkdownEditorDispatchResult) => owner.consumeTransaction(result, port) } })
  commands = wrapper.vm as unknown as typeof commands
  const anchor = anchors.capture(getBinding(), { start: 0, end: 0, direction: 'none' },
    { affinity: 'after', viewportOffset: 0, percentage: 0, surface: 'source', tool: 'none' })
  const captured = owner.capture({ source, origin: 'pick', anchor,
    files: [{ name: file.name, mimeType: file.type, byteLength: file.size }] })
  if (captured.status !== 'created') throw new Error('capture rejected')
  const intent = owner.commitCreated(captured, port)[0]!
  const lease = documentOwner.beginTask('attachment', 'runtime-borrow')
  const binding = { owner, documentOwner, intent, lease, getBinding }
  expect(owner.readOwnedIntent(intent, getBinding())?.current).toBe(true)
  borrowCleanup.push(() => { owner.dispose(); documentOwner.dispose(); wrapper.unmount() })
  return { binding, commands, source: () => source }
}

function storedSnapshot() {
  const key = Object.keys(localStorage).find((candidate) => candidate.startsWith('fsus:image-upload-session:'))
  expect(key).toBeDefined()
  const snapshot = decodePublicAotPayload<{
    uploadId: string
    resumeKey: string
    fileName: string
    sha256: string
    uploadToken: string
  }>(localStorage.getItem(key ?? '') ?? '')
  expect(snapshot).not.toBeNull()
  return { key: key ?? '', snapshot: snapshot! }
}

async function exhaustPartRetries(runtime: ReturnType<typeof useImageUploadRuntime>, file: File): Promise<void> {
  vi.useFakeTimers()
  api.uploadPart.mockRejectedValue(new Error('part unavailable'))
  const upload = runtime.uploadFile(file, options, { wasmOnly: true })
  const rejection = expect(upload).rejects.toThrow('part unavailable')
  await vi.runAllTimersAsync()
  await rejection
  vi.useRealTimers()
}

describe('useImageUploadRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    compression.compressImageFileWithRuntime.mockImplementation(async (file: File) => ({ file, preview }))
    compression.sha256Hex.mockImplementation(async (blob: Blob) => `sha256-${blob.size}`)
    api.initUploadSession.mockResolvedValue({ uploadId: 'upload-old', uploadToken: 'token-old' })
    api.getUploadStatus.mockResolvedValue({ uploadId: 'upload-old', uploadedPartCount: 0 })
    api.getUploadPartMap.mockResolvedValue({ uploadId: 'upload-old', uploadedRanges: [] })
    api.uploadPart.mockImplementation(async (_uploadId: string, _token: string, _part: number, offset: number, chunk: Blob) => ({
      uploadedBytes: offset + chunk.size
    }))
    api.completeUpload.mockResolvedValue({ url: '/uploads/complete.webp' })
    api.abortUpload.mockResolvedValue({ uploadId: 'upload-old', uploadedPartCount: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('runs compression and hashing before init, uploads every required part, then completes once', async () => {
    const events: string[] = []
    const file = fileOf(600_000)
    compression.compressImageFileWithRuntime.mockImplementation(async (input: File) => {
      events.push('compress')
      return { file: input, preview }
    })
    compression.sha256Hex.mockImplementation(async (blob: Blob) => {
      events.push(blob === file ? 'hash-file' : 'hash-part')
      return `sha256-${blob.size}`
    })
    api.initUploadSession.mockImplementation(async () => {
      events.push('init')
      return { uploadId: 'upload-fresh', uploadToken: 'token-fresh' }
    })
    api.uploadPart.mockImplementation(async (_id: string, _token: string, part: number, offset: number, chunk: Blob) => {
      events.push(`part-${part}`)
      return { uploadedBytes: offset + chunk.size }
    })
    api.completeUpload.mockImplementation(async () => {
      events.push('complete')
      return { url: '/uploads/fresh.webp' }
    })

    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(file, options, { wasmOnly: true })).resolves.toBe('/uploads/fresh.webp')

    expect(events).toEqual(['compress', 'hash-file', 'init', 'hash-part', 'part-0', 'hash-part', 'part-1', 'complete'])
    expect(api.uploadPart).toHaveBeenNthCalledWith(1, 'upload-fresh', 'token-fresh', 0, 0, expect.any(Blob), 'sha256-524288')
    expect(api.uploadPart).toHaveBeenNthCalledWith(2, 'upload-fresh', 'token-fresh', 1, 524_288, expect.any(Blob), 'sha256-75712')
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledWith('upload-fresh', 'token-fresh', 'sha256-600000')
    expect(runtime.phase).toBe('completed')
    expect(runtime.progress).toBe(100)
    expect(runtime.activeSession.uploadId).toBe('')
    expect(localStorage.length).toBe(0)
    await expect(runtime.resumeLatest()).rejects.toThrow('没有可恢复的上传任务')
  })

  it('pauses after part retry exhaustion while retaining the resumable attempt and snapshot', async () => {
    const runtime = useImageUploadRuntime()
    await exhaustPartRetries(runtime, fileOf(128))

    expect(api.uploadPart).toHaveBeenCalledTimes(3)
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(runtime.phase).toBe('paused')
    expect(runtime.errorMessage).toContain('part unavailable')
    expect(runtime.canResume).toBe(true)
    expect(runtime.activeSession.uploadId).toBe('upload-old')
    expect(storedSnapshot().snapshot).toMatchObject({ uploadId: 'upload-old', uploadToken: 'token-old' })
  })

  it('resumes the same file and options with the stored identity and uploads only missing parts', async () => {
    const file = fileOf(600_000)
    const runtime = useImageUploadRuntime()
    vi.useFakeTimers()
    api.uploadPart
      .mockResolvedValueOnce({ uploadedBytes: 524_288 })
      .mockRejectedValue(new Error('part one unavailable'))
    const firstUpload = runtime.uploadFile(file, options, { wasmOnly: true })
    const firstRejection = expect(firstUpload).rejects.toThrow('part one unavailable')
    await vi.runAllTimersAsync()
    await firstRejection
    vi.useRealTimers()

    const firstStorageKey = storedSnapshot().key
    api.uploadPart.mockReset().mockResolvedValue({ uploadedBytes: 600_000 })
    api.getUploadStatus.mockResolvedValue({ uploadId: 'upload-old', uploadedPartCount: 1 })
    api.getUploadPartMap.mockResolvedValue({ uploadId: 'upload-old', uploadedRanges: [{ start: 0, end: 0 }] })

    await expect(runtime.resumeLatest()).resolves.toBe('/uploads/complete.webp')

    expect(compression.compressImageFileWithRuntime).toHaveBeenLastCalledWith(file, options, { wasmOnly: true })
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.getUploadStatus).toHaveBeenCalledWith('upload-old')
    expect(api.getUploadPartMap).toHaveBeenCalledWith('upload-old')
    expect(api.uploadPart).toHaveBeenCalledOnce()
    expect(api.uploadPart).toHaveBeenCalledWith('upload-old', 'token-old', 1, 524_288, expect.any(Blob), 'sha256-75712')
    expect(api.completeUpload).toHaveBeenCalledWith('upload-old', 'token-old', 'sha256-600000')
    expect(Object.keys(localStorage)).not.toContain(firstStorageKey)
  })

  it('initializes a new identity when a stored snapshot is tampered', async () => {
    const file = fileOf(128)
    const runtime = useImageUploadRuntime()
    await exhaustPartRetries(runtime, file)
    const { key, snapshot } = storedSnapshot()
    localStorage.setItem(key, encodePublicAotPayload({ ...snapshot, uploadId: 'upload-tampered' }))
    api.getUploadStatus.mockClear()
    api.initUploadSession.mockResolvedValue({ uploadId: 'upload-new', uploadToken: 'token-new' })
    api.uploadPart.mockReset().mockResolvedValue({ uploadedBytes: 128 })

    await runtime.resumeLatest()

    expect(api.getUploadStatus).toHaveBeenCalledWith('upload-tampered')
    expect(api.initUploadSession).toHaveBeenCalledTimes(2)
    expect(api.uploadPart).toHaveBeenLastCalledWith('upload-new', 'token-new', 0, 0, expect.any(Blob), 'sha256-128')
    expect(api.completeUpload).toHaveBeenLastCalledWith('upload-new', 'token-new', 'sha256-128')
  })

  it('initializes a new identity when stored-session status lookup fails', async () => {
    const file = fileOf(128)
    const runtime = useImageUploadRuntime()
    await exhaustPartRetries(runtime, file)
    api.getUploadStatus.mockRejectedValue(new Error('stale session'))
    api.initUploadSession.mockResolvedValue({ uploadId: 'upload-new', uploadToken: 'token-new' })
    api.uploadPart.mockReset().mockResolvedValue({ uploadedBytes: 128 })

    await runtime.resumeLatest()

    expect(api.getUploadStatus).toHaveBeenCalledWith('upload-old')
    expect(api.uploadPart).toHaveBeenLastCalledWith('upload-new', 'token-new', 0, 0, expect.any(Blob), 'sha256-128')
    expect(api.completeUpload).toHaveBeenLastCalledWith('upload-new', 'token-new', 'sha256-128')
  })

  it('clears local state and calls abort once even when abort fails', async () => {
    // Keep this canonical regression identity. Cancelled live work is cleared,
    // while failed server cleanup must retain its separate session obligation.
    const part = deferred<{ uploadedBytes: number }>()
    api.uploadPart.mockReturnValue(part.promise)
    api.abortUpload.mockRejectedValue(new Error('abort unavailable'))
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(fileOf(128), options)
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())

    await expect(runtime.abandon()).rejects.toThrow('abort unavailable')
    expect(api.abortUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).toHaveBeenCalledWith('upload-old')
    expect(runtime.phase).toBe('error')
    expect(runtime.progress).toBe(0)
    expect(runtime.errorMessage).toBe('abort unavailable')
    expect(runtime.preview).toBeNull()
    expect(runtime.activeSession.uploadId).toBe('upload-old')
    expect(runtime.cleanupRequired).toBe(true)
    expect(runtime.canResume).toBe(false)
    expect(storedSnapshot().snapshot.uploadId).toBe('upload-old')
    await expect(runtime.uploadFile(fileOf(64, 'new.png'), options)).rejects.toThrow('上传会话尚未取消')

    part.resolve({ uploadedBytes: 128 })
    await expect(upload).rejects.toThrow('upload_attempt_superseded')
    expect(api.completeUpload).not.toHaveBeenCalled()
    await expect(runtime.resumeLatest()).rejects.toThrow('没有可恢复的上传任务')
    api.abortUpload.mockResolvedValue({ uploadId: 'upload-old', uploadedPartCount: 0 })
    await runtime.abandon()
    expect(api.abortUpload).toHaveBeenCalledTimes(2)
    expect(runtime.cleanupRequired).toBe(false)
    expect(runtime.phase).toBe('idle')
    expect(runtime.activeSession.uploadId).toBe('')
    expect(localStorage.length).toBe(0)
  })

  it('shares an in-flight abort and blocks replacement until server cleanup is acknowledged', async () => {
    const runtime = useImageUploadRuntime()
    await exhaustPartRetries(runtime, fileOf(128))
    const abort = deferred<{ uploadId: string; uploadedPartCount: number }>()
    api.abortUpload.mockReturnValue(abort.promise)
    const first = runtime.abandon()
    const second = runtime.abandon()
    expect(first).toBe(second)
    await flushPromises()
    expect(api.abortUpload).toHaveBeenCalledOnce()
    expect(runtime.activeSession.uploadId).toBe('upload-old')
    expect(runtime.canResume).toBe(false)
    await expect(runtime.uploadFile(fileOf(64, 'new.png'), options)).rejects.toThrow('上传会话尚未取消')
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    abort.resolve({ uploadId: 'upload-old', uploadedPartCount: 0 })
    await Promise.all([first, second])
    expect(runtime.cleanupRequired).toBe(false)
    expect(localStorage.length).toBe(0)
  })

  it('a late part failure cannot resurrect a cancelled recovery snapshot', async () => {
    const part = deferred<{ uploadedBytes: number }>()
    api.uploadPart.mockReturnValue(part.promise)
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(fileOf(128), options)
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())
    await runtime.abandon()
    part.reject(new Error('late transport failure'))
    await rejected
    expect(runtime.phase).toBe('idle')
    expect(localStorage.length).toBe(0)
    expect(api.completeUpload).not.toHaveBeenCalled()
  })

  it('does not call the API when abandoning without an active session', async () => {
    const runtime = useImageUploadRuntime()
    await runtime.abandon()
    await runtime.abandon()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('does not let a late part acknowledgement overwrite a new upload attempt', async () => {
    const latePart = deferred<{ uploadedBytes: number }>()
    api.initUploadSession
      .mockResolvedValueOnce({ uploadId: 'upload-old', uploadToken: 'token-old' })
      .mockResolvedValueOnce({ uploadId: 'upload-new', uploadToken: 'token-new' })
    api.uploadPart
      .mockReturnValueOnce(latePart.promise)
      .mockResolvedValueOnce({ uploadedBytes: 64 })
    api.completeUpload.mockResolvedValue({ url: '/uploads/new.webp' })
    const runtime = useImageUploadRuntime()
    const oldUpload = runtime.uploadFile(fileOf(128, 'old.png'), options)
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())

    await runtime.abandon()
    await expect(runtime.uploadFile(fileOf(64, 'new.png'), options)).resolves.toBe('/uploads/new.webp')
    latePart.resolve({ uploadedBytes: 128 })
    await expect(oldUpload).rejects.toThrow('upload_attempt_superseded')

    expect(api.abortUpload).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledWith('upload-new', 'token-new', 'sha256-64')
    expect(runtime.phase).toBe('completed')
    expect(runtime.progress).toBe(100)
  })

  it('borrows actual compressed facts and retains a bound handle after public session and original lease clear', async () => {
    const file = fileOf(600_000)
    const original = boundAttempt(file)
    const compressed = new File([new Uint8Array(73)], 'actual.webp', { type: 'image/webp' })
    compression.compressImageFileWithRuntime.mockResolvedValue({ file: compressed, preview })
    compression.sha256Hex.mockImplementation(async (blob: Blob) => blob === compressed ? 'a'.repeat(64) : 'b'.repeat(64))
    let borrow!: ImageUploadSessionBorrow
    const runtime = useImageUploadRuntime()
    await runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: async value => {
      borrow = value
      await value.withSession(async (session, signal) => {
        expect(signal).toBe(value.signal)
        expect(session.uploadId).toBe('upload-old')
        expect(session.uploadToken).toBe('token-old')
        expect(session.sha256).toBe('a'.repeat(64))
        expect(session.totalBytes).toBe(73)
        expect(session.commitMayHaveStarted).toBe(false)
        expect(Object.keys(session)).toEqual([])
        expect(() => JSON.stringify(session)).toThrow('upload_session_borrow_not_serializable')
      })
    } })
    original.binding.lease.complete()
    expect(runtime.activeSession).toEqual({ uploadId: '', resumeKey: '', fileName: '' })
    expect(localStorage.length).toBe(0)
    expect(runtime.borrowCurrentSession()).toBe(borrow)
    await borrow.withSession(async session => {
      expect(session.commitMayHaveStarted).toBe(true)
      expect(session.totalBytes).toBe(73)
      expect(session.sha256).toBe('a'.repeat(64))
    })
    expect(api.completeUpload).toHaveBeenCalledWith('upload-old', 'token-old', 'a'.repeat(64))
    borrow.release()
    expect(borrow.signal.aborted).toBe(true)
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it.each(['clone', 'foreign'] as const)('refuses a %s pending handle before creating a session', async kind => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    const intent = kind === 'clone' ? { ...original.binding.intent } : boundAttempt(file).binding.intent
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(file, options, { attemptBinding: { ...original.binding, intent } }))
      .rejects.toThrow('upload_attempt_superseded')
    expect(api.initUploadSession).not.toHaveBeenCalled()
    expect(runtime.borrowCurrentSession()).toBeNull()
  })

  it.each(['clone', 'foreign'] as const)('refuses a %s document lease through the real original registry', async kind => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    const lease = kind === 'clone' ? { ...original.binding.lease,
      isCurrent: () => true, cancel: original.binding.lease.cancel.bind(original.binding.lease),
      complete: original.binding.lease.complete.bind(original.binding.lease),
      accept: original.binding.lease.accept.bind(original.binding.lease) } : boundAttempt(file).binding.lease
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(file, options, { attemptBinding: { ...original.binding, lease } }))
      .rejects.toThrow('upload_attempt_superseded')
    expect(api.initUploadSession).not.toHaveBeenCalled()
  })

  it('refuses to mint a borrow from a localStorage-only resumed session', async () => {
    const file = fileOf(128)
    const legacy = useImageUploadRuntime()
    await exhaustPartRetries(legacy, file)
    api.uploadPart.mockReset().mockResolvedValue({ uploadedBytes: 128 })
    const original = boundAttempt(file)
    const callback = vi.fn()
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(file, options, { wasmOnly: true,
      attemptBinding: original.binding, onSessionReady: callback })).rejects.toThrow('upload_session_borrow_unavailable')
    expect(callback).not.toHaveBeenCalled()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(runtime.borrowCurrentSession()).toBeNull()
    await runtime.abandon()
  })

  it('expires a completed borrow without refreshing it from public state or storage', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    vi.useFakeTimers()
    let borrow!: ImageUploadSessionBorrow
    const runtime = useImageUploadRuntime()
    await runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => { borrow = value } })
    expect(borrow.isCurrent()).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(borrow.signal.aborted).toBe(true)
    await expect(borrow.withSession(async session => session.totalBytes)).rejects.toThrow('upload_attempt_superseded')
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('waits for a cancelled original initialization and real cleanup acknowledgement before replacement', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    const init = deferred<{ uploadId: string; uploadToken: string }>()
    const abort = deferred<{ uploadId: string; uploadedPartCount: number }>()
    api.initUploadSession.mockReturnValue(init.promise)
    api.abortUpload.mockReturnValue(abort.promise)
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(file, options, { attemptBinding: original.binding })
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.initUploadSession).toHaveBeenCalledOnce())
    await expect(runtime.uploadFile(file, options)).rejects.toThrow('上传尝试仍在执行')
    original.binding.lease.cancel()
    const cleanup = runtime.abandon()
    expect(runtime.cleanupRequired).toBe(true)
    await expect(runtime.uploadFile(file, options)).rejects.toThrow('上传会话尚未取消')
    init.resolve({ uploadId: 'late-original', uploadToken: 'late-original-token' })
    await rejected
    await vi.waitFor(() => expect(api.abortUpload).toHaveBeenCalledWith('late-original'))
    expect(runtime.cleanupRequired).toBe(true)
    expect(runtime.activeSession.uploadId).toBe('late-original')
    abort.resolve({ uploadId: 'late-original', uploadedPartCount: 0 })
    await cleanup
    expect(runtime.cleanupRequired).toBe(false)
    expect(api.uploadPart).not.toHaveBeenCalled()
    expect(runtime.borrowCurrentSession()).toBeNull()
  })

  it('keeps unknown initialization cleanup blocked instead of fabricating an abort acknowledgement', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    const init = deferred<{ uploadId: string; uploadToken: string }>()
    api.initUploadSession.mockReturnValue(init.promise)
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(file, options, { attemptBinding: original.binding })
    const rejected = expect(upload).rejects.toThrow('initialization unknown')
    await vi.waitFor(() => expect(api.initUploadSession).toHaveBeenCalledOnce())
    original.binding.lease.cancel()
    const cleanup = expect(runtime.abandon()).rejects.toThrow('initialization unknown')
    init.reject(new Error('initialization unknown'))
    await Promise.all([rejected, cleanup])
    expect(runtime.cleanupRequired).toBe(true)
    await expect(runtime.abandon()).rejects.toThrow('initialization unknown')
    await expect(runtime.uploadFile(file, options)).rejects.toThrow('上传会话尚未取消')
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('retains true completion history and unknown cleanup after a cancelled completion without deleting it', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    const complete = deferred<{ url: string }>()
    api.completeUpload.mockReturnValue(complete.promise)
    let borrow!: ImageUploadSessionBorrow
    let unavailableMap = false
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(file, options, { attemptBinding: { ...original.binding, getBinding: () => {
      const binding = original.binding.getBinding()
      return unavailableMap ? { ...binding, map: { ...binding.map, syntax: [] } } : binding
    } }, onSessionReady: value => { borrow = value } })
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.completeUpload).toHaveBeenCalledOnce())
    await borrow.withSession(async session => { expect(session.commitMayHaveStarted).toBe(true) })
    unavailableMap = true
    expect(runtime.borrowCurrentSession()).toBeNull()
    original.binding.lease.cancel()
    await expect(runtime.abandon()).rejects.toThrow('upload_commit_state_unknown')
    expect(borrow.signal.aborted).toBe(true)
    complete.resolve({ url: '/uploads/late.webp' })
    await rejected
    expect(runtime.cleanupRequired).toBe(true)
    expect(localStorage.length).toBe(1)
    await expect(runtime.abandon()).rejects.toThrow('upload_commit_state_unknown')
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('uses the existing flow original lease and caller cancellation without creating a second upload', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    const part = deferred<{ uploadedBytes: number }>()
    api.uploadPart.mockReturnValue(part.promise)
    const begin = vi.spyOn(original.binding.documentOwner, 'beginTask')
    const onSuccess = vi.fn()
    const onError = vi.fn()
    let borrow!: ImageUploadSessionBorrow
    const runtime = useImageUploadRuntime()
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: original.binding.documentOwner, getAttemptBinding: () => original.binding,
      onSessionReady: (_file, value) => { borrow = value } })
    const work = flow.startUpload({ files: [file], onSuccess, onError, notifyOnSuccess: false })
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())
    expect(begin).toHaveBeenCalledOnce()
    expect(borrow.isCurrent()).toBe(true)
    flow.cancel()
    await runtime.abandon()
    part.resolve({ uploadedBytes: 128 })
    await work
    expect(borrow.signal.aborted).toBe(true)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(api.abortUpload).toHaveBeenCalledOnce()
  })

  it('revokes a borrow on scope disposal and waits for the original part before settling', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    const part = deferred<{ uploadedBytes: number }>()
    api.uploadPart.mockReturnValue(part.promise)
    const scope = effectScope()
    const runtime = scope.run(() => useImageUploadRuntime())!
    let borrow!: ImageUploadSessionBorrow
    const upload = runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => { borrow = value } })
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())
    scope.stop()
    await runtime.abandon()
    expect(borrow.signal.aborted).toBe(true)
    part.resolve({ uploadedBytes: 128 })
    await rejected
    await expect(runtime.uploadFile(file, options)).rejects.toThrow('upload_attempt_superseded')
    expect(api.completeUpload).not.toHaveBeenCalled()
  })

  it('rereads original document and intent ownership after an asynchronous borrow callback', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    let borrow!: ImageUploadSessionBorrow
    const runtime = useImageUploadRuntime()
    await runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => { borrow = value } })
    const read = deferred<void>()
    const work = borrow.withSession(async session => { await read.promise; return session.totalBytes })
    const rejected = expect(work).rejects.toThrow('upload_attempt_superseded')
    original.binding.documentOwner.switchDocument({ articleId: 2, draftId: 'article:2', content: original.source(), reason: 'article-switch' })
    read.resolve()
    await rejected
    expect(borrow.isCurrent()).toBe(false)
    expect(runtime.borrowCurrentSession()).toBeNull()
  })

  it('invalidates a completed original borrow when a new attempt starts', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    let borrow!: ImageUploadSessionBorrow
    const runtime = useImageUploadRuntime()
    await runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => { borrow = value } })
    await runtime.uploadFile(fileOf(64, 'new.png'), options)
    expect(borrow.signal.aborted).toBe(true)
    await expect(borrow.withSession(async session => session.uploadToken)).rejects.toThrow('upload_attempt_superseded')
    expect(api.abortUpload).not.toHaveBeenCalled()
  })
})

describe('ImageUploadOptionsPanel upload controls', () => {
  it('shows resume and abandon only for the corresponding runtime state and wires both actions', async () => {
    const resume = vi.fn()
    const abandon = vi.fn()
    const button = defineComponent({
      emits: ['click'],
      template: '<button type="button" @click="$emit(\'click\')"><slot /></button>'
    })
    const wrapper = mount(ImageUploadOptionsPanel, {
      props: {
        options,
        statusText: '上传已暂停，可继续',
        canResume: true,
        canAbort: true,
        onResume: resume,
        onAbandon: abandon
      },
      global: {
        stubs: {
          ElButton: button,
          ElFormItem: { template: '<label><slot /></label>' },
          ElSelect: true,
          ElOption: true,
          ElSlider: true,
          ElSwitch: true
        }
      }
    })
    await flushPromises()

    const actionButtons = wrapper.findAll('button').filter((candidate) => ['继续上传', '中止上传'].includes(candidate.text()))
    expect(actionButtons.map((candidate) => candidate.text())).toEqual(['继续上传', '中止上传'])
    await actionButtons[0].trigger('click')
    await actionButtons[1].trigger('click')
    expect(resume).toHaveBeenCalledOnce()
    expect(abandon).toHaveBeenCalledOnce()

    await wrapper.setProps({ canResume: false, canAbort: false })
    expect(wrapper.text()).not.toContain('继续上传')
    expect(wrapper.text()).not.toContain('中止上传')
  })
})

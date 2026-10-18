// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import ImageUploadOptionsPanel from '@/components/ui/ImageUploadOptionsPanel.vue'
import { useImageUploadRuntime } from '@/composables/useImageUploadRuntime'
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
    const part = deferred<{ uploadedBytes: number }>()
    api.uploadPart.mockReturnValue(part.promise)
    api.abortUpload.mockRejectedValue(new Error('abort unavailable'))
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(fileOf(128), options)
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())

    await expect(runtime.abandon()).rejects.toThrow('abort unavailable')
    expect(api.abortUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).toHaveBeenCalledWith('upload-old')
    expect(runtime.phase).toBe('idle')
    expect(runtime.progress).toBe(0)
    expect(runtime.errorMessage).toBe('')
    expect(runtime.preview).toBeNull()
    expect(runtime.activeSession).toMatchObject({ uploadId: '', resumeKey: '', fileName: '' })
    expect(localStorage.length).toBe(0)

    part.resolve({ uploadedBytes: 128 })
    await expect(upload).rejects.toThrow('upload_attempt_superseded')
    expect(api.completeUpload).not.toHaveBeenCalled()
    await expect(runtime.resumeLatest()).rejects.toThrow('没有可恢复的上传任务')
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
})

describe('ImageUploadOptionsPanel upload controls', () => {
  it.each([
    { index: 0, key: 'quality', value: 75 },
    { index: 1, key: 'scaleRatio', value: 0.5 },
    { index: 2, key: 'maxEdge', value: 1024 }
  ] as const)('preserves scalar $key updates and rejects array payloads', async ({ index, key, value }) => {
    const wrapper = mount(ImageUploadOptionsPanel, {
      props: { options },
      global: {
        stubs: {
          ElButton: true,
          ElFormItem: { template: '<label><slot /></label>' },
          ElSelect: true,
          ElOption: true,
          ElSlider: true,
          ElSwitch: true
        }
      }
    })
    const sliders = wrapper.findAllComponents({ name: 'ElSlider' })
    expect(sliders).toHaveLength(3)
    const slider = sliders[index]
    slider.vm.$emit('update:modelValue', [])
    slider.vm.$emit('update:modelValue', [value])
    slider.vm.$emit('update:modelValue', [value, value + 1])
    await flushPromises()
    expect(wrapper.emitted('update:options')).toBeUndefined()

    slider.vm.$emit('update:modelValue', value)
    await flushPromises()
    expect(wrapper.emitted('update:options')).toEqual([[{ [key]: value }]])
    expect(options[key]).toBe({ quality: 82, scaleRatio: 1, maxEdge: 1920 }[key])
    wrapper.unmount()
  })

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

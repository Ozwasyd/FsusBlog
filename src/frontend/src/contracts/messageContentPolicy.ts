import { AppErrorCode, createAppError } from '@/utils/appError'

// Mirrors FsusBlog.Shared.Contracts.Validation.MessageContentPolicy.
export const MESSAGE_CONTENT_LIMITS = Object.freeze({
  subjectMaxScalars: 320,
  subjectMaxGraphemes: 160,
  subjectMaxUtf8Bytes: 640,
  bodyMaxScalars: 8000,
  bodyMaxGraphemes: 4000,
  bodyMaxUtf8Bytes: 16000,
  previewMaxGraphemes: 96,
  maxRequestFrameBytes: 20 * 1024
})

type MessageContentKind = 'subject' | 'body'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const encoder = new TextEncoder()

const graphemes = (value: string): string[] =>
  Array.from(segmenter.segment(value), (entry) => entry.segment)

export function validateMessageContent(value: string, kind: MessageContentKind): void {
  const scalarLimit = kind === 'subject' ? MESSAGE_CONTENT_LIMITS.subjectMaxScalars : MESSAGE_CONTENT_LIMITS.bodyMaxScalars
  const graphemeLimit = kind === 'subject' ? MESSAGE_CONTENT_LIMITS.subjectMaxGraphemes : MESSAGE_CONTENT_LIMITS.bodyMaxGraphemes
  const utf8Limit = kind === 'subject' ? MESSAGE_CONTENT_LIMITS.subjectMaxUtf8Bytes : MESSAGE_CONTENT_LIMITS.bodyMaxUtf8Bytes
  if (!value.trim()) throw createAppError(AppErrorCode.Validation, `message_${kind}_empty`)
  if (Array.from(value).length > scalarLimit) {
    throw createAppError(AppErrorCode.Validation, `message_${kind}_scalar_limit_exceeded`)
  }
  if (graphemes(value).length > graphemeLimit) {
    throw createAppError(AppErrorCode.Validation, `message_${kind}_grapheme_limit_exceeded`)
  }
  if (encoder.encode(value).byteLength > utf8Limit) {
    throw createAppError(AppErrorCode.Validation, `message_${kind}_utf8_limit_exceeded`)
  }
}

export function validateMessageSubject(value: string, fallback: string): string {
  const resolved = value.trim() ? value : fallback
  validateMessageContent(resolved, 'subject')
  return resolved
}

export function validateMessageBody(value: string): string {
  validateMessageContent(value, 'body')
  return value
}

export function assertMessageFrameSize(frame: { readonly byteLength: number }): void {
  if (frame.byteLength > MESSAGE_CONTENT_LIMITS.maxRequestFrameBytes) {
    throw createAppError(AppErrorCode.Validation, 'message_frame_utf8_limit_exceeded')
  }
}

export function truncateMessagePreview(value: string): string {
  const parts = graphemes(value)
  return parts.length <= MESSAGE_CONTENT_LIMITS.previewMaxGraphemes
    ? value
    : `${parts.slice(0, MESSAGE_CONTENT_LIMITS.previewMaxGraphemes).join('')}...`
}

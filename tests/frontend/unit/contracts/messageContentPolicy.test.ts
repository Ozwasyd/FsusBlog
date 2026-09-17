import { describe, expect, it } from 'vitest'
import {
  MESSAGE_CONTENT_LIMITS,
  truncateMessagePreview,
  validateMessageBody,
  validateMessageSubject
} from '@/contracts/messageContentPolicy'

describe('shared message content policy', () => {
  it('preserves mixed Unicode and whitespace instead of normalizing storage content', () => {
    const body = '  中文 e\u0301 😀\n第二行  '
    expect(validateMessageBody(body)).toBe(body)
  })

  it('accepts the exact emoji boundary and rejects grapheme and byte overflow explicitly', () => {
    const exact = '😀'.repeat(MESSAGE_CONTENT_LIMITS.subjectMaxGraphemes)
    expect(validateMessageSubject(exact, 'fallback')).toBe(exact)
    expect(() => validateMessageSubject(`${exact}x`, 'fallback'))
      .toThrow('message_subject_grapheme_limit_exceeded')

    const oversizedBytes = '😀\u0301'.repeat(MESSAGE_CONTENT_LIMITS.subjectMaxGraphemes)
    expect(() => validateMessageSubject(oversizedBytes, 'fallback'))
      .toThrow('message_subject_utf8_limit_exceeded')
  })

  it('truncates previews at a grapheme boundary without changing the stored body', () => {
    const cluster = 'e\u0301'
    const body = cluster.repeat(MESSAGE_CONTENT_LIMITS.previewMaxGraphemes + 1)
    expect(truncateMessagePreview(body)).toBe(
      `${cluster.repeat(MESSAGE_CONTENT_LIMITS.previewMaxGraphemes)}...`
    )
    expect(body).toHaveLength((MESSAGE_CONTENT_LIMITS.previewMaxGraphemes + 1) * 2)
  })
})

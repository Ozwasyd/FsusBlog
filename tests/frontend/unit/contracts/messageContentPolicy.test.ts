import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MESSAGE_CONTENT_LIMITS,
  truncateMessagePreview,
  validateMessageBody,
  validateMessageSubject
} from '@/contracts/messageContentPolicy'

describe('shared message content policy', () => {
  it('stays numerically aligned with the shared C# authority', () => {
    const source = readFileSync(resolve(
      process.cwd(),
      '../../src/shared/Contracts/Validation/MessageContentPolicy.cs'
    ), 'utf8')
    const expected = {
      SubjectMaxScalars: MESSAGE_CONTENT_LIMITS.subjectMaxScalars,
      SubjectMaxGraphemes: MESSAGE_CONTENT_LIMITS.subjectMaxGraphemes,
      SubjectMaxUtf8Bytes: MESSAGE_CONTENT_LIMITS.subjectMaxUtf8Bytes,
      BodyMaxScalars: MESSAGE_CONTENT_LIMITS.bodyMaxScalars,
      BodyMaxGraphemes: MESSAGE_CONTENT_LIMITS.bodyMaxGraphemes,
      BodyMaxUtf8Bytes: MESSAGE_CONTENT_LIMITS.bodyMaxUtf8Bytes,
      PreviewMaxGraphemes: MESSAGE_CONTENT_LIMITS.previewMaxGraphemes
    }
    for (const [name, value] of Object.entries(expected)) {
      expect(source).toMatch(new RegExp(`const int ${name} = ${value};`, 'u'))
    }
    expect(source).toContain('MaxRequestFrameBytes = 20 * 1024')
  })

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

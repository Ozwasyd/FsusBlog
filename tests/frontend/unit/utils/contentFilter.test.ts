import { describe, it, expect } from 'vitest'
import {
  normalizeModerationText,
  scoreContentRisk,
  COMMENT_CONTENT_CONSTRAINT,
  USERNAME_CONSTRAINT,
  validateCommentContent,
  validateUsername
} from '@/utils/contentFilter'

describe('validateCommentContent', () => {
  it('rejects empty string', () => {
    const r = validateCommentContent('')
    expect(r.isValid).toBe(false)
    expect(r.message).toBeTruthy()
  })

  it('rejects whitespace-only string', () => {
    const r = validateCommentContent('   ')
    expect(r.isValid).toBe(false)
  })

  it('accepts normal comment', () => {
    const r = validateCommentContent('这是一条正常的评论。')
    expect(r.isValid).toBe(true)
  })

  it('rejects content over the shared character limit before risk scoring', () => {
    const r = validateCommentContent('a'.repeat(COMMENT_CONTENT_CONSTRAINT.maxChars + 1))
    expect(r.isValid).toBe(false)
    expect(r.message).toBe(COMMENT_CONTENT_CONSTRAINT.charLengthMessage)
  })

  it('rejects content over the shared UTF-8 byte limit before risk scoring', () => {
    const r = validateCommentContent('你'.repeat(Math.floor(COMMENT_CONTENT_CONSTRAINT.maxUtf8Bytes / 3) + 1))
    expect(r.isValid).toBe(false)
    expect(r.message).toBe(COMMENT_CONTENT_CONSTRAINT.byteLengthMessage)
  })

  it('rejects ad/spam content', () => {
    const r = validateCommentContent('加微信号123456赚钱')
    expect(r.isValid).toBe(false)
    expect(r.message).toContain('违规')
  })

  it('rejects content with zero-width characters', () => {
    // Zero-width space U+200B separating characters to bypass filter
    const r = validateCommentContent('加\u200B微\u200B信')
    expect(r.isValid).toBe(false)
  })

  it('normalizes full-width and confusable ad terms before matching', () => {
    const r = validateCommentContent('加ＶＸ处理')
    expect(r.isValid).toBe(false)
  })

  it('exposes explainable risk factors for blocked content', () => {
    const risk = scoreContentRisk('代\u200B写联系 t.cn/abc')
    expect(risk.score).toBeGreaterThanOrEqual(0.9)
    expect(risk.factors).toContain('ad')
    expect(risk.factors).toContain('obfuscation')
    expect(risk.firstMatch).toBeTruthy()
  })

  it('accepts text with common legitimate words containing "习"', () => {
    // "学习" should not be flagged as it's in the whitelist
    const r = validateCommentContent('坚持学习是好习惯')
    expect(r.isValid).toBe(true)
  })

  it('normalizes moderation text with NFKC, zero-width stripping, and confusable mapping', () => {
    expect(normalizeModerationText('薇\u200B信：ＡＢＣ')).toContain('微信:abc')
  })
})

describe('validateUsername', () => {
  it('rejects empty username', () => {
    const r = validateUsername('')
    expect(r.isValid).toBe(false)
  })

  it('rejects username shorter than 3 chars', () => {
    const r = validateUsername('ab')
    expect(r.isValid).toBe(false)
    expect(r.message).toContain('3')
  })

  it('rejects username longer than 20 chars', () => {
    const r = validateUsername('a'.repeat(21))
    expect(r.isValid).toBe(false)
    expect(r.message).toContain('20')
  })

  it('rejects username with digits or separators according to the shared backend constraint', () => {
    const r = validateUsername('user_123')
    expect(r.isValid).toBe(false)
    expect(r.message).toBe(USERNAME_CONSTRAINT.patternMessage)
  })

  it('accepts valid Chinese username', () => {
    const r = validateUsername('张三')
    // 张三 is only 2 chars, should fail length check
    expect(r.isValid).toBe(false)
  })

  it('accepts valid 3-char Chinese username', () => {
    const r = validateUsername('张三丰')
    expect(r.isValid).toBe(true)
  })

  it('rejects reserved words', () => {
    const r = validateUsername('admin')
    expect(r.isValid).toBe(false)
    expect(r.message).toContain('保留')
  })

  it('rejects username with zero-width characters', () => {
    const r = validateUsername('user\u200Bname')
    expect(r.isValid).toBe(false)
    expect(r.message).toContain('隐形')
  })

  it('rejects username with special chars', () => {
    const r = validateUsername('user@domain')
    expect(r.isValid).toBe(false)
  })
})

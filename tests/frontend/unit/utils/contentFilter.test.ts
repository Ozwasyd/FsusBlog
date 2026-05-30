import { describe, it, expect } from 'vitest'
import { validateCommentContent, validateUsername } from '@/utils/contentFilter'

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

  it('accepts text with common legitimate words containing "习"', () => {
    // "学习" should not be flagged as it's in the whitelist
    const r = validateCommentContent('坚持学习是好习惯')
    expect(r.isValid).toBe(true)
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

  it('accepts valid ASCII username', () => {
    const r = validateUsername('user_123')
    expect(r.isValid).toBe(true)
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

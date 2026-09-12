import { describe, it, expect } from 'vitest'
import {
  inspectCommentMarkdownContent,
  normalizeModerationText,
  scoreContentRisk,
  COMMENT_CONTENT_CONSTRAINT,
  PUBLIC_HANDLE_CONSTRAINT,
  validateCommentContent,
  validatePublicHandle
} from '@/utils/contentFilter'

describe('validateCommentContent', () => {
  it('exposes default and hard comment length policy bounds', () => {
    expect(COMMENT_CONTENT_CONSTRAINT.defaultMaxChars).toBe(1000)
    expect(COMMENT_CONTENT_CONSTRAINT.defaultMaxUtf8Bytes).toBe(4096)
    expect(COMMENT_CONTENT_CONSTRAINT.hardMaxChars).toBe(3000)
    expect(COMMENT_CONTENT_CONSTRAINT.hardMaxUtf8Bytes).toBe(12288)
  })

  it('rejects empty string', () => {
    const r = validateCommentContent('')
    expect(r.isValid).toBe(false)
    expect(r.message).toBeTruthy()
  })

  it('rejects whitespace-only string', () => {
    const r = validateCommentContent('   ')
    expect(r.isValid).toBe(false)
  })

  it('accepts safe text markdown and extracts review text without control markers', () => {
    const r = inspectCommentMarkdownContent('**重点** [官网](https://example.com/docs?q=1) `code`')
    expect(r.isValid).toBe(true)
    expect(r.reviewText).toContain('重点')
    expect(r.reviewText).toContain('官网')
    expect(r.reviewText).toContain('example.com/docs')
    expect(r.reviewText).toContain('code')
    expect(r.reviewText).not.toContain('**')
    expect(r.reviewText).not.toContain('](')
  })

  it.each([
    ['inline image', '这里有 ![alt](https://example.com/a.png)'],
    ['reference image', '这里有 ![alt][img]\n\n[img]: https://example.com/a.png'],
    ['raw html image', '这里有 <img src="https://example.com/a.png">'],
    ['raw html block', '<iframe src="https://example.com"></iframe>'],
    ['dangerous link scheme', '[点这里](javascript:alert(1))'],
    ['data link scheme', '[点这里](data:text/html,evil)']
  ])('rejects unsafe comment markdown: %s', (_name, content) => {
    const r = validateCommentContent(content)
    expect(r.isValid).toBe(false)
    expect(r.message).toMatch(/Markdown|HTML|链接|图片/)
  })

  it('rejects content over the shared character limit before risk scoring', () => {
    const r = validateCommentContent('a'.repeat(COMMENT_CONTENT_CONSTRAINT.defaultMaxChars + 1))
    expect(r.isValid).toBe(false)
    expect(r.message).toBe(COMMENT_CONTENT_CONSTRAINT.charLengthMessage)
  })

  it('rejects content over the shared UTF-8 byte limit before risk scoring', () => {
    const r = validateCommentContent('你'.repeat(Math.floor(COMMENT_CONTENT_CONSTRAINT.defaultMaxUtf8Bytes / 3) + 1))
    expect(r.isValid).toBe(false)
    expect(r.message).toBe(COMMENT_CONTENT_CONSTRAINT.byteLengthMessage)
  })

  it('uses the server comment policy when one is provided', () => {
    const policy = { maxChars: 1500, maxUtf8Bytes: 6000 }
    const r = validateCommentContent('a'.repeat(COMMENT_CONTENT_CONSTRAINT.defaultMaxChars + 1), policy)
    const tooLong = validateCommentContent('a'.repeat(policy.maxChars + 1), policy)

    expect(r.isValid).toBe(true)
    expect(tooLong.isValid).toBe(false)
    expect(tooLong.message).toContain('1500')
  })

  it.each([
    ['normal-comment', 'ordinary text', '这是一条正常的评论。'],
    ['ad-spam-post-moderation', 'advertising text for post-publish moderation', '加微信号123456赚钱'],
    ['zero-width-obfuscation', 'zero-width obfuscation for post-publish moderation', '加\u200B微\u200B信'],
    ['full-width-confusable-ad', 'full-width/confusable advertising for post-publish moderation', '加ＶＸ处理'],
    ['legitimate-xi-word', 'legitimate text containing the “习” character', '坚持学习是好习惯']
  ])('allows publish candidate %s: %s', (_caseName, _riskCategory, content) => {
    const callerInput = { content }
    const originalContent = callerInput.content

    const r = validateCommentContent(callerInput.content)

    expect(r.isValid).toBe(true)
    expect(r.message).toBe('')
    expect(callerInput.content).toBe(originalContent)
  })

  it('exposes explainable risk factors for blocked content', () => {
    const risk = scoreContentRisk('代\u200B写联系 t.cn/abc')
    expect(risk.score).toBeGreaterThanOrEqual(0.9)
    expect(risk.factors).toContain('ad')
    expect(risk.factors).toContain('obfuscation')
    expect(risk.firstMatch).toBeTruthy()
  })

  it('normalizes moderation text with NFKC, zero-width stripping, and confusable mapping', () => {
    expect(normalizeModerationText('薇\u200B信：ＡＢＣ')).toContain('微信:abc')
  })
})

describe('validatePublicHandle', () => {
  it('rejects reserved public handles without username wording', () => {
    const r = validatePublicHandle('admin')
    expect(r.isValid).toBe(false)
    expect(r.message).toContain('公开称呼')
    expect(r.message).toContain('保留')
    expect(r.message).not.toContain('用户名')
  })

  it('keeps public handle length and character-set constraints distinct from username copy', () => {
    const short = validatePublicHandle('ab')
    expect(short.isValid).toBe(false)
    expect(short.message).toBe(PUBLIC_HANDLE_CONSTRAINT.lengthMessage)
    expect(short.message).toContain('公开称呼')
    expect(short.message).not.toContain('用户名')

    const invalid = validatePublicHandle('user_123')
    expect(invalid.isValid).toBe(false)
    expect(invalid.message).toBe(PUBLIC_HANDLE_CONSTRAINT.patternMessage)
    expect(invalid.message).not.toContain('用户名')
  })

  it('accepts digits and hash marks for public handles', () => {
    expect(validatePublicHandle('reader123').isValid).toBe(true)
    expect(validatePublicHandle('reader#123').isValid).toBe(true)
    expect(validatePublicHandle('读者#123').isValid).toBe(true)
  })

  it('keeps ad, redline, and invisible-character risk checks for public handles', () => {
    const ad = validatePublicHandle('加微信')
    expect(ad.isValid).toBe(false)
    expect(ad.message).toContain('公开称呼')
    expect(ad.message).toContain('引流')
    expect(ad.message).not.toContain('用户名')

    const invisible = validatePublicHandle('张三\u200B丰')
    expect(invisible.isValid).toBe(false)
    expect(invisible.message).toContain('公开称呼')
    expect(invisible.message).not.toContain('用户名')

    const redline = validatePublicHandle('习近平')
    expect(redline.isValid).toBe(false)
    expect(redline.message).toContain('公开称呼')
    expect(redline.message).toContain('涉政')
    expect(redline.message).not.toContain('用户名')
  })

  it('accepts a valid public handle', () => {
    expect(validatePublicHandle('张三丰').isValid).toBe(true)
  })
})

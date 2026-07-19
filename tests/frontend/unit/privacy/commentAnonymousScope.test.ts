import { describe, expect, it } from 'vitest'
import {
  anonymousCommentScopePolicy,
  createAnonymousThreadScope,
  createAnonymousTopLevelScope,
  parseAnonymousCommentScope
} from '@/privacy/commentAnonymousScope'

describe('anonymous comment scope policy', () => {
  it('creates article-bound versioned top-level and thread scopes', () => {
    expect(createAnonymousTopLevelScope(42)).toBe('comment:v1:article:42:top')
    expect(createAnonymousThreadScope(42, '9001')).toBe('comment:v1:article:42:thread:9001')
    expect(createAnonymousThreadScope(43, '9001')).not.toBe(createAnonymousThreadScope(42, '9001'))
  })

  it('publishes the matching credential-cycle quota hints', () => {
    expect(anonymousCommentScopePolicy).toEqual({
      version: 1,
      topLevelUsesPerCredential: 1,
      threadReplyUsesPerCredential: 3
    })
  })

  it('parses current scopes and rejects legacy or malformed values', () => {
    expect(parseAnonymousCommentScope('comment:v1:article:42:top')).toEqual({
      articleId: 42,
      kind: 'top',
      rootId: null
    })
    expect(parseAnonymousCommentScope('comment:v1:article:42:thread:9001')).toEqual({
      articleId: 42,
      kind: 'thread',
      rootId: '9001'
    })
    expect(parseAnonymousCommentScope('article:42')).toBeNull()
    expect(parseAnonymousCommentScope('comment:v1:article:42:thread:0')).toBeNull()
  })
})

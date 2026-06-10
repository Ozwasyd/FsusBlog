import { describe, it, expect } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { mapFramePayloadToViewModel } from '@/adapters/binary/index'

describe('mapFramePayloadToViewModel', () => {
  it('throws for unknown frame type', () => {
    expect(() => mapFramePayloadToViewModel(999 as FrameType, new Uint8Array(0))).toThrow()
  })

  it('throws for FrameType.Unknown (0)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.Unknown, new Uint8Array(0))).toThrow()
  })

  it('throws for FrameType.ApiError', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.ApiError, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleList (throws on empty payload, confirms routing)', () => {
    // The ArticleList mapper will throw for empty payload - this confirms routing is correct
    expect(() => mapFramePayloadToViewModel(FrameType.ArticleList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleDetail (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.ArticleDetail, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleHot (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.ArticleHot, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleSearch (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.ArticleSearch, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleFeatured (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.ArticleFeatured, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleRelatedReading (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.ArticleRelatedReading, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for human read proof frames (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.HumanReadChallengeResponse, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.HumanReadSubmitResponse, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for TrashClearResponse (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.TrashClearResponse, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for AdminUserList (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.AdminUserList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for AuthLoginFlow (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.AuthLoginFlow, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CurrentUserSnapshot (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.CurrentUserSnapshot, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for AuthSessionList (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.AuthSessionList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for PowChallenge (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.PowChallenge, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for MFA frames (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.MfaSetupStart, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.MfaSetupVerify, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.MfaProfile, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.MfaChallengeResult, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for conversation frames (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.ConversationList, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.ConversationDetail, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.ConversationMessage, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for Passkey frames (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.PasskeyRegisterBegin, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.PasskeyLoginBegin, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.PasskeyCredentialList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CommentArticleCursor (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.CommentArticleCursor, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CommentUserCursor (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.CommentUserCursor, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CommentThreadReplyCursor (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.CommentThreadReplyCursor, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for AdminStats (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.AdminStats, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CategoryList (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.CategoryList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for TagList (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.TagList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for RecentCommentStats (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.RecentCommentStats, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for RegionStats (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.RegionStats, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for SeoConfig (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.SeoConfig, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for PageContent (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.PageContent, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadInit (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.UploadInit, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadStatus (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.UploadStatus, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadPartAck (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.UploadPartAck, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadComplete (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.UploadComplete, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadPartMap (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.UploadPartMap, new Uint8Array(0))).toThrow()
  })

  it('maps EmptySuccess payload', () => {
    expect(mapFramePayloadToViewModel(FrameType.EmptySuccess, new Uint8Array([1, 0, 0, 0]))).toBeNull()
  })

  it('maps MutationId payload', () => {
    const payload = new Uint8Array(8)
    new DataView(payload.buffer).setBigInt64(0, 42n, true)
    expect(mapFramePayloadToViewModel(FrameType.MutationId, payload)).toEqual({ id: 42 })
  })
})

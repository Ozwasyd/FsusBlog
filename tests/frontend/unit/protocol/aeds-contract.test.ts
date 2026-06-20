import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { mapAuthLoginFlowFromPayload, mapCurrentUserSnapshotFromPayload, mapIdentityAccountSnapshotFromPayload, mapMfaChallengeResultFromPayload, mapMfaProfileFromPayload, mapMfaSetupStartFromPayload, mapUserSessionsFromPayload } from '@/adapters/binary/authAdapter'
import { mapConversationDetailFromPayload, mapConversationListFromPayload, mapConversationMessageFromPayload } from '@/adapters/binary/messageAdapter'
import { mapArticleDetailFromPodPayload, mapArticleFeaturedFromPodPayload, mapArticleHotFromPodPayload, mapArticlePageFromPodPayload, mapArticleSearchFromPodPayload, mapRelatedReadingFromPodPayload } from '@/adapters/binary/articleAdapter'
import { mapCommentCursorFromPodPayload } from '@/adapters/binary/commentAdapter'
import { mapRecentCommentsFromPodPayload, mapRegionsFromPodPayload, mapSiteStatsFromPodPayload } from '@/adapters/binary/statsAdapter'
import { mapPageContentFromPayload, mapSeoConfigFromPayload } from '@/adapters/binary/systemAdapter'

describe('AEDS cross-stack contract fixture', () => {
  it('decodes the checked-in backend MutationId frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('mutation-id-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.MutationId)
    expect(Array.from(result.payloadView)).toEqual([1, 2, 3, 4, 5])
  })

  it('decodes the checked-in backend ApiError frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('api-error-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.ApiError)
    expect(result.payloadView.byteLength).toBe(584)
    expect(result.payloadView[0]).toBe(5)
    expect(result.payloadView[1]).toBe(3)

    const view = new DataView(result.payloadView.buffer, result.payloadView.byteOffset, result.payloadView.byteLength)
    expect(view.getInt32(4, true)).toBe(403)
    expect(readFixedUtf8(result.payloadView, 8, 256)).toBe('权限不足')
    expect(readFixedUtf8(result.payloadView, 264, 256)).toBe('role_required')
    expect(readFixedUtf8(result.payloadView, 520, 64)).toBe('trace-123')
  })

  it('decodes the checked-in backend PowChallenge frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('pow-challenge-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.PowChallenge)
    expect(result.payloadView.byteLength).toBe(204)

    const view = new DataView(result.payloadView.buffer, result.payloadView.byteOffset, result.payloadView.byteLength)
    expect(readFixedUtf8(result.payloadView, 0, 64)).toBe('salt-value')
    expect(view.getInt32(64, true)).toBe(4)
    expect(Number(view.getBigInt64(68, true))).toBe(1778290000)
    expect(readFixedUtf8(result.payloadView, 76, 128)).toBe('signature-value')
  })

  it('decodes the checked-in backend AuthLoginFlow frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('auth-login-flow-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.AuthLoginFlow)
    expect(result.payloadView.byteLength).toBe(168)
    expect(mapAuthLoginFlowFromPayload(result.payloadView)).toEqual({
      user: { id: 7, username: 'alice', role: 'admin' },
      authPhase: 'mfa_required',
      mfaMode: 'risk',
      challengeToken: 'ticket-1'
    })
  })

  it('decodes the checked-in backend MfaChallengeResult frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('mfa-challenge-result-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.MfaChallengeResult)
    expect(result.payloadView.byteLength).toBe(296)
    expect(mapMfaChallengeResultFromPayload(result.payloadView)).toEqual({
      verified: true,
      action: 'login',
      proofToken: 'proof-1',
      user: { id: 7, username: 'alice', role: 'admin' }
    })
  })

  it('decodes the checked-in backend MfaSetupStart frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('mfa-setup-start-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.MfaSetupStart)
    expect(result.payloadView.byteLength).toBe(112)
    expect(mapMfaSetupStartFromPayload(result.payloadView)).toEqual({
      enabled: true,
      secret: 'secret',
      otpAuthUrl: 'otpauth://totp/Fsus%20Blog?secret=secret',
      issuer: 'Fsus Blog',
      account: 'alice@example.com'
    })
  })

  it('decodes the checked-in backend AuthSessionList frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('auth-session-list-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.AuthSessionList)
    expect(result.payloadView.byteLength).toBe(796)
    expect(mapUserSessionsFromPayload(result.payloadView)).toEqual([
      {
        sessionId: 'session-1',
        deviceFingerprint: 'fp-1',
        lastIp: '127.0.0.1',
        deviceLabel: 'Chrome on Linux',
        lastSeenAt: '2026-01-02T03:04:05.000Z',
        isCurrent: true,
        mfaVerified: true
      },
      {
        sessionId: 'session-2',
        deviceFingerprint: 'fp-2',
        lastIp: '10.0.0.2',
        deviceLabel: 'Safari on iPhone',
        lastSeenAt: null,
        isCurrent: false,
        mfaVerified: false
      }
    ])
  })

  it('decodes the checked-in backend CurrentUserSnapshot frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('current-user-snapshot-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.CurrentUserSnapshot)
    expect(result.payloadView.byteLength).toBe(372)
    expect(mapCurrentUserSnapshotFromPayload(result.payloadView)).toEqual({
      id: 123,
      username: 'alice',
      role: 'User',
      status: 1,
      banReason: null,
      deletedAt: null
    })
  })

  it('decodes the checked-in backend IdentityAccountSnapshot frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('identity-account-snapshot-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.IdentityAccountSnapshot)
    expect(result.payloadView.byteLength).toBe(72 + 4 + 58)
    expect(mapIdentityAccountSnapshotFromPayload(result.payloadView)).toEqual({
      id: 42,
      accountId: 42,
      internalUserId: 7,
      identityKind: 'anonymous_account',
      publicHandle: 'Public Alice',
      passkeyEnabled: true,
      recoveryEnabled: true,
      totpStepUpEnabled: true,
      anonymousCredentialStatus: 'active',
      anonymousCredentialLevel: 'strong_anonymous',
      status: 1,
      banReason: 'limited',
      deletedAt: '2026-01-02T03:04:05.000Z'
    })
  })

  it('decodes the checked-in backend MfaProfile frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('mfa-profile-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.MfaProfile)
    expect(result.payloadView.byteLength).toBe(12)
    expect(mapMfaProfileFromPayload(result.payloadView)).toEqual({
      enabled: true,
      verifiedAt: '2026-01-02T03:04:05.000Z'
    })
  })

  it('decodes the checked-in backend CategoryList frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('category-list-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.CategoryList)
    expect(result.payloadView.byteLength).toBe(48)

    const view = new DataView(result.payloadView.buffer, result.payloadView.byteOffset, result.payloadView.byteLength)
    expect(view.getInt32(0, true)).toBe(2)
    expect(view.getInt32(4, true)).toBe(8)
    expect(new TextDecoder().decode(result.payloadView.subarray(8, 16))).toBe('TechLife')
  })

  it('decodes the checked-in backend ConversationList frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('conversation-list-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.ConversationList)

    expect(mapConversationListFromPayload(result.payloadView)).toEqual({
      total: 1,
      items: [{
        conversationId: '7',
        subject: 'Support',
        status: 1,
        isSystemSource: true,
        canReply: true,
        unreadCount: 2,
        lastMessageAt: '2026-01-02T03:04:05.000Z',
        updatedAt: '2026-01-03T03:04:05.000Z',
        lastMessage: {
          senderType: 1,
          senderName: 'Admin',
          bodyPreview: 'Latest reply',
          createdAt: '2026-01-04T03:04:05.000Z'
        }
      }]
    })
  })

  it('decodes the checked-in backend ConversationMessage frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('conversation-message-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.ConversationMessage)

    expect(mapConversationMessageFromPayload(result.payloadView)).toEqual({
      messageId: '11',
      conversationId: '7',
      senderType: 0,
      senderName: 'Alice',
      body: 'Message body',
      createdAt: '2026-01-02T04:04:05.000Z'
    })
  })

  it('decodes the checked-in backend ConversationDetail frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('conversation-detail-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.ConversationDetail)

    expect(mapConversationDetailFromPayload(result.payloadView)).toEqual({
      conversationId: '7',
      subject: 'Support',
      status: 0,
      isSystemSource: false,
      canReply: true,
      unreadCount: 1,
      lastMessageAt: '2026-01-02T03:04:05.000Z',
      messages: [{
        messageId: '11',
        conversationId: '7',
        senderType: 0,
        senderName: 'Alice',
        body: 'Message body',
        createdAt: '2026-01-02T04:04:05.000Z'
      }]
    })
  })

  it('decodes the checked-in backend ArticleList frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('article-list-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.ArticleList)
    expect(result.payloadView.byteLength).toBe(284)

    expect(mapArticlePageFromPodPayload(result.payloadView)).toEqual({
      total: 17,
      items: [
        {
          id: 11,
          title: 'Intro AEDS',
          summary: 'Binary protocol basics',
          views: 42,
          createTime: '2026-05-12T12:34:56.000Z',
          category: {
            id: 3,
            name: 'Protocol'
          },
          tags: [
            { id: 9, name: 'binary' },
            { id: 10, name: 'contract' }
          ],
          isDeleted: false,
          status: 2,
          scheduledPublishAt: null,
          publishedAt: null
        },
        {
          id: 12,
          title: 'Hydration Fixes',
          summary: '',
          views: 7,
          createTime: '2026-05-13T08:00:00.000Z',
          category: {
            id: 4,
            name: 'Frontend'
          },
          tags: [
            { id: 11, name: 'vue' }
          ],
          isDeleted: false,
          status: 2,
          scheduledPublishAt: null,
          publishedAt: null
        }
      ]
    })
  })

  it('decodes the checked-in backend ArticleFeatured frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('article-featured-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.ArticleFeatured)

    expect(mapArticleFeaturedFromPodPayload(result.payloadView)).toEqual([
      {
        id: 41,
        title: 'Binary First',
        coverImageUrl: '/covers/first.webp',
        views: 88,
        createTime: '2026-05-12T06:00:00.000Z',
        category: {
          id: 3,
          name: 'Protocol'
        }
      },
      {
        id: 42,
        title: 'Hydration Again',
        coverImageUrl: '/covers/hydration.webp',
        views: 64,
        createTime: '2026-05-13T07:30:00.000Z',
        category: {
          id: 4,
          name: 'Frontend'
        }
      }
    ])
  })

  it('decodes the checked-in backend ArticleDetail frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('article-detail-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.ArticleDetail)

    expect(mapArticleDetailFromPodPayload(result.payloadView)).toEqual({
      id: 42,
      title: 'Article 42',
      content: 'Content 42\nHello',
      summary: 'Summary 42',
      views: 123,
      createTime: '2026-01-02T03:04:05.000Z',
      category: {
        id: 7,
        name: 'Life'
      },
      coverImageUrl: '/covers/42.png',
      tags: [
        { id: 9, name: 'aeds' },
        { id: 10, name: 'blog' }
      ],
      isDeleted: false,
      status: 2,
      scheduledPublishAt: null,
      publishedAt: null
    })
  })

  it('decodes the checked-in backend ArticleHot frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('article-hot-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.ArticleHot)

    expect(mapArticleHotFromPodPayload(result.payloadView)).toEqual([
      { id: 11, title: 'Hot 1', views: 999 },
      { id: 22, title: 'Hot 2', views: 888 }
    ])
  })

  it('decodes the checked-in backend ArticleRelatedReading frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('article-related-reading-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.ArticleRelatedReading)

    expect(mapRelatedReadingFromPodPayload(result.payloadView)).toEqual({
      related: [
        {
          id: 10,
          title: 'AEDS public reads',
          summary: 'Binary contract',
          createTime: '2026-05-17T12:00:00.000Z',
          reason: '同分类'
        },
        {
          id: 11,
          title: 'Hydration notes',
          summary: null,
          createTime: '2026-05-18T12:00:00.000Z',
          reason: '全文关键词'
        }
      ],
      previous: {
        id: 9,
        title: 'Previous article',
        summary: 'previous summary',
        createTime: '2026-05-16T12:00:00.000Z',
        reason: '上一篇'
      },
      next: {
        id: 12,
        title: 'Next article',
        summary: null,
        createTime: '2026-05-19T12:00:00.000Z',
        reason: '下一篇'
      }
    })
  })

  it('decodes the checked-in backend ArticleSearch frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('article-search-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.ArticleSearch)

    // Note: total count from the page wrapper is dropped in the legacy mapArticleSearchFromPodPayload when version=0x33525346 not present,
    // actually, in this encoding the searchFrame payload generated by EncodeArticleSearch *does* include the version prefix.
    // Let's verify exactly what mapArticleSearchFromPodPayload gives us.
    const mapped = mapArticleSearchFromPodPayload(result.payloadView)
    expect(mapped.items).toEqual([{
      id: 11,
      title: 'Intro AEDS',
      summary: 'Binary protocol basics',
      views: 42,
      createTime: '2026-05-12T12:34:56.000Z',
      category: {
        id: 3,
        name: 'Protocol'
      },
      tags: [
        { id: 9, name: 'binary' },
        { id: 10, name: 'contract' }
      ]
    }])
  })

  it('decodes the checked-in backend RecentCommentStats frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('recent-comment-stats-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.RecentCommentStats)
    expect(result.payloadView.byteLength).toBe(116)

    expect(mapRecentCommentsFromPodPayload(result.payloadView)).toEqual([
      {
        userId: 12,
        userName: 'alice',
        content: 'first admin comment',
        createTime: '2026-05-12T09:08:07.000Z'
      },
      {
        userId: null,
        userName: 'anonymous',
        content: 'hidden user',
        createTime: '2026-05-12T10:00:00.000Z'
      }
    ])
  })

  it('decodes the checked-in backend RegionStats frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('region-stats-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.RegionStats)
    expect(result.payloadView.byteLength).toBe(44)

    expect(mapRegionsFromPodPayload(result.payloadView)).toEqual([
      {
        region: 'China',
        count: 5
      },
      {
        region: 'Unknown',
        count: 2
      }
    ])
  })

  it('decodes the checked-in backend AdminStats frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('admin-stats-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.AdminStats)
    expect(result.payloadView.byteLength).toBe(231)

    expect(mapSiteStatsFromPodPayload(result.payloadView)).toEqual({
      overview: {
        summary: {
          totalArticles: 25,
          totalComments: 120,
          trashCount: 4,
          totalVisits: 900,
          registeredVisits: 500,
          anonymousVisits: 400
        },
        popularArticles: [
          {
            id: 31,
            title: 'Top post',
            views: 88
          },
          {
            id: 32,
            title: 'Second post',
            views: 55
          }
        ]
      },
      recentComments: [
        {
          userId: 12,
          userName: 'alice',
          content: 'first admin comment',
          createTime: '2026-05-12T09:08:07.000Z'
        }
      ],
      regions: [
        { region: 'China', count: 5 },
        { region: 'Unknown', count: 2 }
      ]
    })
  })

  it('decodes the checked-in backend SeoConfig frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('seo-config-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.SeoConfig)
    expect(result.payloadView.byteLength).toBe(5019)
    expect(mapSeoConfigFromPayload(result.payloadView)).toEqual({
      title: 'Fsus Blog',
      description: 'Forward Forever',
      keywords: 'blog,aeds,hydration',
      author: 'Fsu',
      ogImage: '/images/og.png',
      baseUrl: 'https://fsus.example',
      faviconSvgUrl: '/favicon.svg',
      faviconIcoUrl: '/favicon.ico',
      faviconPngUrl: '/icons/favicon-96.png',
      appleTouchIconUrl: '/apple-touch-icon.png',
      manifestName: 'Fsus Blog',
      manifestShortName: 'Fsus',
      pwaIcon192Url: '/icons/icon-192.png',
      pwaIcon512Url: '/icons/icon-512.png',
      pwaMaskableIconUrl: '/icons/maskable-512.png',
      themeColor: '#0f0f11',
      backgroundColor: '#fcfcfc',
      siteLogoUrl: '/brand/site-logo.svg',
      siteLogoDarkUrl: '/brand/site-logo-dark.svg',
      siteWordmarkUrl: '/brand/site-wordmark.svg',
      adminLogoUrl: '/brand/admin-logo.svg',
      adminCollapsedIconUrl: '/brand/admin-icon.svg',
      loginLogoUrl: '/brand/login-logo.svg',
      loginIconUrl: '/brand/login-icon.svg'
    })
  })

  it('decodes the checked-in backend PageContent frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('page-content-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.PageContent)
    expect(result.payloadView.byteLength).toBe(179)
    expect(mapPageContentFromPayload(result.payloadView)).toEqual({
      slug: 'about',
      content: '# About\n\nHydration-safe binary payload.'
    })
  })

  it('decodes the checked-in backend CommentArticleCursor frame with the real frontend decoder', async () => {
    const { decode } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const buffer = readProtocolFixtureBuffer('comment-article-cursor-frame.hex')

    const result = decode(buffer)

    expect(result.ok).toBe(true)
    expect(result.frameType).toBe(FrameType.CommentArticleCursor)

    const view = new DataView(result.payloadView.buffer, result.payloadView.byteOffset, result.payloadView.byteLength)
    expect(Number(view.getBigInt64(0, true))).toBe(777)
    expect(result.payloadView[8]).toBe(1)
    expect(view.getInt32(9, true)).toBe(1)

    expect(mapCommentCursorFromPodPayload(result.payloadView)).toEqual({
      nextCursor: '777',
      hasMore: true,
      data: [
        {
          id: '101',
          content: 'root comment',
          createTime: '2026-05-12T00:00:00.000Z',
          author: {
            mode: 'public',
            displayName: 'alice',
            displayLanguage: 'zh-CN',
            badge: null,
            scopeLabel: null,
            credentialLevel: null
          },
          userName: 'alice',
          rootId: '101',
          isDeleted: false,
          replyCount: 3,
          hasMoreReplies: true,
          repliesPreview: [
            {
              id: '202',
              content: 'preview reply',
              createTime: '2026-05-12T01:02:03.000Z',
              author: {
                mode: 'public',
                displayName: 'bob',
                displayLanguage: 'zh-CN',
                badge: null,
            scopeLabel: null,
            credentialLevel: null
              },
              userName: 'bob',
              replyToUserName: 'alice',
              replyToAuthor: {
                mode: 'public',
                displayName: 'alice',
                displayLanguage: 'zh-CN',
                badge: null,
            scopeLabel: null,
            credentialLevel: null
              },
              isDeleted: false
            }
          ]
        }
      ]
    })
  })
})

function readProtocolFixtureBuffer(fileName: string): ArrayBuffer {
  const fixturePath = fileURLToPath(new URL(`../../../fixtures/protocol/${fileName}`, import.meta.url))
  const hex = readFileSync(fixturePath, 'utf8').replace(/\s+/g, '')
  const bytes = Uint8Array.from(Buffer.from(hex, 'hex'))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function readFixedUtf8(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return new TextDecoder().decode(end >= 0 ? slice.subarray(0, end) : slice)
}

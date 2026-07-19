import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { AppErrorCode } from '@/utils/appError'
import { encodeAedsFrame } from '@/api/binaryFrame'

vi.mock('@wasm/aeds', async () => await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds'))

vi.mock('@/api/binaryApiClient', async () => {
  const actual = await vi.importActual<typeof import('@/api/binaryApiClient')>('@/api/binaryApiClient')
  return {
    ...actual,
    binaryRequest: vi.fn()
  }
})

import { BinaryRequestError, binaryRequest } from '@/api/binaryApiClient'
import { decodeBinaryFramePayload } from '@/composition/binaryDecoderRegistry'
import { BinaryTransportError, createBinaryTransport } from '@/services/binaryTransport'

const { requestBinaryOnly } = createBinaryTransport(decodeBinaryFramePayload)

const mockBinaryRequest = vi.mocked(binaryRequest)
const API_ERROR_POD_SIZE = 584

function writeFixedUtf8(payload: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = new TextEncoder().encode(value)
  payload.set(encoded.subarray(0, length), offset)
}

function encodeApiErrorFrame(options: {
  status: number
  code?: number
  category?: number
  message?: string
  details?: string
  traceId?: string
}): ArrayBuffer {
  const payload = new Uint8Array(API_ERROR_POD_SIZE)
  const view = new DataView(payload.buffer)
  payload[0] = options.code ?? 1
  payload[1] = options.category ?? 1
  view.setInt32(4, options.status, true)
  writeFixedUtf8(payload, 8, 256, options.message ?? `status:${options.status}`)
  writeFixedUtf8(payload, 264, 256, options.details ?? `details:${options.status}`)
  writeFixedUtf8(payload, 520, 64, options.traceId ?? `trace-${options.status}`)
  return encodeAedsFrame(FrameType.ApiError, payload)
}

describe('binaryTransport ApiError mapping', () => {
  beforeEach(() => {
    mockBinaryRequest.mockReset()
    vi.spyOn(window, 'dispatchEvent').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delegates payload decoding to the injected decoder', async () => {
    const injectedValue = { source: 'injected-decoder' }
    const decodeFramePayload = vi.fn(() => injectedValue)
    const transport = createBinaryTransport(decodeFramePayload)
    mockBinaryRequest.mockResolvedValue(encodeAedsFrame(
      FrameType.EmptySuccess,
      new Uint8Array([1, 0, 0, 0])
    ))

    await expect(transport.requestBinaryOnly({
      binaryUrl: '/api/binary/injected-decoder',
      frameType: FrameType.EmptySuccess
    })).resolves.toBe(injectedValue)
    expect(decodeFramePayload).toHaveBeenCalledOnce()
    expect(decodeFramePayload).toHaveBeenCalledWith(FrameType.EmptySuccess, expect.any(Uint8Array))
  })

  it('maps a PowChallenge frame into the expected view model', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('pow-challenge-frame.hex'))

    await expect(requestBinaryOnly<{ salt: string; difficulty: number; timestamp: number; signature: string }>({
      binaryUrl: '/api/binary/auth/pow-challenge',
      frameType: FrameType.PowChallenge
    })).resolves.toEqual({
      salt: 'salt-value',
      difficulty: 4,
      timestamp: 1778290000,
      signature: 'signature-value'
    })
  })

  it('maps an AuthLoginFlow frame into the expected view model', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('auth-login-flow-frame.hex'))

    await expect(requestBinaryOnly<{
      accountId: number;
      identityKind: string;
      authPhase: 'authenticated' | 'mfa_required';
      mfaMode: 'risk' | 'standard' | null;
      challengeToken: string | null;
    }>({
      binaryUrl: '/api/binary/auth/anonymous/bootstrap',
      frameType: FrameType.AuthLoginFlow
    })).resolves.toEqual({
      accountId: 7,
      identityKind: 'anonymous_account',
      authPhase: 'mfa_required',
      mfaMode: 'risk',
      challengeToken: 'ticket-1'
    })
  })

  it('maps an MfaChallengeResult frame into the expected view model', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('mfa-challenge-result-frame.hex'))

    await expect(requestBinaryOnly<{
      verified: boolean;
      action: string;
      proofToken: string | null;
      user: {
        accountId: number;
        identityKind: string;
      } | null;
    }>({
      binaryUrl: '/api/binary/auth/mfa/challenge',
      frameType: FrameType.MfaChallengeResult
    })).resolves.toEqual({
      verified: true,
      action: 'login',
      proofToken: 'proof-1',
      user: {
        accountId: 7,
        identityKind: 'anonymous_account'
      }
    })
  })

  it('maps an MfaSetupStart frame into the expected view model', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('mfa-setup-start-frame.hex'))

    await expect(requestBinaryOnly<{
      enabled: boolean;
      secret: string;
      otpAuthUrl: string;
      issuer: string;
      account: string;
    }>({
      binaryUrl: '/api/binary/auth/mfa/setup/start',
      frameType: FrameType.MfaSetupStart
    })).resolves.toEqual({
      enabled: true,
      secret: 'secret',
      otpAuthUrl: 'otpauth://totp/Fsus%20Blog?secret=secret',
      issuer: 'Fsus Blog',
      account: 'alice@example.com'
    })
  })

  it('maps an AuthSessionList frame into the expected view model', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('auth-session-list-frame.hex'))

    await expect(requestBinaryOnly<Array<{
      sessionId: string;
      deviceFingerprint: string;
      deviceLabel: string;
      lastSeenAt: string | null;
      isCurrent: boolean;
      mfaVerified: boolean;
    }>>({
      binaryUrl: '/api/binary/auth/sessions',
      frameType: FrameType.AuthSessionList
    })).resolves.toEqual([
      {
        sessionId: 'session-1',
        deviceFingerprint: 'fp-1',
        deviceLabel: 'Chrome on Linux',
        lastSeenAt: '2026-01-02T03:04:05.000Z',
        isCurrent: true,
        mfaVerified: true
      },
      {
        sessionId: 'session-2',
        deviceFingerprint: 'fp-2',
        deviceLabel: 'Safari on iPhone',
        lastSeenAt: null,
        isCurrent: false,
        mfaVerified: false
      }
    ])
  })

  it('maps an IdentityAccountSnapshot frame into the expected current user view model', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('identity-account-snapshot-frame.hex'))

    await expect(requestBinaryOnly<{
      accountId: number;
      identityKind: string;
      publicHandle: string | null;
      passkeyEnabled: boolean;
      recoveryEnabled: boolean;
      anonymousCredentialStatus: string | null;
      anonymousCredentialLevel: string | null;
      status: number;
      banReason: string | null;
      deletedAt: string | null;
    }>({
      binaryUrl: '/api/binary/auth/me',
      frameType: FrameType.IdentityAccountSnapshot
    })).resolves.toEqual({
      accountId: 42,
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

  it('maps an MfaProfile frame into the expected view model', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('mfa-profile-frame.hex'))

    await expect(requestBinaryOnly<{
      enabled: boolean;
      verifiedAt: string | null;
    }>({
      binaryUrl: '/api/binary/auth/mfa/profile',
      frameType: FrameType.MfaProfile
    })).resolves.toEqual({
      enabled: true,
      verifiedAt: '2026-01-02T03:04:05.000Z'
    })
  })

  it('maps a CategoryList frame into the expected items', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('category-list-frame.hex'))

    await expect(requestBinaryOnly<Array<{ id: number; name: string; articleCount: number }>>({
      binaryUrl: '/api/binary/category.aeds',
      frameType: FrameType.CategoryList
    })).resolves.toEqual([
      { id: 1, name: 'Tech', articleCount: 2 },
      { id: 2, name: 'Life', articleCount: 0 }
    ])
  })

  it('applies generated credential policy for anonymous public reads', async () => {
    mockBinaryRequest.mockResolvedValueOnce(readProtocolFixtureBuffer('category-list-frame.hex'))
    await requestBinaryOnly<Array<{ id: number; name: string; articleCount: number }>>({
      binaryRoute: { operationId: 'binary_get_category_aeds' },
      frameType: FrameType.CategoryList
    })
    expect(mockBinaryRequest).toHaveBeenLastCalledWith(
      '/api/binary/category.aeds',
      expect.objectContaining({ credentials: 'omit' })
    )

    mockBinaryRequest.mockResolvedValueOnce(readProtocolFixtureBuffer('seo-config-frame.hex'))
    await requestBinaryOnly({
      binaryRoute: { operationId: 'binary_get_system_seo' },
      frameType: FrameType.SeoConfig
    })
    expect(mockBinaryRequest).toHaveBeenLastCalledWith(
      '/api/binary/system/seo',
      expect.objectContaining({ credentials: 'omit' })
    )

    mockBinaryRequest.mockResolvedValueOnce(readProtocolFixtureBuffer('page-content-frame.hex'))
    await requestBinaryOnly({
      binaryRoute: { operationId: 'binary_get_system_page_slug', params: { slug: 'about' } },
      frameType: FrameType.PageContent
    })
    expect(mockBinaryRequest).toHaveBeenLastCalledWith(
      '/api/binary/system/page/about',
      expect.objectContaining({ credentials: 'omit' })
    )
  })

  it('retries anonymous public GET routes once with PoW when the first read is challenged', async () => {
    mockBinaryRequest
      .mockRejectedValueOnce(new BinaryRequestError(428, 'Binary request failed: 428', encodeApiErrorFrame({
        status: 428,
        message: '公开读取请求需要 PoW 凭证',
        details: 'security.pow',
        traceId: 'trace-pow'
      })))
      .mockResolvedValueOnce(readProtocolFixtureBuffer('category-list-frame.hex'))

    await expect(requestBinaryOnly<Array<{ id: number; name: string; articleCount: number }>>({
      binaryRoute: { operationId: 'binary_get_category_aeds' },
      frameType: FrameType.CategoryList
    })).resolves.toEqual([
      { id: 1, name: 'Tech', articleCount: 2 },
      { id: 2, name: 'Life', articleCount: 0 }
    ])

    expect(mockBinaryRequest).toHaveBeenNthCalledWith(
      1,
      '/api/binary/category.aeds',
      expect.objectContaining({ credentials: 'omit' })
    )
    expect(mockBinaryRequest).toHaveBeenNthCalledWith(
      2,
      '/api/binary/category.aeds',
      expect.objectContaining({
        credentials: 'omit',
        requiresPow: true,
        powScope: 'public-read:/api/binary/category.aeds'
      })
    )
  })

  it('retries anonymous public GET routes when the first read returns an ApiError frame', async () => {
    mockBinaryRequest
      .mockResolvedValueOnce(encodeApiErrorFrame({
        status: 428,
        message: '公开读取请求需要 PoW 凭证',
        details: 'security.pow',
        traceId: 'trace-pow-frame'
      }))
      .mockResolvedValueOnce(readProtocolFixtureBuffer('category-list-frame.hex'))

    await expect(requestBinaryOnly<Array<{ id: number; name: string; articleCount: number }>>({
      binaryRoute: { operationId: 'binary_get_category_aeds' },
      frameType: FrameType.CategoryList
    })).resolves.toEqual([
      { id: 1, name: 'Tech', articleCount: 2 },
      { id: 2, name: 'Life', articleCount: 0 }
    ])

    expect(mockBinaryRequest).toHaveBeenNthCalledWith(
      2,
      '/api/binary/category.aeds',
      expect.objectContaining({
        credentials: 'omit',
        requiresPow: true,
        powScope: 'public-read:/api/binary/category.aeds'
      })
    )
  })

  it('does not retry raw binary URLs on 428 because their public-read contract is unknown', async () => {
    mockBinaryRequest.mockRejectedValue(new BinaryRequestError(428, 'Binary request failed: 428', encodeApiErrorFrame({
      status: 428,
      message: '公开读取请求需要 PoW 凭证',
      details: 'security.pow',
      traceId: 'trace-raw'
    })))

    await expect(requestBinaryOnly({
      binaryUrl: '/api/binary/category.aeds',
      frameType: FrameType.CategoryList
    })).rejects.toMatchObject({
      name: 'BinaryTransportError',
      kind: 'precondition_required',
      status: 428,
      traceId: 'trace-raw'
    })

    expect(mockBinaryRequest).toHaveBeenCalledTimes(1)
  })

  it('keeps credentials included for optional identity routes', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('identity-account-snapshot-frame.hex'))

    await requestBinaryOnly({
      binaryRoute: { operationId: 'binary_get_auth_me' },
      frameType: FrameType.IdentityAccountSnapshot
    })

    expect(mockBinaryRequest).toHaveBeenLastCalledWith('/api/binary/auth/me', expect.not.objectContaining({ credentials: 'omit' }))
  })

  it('maps a ConversationList frame into the expected view model', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('conversation-list-frame.hex'))

    await expect(requestBinaryOnly<{
      total: number;
      items: Array<{
        conversationId: string;
        subject: string;
        status: 0 | 1 | 2;
        isSystemSource: boolean;
        canReply: boolean;
        unreadCount: number;
        lastMessageAt: string;
        updatedAt: string;
        lastMessage?: {
          senderType: 0 | 1 | 2;
          senderName?: string | null;
          bodyPreview: string;
          createdAt: string;
        } | null;
      }>;
    }>({
      binaryUrl: '/api/binary/messages/conversations',
      frameType: FrameType.ConversationList
    })).resolves.toEqual({
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

  it('maps a ConversationMessage frame into the expected view model', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('conversation-message-frame.hex'))

    await expect(requestBinaryOnly<{
      messageId: string;
      conversationId: string;
      senderType: 0 | 1 | 2;
      senderName?: string | null;
      body: string;
      createdAt: string;
    }>({
      binaryUrl: '/api/binary/messages/conversations/7/reply',
      frameType: FrameType.ConversationMessage
    })).resolves.toEqual({
      messageId: '11',
      conversationId: '7',
      senderType: 0,
      senderName: 'Alice',
      body: 'Message body',
      createdAt: '2026-01-02T04:04:05.000Z'
    })
  })

  it('maps a ConversationDetail frame into the expected view model', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('conversation-detail-frame.hex'))

    await expect(requestBinaryOnly<{
      conversationId: string;
      subject: string;
      status: 0 | 1 | 2;
      isSystemSource: boolean;
      canReply: boolean;
      unreadCount: number;
      lastMessageAt: string;
      messages: Array<{
        messageId: string;
        conversationId: string;
        senderType: 0 | 1 | 2;
        senderName?: string | null;
        body: string;
        createdAt: string;
      }>;
    }>({
      binaryUrl: '/api/binary/messages/conversations/7',
      frameType: FrameType.ConversationDetail
    })).resolves.toEqual({
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

  it('maps an ArticleFeatured frame into the expected items', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('article-featured-frame.hex'))

    await expect(requestBinaryOnly<Array<{
      id: number;
      title: string;
      coverImageUrl: string;
      views: number;
      createTime: string;
      category: {
        id: number;
        name: string;
      };
    }>>({
      binaryUrl: '/api/binary/article/featured/2.aeds',
      frameType: FrameType.ArticleFeatured
    })).resolves.toEqual([
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

  it('maps an ArticleDetail frame into the expected view model', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('article-detail-frame.hex'))

    await expect(requestBinaryOnly<{
      id: number;
      title: string;
      content: string;
      summary: string;
      views: number;
      createTime: string;
      category: {
        id: number;
        name: string;
      };
      coverImageUrl: string;
      tags: Array<{
        id: number;
        name: string;
      }>;
    }>({
      binaryUrl: '/api/binary/article/42.aeds',
      frameType: FrameType.ArticleDetail
    })).resolves.toMatchObject({
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
      publishedAt: '2026-01-02T03:04:05.000Z',
      rights: expect.objectContaining({
        enabled: true,
        licenseType: 'CC-BY-4.0',
        proofStatus: 'ready'
      })
    })
  })

  it('maps an ArticleHot frame into the expected view model', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('article-hot-frame.hex'))

    await expect(requestBinaryOnly<Array<{ id: number; title: string; views: number }>>({
      binaryUrl: '/api/binary/article/hot/10.aeds',
      frameType: FrameType.ArticleHot
    })).resolves.toEqual([
      { id: 11, title: 'Hot 1', views: 999 },
      { id: 22, title: 'Hot 2', views: 888 }
    ])
  })

  it('maps an ArticleRelatedReading frame into the expected view model', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('article-related-reading-frame.hex'))

    await expect(requestBinaryOnly<any>({
      binaryUrl: '/api/binary/article/10/related.aeds',
      frameType: FrameType.ArticleRelatedReading
    })).resolves.toEqual({
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

  it('maps an ArticleSearch frame into the expected page response', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('article-search-frame.hex'))

    const res = await requestBinaryOnly<any>({
      binaryUrl: '/api/binary/search/article?q=AEDS',
      frameType: FrameType.ArticleSearch
    });
    expect(res.items).toEqual([{
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

  it('maps an ArticleList frame into the expected page response', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('article-list-frame.hex'))

    await expect(requestBinaryOnly<{
      total: number;
      items: Array<{
        id: number;
        title: string;
        summary: string;
        views: number;
        createTime: string;
        category: {
          id: number;
          name: string;
        };
        tags: Array<{
          id: number;
          name: string;
        }>;
      }>;
    }>({
      binaryUrl: '/api/binary/article/list/home/1/10.aeds',
      frameType: FrameType.ArticleList
    })).resolves.toEqual({
      total: 17,
      nextCursor: null,
      hasMore: false,
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

  it('maps a RecentCommentStats frame into the expected comment list', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('recent-comment-stats-frame.hex'))

    await expect(requestBinaryOnly<Array<{
      authorDisplayName: string;
      authorMode: string;
      authorBadge: string | null;
      authorScopeLabel: string | null;
      content: string;
      createTime: string;
    }>>({
      binaryUrl: '/api/binary/stats/recent-comments',
      frameType: FrameType.RecentCommentStats
    })).resolves.toEqual([
      {
        authorDisplayName: 'Alice Public',
        authorMode: 'public',
        authorBadge: null,
        authorScopeLabel: null,
        content: 'first admin comment',
        createTime: '2026-05-12T09:08:07.000Z'
      },
      {
        authorDisplayName: '强匿名评论者',
        authorMode: 'zk_anonymous',
        authorBadge: '已验证匿名凭证',
        authorScopeLabel: 'article:42',
        content: 'hidden user',
        createTime: '2026-05-12T10:00:00.000Z'
      }
    ])
  })

  it('maps a RegionStats frame into the expected region list', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('region-stats-frame.hex'))

    await expect(requestBinaryOnly<Array<{
      region: string;
      count: number;
    }>>({
      binaryUrl: '/api/binary/stats/regions',
      frameType: FrameType.RegionStats
    })).resolves.toEqual([
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

  it('maps an AdminStats frame into the expected overview', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('admin-stats-frame.hex'))

    await expect(requestBinaryOnly<{
      overview: {
        summary: {
          totalArticles: number;
          totalComments: number;
          trashCount: number;
          totalReads: number;
          humanVerifiedReads: number;
          uniqueViewerKeyEstimate: number;
          articleReads: number;
          siteReads: number;
        };
        popularArticles: Array<{
          id: number;
          title: string;
          views: number;
        }>;
      };
      recentComments: Array<{
        authorDisplayName: string;
        authorMode: string;
        authorBadge: string | null;
        authorScopeLabel: string | null;
        content: string;
        createTime: string;
      }>;
      regions: Array<{
        region: string;
        count: number;
      }>;
    }>({
      binaryUrl: '/api/binary/stats',
      frameType: FrameType.AdminStats
    })).resolves.toEqual({
      overview: {
        summary: {
          totalArticles: 25,
          totalComments: 120,
          trashCount: 4,
          totalReads: 900,
          humanVerifiedReads: 880,
          uniqueViewerKeyEstimate: 300,
          articleReads: 650,
          siteReads: 250
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
          authorDisplayName: 'Alice Public',
          authorMode: 'public',
          authorBadge: null,
          authorScopeLabel: null,
          content: 'first admin comment',
          createTime: '2026-05-12T09:08:07.000Z'
        }
      ],
      regions: [
        {
          region: 'China',
          count: 5
        },
        {
          region: 'Unknown',
          count: 2
        }
      ]
    })
  })

  it('maps a SeoConfig frame into the expected site config', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('seo-config-frame.hex'))

    await expect(requestBinaryOnly<{
      title: string;
      description: string;
      keywords: string;
      author: string;
      ogImage: string;
      baseUrl: string;
      faviconSvgUrl: string;
      faviconIcoUrl: string;
      faviconPngUrl: string;
      appleTouchIconUrl: string;
      manifestName: string;
      manifestShortName: string;
      pwaIcon192Url: string;
      pwaIcon512Url: string;
      pwaMaskableIconUrl: string;
      themeColor: string;
      backgroundColor: string;
      siteLogoUrl: string;
      siteLogoDarkUrl: string;
      siteWordmarkUrl: string;
      adminLogoUrl: string;
      adminCollapsedIconUrl: string;
      loginLogoUrl: string;
      loginIconUrl: string;
    }>({
      binaryUrl: '/api/binary/system/seo',
      frameType: FrameType.SeoConfig
    })).resolves.toEqual({
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

  it('maps a PageContent frame into the expected page payload', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('page-content-frame.hex'))

    await expect(requestBinaryOnly<{
      slug: string;
      content: string;
    }>({
      binaryUrl: '/api/binary/system/page/about',
      frameType: FrameType.PageContent
    })).resolves.toEqual({
      slug: 'about',
      content: '# About\n\nHydration-safe binary payload.'
    })
  })

  it('maps a CommentArticleCursor frame into the expected cursor response', async () => {
    mockBinaryRequest.mockResolvedValue(readProtocolFixtureBuffer('comment-article-cursor-frame.hex'))

    await expect(requestBinaryOnly<{
      nextCursor: string | null;
      hasMore: boolean;
      data: Array<{
        id: string;
        content: string;
        createTime: string;
        author: {
          mode: string;
          displayName: string;
          displayLanguage: string;
          badge: string;
          scopeLabel: string;
        };
        rootId: string;
        isDeleted: boolean;
        replyCount: number;
        hasMoreReplies: boolean;
        repliesPreview: Array<{
          id: string;
          content: string;
          createTime: string;
          author: {
            mode: string;
            displayName: string;
            displayLanguage: string;
            badge: string;
            scopeLabel: string;
          };
            replyToAuthor: {
            mode: string;
            displayName: string;
            displayLanguage: string;
            badge: string;
            scopeLabel: string;
          } | null;
          isDeleted: boolean;
        }>;
      }>;
    }>({
      binaryUrl: '/api/binary/comment/5?limit=10',
      frameType: FrameType.CommentArticleCursor
    })).resolves.toEqual({
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
            scopeLabel: null
          },
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
                scopeLabel: null
              },
              replyToAuthor: {
                mode: 'public',
                displayName: 'alice',
                displayLanguage: 'zh-CN',
                badge: null,
                scopeLabel: null
              },
              isDeleted: false
            }
          ]
        }
      ]
    })
  })

  it('maps an ApiError frame into a BinaryTransportError with message and traceId', async () => {
    const buffer = readProtocolFixtureBuffer('api-error-frame.hex')
    mockBinaryRequest.mockRejectedValue(new BinaryRequestError(403, 'Binary request failed: 403', buffer))

    await requestBinaryOnly({ binaryUrl: '/api/binary/example', frameType: FrameType.EmptySuccess })
      .then(() => {
        throw new Error('expected requestBinaryOnly to throw')
      })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(BinaryTransportError)
        expect(error).toMatchObject({
          name: 'BinaryTransportError',
          kind: 'forbidden',
          code: AppErrorCode.Forbidden,
          traceId: 'trace-123'
        })
        expect((error as BinaryTransportError).message).toContain('权限不足')
        expect((error as BinaryTransportError).message).toContain('[trace:trace-123]')
      })
  })

  it.each([
    [404, 'not_found', AppErrorCode.NotFound],
    [409, 'conflict', AppErrorCode.Conflict],
    [422, 'validation', AppErrorCode.Validation],
    [428, 'precondition_required', AppErrorCode.PreconditionRequired],
    [429, 'rate_limited', AppErrorCode.RateLimited],
    [503, 'public_artifact_not_ready', AppErrorCode.Timeout],
    [400, 'client_route_contract', AppErrorCode.ProtocolFailure],
    [406, 'accept_contract', AppErrorCode.ProtocolFailure]
  ] as const)('maps public artifact status %i to %s', async (status, kind, code) => {
    mockBinaryRequest.mockRejectedValue(new BinaryRequestError(status, `Binary request failed: ${status}`, new ArrayBuffer(0)))

    await expect(requestBinaryOnly({
      binaryUrl: '/api/binary/article/list/home/1/10.aeds',
      frameType: FrameType.ArticleList
    })).rejects.toMatchObject({
      name: 'BinaryTransportError',
      kind,
      code,
      status
    })
  })

  it.each([
    ['RISK_CHALLENGE_PROOF_REQUIRED', undefined, 'required'],
    ['RISK_CHALLENGE_PROOF_EXPIRED', 'expired', 'expired'],
    ['RISK_CHALLENGE_PROOF_REPLAYED', 'replayed_or_missing', 'replayed'],
    ['RISK_CHALLENGE_PROOF_BINDING_MISMATCH', 'binding_mismatch', 'binding_mismatch'],
    ['RISK_CHALLENGE_PROOF_REVOKED', 'revoked', 'revoked'],
    ['RISK_CHALLENGE_PROOF_REJECTED', 'rejected', 'rejected']
  ] as const)('maps structured risk challenge failure %s without business text parsing', async (message, outcome, expected) => {
    const headers = outcome ? { 'X-Fsus-Challenge-Proof-Outcome': outcome } : undefined
    mockBinaryRequest.mockRejectedValue(new BinaryRequestError(
      428,
      'Binary request failed: 428',
      encodeApiErrorFrame({ status: 428, message }),
      undefined,
      headers
    ))

    await expect(requestBinaryOnly({
      binaryUrl: '/api/binary/auth/recovery-key/verify',
      frameType: FrameType.RecoveryKeyVerifyResponse
    })).rejects.toMatchObject({
      name: 'BinaryTransportError',
      kind: 'precondition_required',
      riskChallengeFailure: expected
    })
  })

  it('keeps ApiError code category details and retry-after for rate limits', async () => {
    const buffer = encodeApiErrorFrame({
      status: 429,
      code: 7,
      category: 13,
      message: 'TOO_MANY_REQUESTS',
      details: 'retry later',
      traceId: 'trace-rate'
    })
    mockBinaryRequest.mockRejectedValue(new BinaryRequestError(
      429,
      'Binary request failed: 429',
      buffer,
      undefined,
      { 'Retry-After': '30' }
    ))

    await expect(requestBinaryOnly({
      binaryUrl: '/api/binary/comment/1',
      frameType: FrameType.ArticleList
    })).rejects.toMatchObject({
      name: 'BinaryTransportError',
      kind: 'rate_limited',
      code: AppErrorCode.RateLimited,
      status: 429,
      traceId: 'trace-rate',
      backendCode: 7,
      backendCategory: 13,
      details: 'retry later',
      retryAfter: '30'
    })
  })

  it('emits only categorical binary failure telemetry', async () => {
    const buffer = encodeApiErrorFrame({
      status: 429,
      code: 7,
      category: 13,
      message: 'https://private.example/user/42?token=secret',
      details: 'accountId=42 token=secret',
      traceId: 'trace-business-42'
    })
    mockBinaryRequest.mockRejectedValue(new BinaryRequestError(429, 'failed', buffer))
    const dispatched: CustomEvent<Record<string, unknown>>[] = []
    vi.mocked(window.dispatchEvent).mockImplementation((event) => {
      dispatched.push(event as CustomEvent<Record<string, unknown>>)
      return true
    })

    await expect(requestBinaryOnly({
      binaryUrl: '/api/binary/comment/42?token=secret',
      frameType: FrameType.ArticleList
    })).rejects.toBeInstanceOf(BinaryTransportError)

    const payloads = dispatched
      .filter((event) => event.type === 'fsus:binary:failure' || event.type === 'fsus:binary:error')
      .map((event) => event.detail)
    expect(payloads).toHaveLength(2)
    for (const payload of payloads) {
      expect(payload).toEqual({
        kind: 'rate_limited',
        status: 429,
        backendCategory: 13,
        riskChallengeFailure: undefined,
        frameType: FrameType.ArticleList
      })
      expect(JSON.stringify(payload)).not.toMatch(/url|query|details|token|trace|accountId|\/42/i)
    }
  })

  it('suppresses telemetry for expected anonymous auth failures', async () => {
    mockBinaryRequest.mockRejectedValue(new BinaryRequestError(401, 'Binary request failed: 401', new ArrayBuffer(0)))
    const dispatchSpy = vi.mocked(window.dispatchEvent)

    await expect(requestBinaryOnly({
      binaryUrl: '/api/binary/auth/me',
      frameType: FrameType.IdentityAccountSnapshot,
      suppressAuthFailureTelemetry: true
    })).rejects.toMatchObject({
      name: 'BinaryTransportError',
      kind: 'auth_failed',
      code: AppErrorCode.Unauthorized
    })

    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('treats fetch failures after signal abort as canceled without telemetry', async () => {
    const controller = new AbortController()
    controller.abort()
    mockBinaryRequest.mockRejectedValue(new TypeError('Failed to fetch'))
    const dispatchSpy = vi.mocked(window.dispatchEvent)

    await expect(requestBinaryOnly({
      binaryUrl: '/api/binary/article/list/home/1/10.aeds',
      frameType: FrameType.ArticleList,
      signal: controller.signal
    })).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Failed to fetch'
    })

    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('treats fetch failures after RequestInit signal abort as canceled without telemetry', async () => {
    const controller = new AbortController()
    controller.abort()
    mockBinaryRequest.mockRejectedValue(new TypeError('Failed to fetch'))
    const dispatchSpy = vi.mocked(window.dispatchEvent)

    await expect(requestBinaryOnly({
      binaryUrl: '/api/binary/system/seo',
      frameType: FrameType.SeoConfig,
      requestOptions: {
        signal: controller.signal
      }
    })).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Failed to fetch'
    })

    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('keeps the original transport error when failure telemetry dispatch is unavailable', async () => {
    mockBinaryRequest.mockRejectedValue(new TypeError('Failed to fetch'))
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent').mockImplementation(() => {
      throw new Error('send was called before connect')
    })

    await expect(requestBinaryOnly({
      binaryUrl: '/api/binary/auth/pow-challenge',
      frameType: FrameType.PowChallenge
    })).rejects.toMatchObject({
      name: 'BinaryTransportError',
      kind: 'network',
      code: AppErrorCode.InfraFailure
    })

    expect(dispatchSpy).toHaveBeenCalledTimes(2)
  })
})

function readProtocolFixtureBuffer(fileName: string): ArrayBuffer {
  const fixturePath = fileURLToPath(new URL(`../../../fixtures/protocol/${fileName}`, import.meta.url))
  const hex = readFileSync(fixturePath, 'utf8').replace(/\s+/g, '')
  const bytes = Uint8Array.from(Buffer.from(hex, 'hex'))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

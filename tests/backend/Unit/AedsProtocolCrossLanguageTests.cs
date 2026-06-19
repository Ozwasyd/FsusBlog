using System.Text.RegularExpressions;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared;
using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Validation;
using CoreAedsEncoder = FsusBlog.Core.Algorithms.AedsEncoder;
using CoreFrameType = FsusBlog.Core.Algorithms.AedsFrameType;

namespace FsusBlog.Server.Tests;

public sealed partial class AedsProtocolCrossLanguageTests
{
    [Fact]
    public void FrontendFrameTypeEnum_MatchesSharedProtocolMetadata()
    {
        string source = ReadFrontendFrameProtocolSource();
        Dictionary<string, ushort> frontendFrameTypes = ParseFrontendFrameTypes(source);

        Assert.Equal(AedsProtocolMetadata.FrameTypes.Count, frontendFrameTypes.Count);
        foreach ((string name, ushort raw) in AedsProtocolMetadata.FrameTypes)
        {
            Assert.True(frontendFrameTypes.TryGetValue(name, out ushort frontendRaw), $"Missing frontend frame type: {name}");
            Assert.Equal(raw, frontendRaw);
        }
    }

    [Fact]
    public void FrontendHeaderConstants_MatchSharedProtocolMetadata()
    {
        string source = ReadFrontendFrameProtocolSource();

        int headerLength = ParseIntConstant(source, "AEDS_HEADER_LENGTH");
        int version = ParseIntConstant(source, "AEDS_VERSION");
        uint magic = ParseHexConstant(source, "AEDS_MAGIC");

        Assert.Equal(AedsProtocolMetadata.FrameHeaderSize, headerLength);
        Assert.Equal(AedsProtocolMetadata.FrameVersion, version);
        Assert.Equal(FsusBlog.Shared.AedsFrameHeader.Magic, magic);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedMutationIdFixture()
    {
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.MutationId, [1, 2, 3, 4, 5]);

        Assert.Equal(ReadProtocolFixtureBytes("mutation-id-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedApiErrorFixture()
    {
        ErrorDetail error = ErrorDetail.Create(ErrorCode.Forbidden, "权限不足", "role_required", "trace-123");
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ApiError, PodBinaryCodec.EncodeApiError(error, 403));

        Assert.Equal(ReadProtocolFixtureBytes("api-error-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedPowChallengeFixture()
    {
        PowChallenge challenge = new("salt-value", 4, 1778290000, "signature-value");
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.PowChallenge, PodBinaryCodec.EncodePowChallenge(challenge));

        Assert.Equal(ReadProtocolFixtureBytes("pow-challenge-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedAuthLoginFlowFixture()
    {
        AuthLoginFlowDto flow = new(new AuthIdentitySnapshotDto(7, "alice", "admin"), "mfa_required", "risk", "ticket-1");
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.AuthLoginFlow, PodBinaryCodec.EncodeAuthLoginFlow(flow));

        Assert.Equal(ReadProtocolFixtureBytes("auth-login-flow-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedMfaChallengeResultFixture()
    {
        var payload = new System.Buffers.ArrayBufferWriter<byte>();
        var dto = new MfaChallengeResultDto(
            true,
            "login",
            "proof-1",
            new AuthIdentitySnapshotDto(7, "alice", "admin"));

        PodBinaryCodec.WriteMfaChallengeResult(dto, payload);
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.MfaChallengeResult, payload.WrittenSpan.ToArray());

        Assert.Equal(ReadProtocolFixtureBytes("mfa-challenge-result-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedMfaSetupStartFixture()
    {
        MfaSetupStartDto dto = new(
            true,
            "secret",
            "otpauth://totp/Fsus%20Blog?secret=secret",
            "Fsus Blog",
            "alice@example.com");

        var payload = new System.Buffers.ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteMfaSetupStart(dto, payload);
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.MfaSetupStart, payload.WrittenSpan.ToArray());

        Assert.Equal(ReadProtocolFixtureBytes("mfa-setup-start-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedAuthSessionListFixture()
    {
        List<UserSessionSummaryDto> sessions =
        [
            new(
                "session-1",
                "fp-1",
                "127.0.0.1",
                "Chrome on Linux",
                new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc),
                true,
                true),
            new(
                "session-2",
                "fp-2",
                "10.0.0.2",
                "Safari on iPhone",
                null,
                false,
                false)
        ];

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.AuthSessionList, PodBinaryCodec.EncodeUserSessions(sessions));

        Assert.Equal(ReadProtocolFixtureBytes("auth-session-list-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedCurrentUserSnapshotFixture()
    {
        CurrentUserSnapshotDto snapshot = new(123, "alice", "User", 1, null, null);

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.CurrentUserSnapshot, PodBinaryCodec.EncodeCurrentUserSnapshot(snapshot));

        Assert.Equal(ReadProtocolFixtureBytes("current-user-snapshot-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedMfaProfileFixture()
    {
        MfaProfileDto dto = new(true, new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc));

        var payload = new System.Buffers.ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteMfaProfile(dto, payload);
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.MfaProfile, payload.WrittenSpan.ToArray());

        Assert.Equal(ReadProtocolFixtureBytes("mfa-profile-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedCategoryListFixture()
    {
        List<CategoryListItemResponse> categories =
        [
            new() { Id = 1, Name = "Tech", ArticleCount = 2 },
            new() { Id = 2, Name = "Life", ArticleCount = 0 }
        ];

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.CategoryList, PodBinaryCodec.EncodeCategoryList(categories));

        Assert.Equal(ReadProtocolFixtureBytes("category-list-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedConversationListFixture()
    {
        var page = new PageResponse<ConversationListItemResponse>
        {
            Total = 1,
            Items =
            [
                new ConversationListItemResponse
                {
                    ConversationId = "7",
                    Subject = "Support",
                    Status = (ConversationStatusValue)1,
                    IsSystemSource = true,
                    CanReply = true,
                    UnreadCount = 2,
                    LastMessageAt = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc),
                    UpdatedAt = new DateTime(2026, 1, 3, 3, 4, 5, DateTimeKind.Utc),
                    LastMessage = new ConversationMessagePreviewResponse
                    {
                        SenderType = (ConversationSenderValue)1,
                        SenderName = "Admin",
                        BodyPreview = "Latest reply",
                        CreatedAt = new DateTime(2026, 1, 4, 3, 4, 5, DateTimeKind.Utc)
                    }
                }
            ]
        };

        var payload = new System.Buffers.ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteConversationList(page, payload);
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ConversationList, payload.WrittenSpan.ToArray());

        Assert.Equal(ReadProtocolFixtureBytes("conversation-list-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedConversationMessageFixture()
    {
        var dto = new ConversationMessageResponse
        {
            MessageId = "11",
            ConversationId = "7",
            SenderType = (ConversationSenderValue)0,
            SenderName = "Alice",
            Body = "Message body",
            CreatedAt = new DateTime(2026, 1, 2, 4, 4, 5, DateTimeKind.Utc)
        };

        var payload = new System.Buffers.ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteConversationMessage(dto, payload);
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ConversationMessage, payload.WrittenSpan.ToArray());

        Assert.Equal(ReadProtocolFixtureBytes("conversation-message-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedConversationDetailFixture()
    {
        var dto = new ConversationDetailResponse
        {
            ConversationId = "7",
            Subject = "Support",
            Status = (ConversationStatusValue)0,
            IsSystemSource = false,
            CanReply = true,
            UnreadCount = 1,
            LastMessageAt = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc),
            Messages =
            [
                new ConversationMessageResponse
                {
                    MessageId = "11",
                    ConversationId = "7",
                    SenderType = (ConversationSenderValue)0,
                    SenderName = "Alice",
                    Body = "Message body",
                    CreatedAt = new DateTime(2026, 1, 2, 4, 4, 5, DateTimeKind.Utc)
                }
            ]
        };

        var payload = new System.Buffers.ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteConversationDetail(dto, payload);
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ConversationDetail, payload.WrittenSpan.ToArray());

        Assert.Equal(ReadProtocolFixtureBytes("conversation-detail-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedCommentArticleCursorFixture()
    {
        CursorResponse<CommentThreadItemDto> cursor = new()
        {
            Data =
            [
                new CommentThreadItemDto(
                    "101",
                    "root comment",
                    new DateTime(2026, 5, 12, 0, 0, 0, DateTimeKind.Utc),
                    "alice",
                    new CommentAuthorViewDto("public", "alice", "zh-CN", null, null, null),
                    "101",
                    false,
                    3,
                    true,
                    [
                        new CommentReplyPreviewItemDto(
                            "202",
                            "preview reply",
                            new DateTime(2026, 5, 12, 1, 2, 3, DateTimeKind.Utc),
                            "bob",
                            new CommentAuthorViewDto("public", "bob", "zh-CN", null, null, null),
                            "alice",
                            new CommentAuthorViewDto("public", "alice", "zh-CN", null, null, null),
                            false)
                    ])
            ],
            NextCursor = "777",
            HasMore = true
        };

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.CommentArticleCursor, PodBinaryCodec.EncodeCommentThreadCursor(cursor));

        Assert.Equal(ReadProtocolFixtureBytes("comment-article-cursor-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedArticleListFixture()
    {
        CorePageResult<ArticleListCoreModel> page = new(
        [
            new ArticleListCoreModel(
                default,
                11,
                "Intro AEDS",
                "Binary protocol basics",
                null,
                null,
                42,
                new DateTime(2026, 5, 12, 12, 34, 56, DateTimeKind.Utc),
                new ArticleCategoryCoreModel(3, "Protocol"),
                [
                    new TagCoreModel(9, "binary"),
                    new TagCoreModel(10, "contract")
                ],
                false),
            new ArticleListCoreModel(
                default,
                12,
                "Hydration Fixes",
                string.Empty,
                null,
                null,
                7,
                new DateTime(2026, 5, 13, 8, 0, 0, DateTimeKind.Utc),
                new ArticleCategoryCoreModel(4, "Frontend"),
                [
                    new TagCoreModel(11, "vue")
                ],
                false)
        ],
        17);

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ArticleList, PodBinaryCodec.EncodeArticlePage(page));

        Assert.Equal(ReadProtocolFixtureBytes("article-list-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedArticleFeaturedFixture()
    {
        List<FeaturedArticleSummaryDto> items =
        [
            new(41, "Binary First", "/covers/first.webp", 88, new DateTime(2026, 5, 12, 6, 0, 0, DateTimeKind.Utc), new ArticleCategoryView(3, "Protocol")),
            new(42, "Hydration Again", "/covers/hydration.webp", 64, new DateTime(2026, 5, 13, 7, 30, 0, DateTimeKind.Utc), new ArticleCategoryView(4, "Frontend"))
        ];

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ArticleFeatured, PodBinaryCodec.EncodeFeaturedArticles(items));

        Assert.Equal(ReadProtocolFixtureBytes("article-featured-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedArticleDetailFixture()
    {
        var createTime = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var detailPod = FsusBlog.Core.Mapping.Projectors.PodProjector.ProjectArticleDetail(42, 123, createTime, 7, "Life", "Article 42", "Content 42\nHello", "Summary 42", out _);
        var detail = new FsusBlog.Core.Mapping.Models.ArticleDetailCoreModel(detailPod, 42, "Article 42", "Content 42\nHello", "Summary 42", "/covers/42.png", 123, 0, 0, false, createTime, new FsusBlog.Core.Mapping.Models.ArticleCategoryCoreModel(7, "Life"), [new FsusBlog.Core.Mapping.Models.TagCoreModel(9, "aeds"), new FsusBlog.Core.Mapping.Models.TagCoreModel(10, "blog")], 0, false);
        var payload = new System.Buffers.ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteArticleDetail(detail, payload);
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ArticleDetail, payload.WrittenSpan.ToArray());

        Assert.Equal(ReadProtocolFixtureBytes("article-detail-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedArticleHotFixture()
    {
        var hotPod1 = FsusBlog.Core.Mapping.Projectors.PodProjector.ProjectPopularArticle(11, "Hot 1", 999);
        var hotPod2 = FsusBlog.Core.Mapping.Projectors.PodProjector.ProjectPopularArticle(22, "Hot 2", 888);
        var hotList = new List<FsusBlog.Core.Mapping.Models.PopularArticleCoreModel> { new FsusBlog.Core.Mapping.Models.PopularArticleCoreModel(hotPod1, 11, "Hot 1", 999), new FsusBlog.Core.Mapping.Models.PopularArticleCoreModel(hotPod2, 22, "Hot 2", 888) };
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ArticleHot, PodBinaryCodec.EncodePopularArticles(hotList));

        Assert.Equal(ReadProtocolFixtureBytes("article-hot-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedArticleRelatedReadingFixture()
    {
        var createTime = new DateTime(2026, 5, 17, 12, 0, 0, DateTimeKind.Utc);
        var response = new RelatedReadingResponse(
            [
                new RelatedReadingItem(10, "AEDS public reads", "Binary contract", createTime, "同分类"),
                new RelatedReadingItem(11, "Hydration notes", null, createTime.AddDays(1), "全文关键词")
            ],
            new RelatedReadingItem(9, "Previous article", "previous summary", createTime.AddDays(-1), "上一篇"),
            new RelatedReadingItem(12, "Next article", null, createTime.AddDays(2), "下一篇"));

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ArticleRelatedReading, PodBinaryCodec.EncodeRelatedReading(response));

        Assert.Equal(ReadProtocolFixtureBytes("article-related-reading-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedArticleSearchFixture()
    {
        var searchCreateTime = new DateTime(2026, 5, 12, 12, 34, 56, DateTimeKind.Utc);
        var searchPod = FsusBlog.Core.Mapping.Projectors.PodProjector.ProjectArticleList(11, 42, searchCreateTime, 3, "Protocol", "Intro AEDS", "Binary protocol basics", false, out _);
        var searchList = new List<FsusBlog.Core.Mapping.Models.ArticleListCoreModel>
        {
            new FsusBlog.Core.Mapping.Models.ArticleListCoreModel(searchPod, 11, "Intro AEDS", "Binary protocol basics", null, null, 42, searchCreateTime, new FsusBlog.Core.Mapping.Models.ArticleCategoryCoreModel(3, "Protocol"), [new FsusBlog.Core.Mapping.Models.TagCoreModel(9, "binary"), new FsusBlog.Core.Mapping.Models.TagCoreModel(10, "contract")], false)
        };
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ArticleSearch, PodBinaryCodec.EncodeArticleSearch(searchList));

        Assert.Equal(ReadProtocolFixtureBytes("article-search-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedRecentCommentStatsFixture()
    {
        List<RecentCommentCoreModel> comments =
        [
            new(
                default,
                12,
                "alice",
                "first admin comment",
                new DateTime(2026, 5, 12, 9, 8, 7, DateTimeKind.Utc)),
            new(
                default,
                null,
                "anonymous",
                "hidden user",
                new DateTime(2026, 5, 12, 10, 0, 0, DateTimeKind.Utc))
        ];

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.RecentCommentStats, PodBinaryCodec.EncodeRecentCommentStats(comments));

        Assert.Equal(ReadProtocolFixtureBytes("recent-comment-stats-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedRegionStatsFixture()
    {
        List<RegionDistributionCoreModel> regions =
        [
            new(default, "China", 5),
            new(default, "Unknown", 2)
        ];

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.RegionStats, PodBinaryCodec.EncodeRegionStats(regions));

        Assert.Equal(ReadProtocolFixtureBytes("region-stats-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedAdminStatsFixture()
    {
        SiteStatsCoreModel stats = new(
            PodProjector.ProjectSiteStats(25, 120, 4, 900, 500, 400, 2, 1, 2),
            25,
            120,
            4,
            900,
            500,
            400,
            [
                new PopularArticleCoreModel(default, 31, "Top post", 88),
                new PopularArticleCoreModel(default, 32, "Second post", 55)
            ],
            [
                new RecentCommentCoreModel(default, 12, "alice", "first admin comment", new DateTime(2026, 5, 12, 9, 8, 7, DateTimeKind.Utc))
            ],
            [
                new RegionDistributionCoreModel(default, "China", 5),
                new RegionDistributionCoreModel(default, "Unknown", 2)
            ]);

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.AdminStats, PodBinaryCodec.EncodeSiteStats(stats));

        Assert.Equal(ReadProtocolFixtureBytes("admin-stats-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedSeoConfigFixture()
    {
        SeoConfigPublicDto dto = new()
        {
            Title = "Fsus Blog",
            Description = "Forward Forever",
            Keywords = "blog,aeds,hydration",
            Author = "Fsu",
            OgImage = "/images/og.png",
            BaseUrl = "https://fsus.example",
            FaviconSvgUrl = "/favicon.svg",
            FaviconIcoUrl = "/favicon.ico",
            FaviconPngUrl = "/icons/favicon-96.png",
            AppleTouchIconUrl = "/apple-touch-icon.png",
            ManifestName = "Fsus Blog",
            ManifestShortName = "Fsus",
            PwaIcon192Url = "/icons/icon-192.png",
            PwaIcon512Url = "/icons/icon-512.png",
            PwaMaskableIconUrl = "/icons/maskable-512.png",
            ThemeColor = "#0f0f11",
            BackgroundColor = "#fcfcfc",
            SiteLogoUrl = "/brand/site-logo.svg",
            SiteLogoDarkUrl = "/brand/site-logo-dark.svg",
            SiteWordmarkUrl = "/brand/site-wordmark.svg",
            AdminLogoUrl = "/brand/admin-logo.svg",
            AdminCollapsedIconUrl = "/brand/admin-icon.svg",
            LoginLogoUrl = "/brand/login-logo.svg",
            LoginIconUrl = "/brand/login-icon.svg"
        };

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.SeoConfig, PodBinaryCodec.EncodeSeoConfig(dto));

        Assert.Equal(ReadProtocolFixtureBytes("seo-config-frame.hex"), encoded);
    }

    [Fact]
    public void BackendEncoder_MatchesSharedPageContentFixture()
    {
        PageContentPublicDto dto = new()
        {
            Slug = "about",
            Content = "# About\n\nHydration-safe binary payload."
        };

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.PageContent, PodBinaryCodec.EncodePageContent(dto));

        Assert.Equal(ReadProtocolFixtureBytes("page-content-frame.hex"), encoded);
    }

    private static Dictionary<string, ushort> ParseFrontendFrameTypes(string source)
    {
        Match enumMatch = FrontendFrameEnumRegex().Match(source);
        Assert.True(enumMatch.Success, "Unable to locate frontend FrameType enum.");

        var result = new Dictionary<string, ushort>(StringComparer.Ordinal);
        MatchCollection matches = FrontendFrameEntryRegex().Matches(enumMatch.Groups[1].Value);
        for (int i = 0; i < matches.Count; i++)
        {
            Match match = matches[i];
            string name = match.Groups[1].Value;
            ushort value = ushort.Parse(match.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture);
            result[name] = value;
        }

        return result;
    }

    private static int ParseIntConstant(string source, string constantName)
    {
        Match match = Regex.Match(source, $@"export const {Regex.Escape(constantName)} = (\d+);", RegexOptions.Multiline);
        Assert.True(match.Success, $"Unable to locate frontend constant {constantName}.");
        return int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
    }

    private static uint ParseHexConstant(string source, string constantName)
    {
        Match match = Regex.Match(source, $@"export const {Regex.Escape(constantName)} = 0x([0-9a-fA-F]+);", RegexOptions.Multiline);
        Assert.True(match.Success, $"Unable to locate frontend constant {constantName}.");
        return uint.Parse(match.Groups[1].Value, System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture);
    }

    private static string ReadFrontendFrameProtocolSource()
    {
        return ReadRepoFile("src/frontend/wasm/web/protocol/frame.ts");
    }

    private static byte[] ReadProtocolFixtureBytes(string fileName)
    {
        string relativePath = Path.Combine("tests", "fixtures", "protocol", fileName);
        string fixturePath = BackendTestPaths.FromRoot(relativePath);
        Assert.True(File.Exists(fixturePath), $"{relativePath} must exist.");
        string hex = Regex.Replace(File.ReadAllText(fixturePath), @"\s+", string.Empty);
        return Convert.FromHexString(hex);
    }

    private static string ReadRepoFile(string relativePath)
    {
        string fullPath = BackendTestPaths.FromRoot(relativePath);
        Assert.True(File.Exists(fullPath), $"{relativePath} must exist.");
        return File.ReadAllText(fullPath);
    }

    [GeneratedRegex(@"export\s+(?:const|enum)\s+FrameType\s*(?:=\s*)?\{([^}]*)\}", RegexOptions.Singleline)]
    private static partial Regex FrontendFrameEnumRegex();

    [GeneratedRegex(@"^\s*([A-Za-z0-9_]+)\s*(?:=|:)\s*(\d+),?\s*$", RegexOptions.Multiline)]
    private static partial Regex FrontendFrameEntryRegex();
}

using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;
using FsusBlog.Shared;
using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Validation;

using CoreAedsEncoder = FsusBlog.Core.Algorithms.AedsEncoder;
using CoreFrameType = FsusBlog.Core.Algorithms.AedsFrameType;
namespace FsusBlog.Server.Tests;

public sealed class AedsProtocolCrossLanguageTests
{
    private static readonly Lazy<string> s_frontendProtocolRuntimeJson = new(ExecuteFrontendProtocolModule);

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void GeneratedContracts_CoverEveryFrameTypeAndTheExactV2HeaderLayout()
    {
        AssertGeneratedProtocolIsInSync();
        Dictionary<string, ushort> coreFrameTypes = Enum.GetValues<CoreFrameType>()
            .ToDictionary(static value => value.ToString(), static value => (ushort)value, StringComparer.Ordinal);
        Dictionary<string, ushort> sharedFrameTypes = Enum.GetValues<FsusBlog.Shared.AedsFrameType>()
            .ToDictionary(static value => value.ToString(), static value => (ushort)value, StringComparer.Ordinal);

        Assert.Equal(AedsProtocolMetadata.FrameTypes.Count, coreFrameTypes.Count);
        Assert.Equal(coreFrameTypes.Count, sharedFrameTypes.Count);
        foreach ((string name, ushort value) in AedsProtocolMetadata.FrameTypes)
        {
            Assert.Equal(value, coreFrameTypes[name]);
            Assert.Equal(value, sharedFrameTypes[name]);
        }
        Assert.False(File.Exists(BackendTestPaths.FromRoot("src/core/Algorithms/AedsFrameHeader.cs")));

        Assert.Equal(16, Marshal.SizeOf<AedsFrameHeader>());
        Assert.Equal(0, Marshal.OffsetOf<AedsFrameHeader>(nameof(AedsFrameHeader.MagicValue)).ToInt32());
        Assert.Equal(4, Marshal.OffsetOf<AedsFrameHeader>(nameof(AedsFrameHeader.Version)).ToInt32());
        Assert.Equal(5, Marshal.OffsetOf<AedsFrameHeader>(nameof(AedsFrameHeader.HeaderLength)).ToInt32());
        Assert.Equal(6, Marshal.OffsetOf<AedsFrameHeader>(nameof(AedsFrameHeader.Flags)).ToInt32());
        Assert.Equal(8, Marshal.OffsetOf<AedsFrameHeader>(nameof(AedsFrameHeader.FrameType)).ToInt32());
        Assert.Equal(10, Marshal.OffsetOf<AedsFrameHeader>(nameof(AedsFrameHeader.PayloadLength)).ToInt32());
        Assert.Equal(14, Marshal.OffsetOf<AedsFrameHeader>(nameof(AedsFrameHeader.PayloadCrc16)).ToInt32());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendRoundTrip_AcceptsEveryGeneratedFrameType()
    {
        var encoder = new CoreAedsEncoder();
        foreach (CoreFrameType frameType in Enum.GetValues<CoreFrameType>())
        {
            byte[] payload = [(byte)((ushort)frameType & 0xff), (byte)((ushort)frameType >> 8)];
            byte[] frame = encoder.Encode(frameType, payload);
            Result<FsusBlog.Core.Algorithms.AedsDecodeResult> decoded = encoder.TryDecode(frame);

            // Enum retains retired wire numbers so decoders can reject them explicitly.
            if (frameType is CoreFrameType.RetiredCredentialSpecificRevocationRequest
                or CoreFrameType.RetiredCredentialSpecificRevocationResponse)
            {
                Assert.False(decoded.IsSuccess, $"{frameType}: retired frames must not round-trip");
                Assert.Equal("AEDS frame type retired", decoded.Error.Message);
                continue;
            }

            Assert.True(decoded.IsSuccess, $"{frameType}: {decoded.Error.Message}");
            Assert.Equal(frameType, decoded.Value.FrameType);
            Assert.Equal(payload, decoded.Value.Payload.ToArray());
        }
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void FrontendFrameTypeEnum_MatchesSharedProtocolMetadata()
    {
        using JsonDocument frontend = ReadFrontendProtocolRuntime();
        Dictionary<string, ushort> frontendFrameTypes = frontend.RootElement
            .GetProperty("frameTypes")
            .EnumerateObject()
            .ToDictionary(
                static property => property.Name,
                static property => property.Value.GetUInt16(),
                StringComparer.Ordinal);

        Assert.Equal(AedsProtocolMetadata.FrameTypes.Count, frontendFrameTypes.Count);
        foreach ((string name, ushort raw) in AedsProtocolMetadata.FrameTypes)
        {
            Assert.True(frontendFrameTypes.TryGetValue(name, out ushort frontendRaw), $"Missing frontend frame type: {name}");
            Assert.Equal(raw, frontendRaw);
        }
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "aeds-legacy-admin-reset-retired")]
    public void LegacyAdminPasswordResetFrame_IsRetiredAcrossProtocolSurfaces()
    {
        const string RetiredName = "AdminResetUserPasswordRequest";

        Assert.DoesNotContain(RetiredName, Enum.GetNames<FsusBlog.Shared.AedsFrameType>());
        Assert.DoesNotContain(RetiredName, Enum.GetNames<CoreFrameType>());

        using JsonDocument frontend = ReadFrontendProtocolRuntime();
        Assert.False(frontend.RootElement.GetProperty("frameTypes").TryGetProperty(RetiredName, out _));

        Span<byte> frame = stackalloc byte[AedsFrameHeader.Size];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(frame[0..4], CoreAedsEncoder.Magic);
        frame[4] = AedsFrameHeader.CurrentVersion;
        frame[5] = AedsFrameHeader.CurrentHeaderLength;
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(frame[8..10], 40);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(frame[14..16], FsusBlog.Core.Algorithms.AedsCrc16.Compute([]));
        Result<FsusBlog.Core.Algorithms.AedsDecodeResult> decoded = new CoreAedsEncoder().TryDecode(frame.ToArray());
        Assert.False(decoded.IsSuccess);
        Assert.Equal("AEDS frame type retired", decoded.Error.Message);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "aeds-legacy-aot-upload-removed")]
    public void LegacyAotUploadFrame42_IsRemovedAcrossProtocolAndCodecSurfaces()
    {
        string retiredName = string.Concat("Article", "Aot", "Bundle", "Request");
        string bundlePod = string.Concat("Public", "Aot", "Bundle", "Pod");
        string entryPod = string.Concat("Public", "Aot", "Entry", "Pod");
        string[] retiredTokens = [retiredName, bundlePod, entryPod];

        Assert.DoesNotContain(retiredName, Enum.GetNames<FsusBlog.Shared.AedsFrameType>());
        Assert.DoesNotContain(retiredName, Enum.GetNames<CoreFrameType>());
        Assert.False(AedsProtocolMetadata.FrameTypes.ContainsKey(retiredName));
        Assert.Equal((ushort)41, (ushort)CoreFrameType.ArticleWriteRequest);
        Assert.Equal((ushort)47, (ushort)CoreFrameType.AuthDeleteAccountRequest);

        using JsonDocument frontend = ReadFrontendProtocolRuntime();
        JsonElement frontendFrames = frontend.RootElement.GetProperty("frameTypes");
        foreach (string token in retiredTokens)
        {
            Assert.False(frontendFrames.TryGetProperty(token, out _));
        }

        Type[] protocolSurfaceTypes =
        {
            typeof(PodBinaryCodec),
            typeof(FsusBlog.Shared.AedsFrameType),
            typeof(CoreFrameType),
            typeof(PodProjector)
        };
        TypeInfo[] runtimeTypes = protocolSurfaceTypes
            .Select(static type => type.Assembly)
            .Distinct()
            .SelectMany(static assembly => assembly.DefinedTypes)
            .ToArray();
        foreach (string token in retiredTokens)
        {
            Assert.DoesNotContain(runtimeTypes, type => string.Equals(type.Name, token, StringComparison.Ordinal));
        }

        string codecShape = RuntimeMetadataInspection.DescribeType(typeof(PodBinaryCodec));
        Assert.All(retiredTokens, token => Assert.DoesNotContain(token, codecShape, StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void FrontendHeaderConstants_MatchSharedProtocolMetadata()
    {
        using JsonDocument frontend = ReadFrontendProtocolRuntime();
        int headerLength = frontend.RootElement.GetProperty("headerLength").GetInt32();
        int version = frontend.RootElement.GetProperty("version").GetInt32();
        uint magic = frontend.RootElement.GetProperty("magic").GetUInt32();

        Assert.Equal(AedsProtocolMetadata.FrameHeaderSize, headerLength);
        Assert.Equal(AedsProtocolMetadata.FrameVersion, version);
        Assert.Equal(FsusBlog.Shared.AedsFrameHeader.Magic, magic);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_MatchesSharedMutationIdFixture()
    {
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.MutationId, [1, 2, 3, 4, 5]);

        Assert.Equal(ReadProtocolFixtureBytes("mutation-id-frame.hex"), encoded);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_MatchesSharedApiErrorFixture()
    {
        ErrorDetail error = ErrorDetail.Create(ErrorCode.Forbidden, "权限不足", "role_required", "trace-123");
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ApiError, PodBinaryCodec.EncodeApiError(error, 403));

        Assert.Equal(ReadProtocolFixtureBytes("api-error-frame.hex"), encoded);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_MatchesSharedPowChallengeFixture()
    {
        PowChallenge challenge = new("salt-value", 4, 1778290000, "signature-value");
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.PowChallenge, PodBinaryCodec.EncodePowChallenge(challenge));

        Assert.Equal(ReadProtocolFixtureBytes("pow-challenge-frame.hex"), encoded);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_MatchesSharedAuthLoginFlowFixture()
    {
        AuthLoginFlowDto flow = new(7, "anonymous_account", "mfa_required", "risk", "ticket-1");
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.AuthLoginFlow, PodBinaryCodec.EncodeAuthLoginFlow(flow));

        Assert.Equal(ReadProtocolFixtureBytes("auth-login-flow-frame.hex"), encoded);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_MatchesSharedMfaChallengeResultFixture()
    {
        var payload = new System.Buffers.ArrayBufferWriter<byte>();
        var dto = new MfaChallengeResultDto(
            true,
            "login",
            "proof-1",
            new AuthIdentitySnapshotDto(7, "anonymous_account"));

        PodBinaryCodec.WriteMfaChallengeResult(dto, payload);
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.MfaChallengeResult, payload.WrittenSpan.ToArray());

        Assert.Equal(ReadProtocolFixtureBytes("mfa-challenge-result-frame.hex"), encoded);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
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
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_MatchesSharedAuthSessionListFixture()
    {
        List<UserSessionSummaryDto> sessions =
        [
            new(
                SessionId: "session-1",
                DeviceLabel: "Chrome on Linux",
                CreatedAt: new DateTime(2026, 1, 2, 2, 3, 4, DateTimeKind.Utc),
                LastSeenAt: new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc),
                AuthenticationMethod: "passkey",
                AuthenticationStrength: "webauthn_uv",
                PasskeyFriendlyName: "Work security key",
                DurationPolicy: "persistent_30d",
                IsCurrent: true),
            new(
                SessionId: "session-2",
                DeviceLabel: "Safari on iPhone/iPad",
                CreatedAt: new DateTime(2026, 1, 1, 2, 3, 4, DateTimeKind.Utc),
                LastSeenAt: null,
                AuthenticationMethod: "other",
                AuthenticationStrength: "legacy_unverified",
                PasskeyFriendlyName: null,
                DurationPolicy: "browser_session",
                IsCurrent: false)
        ];

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.AuthSessionList, PodBinaryCodec.EncodeUserSessions(sessions));

        Assert.Equal(ReadProtocolFixtureBytes("auth-session-list-frame.hex"), encoded);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_MatchesSharedCurrentUserSnapshotFixture()
    {
        CurrentUserSnapshotDto snapshot = new(123, "anonymous_account", 1, null, null);

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.CurrentUserSnapshot, PodBinaryCodec.EncodeCurrentUserSnapshot(snapshot));

        Assert.Equal(ReadProtocolFixtureBytes("current-user-snapshot-frame.hex"), encoded);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_MatchesSharedIdentityAccountSnapshotFixture()
    {
        var deletedAt = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var snapshot = new IdentityAccountSnapshotCoreModel(
            AccountId: 42,
            PublicHandle: "Public Alice",
            PasskeyEnabled: true,
            RecoveryEnabled: true,
            TotpStepUpEnabled: true,
            AnonymousCredentialStatus: "active",
            AnonymousCredentialLevel: "strong_anonymous",
            IdentityKind: "anonymous_account",
            Status: 1,
            BanReason: "limited",
            DeletedAt: deletedAt);

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.IdentityAccountSnapshot, PodBinaryCodec.EncodeIdentityAccountSnapshot(snapshot));

        Assert.Equal(ReadProtocolFixtureBytes("identity-account-snapshot-frame.hex"), encoded);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_MatchesSharedMfaProfileFixture()
    {
        MfaProfileDto dto = new(true, new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc));

        var payload = new System.Buffers.ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteMfaProfile(dto, payload);
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.MfaProfile, payload.WrittenSpan.ToArray());

        Assert.Equal(ReadProtocolFixtureBytes("mfa-profile-frame.hex"), encoded);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
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
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
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
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
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
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_MatchesSharedConversationDetailFixture()
    {
        var dto = new ConversationDetailResponse
        {
            ConversationId = "7",
            ReadSnapshotMessageId = "11",
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
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
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
                    new CommentAuthorViewDto("public", "alice", "zh-CN", null, null),
                    "101",
                    false,
                    3,
                    true,
                    [
                        new CommentReplyPreviewItemDto(
                            "202",
                            "preview reply",
                            new DateTime(2026, 5, 12, 1, 2, 3, DateTimeKind.Utc),
                            new CommentAuthorViewDto("public", "bob", "zh-CN", null, null),
                            new CommentAuthorViewDto("public", "alice", "zh-CN", null, null),
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
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_EmitsArticleListWithExactPublicationCoordinates()
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
                false) with
            {
                CurrentRevisionId = 801,
                RevisionNo = 7,
                CurrentPublicationId = 1201,
                PublicationNo = 4
            },
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
                false) with
            {
                CurrentRevisionId = 802,
                RevisionNo = 2,
                CurrentPublicationId = 1202,
                PublicationNo = 1
            }
        ],
        17);

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ArticleList, PodBinaryCodec.EncodeArticlePage(page));

        Assert.Equal(ReadProtocolFixtureBytes("article-list-frame.hex"), encoded);

        Result<FsusBlog.Core.Algorithms.AedsDecodeResult> decodedFrame = new CoreAedsEncoder().TryDecode(encoded);
        Assert.True(decodedFrame.IsSuccess);
        Assert.True(PodBinaryCodec.TryDecodeArticlePage(decodedFrame.Value.Payload, out var decoded));
        Assert.Equal([801L, 802L], decoded.Items.Select(static item => item.CurrentRevisionId).ToArray());
        Assert.Equal([1201L, 1202L], decoded.Items.Select(static item => item.CurrentPublicationId!.Value).ToArray());
        Assert.Equal([7, 2], decoded.Items.Select(static item => item.RevisionNo).ToArray());
        Assert.Equal([4, 1], decoded.Items.Select(static item => item.PublicationNo!.Value).ToArray());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative)]
    public void BackendDecoder_RejectsRetiredArticleListCursorEnvelope()
    {
        byte[] frame = ReadProtocolFixtureBytes("article-list-v1-rejected-frame.hex");
        Result<FsusBlog.Core.Algorithms.AedsDecodeResult> decodedFrame = new CoreAedsEncoder().TryDecode(frame);

        Assert.True(decodedFrame.IsSuccess);
        Assert.False(PodBinaryCodec.TryDecodeArticlePage(decodedFrame.Value.Payload, out _));
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
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
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_EmitsArticleDetailV5WithExactPublicationCoordinates()
    {
        var createTime = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var detailPod = FsusBlog.Core.Mapping.Projectors.PodProjector.ProjectArticleDetail(42, 123, createTime, 7, "Life", "Article 42", "Content 42\nHello", "Summary 42", out _);
        var rights = new ArticleRightsCoreModel(
            SnapshotId: 901,
            ArticleRevisionId: 801,
            RevisionNo: 7,
            Enabled: true,
            LicenseType: "CC-BY-4.0",
            CopyrightHolder: "Fsus",
            CopyrightYear: 2026,
            RightsStatement: "Reuse with attribution.",
            AttributionTemplate: "{title} - {holder}",
            CopyPolicy: "append-attribution",
            MaxExcerptChars: 300,
            AllowCodeCopy: true,
            ShowPublicBadge: true,
            ProofBindingEnabled: true,
            CanonicalUrl: "https://fsus.example/article/42",
            PolicyHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ContentCanonicalHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ProofUrl: "urn:fsus:rights-proof:901",
            ProofStatus: "ready");
        var detail = new FsusBlog.Core.Mapping.Models.ArticleDetailCoreModel(detailPod, 42, "Article 42", "Content 42\nHello", "Summary 42", "/covers/42.png", 123, 0, 0, false, createTime, new FsusBlog.Core.Mapping.Models.ArticleCategoryCoreModel(7, "Life"), [new FsusBlog.Core.Mapping.Models.TagCoreModel(9, "aeds"), new FsusBlog.Core.Mapping.Models.TagCoreModel(10, "blog")], 7, false, 2, null, createTime, createTime.AddHours(2), rights, 801, 7, 1201, 4);
        var payload = new System.Buffers.ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteArticleDetail(detail, payload);
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ArticleDetail, payload.WrittenSpan.ToArray());
        Result<FsusBlog.Core.Algorithms.AedsDecodeResult> decodedFrame = new CoreAedsEncoder().TryDecode(encoded);
        Assert.True(decodedFrame.IsSuccess);
        Assert.True(PodBinaryCodec.TryDecodeArticleDetail(decodedFrame.Value.Payload, out var decoded));
        Assert.Equal(801, decoded.CurrentRevisionId);
        Assert.Equal(7, decoded.RevisionNo);
        Assert.Equal(1201, decoded.CurrentPublicationId);
        Assert.Equal(4, decoded.PublicationNo);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendDecoder_ReadsCheckedInArticleDetailV3FixtureWithoutUpdatedAt()
    {
        byte[] frame = ReadProtocolFixtureBytes("article-detail-frame.hex");
        Result<FsusBlog.Core.Algorithms.AedsDecodeResult> decodedFrame = new CoreAedsEncoder().TryDecode(frame);

        Assert.True(decodedFrame.IsSuccess);
        Assert.Equal(CoreFrameType.ArticleDetail, decodedFrame.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeArticleDetail(decodedFrame.Value.Payload, out var detail));
        Assert.Equal(42, detail.Id);
        Assert.Equal("Article 42", detail.Title);
        Assert.Null(detail.UpdatedAt);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_MatchesSharedArticleHotFixture()
    {
        var hotPod1 = FsusBlog.Core.Mapping.Projectors.PodProjector.ProjectPopularArticle(11, "Hot 1", 999);
        var hotPod2 = FsusBlog.Core.Mapping.Projectors.PodProjector.ProjectPopularArticle(22, "Hot 2", 888);
        var hotList = new List<FsusBlog.Core.Mapping.Models.PopularArticleCoreModel> { new FsusBlog.Core.Mapping.Models.PopularArticleCoreModel(hotPod1, 11, "Hot 1", 999), new FsusBlog.Core.Mapping.Models.PopularArticleCoreModel(hotPod2, 22, "Hot 2", 888) };
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ArticleHot, PodBinaryCodec.EncodePopularArticles(hotList));

        Assert.Equal(ReadProtocolFixtureBytes("article-hot-frame.hex"), encoded);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
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
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_EmitsArticleSearchWithExactPublicationCoordinates()
    {
        var searchCreateTime = new DateTime(2026, 5, 12, 12, 34, 56, DateTimeKind.Utc);
        var searchPod = FsusBlog.Core.Mapping.Projectors.PodProjector.ProjectArticleList(11, 42, searchCreateTime, 3, "Protocol", "Intro AEDS", "Binary protocol basics", false, out _);
        var searchList = new List<FsusBlog.Core.Mapping.Models.ArticleListCoreModel>
        {
            new FsusBlog.Core.Mapping.Models.ArticleListCoreModel(searchPod, 11, "Intro AEDS", "Binary protocol basics", null, null, 42, searchCreateTime, new FsusBlog.Core.Mapping.Models.ArticleCategoryCoreModel(3, "Protocol"), [new FsusBlog.Core.Mapping.Models.TagCoreModel(9, "binary"), new FsusBlog.Core.Mapping.Models.TagCoreModel(10, "contract")], false) with
            {
                CurrentRevisionId = 801,
                RevisionNo = 7,
                CurrentPublicationId = 1201,
                PublicationNo = 4
            }
        };
        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.ArticleSearch, PodBinaryCodec.EncodeArticleSearch(searchList));

        Result<FsusBlog.Core.Algorithms.AedsDecodeResult> decodedFrame = new CoreAedsEncoder().TryDecode(encoded);
        Assert.True(decodedFrame.IsSuccess);
        Assert.True(PodBinaryCodec.TryDecodeArticleSearch(decodedFrame.Value.Payload, out var decoded));
        ArticleListCoreModel item = Assert.Single(decoded);
        Assert.Equal(801, item.CurrentRevisionId);
        Assert.Equal(7, item.RevisionNo);
        Assert.Equal(1201, item.CurrentPublicationId);
        Assert.Equal(4, item.PublicationNo);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_MatchesSharedRecentCommentStatsFixture()
    {
        List<RecentCommentCoreModel> comments =
        [
            new(
                default,
                "Alice Public",
                "public",
                null,
                null,
                "first admin comment",
                new DateTime(2026, 5, 12, 9, 8, 7, DateTimeKind.Utc)),
            new(
                default,
                "强匿名评论者",
                "zk_anonymous",
                "已验证匿名凭证",
                "article:42",
                "hidden user",
                new DateTime(2026, 5, 12, 10, 0, 0, DateTimeKind.Utc))
        ];

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.RecentCommentStats, PodBinaryCodec.EncodeRecentCommentStats(comments));

        Assert.Equal(ReadProtocolFixtureBytes("recent-comment-stats-frame.hex"), encoded);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
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
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void BackendEncoder_MatchesSharedAdminStatsFixture()
    {
        SiteStatsCoreModel stats = new(
            PodProjector.ProjectSiteStats(25, 120, 4, 900, 880, 300, 650, 250, 2, 1, 2),
            25,
            120,
            4,
            900,
            880,
            300,
            650,
            250,
            [
                new PopularArticleCoreModel(default, 31, "Top post", 88),
                new PopularArticleCoreModel(default, 32, "Second post", 55)
            ],
            [
                new RecentCommentCoreModel(default, "Alice Public", "public", null, null, "first admin comment", new DateTime(2026, 5, 12, 9, 8, 7, DateTimeKind.Utc))
            ],
            [
                new RegionDistributionCoreModel(default, "China", 5),
                new RegionDistributionCoreModel(default, "Unknown", 2)
            ]);

        byte[] encoded = new CoreAedsEncoder().Encode(CoreFrameType.AdminStats, PodBinaryCodec.EncodeSiteStats(stats));

        Assert.Equal(ReadProtocolFixtureBytes("admin-stats-frame.hex"), encoded);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
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
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
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

    private static JsonDocument ReadFrontendProtocolRuntime()
        => JsonDocument.Parse(s_frontendProtocolRuntimeJson.Value);

    private static string ExecuteFrontendProtocolModule()
    {
        var startInfo = new ProcessStartInfo("node")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add("--no-warnings");
        startInfo.ArgumentList.Add("--experimental-strip-types");
        startInfo.ArgumentList.Add("--input-type=module");
        startInfo.ArgumentList.Add("--eval");
        startInfo.ArgumentList.Add("import { pathToFileURL } from 'node:url'; const module = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(JSON.stringify({ frameTypes: module.FrameType, headerLength: module.AEDS_HEADER_LENGTH, version: module.AEDS_VERSION, magic: module.AEDS_MAGIC }));");
        startInfo.ArgumentList.Add(BackendTestPaths.FromRoot("src/frontend/wasm/web/protocol/frame.ts"));

        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Unable to execute frontend AEDS protocol module.");
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.Equal(0, process.ExitCode);
        Assert.True(string.IsNullOrWhiteSpace(stderr), stderr);
        Assert.False(string.IsNullOrWhiteSpace(stdout));
        return stdout;
    }

    private static void AssertGeneratedProtocolIsInSync()
    {
        var startInfo = new ProcessStartInfo("node")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add(BackendTestPaths.FromRoot("tools/frontend/generate-aeds-protocol.mjs"));
        startInfo.ArgumentList.Add("--check");

        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Unable to verify generated AEDS protocol surfaces.");
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, $"{stdout}{Environment.NewLine}{stderr}");
    }

    private static byte[] ReadProtocolFixtureBytes(string fileName)
    {
        string relativePath = Path.Combine("tests", "fixtures", "protocol", fileName);
        string fixturePath = BackendTestPaths.FromRoot(relativePath);
        Assert.True(File.Exists(fixturePath), $"{relativePath} must exist.");
        string hex = Regex.Replace(File.ReadAllText(fixturePath), @"\s+", string.Empty);
        return Convert.FromHexString(hex);
    }

}

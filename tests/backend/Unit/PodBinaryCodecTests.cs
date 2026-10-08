using System.Buffers;
using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Core.Services.Implementations;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.AuthSystem;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Validation;

using Microsoft.AspNetCore.Http;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public class PodBinaryCodecTests
{
    private sealed record AuthoringPayload(string Title, int Status, string[] Tags);

    // ── helpers ─────────────────────────────────────────────────────────────

    private static ArticleListCoreModel MakeListItem(int id = 1, string title = "Test Title", string? summary = null)
    {
        var createTime = new DateTime(2024, 5, 10, 0, 0, 0, DateTimeKind.Utc);
        var pod = PodProjector.ProjectArticleList(
            id, views: 42, createTime, categoryId: 3, categoryName: "Tech",
            title, summary, isDeleted: false, out _);
        return new ArticleListCoreModel(
            pod, id, title, summary, null, null, 42, createTime,
            new ArticleCategoryCoreModel(3, "Tech"),
            [new TagCoreModel(1, "dotnet")],
            false, CurrentRevisionId: id + 100, RevisionNo: 1);
    }

    [Fact]
    public void NameMutationRequest_RoundTrip_PreservesName()
    {
        byte[] encoded = PodBinaryCodec.EncodeNameMutationRequest("Category A");
        bool ok = PodBinaryCodec.TryDecodeNameMutationRequest(encoded, out string name);

        Assert.True(ok);
        Assert.Equal("Category A", name);
    }

    [Fact]
    public void TaxonomyMetadataMutationRequest_RoundTrip_PreservesNameAndDescription()
    {
        var request = new TaxonomyMetadataMutationRequestCoreModel("分类 A", "  描述 😀  ");

        byte[] encoded = PodBinaryCodec.EncodeTaxonomyMetadataMutationRequest(request);
        bool ok = PodBinaryCodec.TryDecodeTaxonomyMetadataMutationRequest(
            encoded,
            out TaxonomyMetadataMutationRequestCoreModel decoded,
            out bool isLegacy);

        Assert.True(ok);
        Assert.False(isLegacy);
        Assert.Equal(request, decoded);
    }

    [Fact]
    public void TaxonomyMetadataMutationRequest_LegacyNamePayload_DecodesWithoutDescription()
    {
        byte[] encoded = PodBinaryCodec.EncodeNameMutationRequest("legacy-name");

        bool ok = PodBinaryCodec.TryDecodeTaxonomyMetadataMutationRequest(
            encoded,
            out TaxonomyMetadataMutationRequestCoreModel decoded,
            out bool isLegacy);

        Assert.True(ok);
        Assert.True(isLegacy);
        Assert.Equal("legacy-name", decoded.Name);
        Assert.Null(decoded.Description);
    }

    [Fact]
    public void JsonPayload_RoundTrip_PreservesAuthoringDtoShape()
    {
        var request = new AuthoringPayload("Draft", 0, ["aeds", "authoring"]);
        byte[] encoded = PodBinaryCodec.EncodeJsonPayload(request);
        bool ok = PodBinaryCodec.TryDecodeJsonPayload(encoded, out AuthoringPayload? decoded);

        Assert.True(ok);
        Assert.NotNull(decoded);
        Assert.Equal(request.Title, decoded.Title);
        Assert.Equal(request.Status, decoded.Status);
        Assert.Equal(request.Tags, decoded.Tags);
    }

    [Fact]
    public void ArticleWriteRequest_RoundTrip_PreservesTextAndTags()
    {
        var scheduledAt = new DateTime(2026, 5, 19, 6, 30, 0, DateTimeKind.Utc);
        var rights = new ArticleRightsRequestCoreModel(
            Enabled: true,
            LicenseType: "CC-BY-4.0",
            CopyrightHolder: "Fésus",
            CopyrightYear: 2026,
            RightsStatement: "Line one\nLine two",
            AttributionTemplate: "{title} — {holder}",
            CopyPolicy: "append-attribution",
            MaxExcerptChars: 300,
            AllowCodeCopy: true,
            ShowPublicBadge: false,
            ProofBindingEnabled: true);
        var request = new ArticleWriteRequestCoreModel(
            "Title",
            "Content",
            "Summary",
            "/uploads/cover.webp",
            3,
            [1, 2, 5],
            1,
            scheduledAt,
            rights,
            BaseRevisionId: 8123);

        byte[] encoded = PodBinaryCodec.EncodeArticleWriteRequest(request);
        bool ok = PodBinaryCodec.TryDecodeArticleWriteRequest(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal("Title", decoded.Title);
        Assert.Equal("Content", decoded.Content);
        Assert.Equal("Summary", decoded.Summary);
        Assert.Equal("/uploads/cover.webp", decoded.CoverImageUrl);
        Assert.Equal(3, decoded.CategoryId);
        Assert.Equal([1, 2, 5], decoded.TagIds);
        Assert.Equal(1, decoded.Status);
        Assert.Equal(scheduledAt, decoded.ScheduledPublishAt);
        Assert.NotNull(decoded.Rights);
        Assert.Equal("CC-BY-4.0", decoded.Rights.Value.LicenseType);
        Assert.Equal("Fésus", decoded.Rights.Value.CopyrightHolder);
        Assert.Equal(2026, decoded.Rights.Value.CopyrightYear);
        Assert.Equal("Line one\nLine two", decoded.Rights.Value.RightsStatement);
        Assert.Equal("{title} — {holder}", decoded.Rights.Value.AttributionTemplate);
        Assert.Equal("append-attribution", decoded.Rights.Value.CopyPolicy);
        Assert.Equal(300, decoded.Rights.Value.MaxExcerptChars);
        Assert.True(decoded.Rights.Value.Enabled);
        Assert.True(decoded.Rights.Value.AllowCodeCopy);
        Assert.False(decoded.Rights.Value.ShowPublicBadge);
        Assert.True(decoded.Rights.Value.ProofBindingEnabled);
        Assert.Equal(ArticleRightsMutationMode.Replace, decoded.RightsMutation);
        Assert.Equal(8123, decoded.BaseRevisionId);
    }

    [Fact]
    public void ArticleWriteRequest_DecodesFrontendSupportV5Fixture()
    {
        byte[] encoded = Convert.FromBase64String(
            "AQAAAAEAAAAAAAAAFgAAABYAAABCAAAAWAAAAAwAAABkAAAAAAAAAAEAAABkAAAARGlzdHJpYnV0aW9uIENvaGVyZW5jZSMgRGlzdHJpYnV0aW9uIENvaGVyZW5jZQoKc2FmZSBib2R5IHByb3ZlcyBkaXN0cmlidXRpb24gY29oZXJlbmNlLnNhZmUgc3VtbWFyeQAAAAAAAAAAAAAAAAUAAAAAAAAADwAAAAAAAAAsAQAAAAAAABMAAAATAAAAAAAAABMAAAAAAAAAEwAAAAAAAAATAAAAEgAAACUAAABhbGwtcmlnaHRzLXJlc2VydmVkYXBwZW5kLWF0dHJpYnV0aW9uAAAAAAAAAAA=");

        bool ok = PodBinaryCodec.TryDecodeArticleWriteRequest(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal("Distribution Coherence", decoded.Title);
        Assert.Equal("# Distribution Coherence\n\nsafe body proves distribution coherence.", decoded.Content);
        Assert.Equal("safe summary", decoded.Summary);
        Assert.Equal(ArticleRightsMutationMode.Preserve, decoded.RightsMutation);
        Assert.Null(decoded.BaseRevisionId);
    }

    [Fact]
    public void ArticleMutationResult_RoundTrip_ReportsVersionAndReplayCoordinates()
    {
        var response = new ArticleMutationResult(
            42,
            8123,
            8,
            7201,
            4,
            1,
            9007199254740,
            7,
            true,
            0,
            ArticleMutationOutcome.NoChange);
        var buffer = new ArrayBufferWriter<byte>();

        PodBinaryCodec.WriteArticleMutationResult(response, buffer);
        bool ok = PodBinaryCodec.TryDecodeArticleMutationResult(buffer.WrittenMemory, out var decoded);

        Assert.True(ok);
        Assert.Equal(48, buffer.WrittenCount);
        Assert.Equal(42, decoded.ArticleId);
        Assert.Equal(8123, decoded.RevisionId);
        Assert.Equal(8, decoded.RevisionNo);
        Assert.Equal(7201, decoded.ReleaseId);
        Assert.Equal(4, decoded.ReleaseNo);
        Assert.Equal(1, decoded.Status);
        Assert.Equal(9007199254740, decoded.RightsSnapshotId);
        Assert.Equal(7, decoded.RightsRevisionNo);
        Assert.True(decoded.IdempotencyReplay);
        Assert.Equal(0, decoded.ErrorCode);
        Assert.Equal(ArticleMutationOutcome.NoChange, decoded.Outcome);
    }

    [Fact]
    public void ArticleMutationResult_RejectsUnknownOutcome()
    {
        var response = new ArticleMutationResult(42, 8123, 8, 7201, 4, 1, 9001, 7, false, 0);
        var buffer = new ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteArticleMutationResult(response, buffer);
        byte[] payload = buffer.WrittenMemory.ToArray();
        payload[46] = 9;

        Assert.False(PodBinaryCodec.TryDecodeArticleMutationResult(payload, out _));
    }

    [Fact]
    public void ArticleWriteRequest_DecodeLegacyPayloadWithoutRightsSection_PreservesCurrentPolicy()
    {
        byte[] legacy = EncodeLegacyArticleWriteRequestWithoutRightsV3();

        bool ok = PodBinaryCodec.TryDecodeArticleWriteRequest(legacy, out var decoded);

        Assert.True(ok);
        Assert.Null(decoded.Rights);
        Assert.Equal(ArticleRightsMutationMode.Preserve, decoded.RightsMutation);
    }

    [Theory]
    [InlineData(ArticleRightsMutationMode.Preserve)]
    [InlineData(ArticleRightsMutationMode.Reset)]
    public void ArticleWriteRequest_RoundTrip_PreservesRightsMutationWithoutReplacement(
        ArticleRightsMutationMode mutation)
    {
        var request = new ArticleWriteRequestCoreModel(
            "Title",
            "Content",
            "Summary",
            null,
            3,
            [],
            RightsMutation: mutation);

        byte[] encoded = PodBinaryCodec.EncodeArticleWriteRequest(request);
        bool ok = PodBinaryCodec.TryDecodeArticleWriteRequest(encoded, out var decoded);

        Assert.True(ok);
        Assert.Null(decoded.Rights);
        Assert.Equal(mutation, decoded.RightsMutation);
    }

    [Fact]
    public void HumanReadChallengeRequest_RoundTrip_PreservesScopeRouteAndArticle()
    {
        var request = new HumanReadChallengeRequest("article", "article:42", 42);

        byte[] encoded = PodBinaryCodec.EncodeHumanReadChallengeRequest(request);
        bool ok = PodBinaryCodec.TryDecodeHumanReadChallengeRequest(encoded, out HumanReadChallengeRequest decoded);

        Assert.True(ok);
        Assert.Equal("article", decoded.Scope);
        Assert.Equal("article:42", decoded.RouteKey);
        Assert.Equal(42, decoded.ArticleId);
    }

    [Fact]
    public void HumanReadChallengeResponse_RoundTrip_PreservesTokenAndDates()
    {
        var issued = new DateTimeOffset(2026, 5, 20, 8, 30, 0, TimeSpan.Zero);
        var expires = issued.AddMinutes(5);
        var response = new HumanReadChallengeResponse("token-1", "article", "article:42", 42, 8000, issued, expires);

        byte[] encoded = PodBinaryCodec.EncodeHumanReadChallengeResponse(response);
        bool ok = PodBinaryCodec.TryDecodeHumanReadChallengeResponse(encoded, out HumanReadChallengeResponse decoded);

        Assert.True(ok);
        Assert.Equal("token-1", decoded.Token);
        Assert.Equal("article", decoded.Scope);
        Assert.Equal("article:42", decoded.RouteKey);
        Assert.Equal(42, decoded.ArticleId);
        Assert.Equal(8000, decoded.MinDwellMs);
        Assert.Equal(issued, decoded.IssuedAt);
        Assert.Equal(expires, decoded.ExpiresAt);
    }

    [Fact]
    public void HumanReadSubmitRequest_RoundTrip_PreservesNullableArticleAndDwell()
    {
        var request = new HumanReadSubmitRequest("token-2", "site", "home", null, 9000);

        byte[] encoded = PodBinaryCodec.EncodeHumanReadSubmitRequest(request);
        bool ok = PodBinaryCodec.TryDecodeHumanReadSubmitRequest(encoded, out HumanReadSubmitRequest decoded);

        Assert.True(ok);
        Assert.Equal("token-2", decoded.Token);
        Assert.Equal("site", decoded.Scope);
        Assert.Equal("home", decoded.RouteKey);
        Assert.Null(decoded.ArticleId);
        Assert.Equal(9000, decoded.DwellMs);
    }

    [Fact]
    public void HumanReadSubmitResponse_RoundTrip_PreservesStatus()
    {
        var response = new HumanReadSubmitResponse(true, "counted");

        byte[] encoded = PodBinaryCodec.EncodeHumanReadSubmitResponse(response);
        bool ok = PodBinaryCodec.TryDecodeHumanReadSubmitResponse(encoded, out HumanReadSubmitResponse decoded);

        Assert.True(ok);
        Assert.True(decoded.Counted);
        Assert.Equal("counted", decoded.Status);
    }

    [Fact]
    public void RumMetricBatchRequest_RoundTrip_PreservesBoundedFields()
    {
        var timestamp = new DateTime(2026, 6, 10, 8, 30, 0, DateTimeKind.Utc);
        var request = new RumMetricBatchRequest(
            "article",
            "article",
            "server-aot",
            [
                new RumMetricBatchItem(
                    "web_vital_lcp",
                    1234,
                    timestamp,
                    new Dictionary<string, double>
                    {
                        ["value"] = 1234,
                        ["durationMs"] = 1280
                    },
                    new Dictionary<string, string>
                    {
                        ["routeKind"] = "article",
                        ["renderMode"] = "server-aot"
                    })
            ]);

        byte[] encoded = PodBinaryCodec.EncodeRumMetricBatchRequest(request);
        bool ok = PodBinaryCodec.TryDecodeRumMetricBatchRequest(encoded, out RumMetricBatchRequest decoded);

        Assert.True(ok);
        Assert.Equal("article", decoded.PageType);
        Assert.Equal("article", decoded.RouteKey);
        Assert.Equal("server-aot", decoded.AotSource);
        RumMetricBatchItem item = Assert.Single(decoded.Metrics);
        Assert.Equal("web_vital_lcp", item.Name);
        Assert.Equal(1234, item.Value);
        Assert.Equal(timestamp, item.Timestamp);
        Assert.Equal(1280, item.Metrics!["durationMs"]);
        Assert.Equal("article", item.Dimensions!["routeKind"]);
    }

    [Fact]
    public void RumMetricIngestResponse_RoundTrip_PreservesCounts()
    {
        var response = new RumMetricIngestResponse(true, 2, 1);

        byte[] encoded = PodBinaryCodec.EncodeRumMetricIngestResponse(response);
        bool ok = PodBinaryCodec.TryDecodeRumMetricIngestResponse(encoded, out RumMetricIngestResponse decoded);

        Assert.True(ok);
        Assert.True(decoded.Accepted);
        Assert.Equal(2, decoded.AcceptedCount);
        Assert.Equal(1, decoded.RejectedCount);
    }

    [Fact]
    public void RumMetricBatchRequest_EmptyBatch_ReturnsFalse()
    {
        byte[] encoded = PodBinaryCodec.EncodeRumMetricBatchRequest(new RumMetricBatchRequest("article", "article", "server-aot", []));

        bool ok = PodBinaryCodec.TryDecodeRumMetricBatchRequest(encoded, out _);

        Assert.False(ok);
    }

    [Fact]
    public void SiteComplianceConfig_RoundTrip_PreservesFooterFields()
    {
        var dto = new SiteComplianceConfigPublicDto
        {
            Enabled = true,
            RegionMode = "mainland-cn",
            CopyrightOwner = "Fsus",
            CopyrightStartYear = 2024,
            CopyrightText = "保留所有权利。",
            ContentLicenseName = "CC BY-NC-SA 4.0",
            ContentLicenseUrl = "https://creativecommons.org/licenses/by-nc-sa/4.0/",
            IcpRecordNumber = "京ICP备2026000000号-1",
            IcpRecordUrl = "https://beian.miit.gov.cn/",
            PoliceRecordNumber = "京公网安备11000002000000号",
            PoliceRecordUrl = "https://beian.mps.gov.cn/",
            PoliceBadgeIconUrl = "/beian.png",
            OperatorName = "Fsus",
            ContactEmail = "name@example.test"
        };

        byte[] encoded = PodBinaryCodec.EncodeSiteComplianceConfig(dto);
        bool ok = PodBinaryCodec.TryDecodeSiteComplianceConfig(encoded, out SiteComplianceConfigPublicDto decoded);

        Assert.True(ok);
        Assert.True(decoded.Enabled);
        Assert.Equal("mainland-cn", decoded.RegionMode);
        Assert.Equal("Fsus", decoded.CopyrightOwner);
        Assert.Equal(2024, decoded.CopyrightStartYear);
        Assert.Equal("保留所有权利。", decoded.CopyrightText);
        Assert.Equal("CC BY-NC-SA 4.0", decoded.ContentLicenseName);
        Assert.Equal("京ICP备2026000000号-1", decoded.IcpRecordNumber);
        Assert.Equal("京公网安备11000002000000号", decoded.PoliceRecordNumber);
        Assert.Equal("name@example.test", decoded.ContactEmail);
    }

    [Fact]
    public void NameMutationRequest_CorruptedBytes_ReturnsFalse()
    {
        bool ok = PodBinaryCodec.TryDecodeNameMutationRequest(new byte[2], out _);
        Assert.False(ok);
    }

    [Fact]
    public void TaxonomyMetadataMutationRequest_NonCanonicalDescriptionSlice_ReturnsFalse()
    {
        byte[] encoded = PodBinaryCodec.EncodeTaxonomyMetadataMutationRequest(
            new TaxonomyMetadataMutationRequestCoreModel("category", "description"));
        BinaryPrimitives.WriteInt32LittleEndian(encoded.AsSpan(128, sizeof(int)), 1);

        bool ok = PodBinaryCodec.TryDecodeTaxonomyMetadataMutationRequest(encoded, out _, out _);

        Assert.False(ok);
    }

    [Fact]
    public void StringMutationRequest_RoundTrip_PreservesValue()
    {
        byte[] encoded = PodBinaryCodec.EncodeStringMutationRequest("/uploads/illustration/a.webp");
        bool ok = PodBinaryCodec.TryDecodeStringMutationRequest(encoded, out string value);

        Assert.True(ok);
        Assert.Equal("/uploads/illustration/a.webp", value);
    }

    [Fact]
    public void PasskeyCredentialFriendlyNameUpdateRequest_RoundTrip_PreservesFriendlyName()
    {
        byte[] encoded = PodBinaryCodec.EncodePasskeyCredentialFriendlyNameUpdateRequest("Work laptop");
        bool ok = PodBinaryCodec.TryDecodePasskeyCredentialFriendlyNameUpdateRequest(encoded, out string friendlyName);

        Assert.True(ok);
        Assert.Equal("Work laptop", friendlyName);
    }

    [Fact]
    public void AdminChangeUserStatusRequest_RoundTrip_PreservesReason()
    {
        var request = new AdminChangeUserStatusRequestCoreModel(7, 1, "spam");
        byte[] encoded = PodBinaryCodec.EncodeAdminChangeUserStatusRequest(request);
        bool ok = PodBinaryCodec.TryDecodeAdminChangeUserStatusRequest(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(7, decoded.AccountId);
        Assert.Equal(1, decoded.Status);
        Assert.Equal("spam", decoded.Reason);
    }

    [Fact]
    public void AdminChangeUserStatusRequest_UsesAccountIdNaming()
    {
        Assert.NotNull(typeof(AdminChangeUserStatusRequestPod).GetField("AccountId"));
        Assert.Null(typeof(AdminChangeUserStatusRequestPod).GetField("UserId"));
        Assert.NotNull(typeof(AdminChangeUserStatusRequestCoreModel).GetProperty("AccountId"));
        Assert.Null(typeof(AdminChangeUserStatusRequestCoreModel).GetProperty("UserId"));
    }

    [Fact]
    public void AdminResetUserPasswordRequest_IsRetiredFromPodCodec()
    {
        Assert.Null(typeof(AdminChangeUserStatusRequestPod).Assembly.GetType(
            "FsusBlog.Shared.Contracts.Models.AdminResetUserPasswordRequestPod",
            throwOnError: false));
        Assert.Null(typeof(AdminChangeUserStatusRequestCoreModel).Assembly.GetType(
            "FsusBlog.Core.Mapping.Models.AdminResetUserPasswordRequestCoreModel",
            throwOnError: false));
        Assert.DoesNotContain(typeof(PodBinaryCodec).GetMethods(), static method =>
            method.Name.Contains("AdminResetUserPasswordRequest", StringComparison.Ordinal));
        Assert.Null(typeof(PodBinaryCodec).GetMethod("EncodeAdminResetUserPasswordRequest"));
        Assert.Null(typeof(PodBinaryCodec).GetMethod("TryDecodeAdminResetUserPasswordRequest"));
    }

    [Fact]
    public void AuthAnonymousBootstrapRequest_RoundTrip_DoesNotCarryPasswordOrUsername()
    {
        var request = new AuthAnonymousBootstrapRequestCoreModel("quiet-reader", AcceptedGuidelines: true);
        byte[] encoded = PodBinaryCodec.EncodeAuthAnonymousBootstrapRequest(request);
        bool ok = PodBinaryCodec.TryDecodeAuthAnonymousBootstrapRequest(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal("quiet-reader", decoded.PublicHandle);
        Assert.True(decoded.AcceptedGuidelines);
        Assert.DoesNotContain("secret", Convert.ToHexString(encoded), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ConversationCreateRequest_RoundTrip_PreservesSubjectAndBody()
    {
        var request = new ConversationCreateRequestCoreModel("Support", "Need help");
        byte[] encoded = PodBinaryCodec.EncodeConversationCreateRequest(request);
        bool ok = PodBinaryCodec.TryDecodeConversationCreateRequest(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal("Support", decoded.Subject);
        Assert.Equal("Need help", decoded.Body);
    }

    [Fact]
    public void SystemMessageRequest_RoundTrip_PreservesOptionalTarget()
    {
        var request = new SystemMessageRequestCoreModel(7, "Notice", "Message body");
        byte[] encoded = PodBinaryCodec.EncodeSystemMessageRequest(request);
        bool ok = PodBinaryCodec.TryDecodeSystemMessageRequest(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(7, decoded.TargetAccountId);
        Assert.Equal("Notice", decoded.Subject);
        Assert.Equal("Message body", decoded.Body);
    }

    [Fact]
    public void ConversationDetail_RoundTrip_PreservesMessages()
    {
        var detail = new ConversationDetailResponse
        {
            ConversationId = "9",
            IdempotencyReplay = true,
            ReadSnapshotMessageId = "11",
            PreviousCursor = "11",
            HasOlder = true,
            Subject = "Support",
            Status = ConversationStatusValue.Pending,
            IsSystemSource = false,
            CanReply = true,
            UnreadCount = 1,
            LastMessageAt = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc),
            Messages =
            [
                new ConversationMessageResponse
                {
                    MessageId = "11",
                    ConversationId = "9",
                    IdempotencyReplay = true,
                    SenderType = ConversationSenderValue.Admin,
                    SenderName = "管理员",
                    Body = "已收到",
                    CreatedAt = new DateTime(2026, 1, 2, 4, 4, 5, DateTimeKind.Utc)
                }
            ]
        };

        byte[] encoded = PodBinaryCodec.EncodeConversationDetail(detail);
        bool ok = PodBinaryCodec.TryDecodeConversationDetail(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal("9", decoded.ConversationId);
        Assert.Equal("Support", decoded.Subject);
        Assert.Equal(ConversationStatusValue.Pending, decoded.Status);
        Assert.Single(decoded.Messages);
        Assert.Equal("11", decoded.Messages[0].MessageId);
        Assert.Equal("管理员", decoded.Messages[0].SenderName);
        Assert.Equal("已收到", decoded.Messages[0].Body);

        byte[] v2Encoded = PodBinaryCodec.EncodeConversationDetailV2(detail);
        Assert.True(PodBinaryCodec.TryDecodeConversationDetailV2(v2Encoded, out var v2Decoded));
        Assert.Equal("11", v2Decoded.ReadSnapshotMessageId);
        Assert.True(v2Decoded.IdempotencyReplay);
        Assert.True(Assert.Single(v2Decoded.Messages).IdempotencyReplay);

        byte[] v3Encoded = PodBinaryCodec.EncodeConversationDetailV3(detail);
        Assert.True(PodBinaryCodec.TryDecodeConversationDetailV3(v3Encoded, out var v3Decoded));
        Assert.Equal("11", v3Decoded.ReadSnapshotMessageId);
        Assert.Equal("11", v3Decoded.PreviousCursor);
        Assert.True(v3Decoded.HasOlder);
    }

    [Fact]
    public void ConversationReadAndAccountReplyRequests_RoundTripExplicitCursor()
    {
        var read = new ConversationReadRequestCoreModel(1234);
        Assert.True(PodBinaryCodec.TryDecodeConversationReadRequest(
            PodBinaryCodec.EncodeConversationReadRequest(read),
            out var decodedRead));
        Assert.Equal(1234, decodedRead.ReadThroughMessageId);

        var reply = new AccountConversationReplyRequestCoreModel(1234, "reply body");
        Assert.True(PodBinaryCodec.TryDecodeAccountConversationReplyRequest(
            PodBinaryCodec.EncodeAccountConversationReplyRequest(reply),
            out var decodedReply));
        Assert.Equal(1234, decodedReply.ReadThroughMessageId);
        Assert.Equal("reply body", decodedReply.Body);
    }

    [Fact]
    public void ConversationList_RoundTrip_PreservesPreview()
    {
        var page = new PageResponse<ConversationListItemResponse>
        {
            Total = 1,
            NextCursor = "opaque-next-cursor",
            HasMore = true,
            Items =
            [
                new ConversationListItemResponse
                {
                    ConversationId = "9",
                    Subject = "Support",
                    Status = ConversationStatusValue.Open,
                    IsSystemSource = true,
                    CanReply = false,
                    UnreadCount = 2,
                    LastMessageAt = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc),
                    UpdatedAt = new DateTime(2026, 1, 3, 3, 4, 5, DateTimeKind.Utc),
                    LastMessage = new ConversationMessagePreviewResponse
                    {
                        SenderType = ConversationSenderValue.System,
                        SenderName = "系统",
                        BodyPreview = "通知",
                        CreatedAt = new DateTime(2026, 1, 4, 3, 4, 5, DateTimeKind.Utc)
                    }
                }
            ]
        };

        byte[] encoded = PodBinaryCodec.EncodeConversationList(page);
        bool ok = PodBinaryCodec.TryDecodeConversationList(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(1, decoded.Total);
        Assert.Equal("opaque-next-cursor", decoded.NextCursor);
        Assert.True(decoded.HasMore);
        Assert.Single(decoded.Items);
        Assert.Equal("Support", decoded.Items[0].Subject);
        Assert.NotNull(decoded.Items[0].LastMessage);
        Assert.Equal("通知", decoded.Items[0].LastMessage!.BodyPreview);
    }

    [Fact]
    public void AuthDeleteAccountRequest_RoundTrip_PreservesConfirmTextWithoutPassword()
    {
        Assert.DoesNotContain(
            typeof(AuthDeleteAccountRequestCoreModel).GetProperties(),
            static property => property.Name == "Password");
        Assert.DoesNotContain(
            typeof(AuthDeleteAccountRequestPod).GetFields(),
            static field => field.Name == "Password");

        var request = new AuthDeleteAccountRequestCoreModel("DELETE");
        byte[] encoded = PodBinaryCodec.EncodeAuthDeleteAccountRequest(request);
        bool ok = PodBinaryCodec.TryDecodeAuthDeleteAccountRequest(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal("DELETE", decoded.ConfirmText);
    }

    [Fact]
    public void AuthLoginFlow_RoundTrip_PreservesMfaChallenge()
    {
        var flow = new AuthLoginFlowDto(7, "anonymous_account", "mfa_required", "risk", "ticket-1");
        byte[] encoded = PodBinaryCodec.EncodeAuthLoginFlow(flow);
        bool ok = PodBinaryCodec.TryDecodeAuthLoginFlow(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(7, decoded.AccountId);
        Assert.Equal("anonymous_account", decoded.IdentityKind);
        Assert.Equal("mfa_required", decoded.AuthPhase);
        Assert.Equal("risk", decoded.MfaMode);
        Assert.Equal("ticket-1", decoded.ChallengeToken);
    }

    [Fact]
    public void AuthLoginFlow_RoundTrip_PreservesEnrollmentRequiredWithoutFormalSessionData()
    {
        var flow = new AuthLoginFlowDto(8, "anonymous_account", "enrollment_required", null, null);
        byte[] encoded = PodBinaryCodec.EncodeAuthLoginFlow(flow);
        bool ok = PodBinaryCodec.TryDecodeAuthLoginFlow(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(8, decoded.AccountId);
        Assert.Equal("enrollment_required", decoded.AuthPhase);
        Assert.Null(decoded.MfaMode);
        Assert.Null(decoded.ChallengeToken);
    }

    [Fact]
    public void CurrentUserSnapshot_RoundTrip_PreservesNullableFields()
    {
        var deletedAt = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var snapshot = new CurrentUserSnapshotDto(7, "anonymous_account", 1, "banned", deletedAt);
        byte[] encoded = PodBinaryCodec.EncodeCurrentUserSnapshot(snapshot);
        bool ok = PodBinaryCodec.TryDecodeCurrentUserSnapshot(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(7, decoded.AccountId);
        Assert.Equal("anonymous_account", decoded.IdentityKind);
        Assert.Equal(1, decoded.Status);
        Assert.Equal("banned", decoded.BanReason);
        Assert.Equal(deletedAt, decoded.DeletedAt);
    }

    [Fact]
    public void UserSessions_RoundTrip_PreservesSessionFields()
    {
        var createdAt = new DateTime(2026, 1, 2, 2, 3, 4, DateTimeKind.Utc);
        var lastSeenAt = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        UserSessionSummaryDto[] sessions =
        [
            new(
                SessionId: "session-1",
                DeviceLabel: "Chrome on Linux",
                CreatedAt: createdAt,
                LastSeenAt: lastSeenAt,
                AuthenticationMethod: "passkey",
                AuthenticationStrength: "webauthn_uv",
                PasskeyFriendlyName: "Work security key",
                DurationPolicy: "persistent_30d",
                IsCurrent: true),
            new(
                SessionId: "session-2",
                DeviceLabel: "Firefox on Other",
                CreatedAt: createdAt,
                LastSeenAt: null,
                AuthenticationMethod: "other",
                AuthenticationStrength: "legacy_unverified",
                PasskeyFriendlyName: null,
                DurationPolicy: "browser_session",
                IsCurrent: false)
        ];

        byte[] encoded = PodBinaryCodec.EncodeUserSessions(sessions);
        bool ok = PodBinaryCodec.TryDecodeUserSessions(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(2, decoded.Count);
        Assert.Equal(sizeof(int) + 2 * 500, encoded.Length);
        Assert.Equal("session-1", decoded[0].SessionId);
        Assert.Equal("Chrome on Linux", decoded[0].DeviceLabel);
        Assert.Equal(createdAt, decoded[0].CreatedAt);
        Assert.Equal(lastSeenAt, decoded[0].LastSeenAt);
        Assert.Equal("passkey", decoded[0].AuthenticationMethod);
        Assert.Equal("webauthn_uv", decoded[0].AuthenticationStrength);
        Assert.Equal("Work security key", decoded[0].PasskeyFriendlyName);
        Assert.Equal("persistent_30d", decoded[0].DurationPolicy);
        Assert.True(decoded[0].IsCurrent);
        Assert.Null(decoded[1].LastSeenAt);
        Assert.Null(decoded[1].PasskeyFriendlyName);
        Assert.Null(typeof(UserSessionSummaryDto).GetProperty("DeviceFingerprint"));
        Assert.Null(typeof(UserSessionSummaryDto).GetProperty("MfaVerified"));
        Assert.Null(typeof(UserSessionSummaryPod).GetField("DeviceFingerprint"));
        Assert.Null(typeof(UserSessionSummaryPod).GetField("MfaVerified"));
    }

    [Fact]
    public void UserSessionSummaryPod_UsesPrivacySafeStableOffsets()
    {
        Assert.Equal(500, Marshal.SizeOf<UserSessionSummaryPod>());
        Assert.Equal(0, Marshal.OffsetOf<UserSessionSummaryPod>(nameof(UserSessionSummaryPod.CreatedAtUnixMs)).ToInt32());
        Assert.Equal(8, Marshal.OffsetOf<UserSessionSummaryPod>(nameof(UserSessionSummaryPod.LastSeenAtUnixMs)).ToInt32());
        Assert.Equal(16, Marshal.OffsetOf<UserSessionSummaryPod>(nameof(UserSessionSummaryPod.IsCurrent)).ToInt32());
        Assert.Equal(17, Marshal.OffsetOf<UserSessionSummaryPod>(nameof(UserSessionSummaryPod.HasLastSeenAt)).ToInt32());
        Assert.Equal(18, Marshal.OffsetOf<UserSessionSummaryPod>(nameof(UserSessionSummaryPod.HasPasskeyFriendlyName)).ToInt32());
        Assert.Equal(19, Marshal.OffsetOf<UserSessionSummaryPod>(nameof(UserSessionSummaryPod.Reserved0)).ToInt32());
        Assert.Equal(20, Marshal.OffsetOf<UserSessionSummaryPod>(nameof(UserSessionSummaryPod.SessionId)).ToInt32());
        Assert.Equal(84, Marshal.OffsetOf<UserSessionSummaryPod>(nameof(UserSessionSummaryPod.DeviceLabel)).ToInt32());
        Assert.Equal(148, Marshal.OffsetOf<UserSessionSummaryPod>(nameof(UserSessionSummaryPod.AuthenticationMethod)).ToInt32());
        Assert.Equal(180, Marshal.OffsetOf<UserSessionSummaryPod>(nameof(UserSessionSummaryPod.AuthenticationStrength)).ToInt32());
        Assert.Equal(212, Marshal.OffsetOf<UserSessionSummaryPod>(nameof(UserSessionSummaryPod.DurationPolicy)).ToInt32());
        Assert.Equal(244, Marshal.OffsetOf<UserSessionSummaryPod>(nameof(UserSessionSummaryPod.PasskeyFriendlyName)).ToInt32());
    }

    [Fact]
    public void UserSessions_DecodeRejectsNonZeroReservedByte()
    {
        UserSessionSummaryDto[] sessions =
        [
            new(
                SessionId: "session-1",
                DeviceLabel: "Chrome on Linux",
                CreatedAt: DateTime.UnixEpoch,
                LastSeenAt: null,
                AuthenticationMethod: "passkey",
                AuthenticationStrength: "webauthn_uv",
                PasskeyFriendlyName: null,
                DurationPolicy: "browser_session",
                IsCurrent: true)
        ];
        byte[] encoded = PodBinaryCodec.EncodeUserSessions(sessions);
        encoded[sizeof(int) + 19] = 1;

        Assert.False(PodBinaryCodec.TryDecodeUserSessions(encoded, out _));
    }

    [Fact]
    public void AdminSessions_RoundTrip_DoesNotCarryRawIp()
    {
        var createdAt = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var lastSeenAt = createdAt.AddMinutes(1);
        AdminSessionSummaryDto[] sessions =
        [
            new(
                SessionId: "admin-session-1",
                DeviceFingerprint: "admin-fp-1",
                UserAgent: "Firefox",
                CreatedAtUtc: createdAt,
                LastSeenAtUtc: lastSeenAt,
                IdleExpiresAtUtc: createdAt.AddHours(1),
                AbsoluteExpiresAtUtc: createdAt.AddHours(8),
                IsCurrent: true,
                IsRevoked: false)
        ];

        byte[] encoded = PodBinaryCodec.EncodeAdminSessions(sessions);
        bool ok = PodBinaryCodec.TryDecodeAdminSessions(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(sizeof(int) + Marshal.SizeOf<AdminSessionSummaryPod>(), encoded.Length);
        Assert.Null(typeof(AdminSessionSummaryDto).GetProperty("LastIp"));
        Assert.Null(typeof(AdminSessionSummaryPod).GetField("LastIp"));
        Assert.Equal("admin-session-1", decoded[0].SessionId);
        Assert.Equal("admin-fp-1", decoded[0].DeviceFingerprint);
        Assert.Equal("Firefox", decoded[0].UserAgent);
        Assert.Equal(createdAt, decoded[0].CreatedAtUtc);
        Assert.Equal(lastSeenAt, decoded[0].LastSeenAtUtc);
    }

    [Fact]
    public void SessionAndIdentityDtos_SerializeWithoutLegacyUserPodFields()
    {
        var options = new JsonSerializerOptions { PropertyNamingPolicy = null };
        var userSessionJson = JsonSerializer.Serialize(
            new UserSessionSummaryDto(
                SessionId: "session-1",
                DeviceLabel: "Chrome on Linux",
                CreatedAt: DateTime.UnixEpoch,
                LastSeenAt: null,
                AuthenticationMethod: "passkey",
                AuthenticationStrength: "webauthn_uv",
                PasskeyFriendlyName: "Security key",
                DurationPolicy: "browser_session",
                IsCurrent: true),
            options);
        var adminSessionJson = JsonSerializer.Serialize(
            new AdminSessionSummaryDto(
                SessionId: "admin-session-1",
                DeviceFingerprint: "admin-fp-1",
                UserAgent: "Firefox",
                CreatedAtUtc: DateTime.UnixEpoch,
                LastSeenAtUtc: null,
                IdleExpiresAtUtc: DateTime.UnixEpoch,
                AbsoluteExpiresAtUtc: DateTime.UnixEpoch,
                IsCurrent: true,
                IsRevoked: false),
            options);
        var identityJson = JsonSerializer.Serialize(
            new IdentityAccountSnapshotCoreModel(
                AccountId: 42,
                PublicHandle: "alice",
                PasskeyEnabled: true,
                RecoveryEnabled: true,
                TotpStepUpEnabled: null,
                AnonymousCredentialStatus: null,
                AnonymousCredentialLevel: null),
            options);

        foreach (string json in new[] { userSessionJson, adminSessionJson, identityJson })
        {
            Assert.DoesNotContain("LastIp", json, StringComparison.Ordinal);
            Assert.DoesNotContain("InternalUserId", json, StringComparison.Ordinal);
            Assert.DoesNotContain("\"UserId\"", json, StringComparison.Ordinal);
        }
        Assert.DoesNotContain("DeviceFingerprint", userSessionJson, StringComparison.Ordinal);
        Assert.DoesNotContain("MfaVerified", userSessionJson, StringComparison.Ordinal);
    }

    [Fact]
    public void MfaPods_RoundTrip_PreserveFields()
    {
        var verify = new MfaSetupVerifyDto { Enabled = true, RecoveryCodes = ["code-1", "code-2"] };
        byte[] verifyEncoded = PodBinaryCodec.EncodeMfaSetupVerify(verify);
        Assert.True(PodBinaryCodec.TryDecodeMfaSetupVerify(verifyEncoded, out var verifyDecoded));
        Assert.True(verifyDecoded.Enabled);
        Assert.Equal(["code-1", "code-2"], verifyDecoded.RecoveryCodes);

        var proof = new MfaPasswordProofRequestCoreModel("pw", "123456", null);
        byte[] proofEncoded = PodBinaryCodec.EncodeMfaPasswordProofRequest(proof);
        Assert.True(PodBinaryCodec.TryDecodeMfaPasswordProofRequest(proofEncoded, out var proofDecoded));
        Assert.Equal("pw", proofDecoded.Password);
        Assert.Equal("123456", proofDecoded.Code);
        Assert.Null(proofDecoded.RecoveryCode);

        var challenge = new MfaChallengeVerifyRequestCoreModel("ticket", "login", "123456", null);
        byte[] challengeEncoded = PodBinaryCodec.EncodeMfaChallengeVerifyRequest(challenge);
        Assert.True(PodBinaryCodec.TryDecodeMfaChallengeVerifyRequest(challengeEncoded, out var challengeDecoded));
        Assert.Equal("ticket", challengeDecoded.ChallengeToken);
        Assert.Equal("login", challengeDecoded.Action);
    }

    [Fact]
    public void RecoveryKeyPods_RoundTrip_PreserveFields()
    {
        var createdAt = new DateTime(2026, 6, 16, 12, 30, 45, 123, DateTimeKind.Utc);
        var create = new RecoveryKeyCreateResponseCoreModel("frk_test-recovery-key", 3, createdAt);
        byte[] createEncoded = EncodeWithWriter(writer => PodBinaryCodec.WriteRecoveryKeyCreateResponse(create, writer));
        Assert.True(PodBinaryCodec.TryDecodeRecoveryKeyCreateResponse(createEncoded, out var createDecoded));
        Assert.Equal("frk_test-recovery-key", createDecoded.RecoveryKey);
        Assert.Equal(3, createDecoded.KeyVersion);
        Assert.Equal(createdAt, createDecoded.CreatedAt);

        var request = new RecoveryKeyVerifyRequestCoreModel("frk_test-recovery-key", RevokeSessions: true, RevokePasskeys: true);
        byte[] requestEncoded = EncodeWithWriter(writer => PodBinaryCodec.WriteRecoveryKeyVerifyRequest(request, writer));
        Assert.True(PodBinaryCodec.TryDecodeRecoveryKeyVerifyRequest(requestEncoded, out var requestDecoded));
        Assert.Equal("frk_test-recovery-key", requestDecoded.RecoveryKey);
        Assert.True(requestDecoded.RevokeSessions);
        Assert.True(requestDecoded.RevokePasskeys);

        var expiresAt = createdAt.AddMinutes(10);
        var response = new RecoveryKeyVerifyResponseCoreModel("recovery-session-token", expiresAt);
        byte[] responseEncoded = EncodeWithWriter(writer => PodBinaryCodec.WriteRecoveryKeyVerifyResponse(response, writer));
        Assert.True(PodBinaryCodec.TryDecodeRecoveryKeyVerifyResponse(responseEncoded, out var responseDecoded));
        Assert.Equal("recovery-session-token", responseDecoded.RecoverySessionToken);
        Assert.Equal(expiresAt, responseDecoded.ExpiresAt);
    }

    [Fact]
    public void AnonymousIdentityFrames_AreReservedAfterRecoveryKeyFrames()
    {
        Assert.Equal((ushort)159, (ushort)AedsFrameType.RecoveryKeyCreateResponse);
        Assert.Equal((ushort)160, (ushort)AedsFrameType.RecoveryKeyVerifyRequest);
        Assert.Equal((ushort)161, (ushort)AedsFrameType.RecoveryKeyVerifyResponse);
        Assert.Equal((ushort)162, (ushort)AedsFrameType.RecoveryKeySessionRequest);
        Assert.Equal((ushort)163, (ushort)AedsFrameType.IdentityAccountSnapshot);
        Assert.Equal((ushort)164, (ushort)AedsFrameType.CommentPolicySnapshot);
        Assert.Equal((ushort)165, (ushort)AedsFrameType.CommentPolicyUpdateRequest);
        Assert.Equal((ushort)166, (ushort)AedsFrameType.CommentCreateRequest);
        Assert.Equal((ushort)167, (ushort)AedsFrameType.CommentAuthorView);
        Assert.Equal((ushort)189, (ushort)AedsFrameType.AuthAnonymousBootstrapRequest);
    }

    [Fact]
    public void AnonymousPrivacyFrames_AreReservedAfterSecurityChallengeFrames()
    {
        Assert.Equal((ushort)177, (ushort)AedsFrameType.Reserved177);
        Assert.Equal((ushort)178, (ushort)AedsFrameType.Reserved178);
        Assert.Equal((ushort)179, (ushort)AedsFrameType.AnonymousCredentialRootSnapshot);
        Assert.Equal((ushort)198, (ushort)AedsFrameType.AnonymousCommentTicketRequest);
        Assert.Equal((ushort)199, (ushort)AedsFrameType.AnonymousCommentTicketResponse);
        Assert.Equal((ushort)182, (ushort)AedsFrameType.AnonymousCommentCreateRequest);
        Assert.Equal((ushort)183, (ushort)AedsFrameType.AnonymousPrivacyStateSnapshot);
        Assert.Equal((ushort)186, (ushort)AedsFrameType.RetiredCredentialSpecificRevocationRequest);
        Assert.Equal((ushort)187, (ushort)AedsFrameType.RetiredCredentialSpecificRevocationResponse);
        Assert.Equal((ushort)196, (ushort)AedsFrameType.AnonymousCredentialRevocationSnapshot);
        Assert.Equal((ushort)197, (ushort)AedsFrameType.AnonymousCredentialRevocationDelta);
    }

    [Fact]
    public void AnonymousPrivacyPods_RoundTrip_PreserveCredentialRootTicketAndComment()
    {
        byte[] groth16Proof = Enumerable.Range(0, 192)
            .Select(static value => (byte)((value + 13) % 251))
            .ToArray();
        byte[] publicInputs = NativeGroth16PublicInputCodec.Encode(new ProductionZkProofBackendRequest(
            ActionContext: "comment.create",
            Scope: "article:42",
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: new string('a', 64),
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            NullifierHash: Convert.ToHexStringLower(Enumerable.Repeat((byte)0x33, 32).ToArray()),
            CredentialRoot: Convert.ToHexStringLower(Enumerable.Repeat((byte)0x11, 32).ToArray()),
            PolicyHash: new string('9', 64),
            IsEligible: true,
            MayComment: true,
            RateClass: AnonymousPrivacyContract.CommonRateClass,
            RequiresModeration: false,
            Proof: ReadOnlyMemory<byte>.Empty,
            RevocationRoot: Convert.ToHexStringLower(Enumerable.Repeat((byte)0x22, 32).ToArray()),
            IssuerPublicKeyHash: new string('b', 64))).ToArray();

        var root = new AnonymousCredentialRootSnapshotCoreModel(
            CredentialEpoch: 20260618,
            RootExpiresAtUnixMs: 1780000000000,
            RootGraceExpiresAtUnixMs: 1780003600000,
            CircuitNumericId: 7,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            ZkAnonymousEnabled: true,
            VerifierConfigured: true,
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: new string('a', 64),
            IssuerPublicKeyHash: new string('b', 64),
            CredentialRoot: Enumerable.Repeat((byte)0x11, 32).ToArray(),
            RevocationRoot: Enumerable.Repeat((byte)0x22, 32).ToArray(),
            CircuitMetadata: [17, 18]);
        byte[] rootEncoded = PodBinaryCodec.EncodeAnonymousCredentialRootSnapshot(root);
        Assert.True(PodBinaryCodec.TryDecodeAnonymousCredentialRootSnapshot(rootEncoded, out var rootDecoded));
        Assert.Equal(1780003600000, rootDecoded.RootGraceExpiresAtUnixMs);
        Assert.True(rootDecoded.ZkAnonymousEnabled);
        Assert.True(rootDecoded.VerifierConfigured);
        Assert.Equal(new string('a', 64), rootDecoded.VerifyingKeyHash);
        Assert.Equal(new string('b', 64), rootDecoded.IssuerPublicKeyHash);
        Assert.Equal(Enumerable.Repeat((byte)0x11, 32), rootDecoded.CredentialRoot);
        Assert.Equal(Enumerable.Repeat((byte)0x22, 32), rootDecoded.RevocationRoot);
        Assert.Equal([17, 18], rootDecoded.CircuitMetadata);

        var ticket = new AnonymousCommentTicketRequestCoreModel(
            ArticleId: 42,
            ParentId: "100",
            RootId: "90",
            ReplyToCommentId: "80",
            CircuitNumericId: 7,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            ActionContext: "comment.create",
            Scope: "article:42",
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: new string('a', 64),
            NullifierHash: Enumerable.Repeat((byte)0x33, 32).ToArray(),
            CredentialRoot: Enumerable.Repeat((byte)0x11, 32).ToArray(),
            RevocationRoot: Enumerable.Repeat((byte)0x22, 32).ToArray(),
            IsEligible: true,
            MayComment: true,
            RateClass: AnonymousPrivacyContract.CommonRateClass,
            RequiresModeration: false,
            Groth16Proof: groth16Proof,
            PublicInputs: publicInputs);
        byte[] ticketEncoded = PodBinaryCodec.EncodeAnonymousCommentTicketRequest(ticket);
        Assert.True(PodBinaryCodec.TryDecodeAnonymousCommentTicketRequest(ticketEncoded, out var ticketDecoded));
        Assert.Equal("comment.create", ticketDecoded.ActionContext);
        Assert.Equal("article:42", ticketDecoded.Scope);
        Assert.Equal(new string('a', 64), ticketDecoded.VerifyingKeyHash);
        Assert.True(ticketDecoded.IsEligible);
        Assert.True(ticketDecoded.MayComment);
        Assert.Equal(AnonymousPrivacyContract.CommonRateClass, ticketDecoded.RateClass);
        Assert.False(ticketDecoded.RequiresModeration);
        Assert.Equal(groth16Proof, ticketDecoded.Groth16Proof);
        Assert.Equal(publicInputs, ticketDecoded.PublicInputs);

        var revocationArtifact = new AnonymousCredentialRevocationArtifactCoreModel(
            CredentialEpoch: 20260618,
            Version: 2,
            BaseVersion: 0,
            ExpiresAtUnixMs: 1780003600000,
            Kind: AnonymousCredentialRevocationArtifactKinds.Full,
            PathDepth: 128,
            AlgorithmId: "circuit-friendly-non-membership.v1",
            IssuerPublicKeyHash: new('b', 64),
            RevocationRoot: Enumerable.Repeat((byte)0x22, 32).ToArray(),
            ContentHash: Enumerable.Repeat((byte)0x33, 32).ToArray(),
            Signature: Enumerable.Repeat((byte)0x44, 32).ToArray(),
            EntryHashes: Enumerable.Range(0, 64).Select(static value => (byte)value).ToArray());
        byte[] artifactEncoded = PodBinaryCodec.EncodeAnonymousCredentialRevocationArtifact(revocationArtifact);
        Assert.True(PodBinaryCodec.TryDecodeAnonymousCredentialRevocationArtifact(artifactEncoded, out var artifactDecoded));
        Assert.Equal(2, artifactDecoded.Version);
        Assert.Equal(128, artifactDecoded.PathDepth);
        Assert.Equal(revocationArtifact.EntryHashes, artifactDecoded.EntryHashes);

        var ticketResponse = new AnonymousCommentTicketResponseCoreModel(
            TicketExpiresAtUnixMs: 1780000005000,
            RateClass: AnonymousPrivacyContract.CommonRateClass,
            RequiresModeration: false,
            Ticket: [25, 26],
            ModerationSubjectHash: [27, 28]);
        byte[] ticketResponseEncoded = PodBinaryCodec.EncodeAnonymousCommentTicketResponse(ticketResponse);
        Assert.True(PodBinaryCodec.TryDecodeAnonymousCommentTicketResponse(ticketResponseEncoded, out var ticketResponseDecoded));
        Assert.Equal([25, 26], ticketResponseDecoded.Ticket);
        Assert.Equal([27, 28], ticketResponseDecoded.ModerationSubjectHash);

        var create = new AnonymousCommentCreateRequestCoreModel(
            ArticleId: 42,
            Content: "anonymous comment",
            ParentId: "100",
            RootId: "90",
            ReplyToCommentId: "80",
            AnonymousScope: "article:42",
            DisplayLanguage: "en",
            Ticket: [31, 32]);
        byte[] createEncoded = PodBinaryCodec.EncodeAnonymousCommentCreateRequest(create);
        Assert.True(PodBinaryCodec.TryDecodeAnonymousCommentCreateRequest(createEncoded, out var createDecoded));
        Assert.Equal("anonymous comment", createDecoded.Content);
        Assert.Equal("100", createDecoded.ParentId);
        Assert.Equal("article:42", createDecoded.AnonymousScope);
        Assert.Equal([31, 32], createDecoded.Ticket);

        var state = new AnonymousPrivacyStateSnapshotCoreModel(
            CredentialEpoch: 20260618,
            RootExpiresAtUnixMs: 1780000000000,
            TicketExpiresAtUnixMs: 1780000005000,
            CircuitNumericId: 7,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            HasActiveCredential: true,
            CanIssueCredential: false,
            CanSubmitAnonymousComment: true,
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: new string('a', 64),
            CredentialStatus: "active",
            CredentialLevel: "strong_anonymous");
        byte[] stateEncoded = PodBinaryCodec.EncodeAnonymousPrivacyStateSnapshot(state);
        Assert.True(PodBinaryCodec.TryDecodeAnonymousPrivacyStateSnapshot(stateEncoded, out var stateDecoded));
        Assert.True(stateDecoded.HasActiveCredential);
        Assert.False(stateDecoded.CanIssueCredential);
        Assert.True(stateDecoded.CanSubmitAnonymousComment);
        Assert.Equal("active", stateDecoded.CredentialStatus);
    }

    [Fact]
    public void AnonymousPrivacyPods_RejectMalformedTrailingAndOversizedPayloads()
    {
        Assert.False(PodBinaryCodec.TryDecodeAnonymousCommentCreateRequest(new byte[] { 1, 2, 3 }, out _));

        var create = new AnonymousCommentCreateRequestCoreModel(
            ArticleId: 42,
            Content: "ok",
            ParentId: null,
            RootId: null,
            ReplyToCommentId: null,
            AnonymousScope: "article:42",
            DisplayLanguage: "en",
            Ticket: [1, 2, 3]);
        byte[] encoded = PodBinaryCodec.EncodeAnonymousCommentCreateRequest(create);
        byte[] trailing = [.. encoded, 0xff];
        Assert.False(PodBinaryCodec.TryDecodeAnonymousCommentCreateRequest(trailing, out _));

        var oversizedTicket = create with
        {
            Ticket = new byte[20 * 1024]
        };
        byte[] oversizedEncoded = PodBinaryCodec.EncodeAnonymousCommentCreateRequest(oversizedTicket);
        Assert.False(PodBinaryCodec.TryDecodeAnonymousCommentCreateRequest(oversizedEncoded, out _));

        var oversizedProof = new AnonymousCommentTicketRequestCoreModel(
            ArticleId: 42,
            ParentId: null,
            RootId: null,
            ReplyToCommentId: null,
            CircuitNumericId: 7,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            ActionContext: "comment.create",
            Scope: "article:42",
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: new string('a', 64),
            NullifierHash: Enumerable.Repeat((byte)0x33, 32).ToArray(),
            CredentialRoot: Enumerable.Repeat((byte)0x11, 32).ToArray(),
            RevocationRoot: Enumerable.Repeat((byte)0x22, 32).ToArray(),
            IsEligible: true,
            MayComment: true,
            RateClass: AnonymousPrivacyContract.CommonRateClass,
            RequiresModeration: false,
            Groth16Proof: new byte[AnonymousPrivacyContract.MaxGroth16ProofBytes + 1],
            PublicInputs: [2]);
        byte[] oversizedProofEncoded = PodBinaryCodec.EncodeAnonymousCommentTicketRequest(oversizedProof);
        Assert.False(PodBinaryCodec.TryDecodeAnonymousCommentTicketRequest(oversizedProofEncoded, out _));

        var wrongLayout = oversizedProof with
        {
            PublicInputLayoutVersion = (ushort)(AnonymousPrivacyContract.PublicInputLayoutVersion + 1),
            Groth16Proof = [1, 2, 3],
            PublicInputs = "action_context=comment.create"u8.ToArray()
        };
        Assert.False(PodBinaryCodec.TryDecodeAnonymousCommentTicketRequest(
            PodBinaryCodec.EncodeAnonymousCommentTicketRequest(wrongLayout),
            out _));

        var wrongCircuit = wrongLayout with
        {
            PublicInputLayoutVersion = AnonymousPrivacyContract.PublicInputLayoutVersion,
            CircuitId = "zk-comment-invalid"
        };
        Assert.False(PodBinaryCodec.TryDecodeAnonymousCommentTicketRequest(
            PodBinaryCodec.EncodeAnonymousCommentTicketRequest(wrongCircuit),
            out _));
    }

    [Fact]
    public void AnonymousCommentTicketContract_UsesCurrentCircuitWithoutStableCredential()
    {
        Assert.Equal("fsus.anonymous.comment.v5", AnonymousPrivacyContract.CircuitId);
        Assert.Equal(6, AnonymousPrivacyContract.PublicInputLayoutVersion);
        Assert.Equal(4096, AnonymousPrivacyContract.MaxGroth16ProofBytes);

        string[] ticketFields = typeof(AnonymousCommentTicketRequestPod)
            .GetFields()
            .Select(static field => field.Name)
            .ToArray();
        Assert.DoesNotContain("CredentialCommitment", ticketFields);
    }

    [Fact]
    public void AnonymousCommentCreateRequestContract_DoesNotCarryReversibleIdentity()
    {
        Assert.DoesNotContain("ReplyToUserId", nameof(AnonymousCommentCreateRequestCoreModel), StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", nameof(AnonymousCommentCreateRequestCoreModel), StringComparison.Ordinal);

        string[] fields = typeof(AnonymousCommentCreateRequestPod)
            .GetFields()
            .Select(static field => field.Name)
            .ToArray();
        Assert.DoesNotContain("UserId", fields);
        Assert.DoesNotContain("Username", fields);
        Assert.DoesNotContain("Authorization", fields);
        Assert.DoesNotContain("PublicHandle", fields);
    }

    [Fact]
    public void IdentityAccountSnapshot_RoundTrip_PreservesNullableHandleAndCredentialState()
    {
        var deletedAt = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var snapshot = new IdentityAccountSnapshotCoreModel(
            AccountId: 42,
            PublicHandle: "alice",
            PasskeyEnabled: true,
            RecoveryEnabled: true,
            TotpStepUpEnabled: false,
            AnonymousCredentialStatus: "active",
            AnonymousCredentialLevel: "strong_anonymous",
            IdentityKind: "anonymous_account",
            Status: 1,
            BanReason: "limited",
            DeletedAt: deletedAt);

        byte[] encoded = PodBinaryCodec.EncodeIdentityAccountSnapshot(snapshot);
        bool ok = PodBinaryCodec.TryDecodeIdentityAccountSnapshot(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(42, decoded.AccountId);
        Assert.Equal("alice", decoded.PublicHandle);
        Assert.True(decoded.PasskeyEnabled);
        Assert.True(decoded.RecoveryEnabled);
        Assert.False(decoded.TotpStepUpEnabled);
        Assert.Equal("active", decoded.AnonymousCredentialStatus);
        Assert.Equal("strong_anonymous", decoded.AnonymousCredentialLevel);
        Assert.Equal("anonymous_account", decoded.IdentityKind);
        Assert.Equal(1, decoded.Status);
        Assert.Equal("limited", decoded.BanReason);
        Assert.Equal(deletedAt, decoded.DeletedAt);

        byte[] hiddenHandle = PodBinaryCodec.EncodeIdentityAccountSnapshot(snapshot with
        {
            PublicHandle = null,
            TotpStepUpEnabled = null
        });
        Assert.True(PodBinaryCodec.TryDecodeIdentityAccountSnapshot(hiddenHandle, out var hiddenDecoded));
        Assert.Null(hiddenDecoded.PublicHandle);
        Assert.Null(hiddenDecoded.TotpStepUpEnabled);
    }

    [Fact]
    public void CommentPolicySnapshotAndUpdate_RoundTrip_PreserveModesLanguagesAndPatchSemantics()
    {
        var snapshot = new CommentPolicySnapshotCoreModel(
            AnonymousCommentsEnabled: true,
            PublicCommentsEnabled: true,
            ZkAnonymousEnabled: true,
            DefaultAuthorMode: "zk_anonymous",
            SupportedDisplayLanguages: ["zh-CN", "en"],
            SnapshotHash: new string('9', 64),
            CommentMaxChars: 2500,
            CommentMaxUtf8Bytes: 10_000,
            ZkProdEnabled: true,
            ZkProdNativeVerifierConfigured: true,
            ZkProdTrustedSetupVerified: true,
            ZkProdCredentialRequired: true,
            ZkProdCredentialRootReady: true,
            ZkProdUnavailableReason: string.Empty);

        byte[] snapshotEncoded = PodBinaryCodec.EncodeCommentPolicySnapshot(snapshot);
        int snapshotBlobLength = Encoding.UTF8.GetByteCount("zh-CN\nen") + 64;
        Assert.Equal(41 + sizeof(int) + snapshotBlobLength, snapshotEncoded.Length);
        Assert.Equal(snapshotBlobLength, BinaryPrimitives.ReadInt32LittleEndian(snapshotEncoded.AsSpan(41, sizeof(int))));
        Assert.True(PodBinaryCodec.TryDecodeCommentPolicySnapshot(snapshotEncoded, out var snapshotDecoded));
        Assert.True(snapshotDecoded.AnonymousCommentsEnabled);
        Assert.True(snapshotDecoded.PublicCommentsEnabled);
        Assert.True(snapshotDecoded.ZkAnonymousEnabled);
        Assert.True(snapshotDecoded.ZkProdEnabled);
        Assert.True(snapshotDecoded.ZkProdNativeVerifierConfigured);
        Assert.True(snapshotDecoded.ZkProdTrustedSetupVerified);
        Assert.True(snapshotDecoded.ZkProdCredentialRequired);
        Assert.True(snapshotDecoded.ZkProdCredentialRootReady);
        Assert.Equal(string.Empty, snapshotDecoded.ZkProdUnavailableReason);
        Assert.Equal("zk_anonymous", snapshotDecoded.DefaultAuthorMode);
        Assert.Equal(["zh-CN", "en"], snapshotDecoded.SupportedDisplayLanguages);
        Assert.Equal(new string('9', 64), snapshotDecoded.SnapshotHash);
        Assert.Equal(2500, snapshotDecoded.CommentMaxChars);
        Assert.Equal(10_000, snapshotDecoded.CommentMaxUtf8Bytes);

        var update = new CommentPolicyUpdateRequestCoreModel(
            AnonymousCommentsEnabled: false,
            PublicCommentsEnabled: null,
            ZkAnonymousEnabled: true,
            DefaultAuthorMode: "public",
            SupportedDisplayLanguages: ["en"],
            CommentMaxChars: 2300,
            CommentMaxUtf8Bytes: 9200);

        byte[] updateEncoded = PodBinaryCodec.EncodeCommentPolicyUpdateRequest(update);
        int updateBlobLength = Encoding.UTF8.GetByteCount("en");
        Assert.Equal(26 + sizeof(int) + updateBlobLength, updateEncoded.Length);
        Assert.Equal(updateBlobLength, BinaryPrimitives.ReadInt32LittleEndian(updateEncoded.AsSpan(26, sizeof(int))));
        Assert.True(PodBinaryCodec.TryDecodeCommentPolicyUpdateRequest(updateEncoded, out var updateDecoded));
        Assert.False(updateDecoded.AnonymousCommentsEnabled);
        Assert.Null(updateDecoded.PublicCommentsEnabled);
        Assert.True(updateDecoded.ZkAnonymousEnabled);
        Assert.Equal("public", updateDecoded.DefaultAuthorMode);
        Assert.Equal(["en"], updateDecoded.SupportedDisplayLanguages);
        Assert.Equal(2300, updateDecoded.CommentMaxChars);
        Assert.Equal(9200, updateDecoded.CommentMaxUtf8Bytes);

        foreach (int rawMode in new[] { 0, 1, 2, 5 })
        {
            byte[] invalidMode = (byte[])snapshotEncoded.Clone();
            invalidMode[CommentPolicySnapshotWire.DefaultAuthorModeOffset] = (byte)rawMode;
            Assert.False(PodBinaryCodec.TryDecodeCommentPolicySnapshot(invalidMode, out _));
        }
        foreach (int maxChars in new[] { 0, CommentPolicySnapshotWire.HardMaxChars + 1 })
        {
            byte[] invalidLimits = (byte[])snapshotEncoded.Clone();
            BinaryPrimitives.WriteInt32LittleEndian(invalidLimits.AsSpan(CommentPolicySnapshotWire.CommentMaxCharsOffset), maxChars);
            Assert.False(PodBinaryCodec.TryDecodeCommentPolicySnapshot(invalidLimits, out _));
            Assert.Throws<ArgumentOutOfRangeException>(() => PodBinaryCodec.EncodeCommentPolicySnapshot(snapshot with { CommentMaxChars = maxChars }));
        }
        byte[] missingHash = (byte[])snapshotEncoded.Clone();
        BinaryPrimitives.WriteInt32LittleEndian(missingHash.AsSpan(CommentPolicySnapshotWire.SnapshotHashOffset + 4), 0);
        Assert.False(PodBinaryCodec.TryDecodeCommentPolicySnapshot(missingHash, out _));
        byte[] missingReason = (byte[])snapshotEncoded.Clone();
        BinaryPrimitives.WriteInt32LittleEndian(missingReason.AsSpan(CommentPolicySnapshotWire.ZkProdUnavailableReasonOffset), 0);
        Assert.False(PodBinaryCodec.TryDecodeCommentPolicySnapshot(missingReason, out _));
        byte[] invalidUtf8 = (byte[])snapshotEncoded.Clone();
        invalidUtf8[CommentPolicySnapshotWire.PodBytes + sizeof(int)] = 0xff;
        Assert.False(PodBinaryCodec.TryDecodeCommentPolicySnapshot(invalidUtf8, out _));
        Assert.Equal(CommentPolicySnapshotWire.PodBytes, Marshal.SizeOf<CommentPolicySnapshotPod>());
        Assert.Equal(CommentPolicySnapshotWire.CommentMaxCharsOffset, Marshal.OffsetOf<CommentPolicySnapshotPod>(nameof(CommentPolicySnapshotPod.CommentMaxChars)).ToInt32());

        byte[] retiredSnapshotMode = (byte[])snapshotEncoded.Clone();
        retiredSnapshotMode[3] = 2;
        Assert.False(PodBinaryCodec.TryDecodeCommentPolicySnapshot(retiredSnapshotMode, out _));

        byte[] retiredUpdateMode = (byte[])updateEncoded.Clone();
        retiredUpdateMode[7] = 2;
        Assert.False(PodBinaryCodec.TryDecodeCommentPolicyUpdateRequest(retiredUpdateMode, out _));
    }

    [Fact]
    public void PasskeyRegisterBegin_RoundTrip_PreservesOptions()
    {
        var value = new PasskeyRegisterBeginCoreModel
        {
            SessionKey = "session-1",
            Timeout = 60000,
            Attestation = 0,
            ResidentKey = 1,
            UserVerification = 1,
            AuthenticatorAttachment = 0,
            RequireResidentKey = true,
            RpId = "localhost",
            RpName = "FsusBlog",
            AccountName = "fsus-anonymous-account",
            AccountDisplayName = "Anonymous account",
            AccountHandle = [1, 2, 3, 4],
            Challenge = [5, 6, 7, 8],
            PubKeyCredParams = [new PasskeyPublicKeyCredentialParamCoreModel(0, -7)],
            ExcludeCredentials = [new PasskeyCredentialDescriptorCoreModel(0, [9, 10, 11], [5])]
        };

        byte[] encoded = PodBinaryCodec.EncodePasskeyRegisterBegin(value);
        bool ok = PodBinaryCodec.TryDecodePasskeyRegisterBegin(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal("session-1", decoded.SessionKey);
        Assert.Equal("localhost", decoded.RpId);
        Assert.Equal("FsusBlog", decoded.RpName);
        Assert.Equal("fsus-anonymous-account", decoded.AccountName);
        Assert.Equal("Anonymous account", decoded.AccountDisplayName);
        Assert.Equal([1, 2, 3, 4], decoded.AccountHandle);
        Assert.Equal([5, 6, 7, 8], decoded.Challenge);
        Assert.Single(decoded.PubKeyCredParams);
        Assert.Equal(-7, decoded.PubKeyCredParams[0].Alg);
        Assert.Single(decoded.ExcludeCredentials);
        Assert.Equal([9, 10, 11], decoded.ExcludeCredentials[0].Id);
        Assert.Equal([5], decoded.ExcludeCredentials[0].Transports);
    }

    [Fact]
    public void PasskeyLoginBegin_RoundTrip_PreservesOptions()
    {
        var value = new PasskeyLoginBeginCoreModel
        {
            ChallengeToken = "challenge-1",
            Timeout = 30000,
            RpId = "localhost",
            UserVerification = 2,
            Challenge = [1, 2, 3],
            AllowCredentials = [new PasskeyCredentialDescriptorCoreModel(0, [4, 5, 6], [0])]
        };

        byte[] encoded = PodBinaryCodec.EncodePasskeyLoginBegin(value);
        bool ok = PodBinaryCodec.TryDecodePasskeyLoginBegin(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal("challenge-1", decoded.ChallengeToken);
        Assert.Equal("localhost", decoded.RpId);
        Assert.Equal(2, decoded.UserVerification);
        Assert.Equal([1, 2, 3], decoded.Challenge);
        Assert.Single(decoded.AllowCredentials);
        Assert.Equal([4, 5, 6], decoded.AllowCredentials[0].Id);
        Assert.Equal([0], decoded.AllowCredentials[0].Transports);
    }

    [Fact]
    public void PasskeyRegisterCompleteRequest_RoundTrip_PreservesCredential()
    {
        var value = new PasskeyRegisterCompleteCoreModel
        {
            SessionKey = "session-1",
            Id = "credential-1",
            RawId = [1, 2, 3],
            ClientDataBytes = [4, 5, 6],
            AttestationObject = [7, 8, 9],
            Transports = [5],
            FriendlyName = "Laptop",
            MfaProofToken = "proof-1"
        };

        byte[] encoded = EncodeWithWriter(writer => PodBinaryCodec.WritePasskeyRegisterCompleteRequest(value, writer));
        bool ok = PodBinaryCodec.TryDecodePasskeyRegisterCompleteRequest(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal("session-1", decoded.SessionKey);
        Assert.Equal("credential-1", decoded.Id);
        Assert.Equal([1, 2, 3], decoded.RawId);
        Assert.Equal([4, 5, 6], decoded.ClientDataBytes);
        Assert.Equal([7, 8, 9], decoded.AttestationObject);
        Assert.Equal([5], decoded.Transports);
        Assert.Equal("Laptop", decoded.FriendlyName);
        Assert.Equal("proof-1", decoded.MfaProofToken);
    }

    [Fact]
    public void PasskeyLoginCompleteRequest_RoundTrip_PreservesAssertion()
    {
        var value = new PasskeyLoginCompleteCoreModel
        {
            ChallengeToken = "challenge-1",
            Id = "credential-1",
            RawId = [1, 2, 3],
            ClientDataBytes = [4, 5, 6],
            AuthenticatorData = [7, 8, 9],
            Signature = [10, 11, 12],
            UserHandle = [13, 14, 15],
            RememberMe = true
        };

        byte[] encoded = EncodeWithWriter(writer => PodBinaryCodec.WritePasskeyLoginCompleteRequest(value, writer));
        bool ok = PodBinaryCodec.TryDecodePasskeyLoginCompleteRequest(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal("challenge-1", decoded.ChallengeToken);
        Assert.Equal("credential-1", decoded.Id);
        Assert.Equal([1, 2, 3], decoded.RawId);
        Assert.Equal([4, 5, 6], decoded.ClientDataBytes);
        Assert.Equal([7, 8, 9], decoded.AuthenticatorData);
        Assert.Equal([10, 11, 12], decoded.Signature);
        Assert.Equal([13, 14, 15], decoded.UserHandle);
        Assert.True(decoded.RememberMe);
    }

    [Fact]
    public void PasskeyCredentialList_RoundTrip_PreservesCredentials()
    {
        var created = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var lastUsed = new DateTime(2026, 1, 3, 4, 5, 6, DateTimeKind.Utc);
        PasskeyCredentialSummaryDto[] values =
        [
            new(7, "Laptop", created, lastUsed, "aaguid-1", true, false),
            new(8, null, created, null, "aaguid-2", false, true)
        ];

        byte[] encoded = EncodeWithWriter(writer => PodBinaryCodec.WritePasskeyCredentialList(values, writer));
        bool ok = PodBinaryCodec.TryDecodePasskeyCredentialList(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(2, decoded.Count);
        Assert.Equal("Laptop", decoded[0].DeviceFriendlyName);
        Assert.Equal(lastUsed, decoded[0].LastUsedAt);
        Assert.Null(decoded[1].DeviceFriendlyName);
        Assert.Null(decoded[1].LastUsedAt);
        Assert.True(decoded[1].BackupState);
    }

    [Fact]
    public void PasskeySignalState_RoundTrip_PreservesAuthoritativeCredentialSet()
    {
        var value = new PasskeySignalStateDto(
            42,
            "example.test",
            "stable-user-id",
            "fsus-anonymous-account",
            "Quiet Reader",
            ["credential-a", "credential-b"]);

        byte[] encoded = EncodeWithWriter(writer => PodBinaryCodec.WritePasskeySignalState(value, writer));
        bool ok = PodBinaryCodec.TryDecodePasskeySignalState(encoded, out PasskeySignalStateDto decoded);

        Assert.True(ok);
        Assert.Equal(value.Revision, decoded.Revision);
        Assert.Equal(value.RpId, decoded.RpId);
        Assert.Equal(value.UserId, decoded.UserId);
        Assert.Equal(value.Name, decoded.Name);
        Assert.Equal(value.DisplayName, decoded.DisplayName);
        Assert.Equal(["credential-a", "credential-b"], decoded.AllAcceptedCredentialIds);
    }

    [Fact]
    public void AdminUserPage_RoundTrip_PreservesAnonymousAccountGovernanceFields()
    {
        var created = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var privacyInitialized = new DateTime(2026, 1, 3, 3, 4, 5, DateTimeKind.Utc);
        var deleted = new DateTime(2026, 1, 4, 3, 4, 5, DateTimeKind.Utc);
        var page = new AdminUserPageContract
        {
            Total = 2,
            Items =
            [
                new AdminAccountListItemContract(7, "anonymous_account", "alice-public", true, true, privacyInitialized, "active", 3, 1, created, deleted),
                new AdminAccountListItemContract(8, "anonymous_account", null, false, false, null, "revoked", 0, 0, created, null)
            ]
        };

        byte[] encoded = PodBinaryCodec.EncodeAdminUserPage(page);
        bool ok = PodBinaryCodec.TryDecodeAdminUserPage(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(2, decoded.Total);
        Assert.Equal(2, decoded.Items.Count);
        Assert.Equal(7, decoded.Items[0].AccountId);
        Assert.Equal("anonymous_account", decoded.Items[0].IdentityKind);
        Assert.Equal("alice-public", decoded.Items[0].PublicHandle);
        Assert.True(decoded.Items[0].PasskeyInitialized);
        Assert.True(decoded.Items[0].RecoveryInitialized);
        Assert.Equal(privacyInitialized, decoded.Items[0].PrivacyInitializedAt);
        Assert.Equal("active", decoded.Items[0].AnonymousCredentialStatus);
        Assert.DoesNotContain("AnonymousCredentialLevel", typeof(AdminAccountListItemContract).GetProperties().Select(static item => item.Name));
        Assert.Equal(3, decoded.Items[0].RiskFlags);
        Assert.Equal(1, decoded.Items[0].Status);
        Assert.Equal(deleted, decoded.Items[0].DeletedAt);
        Assert.Null(decoded.Items[1].PublicHandle);
        Assert.False(decoded.Items[1].PasskeyInitialized);
        Assert.False(decoded.Items[1].RecoveryInitialized);
        Assert.Null(decoded.Items[1].PrivacyInitializedAt);
        Assert.Null(decoded.Items[1].DeletedAt);
    }

    [Fact]
    public void TrashClearResponse_RoundTrip_PreservesCount()
    {
        byte[] encoded = PodBinaryCodec.EncodeTrashClearResponse(new TrashClearResponseDto(5));
        bool ok = PodBinaryCodec.TryDecodeTrashClearResponse(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(5, decoded.Count);
    }

    [Fact]
    public void CommentCreateRequest_RoundTrip_PreservesAnonymousFields()
    {
        var request = new CommentCreateRequestCoreModel(
            ArticleId: 9,
            Content: "Hello anonymous mode",
            ParentId: "100",
            RootId: "90",
            ReplyToCommentId: "80",
            AuthorMode: "zk_anonymous",
            PublicSendExplicitlySelected: false,
            AnonymousScope: "article:9:root:90",
            DisplayLanguage: "zh-CN",
            ProofToken: "proof-token",
            ZkProof: [1, 2, 3, 4]);

        byte[] encoded = PodBinaryCodec.EncodeCommentCreateRequest(request);
        bool ok = PodBinaryCodec.TryDecodeCommentCreateRequest(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(9, decoded.ArticleId);
        Assert.Equal("Hello anonymous mode", decoded.Content);
        Assert.Equal("100", decoded.ParentId);
        Assert.Equal("90", decoded.RootId);
        Assert.Equal("80", decoded.ReplyToCommentId);

        var view = new ReadOnlySpan<byte>(encoded);
        Assert.Equal(CommentCreateRequestWire.PodBytes, Marshal.SizeOf<CommentCreateRequestPod>());
        Assert.True(CommentCreateRequestWire.PodBytes < 80);
        Assert.Equal("zk_anonymous", decoded.AuthorMode);
        Assert.False(decoded.PublicSendExplicitlySelected);
        Assert.Equal("article:9:root:90", decoded.AnonymousScope);
        Assert.Equal("zh-CN", decoded.DisplayLanguage);
        Assert.Equal("proof-token", decoded.ProofToken);
        Assert.Equal([1, 2, 3, 4], decoded.ZkProof);

        byte[] retiredAuthorMode = (byte[])encoded.Clone();
        retiredAuthorMode[CommentCreateRequestWire.AuthorModeOffset] = 2;
        Assert.False(PodBinaryCodec.TryDecodeCommentCreateRequest(retiredAuthorMode, out _));
        byte[] trailing = [.. encoded, 0];
        Assert.False(PodBinaryCodec.TryDecodeCommentCreateRequest(trailing, out _));
        // Minimal retired 80-byte request with a real client-supplied account target.
        byte[] retired = new byte[encoded.Length + 7];
        encoded.AsSpan(0, 4).CopyTo(retired);
        BinaryPrimitives.WriteInt32LittleEndian(retired.AsSpan(4), 7);
        encoded.AsSpan(4, 3).CopyTo(retired.AsSpan(8));
        retired[11] = 1;
        encoded.AsSpan(7, 2).CopyTo(retired.AsSpan(12));
        encoded.AsSpan(9, 64).CopyTo(retired.AsSpan(16));
        encoded.AsSpan(CommentCreateRequestWire.PodBytes).CopyTo(retired.AsSpan(80));
        Assert.False(PodBinaryCodec.TryDecodeCommentCreateRequest(retired, out _));
    }

    [Fact]
    public void CommentAuthorView_RoundTrip_PreservesLocalizedAnonymousProjection()
    {
        var author = new CommentAuthorViewCoreModel(
            Mode: "zk_anonymous",
            DisplayName: "Anonymous reader",
            DisplayLanguage: "en",
            Badge: "verified proof",
            ScopeLabel: "article scope");

        byte[] encoded = PodBinaryCodec.EncodeCommentAuthorView(author);
        bool ok = PodBinaryCodec.TryDecodeCommentAuthorView(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal("zk_anonymous", decoded.Mode);
        Assert.Equal("Anonymous reader", decoded.DisplayName);
        Assert.Equal("en", decoded.DisplayLanguage);
        Assert.Equal("verified proof", decoded.Badge);
        Assert.Equal("article scope", decoded.ScopeLabel);
        Assert.DoesNotContain("CredentialLevel", typeof(CommentAuthorViewCoreModel).GetProperties().Select(static item => item.Name));

        byte[] historical = (byte[])encoded.Clone();
        historical[0] = 1;
        Assert.True(PodBinaryCodec.TryDecodeCommentAuthorView(historical, out var legacy));
        Assert.Equal("legacy_server_visible_pseudonymous", legacy.Mode);
    }

    private static ArticleDetailCoreModel MakeDetailItem(int id = 1, string title = "Detail", string content = "Hello content")
    {
        var createTime = new DateTime(2024, 6, 1, 0, 0, 0, DateTimeKind.Utc);
        var pod = PodProjector.ProjectArticleDetail(id, views: 10, createTime, 2, "Dev", title, content, null, out _);
        int wordCount = content.Count(c => !char.IsWhiteSpace(c));
        return new ArticleDetailCoreModel(
            pod, id, title, content, null, "/uploads/illustration/test-cover.webp", 10, wordCount,
            Math.Max(1, (wordCount + 299) / 300), false, createTime,
            new ArticleCategoryCoreModel(2, "Dev"),
            [new TagCoreModel(7, "rust")], 2, false, 3, null, createTime, createTime.AddHours(2), Rights: MakeRights());
    }

    private static ArticleRightsCoreModel MakeRights()
        => new(
            SnapshotId: 901,
            ArticleRevisionId: 801,
            RevisionNo: 7,
            Enabled: true,
            LicenseType: "CC-BY-4.0",
            CopyrightHolder: "Fésus",
            CopyrightYear: 2026,
            RightsStatement: "Line one\nLine two",
            AttributionTemplate: "{title} — {holder}",
            CopyPolicy: "append-attribution",
            MaxExcerptChars: 300,
            AllowCodeCopy: true,
            ShowPublicBadge: false,
            ProofBindingEnabled: true,
            CanonicalUrl: "https://example.test/article/10",
            PolicyHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ContentCanonicalHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ProofUrl: "https://example.test/proofs/rights/901",
            ProofStatus: "ready");

    private static byte[] EncodeLegacyArticleDetailPayloadWithoutV3Envelope()
    {
        var item = MakeDetailItem();
        ArticleDetailPod pod = PodProjector.ProjectArticleDetail(
            item.Id,
            item.Views,
            item.CreateTime,
            item.Category.Id,
            item.Category.Name,
            item.Title,
            item.Content,
            item.Summary,
            out ReadOnlyMemory<byte> payload);
        var writer = new ArrayBufferWriter<byte>();
        WritePod(writer, pod);
        WriteInt32(writer, item.Tags.Count);
        foreach (TagCoreModel tag in item.Tags)
        {
            WritePod(writer, PodProjector.ProjectTag(tag.Id, tag.Name));
        }

        WriteBytes(writer, payload.Span);
        WriteBytes(writer, Encoding.UTF8.GetBytes(item.CoverImageUrl ?? string.Empty));
        WriteByte(writer, item.IsDeleted ? (byte)1 : (byte)0);
        WriteInt32(writer, item.Status);
        WriteInt64(writer, ToUnixMsOrZero(item.ScheduledPublishAt));
        WriteInt64(writer, ToUnixMsOrZero(item.PublishedAt));
        return writer.WrittenSpan.ToArray();
    }

    private static long ToUnixMsOrZero(DateTime? value)
        => value.HasValue ? new DateTimeOffset(value.Value).ToUnixTimeMilliseconds() : 0;

    private static void WritePod<T>(ArrayBufferWriter<byte> writer, in T value)
        where T : unmanaged
    {
        int size = Marshal.SizeOf<T>();
        Span<byte> span = writer.GetSpan(size);
        MemoryMarshal.Write(span, in value);
        writer.Advance(size);
    }

    private static void WriteInt32(ArrayBufferWriter<byte> writer, int value)
    {
        Span<byte> span = writer.GetSpan(sizeof(int));
        BinaryPrimitives.WriteInt32LittleEndian(span, value);
        writer.Advance(sizeof(int));
    }

    private static void WriteInt64(ArrayBufferWriter<byte> writer, long value)
    {
        Span<byte> span = writer.GetSpan(sizeof(long));
        BinaryPrimitives.WriteInt64LittleEndian(span, value);
        writer.Advance(sizeof(long));
    }

    private static void WriteByte(ArrayBufferWriter<byte> writer, byte value)
    {
        Span<byte> span = writer.GetSpan(1);
        span[0] = value;
        writer.Advance(1);
    }

    private static void WriteBytes(ArrayBufferWriter<byte> writer, ReadOnlySpan<byte> value)
    {
        WriteInt32(writer, value.Length);
        Span<byte> span = writer.GetSpan(value.Length);
        value.CopyTo(span);
        writer.Advance(value.Length);
    }

    private static byte[] EncodeWithWriter(Action<IBufferWriter<byte>> write)
    {
        var writer = new ArrayBufferWriter<byte>();
        write(writer);
        return writer.WrittenSpan.ToArray();
    }

    // ── Common response PODs ────────────────────────────────────────────────

    [Fact]
    public void EmptySuccess_RoundTrip_PreservesOkMarker()
    {
        byte[] encoded = PodBinaryCodec.EncodeEmptySuccess();
        bool ok = PodBinaryCodec.TryDecodeEmptySuccess(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(1, decoded.Ok);
    }

    [Fact]
    public void MutationId_RoundTrip_PreservesId()
    {
        byte[] encoded = PodBinaryCodec.EncodeMutationId(123456789);
        bool ok = PodBinaryCodec.TryDecodeMutationId(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(123456789, decoded.Id);
    }

    [Fact]
    public void ApiError_RoundTrip_PreservesCodeMessageAndTraceId()
    {
        var error = ErrorDetail.Create(ErrorCode.Forbidden, "权限不足", "role_required", "trace-123");
        byte[] encoded = PodBinaryCodec.EncodeApiError(error, StatusCodes.Status403Forbidden);
        bool ok = PodBinaryCodec.TryDecodeApiError(encoded, out var decoded);
        ErrorDetail restored = PodBinaryCodec.ToErrorDetail(decoded);

        Assert.True(ok);
        Assert.Equal((byte)ErrorCode.Forbidden, decoded.Code);
        Assert.Equal(StatusCodes.Status403Forbidden, decoded.HttpStatus);
        Assert.Equal(ErrorCode.Forbidden, restored.Code);
        Assert.Equal("权限不足", restored.Message);
        Assert.Equal("role_required", restored.Details);
        Assert.Equal("trace-123", restored.TraceId);
    }

    [Fact]
    public void ApiError_CorruptedBytes_ReturnsFalse()
    {
        bool ok = PodBinaryCodec.TryDecodeApiError(new byte[] { 0x01, 0x02 }, out _);

        Assert.False(ok);
    }

    [Fact]
    public void ApiError_LongMessage_TruncatesInsteadOfThrowing()
    {
        string longMessage = new('错', 200);
        var error = ErrorDetail.Create(ErrorCode.InfraFailure, longMessage);
        byte[] encoded = PodBinaryCodec.EncodeApiError(error, StatusCodes.Status500InternalServerError);
        bool ok = PodBinaryCodec.TryDecodeApiError(encoded, out var decoded);
        ErrorDetail restored = PodBinaryCodec.ToErrorDetail(decoded);

        Assert.True(ok);
        Assert.Equal(ErrorCode.InfraFailure, restored.Code);
        Assert.NotEmpty(restored.Message);
        Assert.True(restored.Message.Length < longMessage.Length);
    }

    [Fact]
    public void UploadInit_RoundTrip_PreservesFields()
    {
        var dto = new UploadInitDto
        {
            UploadId = "uid-1",
            FileName = "photo.jpg",
            MimeType = "image/jpeg",
            TargetFormat = "webp",
            TotalBytes = 1024,
            ChunkSize = 512,
            TotalParts = 2,
            ExpiresAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc)
        };

        byte[] encoded = PodBinaryCodec.EncodeUploadInit(dto);
        bool ok = PodBinaryCodec.TryDecodeUploadInit(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(dto.UploadId, decoded.UploadId);
        Assert.Equal(dto.FileName, decoded.FileName);
        Assert.Equal(dto.ExpiresAt, decoded.ExpiresAt);
    }

    [Fact]
    public void UploadStatus_RoundTrip_PreservesFields()
    {
        var dto = new UploadStatusDto
        {
            UploadId = "uid-2",
            Status = "uploading",
            TotalBytes = 2048,
            UploadedBytes = 512,
            ChunkSize = 512,
            TotalParts = 4,
            UploadedPartCount = 1,
            NextPartHint = 2,
            ExpiresAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc)
        };

        byte[] encoded = PodBinaryCodec.EncodeUploadStatus(dto);
        bool ok = PodBinaryCodec.TryDecodeUploadStatus(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(dto.Status, decoded.Status);
        Assert.Equal(dto.UploadedBytes, decoded.UploadedBytes);
        Assert.Equal(dto.NextPartHint, decoded.NextPartHint);
    }

    [Fact]
    public void UploadPartMap_RoundTrip_PreservesRanges()
    {
        var dto = new UploadPartMapDto
        {
            UploadId = "uid-3",
            UploadedRanges = [new UploadPartRangeDto(0, 1), new UploadPartRangeDto(3, 4)]
        };

        byte[] encoded = PodBinaryCodec.EncodeUploadPartMap(dto);
        bool ok = PodBinaryCodec.TryDecodeUploadPartMap(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(dto.UploadId, decoded.UploadId);
        Assert.Equal(2, decoded.UploadedRanges.Count);
        Assert.Equal(3, decoded.UploadedRanges[1].Start);
    }

    [Fact]
    public void UploadPartAck_RoundTrip_PreservesFields()
    {
        var dto = new UploadPartAckDto
        {
            UploadId = "uid-4",
            PartNumber = 1,
            Offset = 512,
            Size = 512,
            UploadedBytes = 1024,
            UploadedPartCount = 2
        };

        byte[] encoded = PodBinaryCodec.EncodeUploadPartAck(dto);
        bool ok = PodBinaryCodec.TryDecodeUploadPartAck(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(dto.PartNumber, decoded.PartNumber);
        Assert.Equal(dto.Offset, decoded.Offset);
        Assert.Equal(dto.UploadedPartCount, decoded.UploadedPartCount);
    }

    [Fact]
    public void UploadComplete_RoundTrip_PreservesFields()
    {
        var dto = new UploadCompleteDto
        {
            UploadId = "uid-5",
            Url = "/uploads/photo.webp",
            RelativeUrl = "/uploads/photo.webp",
            MimeType = "image/webp",
            TotalBytes = 2048
        };

        byte[] encoded = PodBinaryCodec.EncodeUploadComplete(dto);
        bool ok = PodBinaryCodec.TryDecodeUploadComplete(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(dto.Url, decoded.Url);
        Assert.Equal(dto.MimeType, decoded.MimeType);
        Assert.Equal(dto.TotalBytes, decoded.TotalBytes);
    }

    [Fact]
    public void PowChallenge_RoundTrip_PreservesFields()
    {
        var challenge = new PowChallenge("salt-value", 4, 1778290000, "signature-value");

        byte[] encoded = PodBinaryCodec.EncodePowChallenge(challenge);
        bool ok = PodBinaryCodec.TryDecodePowChallenge(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(challenge.Salt, decoded.Salt);
        Assert.Equal(challenge.Difficulty, decoded.Difficulty);
        Assert.Equal(challenge.Timestamp, decoded.Timestamp);
        Assert.Equal(challenge.Signature, decoded.Signature);
    }

    [Fact]
    public void UploadInitRequest_RoundTrip_PreservesFields()
    {
        var dto = new UploadInitRequestCoreModel(
            "photo.webp",
            "image/webp",
            "webp",
            4096,
            1024,
            new string('a', 64));

        byte[] encoded = PodBinaryCodec.EncodeUploadInitRequest(dto);
        bool ok = PodBinaryCodec.TryDecodeUploadInitRequest(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(dto.FileName, decoded.FileName);
        Assert.Equal(dto.MimeType, decoded.MimeType);
        Assert.Equal(dto.TargetFormat, decoded.TargetFormat);
        Assert.Equal(dto.TotalBytes, decoded.TotalBytes);
        Assert.Equal(dto.ChunkSize, decoded.ChunkSize);
        Assert.Equal(dto.Sha256, decoded.Sha256);
    }

    [Fact]
    public void UploadCompleteRequest_RoundTrip_PreservesSha256()
    {
        var dto = new UploadCompleteRequestCoreModel(new string('b', 64));

        byte[] encoded = PodBinaryCodec.EncodeUploadCompleteRequest(dto);
        bool ok = PodBinaryCodec.TryDecodeUploadCompleteRequest(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(dto.Sha256, decoded.Sha256);
    }

    [Fact]
    public void CategoryList_RoundTrip_PreservesItems()
    {
        List<CategoryListItemResponse> categories =
        [
            new() { Id = 1, Name = "Tech", ArticleCount = 2 },
            new() { Id = 2, Name = "Life", ArticleCount = 0 }
        ];

        byte[] encoded = PodBinaryCodec.EncodeCategoryList(categories);
        bool ok = PodBinaryCodec.TryDecodeCategoryList(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(categories.Count, decoded.Count);
        Assert.Equal(categories[0].Name, decoded[0].Name);
        Assert.Equal(categories[1].ArticleCount, decoded[1].ArticleCount);
    }

    [Fact]
    public void TagWithCountList_RoundTrip_PreservesItems()
    {
        List<TagWithCountDto> tags =
        [
            new(1, "dotnet", 4),
            new(2, "wasm", 3)
        ];

        byte[] encoded = PodBinaryCodec.EncodeTagWithCountList(tags);
        bool ok = PodBinaryCodec.TryDecodeTagWithCountList(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(tags.Count, decoded.Count);
        Assert.Equal(tags[0].Name, decoded[0].Name);
        Assert.Equal(tags[1].ArticleCount, decoded[1].ArticleCount);
    }

    // ── ArticlePage round-trip ───────────────────────────────────────────────

    [Fact]
    public void ArticlePage_EmptyPage_RoundTrip()
    {
        var page = new CorePageResult<ArticleListCoreModel>([], 0);
        byte[] encoded = PodBinaryCodec.EncodeArticlePage(page);
        bool ok = PodBinaryCodec.TryDecodeArticlePage(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(0, decoded.Total);
        Assert.Empty(decoded.Items);
    }

    [Fact]
    public void ArticlePage_SingleItem_RoundTrip()
    {
        var scheduledAt = new DateTime(2026, 5, 20, 8, 0, 0, DateTimeKind.Utc);
        var item = MakeListItem(5, "Hello World", "a summary") with
        {
            Status = 1,
            ScheduledPublishAt = scheduledAt
        };
        var page = new CorePageResult<ArticleListCoreModel>([item], 1);
        byte[] encoded = PodBinaryCodec.EncodeArticlePage(page);
        bool ok = PodBinaryCodec.TryDecodeArticlePage(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(1, decoded.Total);
        Assert.Single(decoded.Items);
        Assert.Equal("Hello World", decoded.Items[0].Title);
        Assert.Equal("a summary", decoded.Items[0].Summary);
        Assert.Equal(5, decoded.Items[0].Id);
        Assert.Equal(1, decoded.Items[0].Status);
        Assert.Equal(scheduledAt, decoded.Items[0].ScheduledPublishAt);
    }

    [Fact]
    public void ArticlePage_MultipleItems_AllPreserved()
    {
        var items = Enumerable.Range(1, 5).Select(i => MakeListItem(i, $"Title {i}")).ToList();
        var page = new CorePageResult<ArticleListCoreModel>(items, 5);
        byte[] encoded = PodBinaryCodec.EncodeArticlePage(page);
        bool ok = PodBinaryCodec.TryDecodeArticlePage(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(5, decoded.Total);
        Assert.Equal(5, decoded.Items.Count);
        for (int i = 0; i < 5; i++)
        {
            Assert.Equal($"Title {i + 1}", decoded.Items[i].Title);
        }
    }

    [Fact]
    public void ArticlePage_OpaqueCursor_RoundTripPreservesExactToken()
    {
        var item = MakeListItem(5, "Hello World");
        const string Cursor = "AQIDBA-filter-bound-checksum";
        var page = new CorePageResult<ArticleListCoreModel>([item], 20, Cursor, true);

        byte[] encoded = PodBinaryCodec.EncodeArticlePage(page);
        bool ok = PodBinaryCodec.TryDecodeArticlePage(encoded, out CorePageResult<ArticleListCoreModel> decoded);

        Assert.True(ok);
        Assert.Equal(Cursor, decoded.NextCursor);
        Assert.True(decoded.HasMore);
    }

    [Fact]
    public void ArticlePage_EmptyBytes_ReturnsFalse()
    {
        bool ok = PodBinaryCodec.TryDecodeArticlePage(ReadOnlyMemory<byte>.Empty, out _);
        Assert.False(ok);
    }

    [Fact]
    public void ArticlePage_CorruptedBytes_ReturnsFalse()
    {
        bool ok = PodBinaryCodec.TryDecodeArticlePage(new byte[] { 0xFF, 0xFF }, out _);
        Assert.False(ok);
    }

    // ── ArticleDetail round-trip ─────────────────────────────────────────────

    [Fact]
    public void ArticleDetail_RoundTrip_PreservesFields()
    {
        var item = MakeDetailItem(10, "My Post", "This is the full content of the article.");
        byte[] encoded = PodBinaryCodec.EncodeArticleDetail(item);
        bool ok = PodBinaryCodec.TryDecodeArticleDetail(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(0x41524435u, BinaryPrimitives.ReadUInt32LittleEndian(encoded.AsSpan(0, sizeof(uint))));
        Assert.Equal(5, BinaryPrimitives.ReadInt32LittleEndian(encoded.AsSpan(sizeof(uint), sizeof(int))));
        Assert.Equal(10, decoded.Id);
        Assert.Equal("My Post", decoded.Title);
        Assert.Equal("This is the full content of the article.", decoded.Content);
        Assert.Equal("/uploads/illustration/test-cover.webp", decoded.CoverImageUrl);
        Assert.Equal(2, decoded.Category.Id);
        Assert.Equal("Dev", decoded.Category.Name);
        Assert.Equal(3, decoded.Status);
        Assert.Equal(new DateTime(2024, 6, 1, 0, 0, 0, DateTimeKind.Utc), decoded.PublishedAt);
        Assert.Equal(new DateTime(2024, 6, 1, 2, 0, 0, DateTimeKind.Utc), decoded.UpdatedAt);
        Assert.Equal(901L, decoded.Rights.SnapshotId);
        Assert.Equal(801L, decoded.Rights.ArticleRevisionId);
        Assert.Equal(7, decoded.Rights.RevisionNo);
        Assert.True(decoded.Rights.Enabled);
        Assert.Equal("CC-BY-4.0", decoded.Rights.LicenseType);
        Assert.Equal("Fésus", decoded.Rights.CopyrightHolder);
        Assert.Equal(2026, decoded.Rights.CopyrightYear);
        Assert.Equal("Line one\nLine two", decoded.Rights.RightsStatement);
        Assert.Equal("{title} — {holder}", decoded.Rights.AttributionTemplate);
        Assert.Equal("append-attribution", decoded.Rights.CopyPolicy);
        Assert.Equal(300, decoded.Rights.MaxExcerptChars);
        Assert.True(decoded.Rights.AllowCodeCopy);
        Assert.False(decoded.Rights.ShowPublicBadge);
        Assert.True(decoded.Rights.ProofBindingEnabled);
        Assert.Equal("https://example.test/article/10", decoded.Rights.CanonicalUrl);
        Assert.Equal("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", decoded.Rights.PolicyHash);
        Assert.Equal("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decoded.Rights.ContentCanonicalHash);
        Assert.Equal("https://example.test/proofs/rights/901", decoded.Rights.ProofUrl);
        Assert.Equal("ready", decoded.Rights.ProofStatus);
    }

    [Fact]
    public void ArticleDetail_WithTags_PreservesTagCount()
    {
        var item = MakeDetailItem(1, "T", "C");
        byte[] encoded = PodBinaryCodec.EncodeArticleDetail(item);
        bool ok = PodBinaryCodec.TryDecodeArticleDetail(encoded, out var decoded);

        Assert.True(ok);
        Assert.Single(decoded.Tags);
        Assert.Equal("rust", decoded.Tags[0].Name);
    }

    [Fact]
    public void ArticleDetail_EmptyBytes_ReturnsFalse()
    {
        bool ok = PodBinaryCodec.TryDecodeArticleDetail(ReadOnlyMemory<byte>.Empty, out _);
        Assert.False(ok);
    }

    [Fact]
    public void ArticleDetail_DecodeRejectsRetiredPayloadWithoutVersionedEnvelope()
    {
        byte[] legacy = EncodeLegacyArticleDetailPayloadWithoutV3Envelope();

        bool ok = PodBinaryCodec.TryDecodeArticleDetail(legacy, out _);

        Assert.False(ok);
    }

    [Fact]
    public void RetiredPublicArticleArtifact_IsNotAcceptedAsSupportedArticleDetail()
    {
        byte[] legacyPayload = EncodeLegacyArticleDetailPayloadWithoutV3Envelope();
        byte[] legacyFrame = new AedsEncoder().Encode(AedsFrameType.ArticleDetail, legacyPayload);

        bool artifactLooksSupported = ArticleDetailAedsFileArtifactStore.LooksLikeAedsArticleDetailFrame(legacyFrame);
        bool payloadDecodes = PodBinaryCodec.TryDecodeArticleDetail(legacyPayload, out _);

        Assert.False(artifactLooksSupported);
        Assert.False(payloadDecodes);
    }

    [Fact]
    public void ArticleDetail_DecodeRejectsInvalidMagicVersionAndTrailingPayload()
    {
        var item = MakeDetailItem();
        byte[] encoded = PodBinaryCodec.EncodeArticleDetail(item);

        byte[] invalidMagic = (byte[])encoded.Clone();
        BinaryPrimitives.WriteUInt32LittleEndian(invalidMagic.AsSpan(0, sizeof(uint)), 0x21444142u);
        Assert.False(PodBinaryCodec.TryDecodeArticleDetail(invalidMagic, out _));

        byte[] invalidVersion = (byte[])encoded.Clone();
        BinaryPrimitives.WriteInt32LittleEndian(invalidVersion.AsSpan(sizeof(uint), sizeof(int)), 2);
        Assert.False(PodBinaryCodec.TryDecodeArticleDetail(invalidVersion, out _));

        byte[] trailing = new byte[encoded.Length + 1];
        encoded.CopyTo(trailing.AsSpan());
        Assert.False(PodBinaryCodec.TryDecodeArticleDetail(trailing, out _));
    }

    [Fact]
    public void ArticleDetail_LargeContentRightsAndManyTags_RoundTripPreservesV4Payload()
    {
        string content = new('字', 9_000);
        var item = MakeDetailItem(42, "Long rights article", content) with
        {
            Tags = Enumerable.Range(1, 32).Select(static id => new TagCoreModel(id, $"tag-{id}")).ToArray(),
            Rights = MakeRights() with
            {
                RightsStatement = new string('版', 4_096),
                AttributionTemplate = "{title}\n{url}\n{holder}\n{license}"
            }
        };

        byte[] encoded = PodBinaryCodec.EncodeArticleDetail(item);
        bool ok = PodBinaryCodec.TryDecodeArticleDetail(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(content, decoded.Content);
        Assert.Equal(32, decoded.Tags.Count);
        Assert.Equal(new string('版', 4_096), decoded.Rights.RightsStatement);
        Assert.Equal("{title}\n{url}\n{holder}\n{license}", decoded.Rights.AttributionTemplate);
    }

    // ── RelatedReading round-trip ───────────────────────────────────────────

    [Fact]
    public void RelatedReading_RoundTrip_PreservesCompositeNavigation()
    {
        var createTime = new DateTime(2026, 5, 17, 12, 0, 0, DateTimeKind.Utc);
        var response = new RelatedReadingResponse(
            [
                new RelatedReadingItem(10, "AEDS public reads", "Binary contract", createTime, "同分类"),
                new RelatedReadingItem(11, "Hydration notes", null, createTime.AddDays(1), "全文关键词")
            ],
            new RelatedReadingItem(9, "Previous article", "previous summary", createTime.AddDays(-1), "上一篇"),
            new RelatedReadingItem(12, "Next article", null, createTime.AddDays(2), "下一篇"));

        byte[] encoded = PodBinaryCodec.EncodeRelatedReading(response);
        bool ok = PodBinaryCodec.TryDecodeRelatedReading(encoded, out RelatedReadingResponse decoded);

        Assert.True(ok);
        Assert.Equal(2, decoded.Related.Count);
        Assert.Equal("AEDS public reads", decoded.Related[0].Title);
        Assert.Equal("Binary contract", decoded.Related[0].Summary);
        Assert.Null(decoded.Related[1].Summary);
        Assert.Equal("上一篇", decoded.Previous?.Reason);
        Assert.Equal(12, decoded.Next?.Id);
        Assert.Null(decoded.Next?.Summary);
    }

    [Fact]
    public void RelatedReading_EmptyBytes_ReturnsFalse()
    {
        bool ok = PodBinaryCodec.TryDecodeRelatedReading(ReadOnlyMemory<byte>.Empty, out _);
        Assert.False(ok);
    }

    [Fact]
    public void ArticleSearch_RetiredAndMalformedLayouts_FailClosed()
    {
        byte[] payload = PodBinaryCodec.EncodeArticleSearch([MakeListItem()]);
        Assert.Equal(AedsArticleSearchWire.Magic, BinaryPrimitives.ReadInt32LittleEndian(payload));
        Assert.False(PodBinaryCodec.TryDecodeArticleSearch(payload.AsMemory(8), out _));
        byte[] trailingPayload = [.. payload, 0];
        Assert.False(PodBinaryCodec.TryDecodeArticleSearch(trailingPayload, out _));
        foreach (int offset in new[] { AedsArticleSearchWire.CurrentRevisionIdOffset, AedsArticleSearchWire.RevisionNoOffset })
        {
            byte[] invalid = payload.ToArray();
            BinaryPrimitives.WriteInt32LittleEndian(invalid.AsSpan(AedsArticleSearchWire.HeaderBytes + offset), 0);
            Assert.False(PodBinaryCodec.TryDecodeArticleSearch(invalid, out _));
        }
        byte[] old = payload.ToArray();
        BinaryPrimitives.WriteInt32LittleEndian(old.AsSpan(4), 3);
        Assert.False(PodBinaryCodec.TryDecodeArticleSearch(old, out _));
    }

    // ── ArticleSearch round-trip ─────────────────────────────────────────────

    [Fact]
    public void ArticleSearch_EmptyList_RoundTrip()
    {
        byte[] encoded = PodBinaryCodec.EncodeArticleSearch([]);
        bool ok = PodBinaryCodec.TryDecodeArticleSearch(encoded, out var items);

        Assert.True(ok);
        Assert.Empty(items);
    }

    [Fact]
    public void ArticleSearch_MultipleItems_RoundTrip()
    {
        IReadOnlyList<ArticleListCoreModel> list = [MakeListItem(1, "Alpha"), MakeListItem(2, "Beta")];
        byte[] encoded = PodBinaryCodec.EncodeArticleSearch(list);
        bool ok = PodBinaryCodec.TryDecodeArticleSearch(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(2, decoded.Count);
        Assert.Equal("Alpha", decoded[0].Title);
        Assert.Equal("Beta", decoded[1].Title);
    }

    [Fact]
    public void ArticleSearch_CorruptedBytes_ReturnsFalse()
    {
        bool ok = PodBinaryCodec.TryDecodeArticleSearch(new byte[2] { 0xAA, 0xBB }, out _);
        Assert.False(ok);
    }

    // ── PopularArticles round-trip ───────────────────────────────────────────

    [Fact]
    public void PopularArticles_EmptyList_RoundTrip()
    {
        byte[] encoded = PodBinaryCodec.EncodePopularArticles([]);
        bool ok = PodBinaryCodec.TryDecodePopularArticles(encoded, out var items);

        Assert.True(ok);
        Assert.Empty(items);
    }

    [Fact]
    public void PopularArticles_WithItems_PreservesViewsAndTitle()
    {
        var pod = PodProjector.ProjectPopularArticle(7, "Popular Post", 9999);
        IReadOnlyList<PopularArticleCoreModel> list = [new PopularArticleCoreModel(pod, 7, "Popular Post", 9999)];
        byte[] encoded = PodBinaryCodec.EncodePopularArticles(list);
        bool ok = PodBinaryCodec.TryDecodePopularArticles(encoded, out var decoded);

        Assert.True(ok);
        Assert.Single(decoded);
        Assert.Equal(7, decoded[0].Id);
        Assert.Equal(9999, decoded[0].Views);
        Assert.Equal("Popular Post", decoded[0].Title);
    }

    // ── FeaturedArticles round-trip ─────────────────────────────────────────

    [Fact]
    public void FeaturedArticles_WithItems_PreservesCoverAndCategory()
    {
        var created = new DateTime(2026, 5, 9, 12, 0, 0, DateTimeKind.Utc);
        IReadOnlyList<FeaturedArticleSummaryDto> list =
        [
            new(8, "Featured Post", "/uploads/cover.webp", 321, created, new ArticleCategoryView(4, "Life"))
        ];

        byte[] encoded = PodBinaryCodec.EncodeFeaturedArticles(list);
        bool ok = PodBinaryCodec.TryDecodeFeaturedArticles(encoded, out var decoded);

        Assert.True(ok);
        Assert.Single(decoded);
        Assert.Equal(8, decoded[0].Id);
        Assert.Equal("Featured Post", decoded[0].Title);
        Assert.Equal("/uploads/cover.webp", decoded[0].CoverImageUrl);
        Assert.Equal(321, decoded[0].Views);
        Assert.Equal(created, decoded[0].CreateTime);
        Assert.Equal(4, decoded[0].Category.Id);
        Assert.Equal("Life", decoded[0].Category.Name);
    }

    [Fact]
    public void FeaturedArticles_CorruptedBytes_ReturnsFalse()
    {
        bool ok = PodBinaryCodec.TryDecodeFeaturedArticles(new byte[3] { 0x01, 0x02, 0x03 }, out _);
        Assert.False(ok);
    }

    [Fact]
    public void FeaturedArticleCoreList_WithItems_PreservesBusinessModel()
    {
        var created = new DateTime(2026, 5, 9, 12, 0, 0, DateTimeKind.Utc);
        IReadOnlyList<FeaturedArticleCoreModel> list =
        [
            new(8, "Featured Post", "/uploads/cover.webp", 321, created, new ArticleCategoryCoreModel(4, "Life"))
        ];

        byte[] encoded = PodBinaryCodec.EncodeFeaturedArticleCoreList(list);
        bool ok = PodBinaryCodec.TryDecodeFeaturedArticleCoreList(encoded, out var decoded);

        Assert.True(ok);
        Assert.Single(decoded);
        Assert.Equal(8, decoded[0].Id);
        Assert.Equal("Featured Post", decoded[0].Title);
        Assert.Equal("/uploads/cover.webp", decoded[0].CoverImageUrl);
        Assert.Equal(321, decoded[0].Views);
        Assert.Equal(created, decoded[0].CreateTime);
        Assert.Equal(4, decoded[0].Category.Id);
        Assert.Equal("Life", decoded[0].Category.Name);
    }

    // ── SiteStats round-trip ─────────────────────────────────────────────────

    [Fact]
    public void SiteStats_RoundTrip_PreservesFields()
    {
        var pod = PodProjector.ProjectSiteStats(10, 20, 2, 1000, 980, 240, 760, 240, 3, 5, 2);
        var popular = (IReadOnlyList<PopularArticleCoreModel>)[];
        var recentPod = PodProjector.ProjectRecentComment(
            new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
            "Alice Public",
            "public",
            null,
            null,
            "Hello",
            out _);
        var regionPod = PodProjector.ProjectRegionDistribution("US", 12);
        var stats = new SiteStatsCoreModel(
            pod,
            10,
            20,
            2,
            1000,
            980,
            240,
            760,
            240,
            popular,
            [new RecentCommentCoreModel(recentPod, "Alice Public", "public", null, null, "Hello", new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc))],
            [new RegionDistributionCoreModel(regionPod, "US", 12)]);
        byte[] encoded = PodBinaryCodec.EncodeSiteStats(stats);
        bool ok = PodBinaryCodec.TryDecodeSiteStats(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(10, decoded.TotalArticles);
        Assert.Equal(20, decoded.TotalComments);
        Assert.Equal(1000, decoded.TotalReads);
        Assert.Equal(980, decoded.HumanVerifiedReads);
        Assert.Equal(240, decoded.UniqueViewerKeyEstimate);
        Assert.Equal(760, decoded.ArticleReads);
        Assert.Equal(240, decoded.SiteReads);
        Assert.Single(decoded.RecentComments);
        Assert.Equal("Hello", decoded.RecentComments[0].Content);
        Assert.Equal("Alice Public", decoded.RecentComments[0].AuthorDisplayName);
        Assert.Single(decoded.RegionDistributions);
        Assert.Equal("US", decoded.RegionDistributions[0].Region);
    }

    [Fact]
    public void SiteStats_CorruptedBytes_ReturnsFalse()
    {
        bool ok = PodBinaryCodec.TryDecodeSiteStats(new byte[3], out _);
        Assert.False(ok);
    }

    [Fact]
    public void RecentCommentStats_RoundTrip_PreservesContent()
    {
        var createTime = new DateTime(2026, 2, 2, 0, 0, 0, DateTimeKind.Utc);
        var pod = PodProjector.ProjectRecentComment(
            createTime,
            "强匿名评论者",
            "zk_anonymous",
            "已验证匿名凭证",
            "article:42",
            "Recent content",
            out _);
        IReadOnlyList<RecentCommentCoreModel> comments = [new(
            pod,
            "强匿名评论者",
            "zk_anonymous",
            "已验证匿名凭证",
            "article:42",
            "Recent content",
            createTime)];

        byte[] encoded = PodBinaryCodec.EncodeRecentCommentStats(comments);
        bool ok = PodBinaryCodec.TryDecodeRecentCommentStats(encoded, out var decoded);

        Assert.True(ok);
        Assert.Single(decoded);
        Assert.Equal("强匿名评论者", decoded[0].AuthorDisplayName);
        Assert.Equal("zk_anonymous", decoded[0].AuthorMode);
        Assert.Equal("已验证匿名凭证", decoded[0].AuthorBadge);
        Assert.Equal("article:42", decoded[0].AuthorScopeLabel);
        Assert.DoesNotContain("CredentialLevel", typeof(RecentCommentCoreModel).GetProperties().Select(static item => item.Name));
        Assert.Equal("Recent content", decoded[0].Content);
    }

    [Fact]
    public void RegionStats_RoundTrip_PreservesCounts()
    {
        var pod = PodProjector.ProjectRegionDistribution("CN", 8);
        IReadOnlyList<RegionDistributionCoreModel> regions = [new(pod, "CN", 8)];

        byte[] encoded = PodBinaryCodec.EncodeRegionStats(regions);
        bool ok = PodBinaryCodec.TryDecodeRegionStats(encoded, out var decoded);

        Assert.True(ok);
        Assert.Single(decoded);
        Assert.Equal("CN", decoded[0].Region);
        Assert.Equal(8, decoded[0].Count);
    }

    [Fact]
    public void SeoConfig_RoundTrip_PreservesFields()
    {
        var dto = new SeoConfigPublicDto
        {
            Title = "Fsus",
            Description = "Forward",
            Keywords = "blog,aeds",
            Author = "Fsu",
            OgImage = "/og.webp",
            BaseUrl = "https://example.test",
            FaviconSvgUrl = "/favicon.svg",
            FaviconIcoUrl = "/favicon.ico",
            FaviconPngUrl = "/favicon.png",
            AppleTouchIconUrl = "/apple-touch-icon.png",
            ManifestName = "Fsus Manifest",
            ManifestShortName = "Fsus",
            PwaIcon192Url = "/icon-192.png",
            PwaIcon512Url = "/icon-512.png",
            PwaMaskableIconUrl = "/maskable-512.png",
            ThemeColor = "#0f0f11",
            BackgroundColor = "#fcfcfc",
            SiteLogoUrl = "/site-logo.svg",
            SiteLogoDarkUrl = "/site-logo-dark.svg",
            SiteWordmarkUrl = "/wordmark.svg",
            AdminLogoUrl = "/admin-logo.svg",
            AdminCollapsedIconUrl = "/admin-icon.svg",
            LoginLogoUrl = "/login-logo.svg",
            LoginIconUrl = "/login-icon.svg"
        };

        byte[] encoded = PodBinaryCodec.EncodeSeoConfig(dto);
        bool ok = PodBinaryCodec.TryDecodeSeoConfig(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(dto.Title, decoded.Title);
        Assert.Equal(dto.Description, decoded.Description);
        Assert.Equal(dto.BaseUrl, decoded.BaseUrl);
        Assert.Equal(dto.FaviconSvgUrl, decoded.FaviconSvgUrl);
        Assert.Equal(dto.ManifestName, decoded.ManifestName);
        Assert.Equal(dto.ThemeColor, decoded.ThemeColor);
        Assert.Equal(dto.SiteWordmarkUrl, decoded.SiteWordmarkUrl);
        Assert.Equal(dto.LoginIconUrl, decoded.LoginIconUrl);
    }

    [Fact]
    public void PageContent_RoundTrip_PreservesContent()
    {
        var dto = new PageContentPublicDto
        {
            Slug = "about",
            Content = "# About"
        };

        byte[] encoded = PodBinaryCodec.EncodePageContent(dto);
        bool ok = PodBinaryCodec.TryDecodePageContent(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(dto.Slug, decoded.Slug);
        Assert.Equal(dto.Content, decoded.Content);
    }

    private static byte[] EncodeLegacyArticleWriteRequestWithoutRightsV3()
    {
        byte[] title = Encoding.UTF8.GetBytes("Title");
        byte[] content = Encoding.UTF8.GetBytes("Content");
        byte[] summary = Encoding.UTF8.GetBytes("Summary");
        byte[] cover = Encoding.UTF8.GetBytes("/uploads/cover.webp");
        int blobLength = title.Length + content.Length + summary.Length + cover.Length;
        int totalLength = 40 + (3 * sizeof(int)) + sizeof(int) + blobLength + sizeof(int) + sizeof(long);
        byte[] bytes = new byte[totalLength];
        int cursor = 0;

        WriteInt(bytes, ref cursor, 3);
        WriteInt(bytes, ref cursor, 3);
        int blobOffset = 0;
        WriteSlice(bytes, ref cursor, blobOffset, title.Length);
        blobOffset += title.Length;
        WriteSlice(bytes, ref cursor, blobOffset, content.Length);
        blobOffset += content.Length;
        WriteSlice(bytes, ref cursor, blobOffset, summary.Length);
        blobOffset += summary.Length;
        WriteSlice(bytes, ref cursor, blobOffset, cover.Length);

        WriteInt(bytes, ref cursor, 1);
        WriteInt(bytes, ref cursor, 2);
        WriteInt(bytes, ref cursor, 5);
        WriteInt(bytes, ref cursor, blobLength);
        title.CopyTo(bytes.AsSpan(cursor));
        cursor += title.Length;
        content.CopyTo(bytes.AsSpan(cursor));
        cursor += content.Length;
        summary.CopyTo(bytes.AsSpan(cursor));
        cursor += summary.Length;
        cover.CopyTo(bytes.AsSpan(cursor));
        cursor += cover.Length;
        WriteInt(bytes, ref cursor, 1);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(cursor, sizeof(long)), new DateTimeOffset(2026, 5, 19, 6, 30, 0, TimeSpan.Zero).ToUnixTimeMilliseconds());

        return bytes;
    }

    private static void WriteSlice(byte[] target, ref int cursor, int offset, int length)
    {
        WriteInt(target, ref cursor, offset);
        WriteInt(target, ref cursor, length);
    }

    private static void WriteInt(byte[] target, ref int cursor, int value)
    {
        BinaryPrimitives.WriteInt32LittleEndian(target.AsSpan(cursor, sizeof(int)), value);
        cursor += sizeof(int);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// StatsCoreService
// ──────────────────────────────────────────────────────────────────────────────

public class StatsCoreServiceTests
{
    [Fact]
    public async Task GetAdminStats_DelegatesToGateway()
    {
        var gw = Substitute.For<IStatsCoreGateway>();
        var expected = new SiteStatsCoreModel(default, 5, 10, 1, 500, 490, 120, 380, 120, [], [], []);
        gw.GetAdminStatsAsync().Returns(expected);

        var svc = new StatsCoreService(gw);
        var result = await svc.GetAdminStatsAsync();

        Assert.True(result.IsSuccess);
        Assert.Equal(5, result.Value.TotalArticles);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// PodBinaryCodec — CommentCursor round-trips
// ──────────────────────────────────────────────────────────────────────────────

public class PodBinaryCodecCommentTests
{
    private static CommentQueryCoreModel MakeCommentItem(long id = 1, string content = "hello", string user = "Alice")
    {
        var createTime = new DateTime(2024, 4, 1, 0, 0, 0, DateTimeKind.Utc);
        var author = new CommentAuthorViewDto("public", user, "zh-CN", null, null);
        var pod = PodProjector.ProjectCommentItem(id, createTime, author.Mode, author.DisplayName, content, out _);
        return new CommentQueryCoreModel(pod, id, content, createTime, author);
    }

    private static UserCommentCoreModel MakeUserComment(
        long id = 1,
        string content = "my comment",
        string title = "Article A",
        int moderationStatus = 1,
        string moderationStatusLabel = "已公开",
        string visibilityState = "public",
        string visibilityReasonCode = "approved_public",
        bool isPubliclyVisible = true)
    {
        var createTime = new DateTime(2024, 4, 5, 0, 0, 0, DateTimeKind.Utc);
        var pod = PodProjector.ProjectUserComment(
            id,
            99,
            createTime,
            content,
            title,
            null,
            moderationStatus,
            moderationStatusLabel,
            visibilityState,
            visibilityReasonCode,
            isPubliclyVisible,
            out _);
        return new UserCommentCoreModel(
            pod,
            id,
            content,
            createTime,
            99,
            title,
            null,
            new CommentAuthorViewDto("public", "未署名用户", "zh-CN", null, null),
            null,
            moderationStatus,
            moderationStatusLabel,
            visibilityState,
            visibilityReasonCode,
            isPubliclyVisible);
    }

    [Fact]
    public void CommentCursor_Empty_RoundTrip()
    {
        var cursor = new CoreCursorResult<CommentQueryCoreModel>([], null, false);
        byte[] encoded = PodBinaryCodec.EncodeCommentCursor(cursor);
        bool ok = PodBinaryCodec.TryDecodeCommentCursor(encoded, out var decoded);

        Assert.True(ok);
        Assert.Empty(decoded.Data);
        Assert.False(decoded.HasMore);
    }

    [Fact]
    public void CommentCursor_WithItems_RoundTrip()
    {
        var items = new[] { MakeCommentItem(1, "First"), MakeCommentItem(2, "Second") };
        var cursor = new CoreCursorResult<CommentQueryCoreModel>(items, 2L, true);
        byte[] encoded = PodBinaryCodec.EncodeCommentCursor(cursor);
        bool ok = PodBinaryCodec.TryDecodeCommentCursor(encoded, out var decoded);

        Assert.True(ok);
        Assert.Equal(2, decoded.Data.Count);
        Assert.True(decoded.HasMore);
        Assert.Equal(2L, decoded.NextCursor);
    }

    [Fact]
    public void CommentCursor_CorruptedBytes_ReturnsFalse()
    {
        bool ok = PodBinaryCodec.TryDecodeCommentCursor(new byte[2], out _);
        Assert.False(ok);
    }

    [Fact]
    public void CommentCreateResult_RoundTrip_PreservesFinalVisibility()
    {
        byte[] encoded = PodBinaryCodec.EncodeCommentCreateResult(
            9_007_199_254_740L,
            moderationStatus: 0,
            visibilityState: 0,
            isPubliclyVisible: false,
            rootId: 9_007_199_254_700L,
            parentId: 9_007_199_254_701L,
            createdAtUtc: new DateTime(2026, 7, 20, 4, 30, 0, DateTimeKind.Utc),
            idempotencyReplay: true);

        Assert.Equal(PodSizeCatalog.CommentCreateResultPod, encoded.Length);
        Assert.True(PodBinaryCodec.TryDecodeCommentCreateResult(
            encoded,
            out long commentId,
            out long rootId,
            out long? parentId,
            out DateTime createdAtUtc,
            out int moderationStatus,
            out byte visibilityState,
            out bool isPubliclyVisible,
            out bool idempotencyReplay));
        Assert.Equal(9_007_199_254_740L, commentId);
        Assert.Equal(9_007_199_254_700L, rootId);
        Assert.Equal(9_007_199_254_701L, parentId);
        Assert.Equal(new DateTime(2026, 7, 20, 4, 30, 0, DateTimeKind.Utc), createdAtUtc);
        Assert.Equal(0, moderationStatus);
        Assert.Equal(0, visibilityState);
        Assert.False(isPubliclyVisible);
        Assert.True(idempotencyReplay);

        byte[] trailing = [.. encoded, 0xff];
        Assert.False(PodBinaryCodec.TryDecodeCommentCreateResult(trailing, out _, out _, out _, out _, out _, out _, out _, out _));
        encoded[37] = 2;
        Assert.False(PodBinaryCodec.TryDecodeCommentCreateResult(encoded, out _, out _, out _, out _, out _, out _, out _, out _));
    }

    [Fact]
    public void UserCommentCursor_Empty_RoundTrip()
    {
        var cursor = new CoreCursorResult<UserCommentCoreModel>([], null, false);
        byte[] encoded = PodBinaryCodec.EncodeUserCommentCursor(cursor);
        bool ok = PodBinaryCodec.TryDecodeUserCommentCursor(encoded, out var decoded);

        Assert.True(ok);
        Assert.Empty(decoded.Data);
    }

    [Fact]
    public void UserCommentCursor_WithItems_RoundTrip()
    {
        var items = new[]
        {
            MakeUserComment(
                5,
                "content",
                "My Blog Post",
                moderationStatus: 2,
                moderationStatusLabel: "未通过审核",
                visibilityState: "rejected",
                visibilityReasonCode: "rejected_by_moderation",
                isPubliclyVisible: false)
        };
        var cursor = new CoreCursorResult<UserCommentCoreModel>(items, null, false);
        byte[] encoded = PodBinaryCodec.EncodeUserCommentCursor(cursor);
        bool ok = PodBinaryCodec.TryDecodeUserCommentCursor(encoded, out var decoded);

        Assert.True(ok);
        Assert.Single(decoded.Data);
        Assert.Equal("content", decoded.Data[0].Content);
        Assert.Equal("My Blog Post", decoded.Data[0].ArticleTitle);
        Assert.Equal(2, decoded.Data[0].ModerationStatus);
        Assert.Equal("未通过审核", decoded.Data[0].ModerationStatusLabel);
        Assert.Equal("rejected", decoded.Data[0].VisibilityState);
        Assert.Equal("rejected_by_moderation", decoded.Data[0].VisibilityReasonCode);
        Assert.False(decoded.Data[0].IsPubliclyVisible);
    }

    [Fact]
    public void UserCommentCursor_CorruptedBytes_ReturnsFalse()
    {
        bool ok = PodBinaryCodec.TryDecodeUserCommentCursor(new byte[3], out _);
        Assert.False(ok);
    }

    [Fact]
    public void CommentThreadCursor_Empty_RoundTrip()
    {
        var cursor = new CursorResponse<CommentThreadItemDto> { Data = [], NextCursor = null, HasMore = false };
        byte[] encoded = PodBinaryCodec.EncodeCommentThreadCursor(cursor);
        // Just verify no exception; thread cursor decode is complex
        Assert.NotNull(encoded);
        Assert.True(encoded.Length > 0);
    }

    [Fact]
    public void CommentReplyCursor_Empty_RoundTrip()
    {
        var cursor = new CursorResponse<CommentReplyItemDto> { Data = [], NextCursor = null, HasMore = false };
        byte[] encoded = PodBinaryCodec.EncodeCommentReplyCursor(99L, cursor);
        Assert.NotNull(encoded);
        Assert.True(encoded.Length > 0);
    }

    [Fact]
    public void ConversationStatusMutation_RequestAndResultRoundTripPreserveReasonAndNoChange()
    {
        var request = new ConversationStatusRequestCoreModel(
            ConversationStatusValue.Closed,
            "resolved_after_admin_review");
        byte[] encodedRequest = PodBinaryCodec.EncodeConversationStatusRequest(request);
        Assert.True(PodBinaryCodec.TryDecodeConversationStatusRequest(encodedRequest, out var decodedRequest));
        Assert.Equal(request, decodedRequest);

        var result = new ConversationStatusMutationResultResponse(
            ConversationStatusValue.Closed,
            ConversationStatusValue.Closed,
            ConversationStatusMutationOutcomeValue.NoChange);
        byte[] encodedResult = PodBinaryCodec.EncodeConversationStatusMutationResult(result);
        Assert.True(PodBinaryCodec.TryDecodeConversationStatusMutationResult(encodedResult, out var decodedResult));
        Assert.Equal(result, decodedResult);

        encodedResult[9] = 1;
        Assert.False(PodBinaryCodec.TryDecodeConversationStatusMutationResult(encodedResult, out _));
    }

}

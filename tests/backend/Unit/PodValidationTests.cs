using CoreFrameType = FsusBlog.Core.Algorithms.AedsFrameType;
using FsusBlog.Shared;
using SharedFrameType = FsusBlog.Shared.AedsFrameType;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Primitives;
using FsusBlog.Shared.Contracts.Validation;
namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// PodSizeCatalog
// ──────────────────────────────────────────────────────────────────────────────

public class PodSizeCatalogTests
{
    private static void AssertPositiveSize(int size, string fieldName)
    {
        Assert.True(size > 0, $"{fieldName} size must be positive, got {size}");
    }

    [Fact]
    public void AllSizesArePositive()
    {
        AssertPositiveSize(PodSizeCatalog.Utf8Fixed32, nameof(PodSizeCatalog.Utf8Fixed32));
        AssertPositiveSize(PodSizeCatalog.Utf8Fixed64, nameof(PodSizeCatalog.Utf8Fixed64));
        AssertPositiveSize(PodSizeCatalog.Utf8Fixed128, nameof(PodSizeCatalog.Utf8Fixed128));
        AssertPositiveSize(PodSizeCatalog.Utf8Fixed256, nameof(PodSizeCatalog.Utf8Fixed256));
        AssertPositiveSize(PodSizeCatalog.Utf8Fixed512, nameof(PodSizeCatalog.Utf8Fixed512));
        AssertPositiveSize(PodSizeCatalog.Utf8SliceRef, nameof(PodSizeCatalog.Utf8SliceRef));

        AssertPositiveSize(PodSizeCatalog.PodEnvelopeHeader, nameof(PodSizeCatalog.PodEnvelopeHeader));
        AssertPositiveSize(PodSizeCatalog.PageEnvelope, nameof(PodSizeCatalog.PageEnvelope));
        AssertPositiveSize(PodSizeCatalog.CursorEnvelope, nameof(PodSizeCatalog.CursorEnvelope));
        AssertPositiveSize(PodSizeCatalog.PagedPodEnvelope, nameof(PodSizeCatalog.PagedPodEnvelope));
        AssertPositiveSize(PodSizeCatalog.CursorPodEnvelope, nameof(PodSizeCatalog.CursorPodEnvelope));

        AssertPositiveSize(PodSizeCatalog.EmptySuccessPod, nameof(PodSizeCatalog.EmptySuccessPod));
        AssertPositiveSize(PodSizeCatalog.MutationIdPod, nameof(PodSizeCatalog.MutationIdPod));
        AssertPositiveSize(PodSizeCatalog.ApiErrorPod, nameof(PodSizeCatalog.ApiErrorPod));

        AssertPositiveSize(PodSizeCatalog.ArticleListItemPod, nameof(PodSizeCatalog.ArticleListItemPod));
        AssertPositiveSize(PodSizeCatalog.ArticleDetailPod, nameof(PodSizeCatalog.ArticleDetailPod));
        AssertPositiveSize(PodSizeCatalog.ArticleDetailV3HeaderPod, nameof(PodSizeCatalog.ArticleDetailV3HeaderPod));
        AssertPositiveSize(PodSizeCatalog.ArticleDetailV3RecordPod, nameof(PodSizeCatalog.ArticleDetailV3RecordPod));
        Assert.Equal(84, PodSizeCatalog.ArticleDetailV3RecordPod);
        Assert.Equal(44, PodSizeCatalog.ArticleDetailV4HeaderPod);
        Assert.Equal(92, PodSizeCatalog.ArticleDetailV4RecordPod);
        AssertPositiveSize(PodSizeCatalog.ArticleDetailTagV3RecordPod, nameof(PodSizeCatalog.ArticleDetailTagV3RecordPod));
        AssertPositiveSize(PodSizeCatalog.ArticleRightsV3RecordPod, nameof(PodSizeCatalog.ArticleRightsV3RecordPod));
        AssertPositiveSize(PodSizeCatalog.TagPod, nameof(PodSizeCatalog.TagPod));
        AssertPositiveSize(PodSizeCatalog.TagWithCountPod, nameof(PodSizeCatalog.TagWithCountPod));
        AssertPositiveSize(PodSizeCatalog.CategoryPod, nameof(PodSizeCatalog.CategoryPod));
        AssertPositiveSize(PodSizeCatalog.ArticleNoticePod, nameof(PodSizeCatalog.ArticleNoticePod));
        AssertPositiveSize(PodSizeCatalog.ArticleMutationResponsePod, nameof(PodSizeCatalog.ArticleMutationResponsePod));
        AssertPositiveSize(PodSizeCatalog.TrashClearResponsePod, nameof(PodSizeCatalog.TrashClearResponsePod));
        AssertPositiveSize(PodSizeCatalog.ArticleWriteRequestPod, nameof(PodSizeCatalog.ArticleWriteRequestPod));
        AssertPositiveSize(PodSizeCatalog.ArticleRightsWriteRequestPod, nameof(PodSizeCatalog.ArticleRightsWriteRequestPod));

        AssertPositiveSize(PodSizeCatalog.CommentItemPod, nameof(PodSizeCatalog.CommentItemPod));
        AssertPositiveSize(PodSizeCatalog.UserCommentPod, nameof(PodSizeCatalog.UserCommentPod));
        AssertPositiveSize(PodSizeCatalog.CommentPolicySnapshotPod, nameof(PodSizeCatalog.CommentPolicySnapshotPod));
        AssertPositiveSize(PodSizeCatalog.CommentPolicyUpdateRequestPod, nameof(PodSizeCatalog.CommentPolicyUpdateRequestPod));
        Assert.Equal(41, PodSizeCatalog.CommentPolicySnapshotPod);
        Assert.Equal(26, PodSizeCatalog.CommentPolicyUpdateRequestPod);
        AssertPositiveSize(PodSizeCatalog.CommentCreateV2RequestPod, nameof(PodSizeCatalog.CommentCreateV2RequestPod));
        AssertPositiveSize(PodSizeCatalog.CommentAuthorViewPod, nameof(PodSizeCatalog.CommentAuthorViewPod));
        AssertPositiveSize(PodSizeCatalog.AnonymousCredentialIssueRequestPod, nameof(PodSizeCatalog.AnonymousCredentialIssueRequestPod));
        AssertPositiveSize(PodSizeCatalog.AnonymousCredentialIssueResponsePod, nameof(PodSizeCatalog.AnonymousCredentialIssueResponsePod));
        AssertPositiveSize(PodSizeCatalog.AnonymousCredentialRootSnapshotPod, nameof(PodSizeCatalog.AnonymousCredentialRootSnapshotPod));
        AssertPositiveSize(PodSizeCatalog.AnonymousCommentTicketRequestPod, nameof(PodSizeCatalog.AnonymousCommentTicketRequestPod));
        AssertPositiveSize(PodSizeCatalog.AnonymousCommentTicketResponsePod, nameof(PodSizeCatalog.AnonymousCommentTicketResponsePod));
        AssertPositiveSize(PodSizeCatalog.AnonymousCommentCreateRequestPod, nameof(PodSizeCatalog.AnonymousCommentCreateRequestPod));
        AssertPositiveSize(PodSizeCatalog.AnonymousPrivacyStateSnapshotPod, nameof(PodSizeCatalog.AnonymousPrivacyStateSnapshotPod));
        AssertPositiveSize(PodSizeCatalog.CommentThreadItemPod, nameof(PodSizeCatalog.CommentThreadItemPod));
        AssertPositiveSize(PodSizeCatalog.CommentReplyItemPod, nameof(PodSizeCatalog.CommentReplyItemPod));
        AssertPositiveSize(PodSizeCatalog.CommentThreadCursorPod, nameof(PodSizeCatalog.CommentThreadCursorPod));
        AssertPositiveSize(PodSizeCatalog.CommentReplyCursorPod, nameof(PodSizeCatalog.CommentReplyCursorPod));

        AssertPositiveSize(PodSizeCatalog.MessageInboxPod, nameof(PodSizeCatalog.MessageInboxPod));
        AssertPositiveSize(PodSizeCatalog.CommentPushPod, nameof(PodSizeCatalog.CommentPushPod));
        AssertPositiveSize(PodSizeCatalog.CommentAddedNotifyPod, nameof(PodSizeCatalog.CommentAddedNotifyPod));
        AssertPositiveSize(PodSizeCatalog.GlobalNoticePayloadPod, nameof(PodSizeCatalog.GlobalNoticePayloadPod));
        AssertPositiveSize(PodSizeCatalog.MessageRevokedPayloadPod, nameof(PodSizeCatalog.MessageRevokedPayloadPod));
        AssertPositiveSize(PodSizeCatalog.AccountStatusPayloadPod, nameof(PodSizeCatalog.AccountStatusPayloadPod));
        AssertPositiveSize(PodSizeCatalog.NoticePayloadPod, nameof(PodSizeCatalog.NoticePayloadPod));
        AssertPositiveSize(PodSizeCatalog.CommentRemovedPayloadPod, nameof(PodSizeCatalog.CommentRemovedPayloadPod));

        AssertPositiveSize(PodSizeCatalog.TokenResponsePod, nameof(PodSizeCatalog.TokenResponsePod));
        AssertPositiveSize(PodSizeCatalog.LoginResponsePod, nameof(PodSizeCatalog.LoginResponsePod));
        AssertPositiveSize(PodSizeCatalog.CurrentUserSnapshotPod, nameof(PodSizeCatalog.CurrentUserSnapshotPod));
        AssertPositiveSize(PodSizeCatalog.IdentityAccountSnapshotPod, nameof(PodSizeCatalog.IdentityAccountSnapshotPod));
        AssertPositiveSize(PodSizeCatalog.UserListItemPod, nameof(PodSizeCatalog.UserListItemPod));

        AssertPositiveSize(PodSizeCatalog.SeoConfigPod, nameof(PodSizeCatalog.SeoConfigPod));
        AssertPositiveSize(PodSizeCatalog.PageContentPod, nameof(PodSizeCatalog.PageContentPod));

        AssertPositiveSize(PodSizeCatalog.PopularArticlePod, nameof(PodSizeCatalog.PopularArticlePod));
        AssertPositiveSize(PodSizeCatalog.RecentCommentPod, nameof(PodSizeCatalog.RecentCommentPod));
        AssertPositiveSize(PodSizeCatalog.RegionDistributionPod, nameof(PodSizeCatalog.RegionDistributionPod));
        AssertPositiveSize(PodSizeCatalog.SiteStatsPod, nameof(PodSizeCatalog.SiteStatsPod));

        AssertPositiveSize(PodSizeCatalog.FileUploadOutputPod, nameof(PodSizeCatalog.FileUploadOutputPod));
        AssertPositiveSize(PodSizeCatalog.UploadInitPod, nameof(PodSizeCatalog.UploadInitPod));
        AssertPositiveSize(PodSizeCatalog.UploadStatusPod, nameof(PodSizeCatalog.UploadStatusPod));
        AssertPositiveSize(PodSizeCatalog.UploadPartMapPod, nameof(PodSizeCatalog.UploadPartMapPod));
        AssertPositiveSize(PodSizeCatalog.UploadPartRangePod, nameof(PodSizeCatalog.UploadPartRangePod));
        AssertPositiveSize(PodSizeCatalog.UploadPartAckPod, nameof(PodSizeCatalog.UploadPartAckPod));
        AssertPositiveSize(PodSizeCatalog.UploadCompletePod, nameof(PodSizeCatalog.UploadCompletePod));
        AssertPositiveSize(PodSizeCatalog.UploadInitRequestPod, nameof(PodSizeCatalog.UploadInitRequestPod));
        AssertPositiveSize(PodSizeCatalog.UploadCompleteRequestPod, nameof(PodSizeCatalog.UploadCompleteRequestPod));
        AssertPositiveSize(PodSizeCatalog.PowChallengePod, nameof(PodSizeCatalog.PowChallengePod));
    }

    [Fact]
    public void Utf8FixedSizesIncreaseWithLength()
    {
        Assert.True(PodSizeCatalog.Utf8Fixed32 < PodSizeCatalog.Utf8Fixed64);
        Assert.True(PodSizeCatalog.Utf8Fixed64 < PodSizeCatalog.Utf8Fixed128);
        Assert.True(PodSizeCatalog.Utf8Fixed128 < PodSizeCatalog.Utf8Fixed256);
        Assert.True(PodSizeCatalog.Utf8Fixed256 < PodSizeCatalog.Utf8Fixed512);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// PodContractValidation
// ──────────────────────────────────────────────────────────────────────────────

public class PodContractValidationTests
{
    [Fact]
    public void AreAllPodModelsReferenceFree_ReturnsTrue()
    {
        bool result = PodContractValidation.AreAllPodModelsReferenceFree();
        Assert.True(result);
    }

    [Fact]
    public void SizeOf_Utf8Fixed32_ReturnsPositive()
    {
        int size = PodContractValidation.SizeOf<Utf8Fixed32>();
        Assert.True(size > 0);
        Assert.Equal(32, size);
    }

    [Fact]
    public void CommentPushPod_UsesAuthorSnapshotSlotsWithoutLegacyIdentityFields()
    {
        string[] fields = typeof(CommentPushPod)
            .GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance)
            .Select(static field => field.Name)
            .ToArray();

        Assert.Contains("Author", fields);
        Assert.Contains("ReplyToAuthor", fields);
        Assert.DoesNotContain("UserName", fields);
        Assert.DoesNotContain("ReplyToUserId", fields);
    }

    [Fact]
    public void SizeOf_Utf8Fixed64_ReturnsPositive()
    {
        int size = PodContractValidation.SizeOf<Utf8Fixed64>();
        Assert.True(size > 0);
        Assert.Equal(64, size);
    }

    [Fact]
    public void SizeOf_Utf8Fixed128_ReturnsPositive()
    {
        int size = PodContractValidation.SizeOf<Utf8Fixed128>();
        Assert.True(size > 0);
        Assert.Equal(128, size);
    }

    [Fact]
    public void SizeOf_Utf8Fixed256_ReturnsPositive()
    {
        int size = PodContractValidation.SizeOf<Utf8Fixed256>();
        Assert.True(size > 0);
        Assert.Equal(256, size);
    }

    [Fact]
    public void SizeOf_Utf8Fixed512_ReturnsPositive()
    {
        int size = PodContractValidation.SizeOf<Utf8Fixed512>();
        Assert.True(size > 0);
        Assert.Equal(512, size);
    }
}

public class AedsProtocolMetadataTests
{
    [Fact]
    public void Metadata_UsesCurrentFrameHeaderValues()
    {
        Assert.Equal(AedsFrameHeader.VersionValue, AedsProtocolMetadata.FrameVersion);
        Assert.Equal(AedsFrameHeader.Size, AedsProtocolMetadata.FrameHeaderSize);
        Assert.True(AedsProtocolMetadata.SchemaVersion > 0);
    }

    [Fact]
    public void Metadata_FrameTypesMatchSharedEnum()
    {
        foreach (SharedFrameType frameType in Enum.GetValues<SharedFrameType>())
        {
            string name = Enum.GetName(frameType) ?? ((ushort)frameType).ToString();
            Assert.True(AedsProtocolMetadata.FrameTypes.TryGetValue(name, out ushort raw));
            Assert.Equal((ushort)frameType, raw);
        }
    }

    [Fact]
    public void SharedAndCoreFrameTypes_AreAligned()
    {
        var core = Enum.GetValues<CoreFrameType>()
            .ToDictionary(static value => Enum.GetName(value)!, static value => (ushort)value, StringComparer.Ordinal);
        var shared = Enum.GetValues<SharedFrameType>()
            .ToDictionary(static value => Enum.GetName(value)!, static value => (ushort)value, StringComparer.Ordinal);

        Assert.Equal(core.Count, shared.Count);
        foreach ((string name, ushort raw) in core)
        {
            Assert.True(shared.TryGetValue(name, out ushort sharedRaw), $"Missing shared frame type: {name}");
            Assert.Equal(raw, sharedRaw);
        }
    }

    [Fact]
    public void Metadata_PodSizesMatchCatalogFields()
    {
        var fields = typeof(PodSizeCatalog)
            .GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)
            .Where(static field => field.FieldType == typeof(int))
            .ToArray();

        Assert.Equal(fields.Length, AedsProtocolMetadata.PodSizes.Count);
        for (int i = 0; i < fields.Length; i++)
        {
            var field = fields[i];
            Assert.True(AedsProtocolMetadata.PodSizes.TryGetValue(field.Name, out int size), $"Missing metadata pod size: {field.Name}");
            Assert.Equal((int)(field.GetValue(null) ?? 0), size);
        }
    }
}

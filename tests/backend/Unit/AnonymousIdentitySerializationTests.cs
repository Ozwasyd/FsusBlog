using System.Reflection;
using System.Text.Json;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousIdentitySerializationTests
{
    [Theory]
    [InlineData(typeof(AuthIdentitySnapshotDto))]
    [InlineData(typeof(AuthLoginFlowDto))]
    [InlineData(typeof(CurrentUserSnapshotDto))]
    [InlineData(typeof(MfaChallengeResultDto))]
    [InlineData(typeof(CommentItemDto))]
    [InlineData(typeof(CommentReplyItemDto))]
    [InlineData(typeof(CommentReplyPreviewItemDto))]
    [InlineData(typeof(CommentThreadItemDto))]
    [InlineData(typeof(UserCommentResponse))]
    public void AnonymousIdentityDtos_DoNotExposeLegacyIdentityFields(Type dtoType)
    {
        string[] propertyNames = dtoType
            .GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(static property => property.Name)
            .ToArray();

        Assert.DoesNotContain("Username", propertyNames);
        Assert.DoesNotContain("UserName", propertyNames);
        Assert.DoesNotContain("Role", propertyNames);
        Assert.DoesNotContain("UserId", propertyNames);
        Assert.DoesNotContain("ReplyToUserName", propertyNames);
    }

    [Theory]
    [InlineData(typeof(AuthLoginFlowPod))]
    [InlineData(typeof(CurrentUserSnapshotPod))]
    [InlineData(typeof(IdentityAccountSnapshotPod))]
    [InlineData(typeof(MfaChallengeResultPod))]
    [InlineData(typeof(CommentItemPod))]
    [InlineData(typeof(UserCommentPod))]
    [InlineData(typeof(CommentThreadItemPod))]
    [InlineData(typeof(CommentReplyItemPod))]
    [InlineData(typeof(CommentReplyPreviewItemPod))]
    [InlineData(typeof(CommentPushPod))]
    public void AnonymousIdentityPods_DoNotCarryLegacyIdentityFields(Type podType)
    {
        string[] fieldNames = podType
            .GetFields(BindingFlags.Instance | BindingFlags.Public)
            .Select(static field => field.Name)
            .ToArray();

        Assert.DoesNotContain("Username", fieldNames);
        Assert.DoesNotContain("UserName", fieldNames);
        Assert.DoesNotContain("Role", fieldNames);
        Assert.DoesNotContain("UserId", fieldNames);
        Assert.DoesNotContain("ReplyToUserName", fieldNames);
    }

    [Fact]
    public void CommentItemDto_SerializesAuthorSnapshotWithoutLegacyIdentityFields()
    {
        var dto = new CommentItemDto(
            "42",
            "hello",
            DateTime.UnixEpoch,
            new CommentAuthorViewDto("anonymous", "Anonymous User 7", "en", null, "article"));

        string json = JsonSerializer.Serialize(dto, JsonOptions());

        Assert.Contains("\"author\"", json, StringComparison.Ordinal);
        Assert.Contains("\"displayName\":\"Anonymous User 7\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("userName", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("userId", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("role", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("credentialLevel", json, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void UserCommentResponse_SerializesReplyAuthorSnapshotWithoutLegacyReplyName()
    {
        var dto = new UserCommentResponse
        {
            Id = 42,
            Content = "reply",
            CreateTime = DateTime.UnixEpoch,
            ArticleId = 7,
            ArticleTitle = "Article",
            RootId = 42,
            Author = new CommentAuthorViewDto("public", "Alice", "zh-CN", null, null),
            ReplyToAuthor = new CommentAuthorViewDto("public", "Bob", "zh-CN", null, null),
            ModerationStatus = 1,
            ModerationStatusLabel = "已公开",
            VisibilityState = "public",
            VisibilityReasonCode = "approved_public",
            IsPubliclyVisible = true
        };

        string json = JsonSerializer.Serialize(dto, JsonOptions());

        Assert.Contains("\"replyToAuthor\"", json, StringComparison.Ordinal);
        Assert.Contains("\"displayName\":\"Bob\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("replyToUserName", json, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void UserAccountReader_MapsAnonymousAccountSnapshotWithoutLegacyIdentity()
    {
        var deletedAt = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var user = new User
        {
            Id = 42,
            Status = 1,
            BanReason = "limited",
            DeletedAt = deletedAt,
            PublicHandle = "Public Alice",
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            PasskeyEnabled = true,
            RecoveryEnabled = true,
            MfaEnabled = true,
            AnonymousCredentialStatus = "active",
            AnonymousCredentialLevel = "strong_anonymous"
        };

        UserAccountSnapshot account = UserAccountReader.ToAccountSnapshot(user);
        IdentityAccountSnapshotCoreModel snapshot = UserAccountReader.ToAnonymousAccountSnapshot(account);

        string[] propertyNames = snapshot.GetType().GetProperties().Select(static property => property.Name).ToArray();
        Assert.DoesNotContain("Username", propertyNames);
        Assert.DoesNotContain("Role", propertyNames);
        Assert.DoesNotContain("UserId", propertyNames);
        Assert.DoesNotContain("InternalUserId", propertyNames);
        Assert.Equal(42, snapshot.AccountId);
        Assert.Equal(AnonymousIdentityRuntime.AnonymousAccountKind, snapshot.IdentityKind);
        Assert.Equal("Public Alice", snapshot.PublicHandle);
        Assert.True(snapshot.PasskeyEnabled);
        Assert.True(snapshot.RecoveryEnabled);
        Assert.True(snapshot.TotpStepUpEnabled);
        Assert.Equal("active", snapshot.AnonymousCredentialStatus);
        Assert.Equal("strong_anonymous", snapshot.AnonymousCredentialLevel);
        Assert.Equal(1, snapshot.Status);
        Assert.Equal("limited", snapshot.BanReason);
        Assert.Equal(deletedAt, snapshot.DeletedAt);
    }

    private static JsonSerializerOptions JsonOptions()
        => new(JsonSerializerDefaults.Web);
}

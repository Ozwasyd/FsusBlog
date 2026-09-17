using System.Reflection;
using System.Text.Json;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

public sealed class StatsRecentCommentPrivacyBehaviorTests
{
    [Fact]
    public void RecentCommentModels_ExposeAuthorSnapshotsWithoutAccountIdentityMembers()
    {
        Type[] contractTypes =
        [
            typeof(RecentCommentStatItemDto),
            typeof(RecentCommentPod),
            typeof(RecentCommentCoreModel)
        ];

        foreach (Type contractType in contractTypes)
        {
            string[] memberNames = contractType
                .GetMembers(BindingFlags.Public | BindingFlags.Instance)
                .Select(static member => member.Name)
                .ToArray();
            Assert.DoesNotContain(memberNames, static name =>
                string.Equals(name, "UserId", StringComparison.OrdinalIgnoreCase)
                || string.Equals(name, "UserName", StringComparison.OrdinalIgnoreCase));
        }

        Assert.Contains(nameof(RecentCommentStatItemDto.AuthorDisplayName),
            typeof(RecentCommentStatItemDto).GetProperties().Select(static property => property.Name));
        Assert.Contains(nameof(RecentCommentCoreModel.AuthorMode),
            typeof(RecentCommentCoreModel).GetProperties().Select(static property => property.Name));
        Assert.NotNull(typeof(RecentCommentPod).GetField(nameof(RecentCommentPod.AuthorDisplayName)));
    }

    [Fact]
    public void RecentCommentDto_JsonContainsOnlySnapshotIdentityFields()
    {
        var value = new RecentCommentStatItemDto(
            "Scoped Sparrow",
            CommentAuthorModes.ZkAnonymous,
            "已验证匿名凭证",
            "article:42",
            "privacy-safe",
            DateTime.UnixEpoch);

        string json = JsonSerializer.Serialize(value);
        using JsonDocument document = JsonDocument.Parse(json);
        string[] names = document.RootElement.EnumerateObject().Select(static property => property.Name).ToArray();

        Assert.DoesNotContain(names, static name =>
            string.Equals(name, "userId", StringComparison.OrdinalIgnoreCase)
            || string.Equals(name, "userName", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(names, static name => string.Equals(name, "authorDisplayName", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(names, static name => string.Equals(name, "credentialLevel", StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData(CommentAuthorModes.Public, "Public Handle", "ignored", "ignored", "Public Handle", null, null)]
    [InlineData(CommentAuthorModes.LegacyServerVisiblePseudonymous, null, "Anonymous Finch", null, "Anonymous Finch", null, null)]
    [InlineData(CommentAuthorModes.ZkAnonymous, null, "Verified Owl", "article:9", "Verified Owl", "已验证匿名资格", "article:9")]
    [InlineData(CommentAuthorModes.ZkAnonymous, null, null, null, "强匿名评论者", "已验证匿名资格", null)]
    public void CreateRecentCommentStatItem_PreservesPrivacySafeAuthorSemantics(
        string authorMode,
        string? publicHandle,
        string? anonymousDisplayName,
        string? anonymousScope,
        string expectedDisplayName,
        string? expectedBadge,
        string? expectedScope)
    {
        RecentCommentStatItemDto item = StatsService.CreateRecentCommentStatItem(
            authorMode,
            publicHandle,
            anonymousDisplayName,
            anonymousScope,
            "comment",
            DateTime.UnixEpoch);

        Assert.Equal(expectedDisplayName, item.AuthorDisplayName);
        Assert.Equal(authorMode, item.AuthorMode);
        Assert.Equal(expectedBadge, item.AuthorBadge);
        Assert.Equal(expectedScope, item.AuthorScopeLabel);
        Assert.DoesNotContain("CredentialLevel", typeof(RecentCommentStatItemDto).GetProperties().Select(static property => property.Name));
    }
}

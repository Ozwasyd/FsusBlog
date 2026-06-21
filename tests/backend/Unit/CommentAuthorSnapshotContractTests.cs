using System.Reflection;
using System.Text.Json;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentAuthorSnapshotContractTests
{
    [Theory]
    [InlineData(typeof(CommentItemPod))]
    [InlineData(typeof(UserCommentPod))]
    [InlineData(typeof(CommentThreadItemPod))]
    [InlineData(typeof(CommentReplyItemPod))]
    [InlineData(typeof(CommentReplyPreviewItemPod))]
    [InlineData(typeof(CommentPushPod))]
    public void CommentWirePods_DoNotCarryLegacyUserNameFields(Type podType)
    {
        string[] fieldNames = podType
            .GetFields(BindingFlags.Instance | BindingFlags.Public)
            .Select(field => field.Name)
            .ToArray();

        Assert.DoesNotContain("UserName", fieldNames);
        Assert.DoesNotContain("ReplyToUserName", fieldNames);
    }

    [Fact]
    public void CommentItemDto_UsesAuthorSnapshotInsteadOfUserName()
    {
        string contracts = BackendTestPaths.ReadAllTextFromRoot("src/shared/Contracts/Outputs/ServerResponseContracts.cs");
        string block = ExtractBlock(contracts, "public readonly record struct CommentItemDto", "public readonly record struct CommentListResponseDto");

        Assert.Contains("CommentAuthorViewDto Author", block, StringComparison.Ordinal);
        Assert.DoesNotContain("UserName", block, StringComparison.Ordinal);
    }

    [Fact]
    public void UserCommentResponse_SerializesReplyDisplaySnapshotInsteadOfReplyToUserName()
    {
        var dto = new UserCommentResponse
        {
            Id = 42,
            Content = "reply",
            CreateTime = DateTime.UnixEpoch,
            ArticleId = 7,
            ArticleTitle = "Article",
            RootId = 42,
            Author = new CommentAuthorViewDto("public", "Alice", "zh-CN", null, null, null),
            ReplyToAuthor = new CommentAuthorViewDto("public", "Bob", "zh-CN", null, null, null),
            ModerationStatus = 1,
            ModerationStatusLabel = "已公开",
            VisibilityState = "public",
            VisibilityReasonCode = "approved_public",
            IsPubliclyVisible = true
        };

        string json = JsonSerializer.Serialize(dto, JsonOptions());

        Assert.Contains("\"replyToAuthor\"", json, StringComparison.Ordinal);
        Assert.Contains("\"displayName\":\"Bob\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("ReplyToUserName", json, StringComparison.Ordinal);
        Assert.DoesNotContain("replyToUserName", json, StringComparison.Ordinal);
    }

    [Fact]
    public void CppAlignmentChecklist_DoesNotReserveUsernameFixedSlot()
    {
        string checklist = BackendTestPaths.ReadAllTextFromRoot("src/shared/Contracts/CPP_ALIGNMENT_CHECKLIST.md");

        Assert.DoesNotContain("username: 64", checklist, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CoreBenchmarks_UseCommentAuthorSnapshotFieldsInsteadOfLegacyUserName()
    {
        string benchmark = BackendTestPaths.ReadAllTextFromRoot("benchmarks/core/Program.cs");

        Assert.Contains("_displayName", benchmark, StringComparison.Ordinal);
        Assert.Contains("_authorMode", benchmark, StringComparison.Ordinal);
        Assert.Contains("GetProperty(\"author\")", benchmark, StringComparison.Ordinal);
        Assert.Contains("GetProperty(\"displayName\")", benchmark, StringComparison.Ordinal);
        Assert.DoesNotContain("_userName", benchmark, StringComparison.Ordinal);
        Assert.DoesNotContain("GetProperty(\"userName\")", benchmark, StringComparison.Ordinal);
    }

    private static JsonSerializerOptions JsonOptions()
        => new(JsonSerializerDefaults.Web);

    private static string ExtractBlock(string source, string startToken, string endToken)
    {
        int start = source.IndexOf(startToken, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start token: {startToken}");
        int end = source.IndexOf(endToken, start + startToken.Length, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing end token: {endToken}");
        return source[start..end];
    }
}

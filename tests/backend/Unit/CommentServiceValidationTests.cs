using System.Reflection;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Moderation;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Tests CommentService validation paths that return early before any DB query.
/// </summary>
public class CommentServiceValidationTests
{
    private static CommentService BuildService()
    {
        return new CommentService(
            db: Substitute.For<ISqlSugarClient>(),
            logger: NullLogger<CommentService>.Instance,
            commentNotifications: Substitute.For<ICommentNotificationService>(),
            cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            regionLegalModerationService: new RegionLegalModerationService());
    }

    private static CommentQueryService BuildQueryService()
        => new(Substitute.For<ISqlSugarClient>(), new RegionLegalModerationService());

    private static CursorPageRequest<long> MakeRequest(int limit = 10)
        => new(null, null, limit);

    // ─── CreateCommentAsync early returns ────────────────────────────────────

    [Fact]
    public async Task CreateComment_ArticleIdZero_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = 0, Content = "valid content" };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    [Fact]
    public async Task CreateComment_NegativeArticleId_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = -5, Content = "valid content" };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    [Fact]
    public async Task CreateComment_EmptyContent_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = 1, Content = "   " };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    [Fact]
    public async Task CreateComment_InvalidParentId_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = 1, Content = "hello", ParentId = "not-a-number" };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    [Fact]
    public async Task CreateComment_ZeroParentId_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = 1, Content = "hello", ParentId = "0" };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    [Fact]
    public async Task CreateComment_InvalidRootId_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = 1, Content = "hello", ParentId = "100", RootId = "abc" };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    [Fact]
    public async Task CreateComment_InvalidReplyToCommentId_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = 1, Content = "hello", ParentId = "100", ReplyToCommentId = "bad" };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    [Fact]
    public async Task CreateComment_NullContent_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = 1, Content = null! };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    [Fact]
    public async Task CreateComment_NegativeParentId_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = 1, Content = "hello", ParentId = "-1" };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    [Fact]
    public async Task CreateComment_NegativeRootId_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = 1, Content = "hello", ParentId = "100", RootId = "-5" };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    // ─── GetCommentThreadsByCursorAsync guard ────────────────────────────────

    [Fact]
    public async Task GetCommentThreads_ArticleIdZero_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetThreadsAsync(0, MakeRequest());
        Assert.Empty(result.Data);
        Assert.Null(result.NextCursor);
        Assert.False(result.HasMore);
    }

    [Fact]
    public async Task GetCommentThreads_NegativeArticleId_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetThreadsAsync(-1, MakeRequest());
        Assert.Empty(result.Data);
        Assert.Null(result.NextCursor);
        Assert.False(result.HasMore);
    }

    // ─── GetThreadRepliesByCursorAsync guard ─────────────────────────────────

    [Fact]
    public async Task GetThreadReplies_ArticleIdZero_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetRepliesAsync(0, 1L, MakeRequest());
        Assert.Empty(result.Data);
    }

    [Fact]
    public async Task GetThreadReplies_RootIdZero_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetRepliesAsync(1, 0L, MakeRequest());
        Assert.Empty(result.Data);
    }

    [Fact]
    public async Task GetThreadReplies_NegativeRootId_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetRepliesAsync(1, -100L, MakeRequest());
        Assert.Empty(result.Data);
    }

    [Fact]
    public async Task GetThreadReplies_BothNegative_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetRepliesAsync(-1, -1L, MakeRequest());
        Assert.Empty(result.Data);
        Assert.False(result.HasMore);
    }

    // ─── GetAttributableCommentsAsync guard ─────────────────────────────────

    [Fact]
    public async Task GetAttributableComments_UserIdZero_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetAttributableAsync(0, MakeRequest());
        Assert.Empty(result.Data);
        Assert.Null(result.NextCursor);
        Assert.False(result.HasMore);
    }

    [Fact]
    public async Task GetAttributableComments_NegativeUserId_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetAttributableAsync(-99, MakeRequest());
        Assert.Empty(result.Data);
        Assert.False(result.HasMore);
    }

    // ─── GetCommentsByCursorAsync delegates to GetCommentThreads ─────────────

    [Fact]
    public async Task GetCommentsByCursor_ArticleIdZero_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetLegacyCommentsAsync(0, MakeRequest());
        Assert.Empty(result.Data);
        Assert.False(result.HasMore);
    }

    [Fact]
    public async Task GetCommentsByCursor_NegativeArticleId_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetLegacyCommentsAsync(-5, MakeRequest());
        Assert.Empty(result.Data);
    }

    [Fact]
    public void CommentCursorQueries_UseIndexedKeysetPredicates()
    {
        string roots = RuntimeMetadataInspection.DescribeDeclaredMethodContaining(
            typeof(CommentQueryService),
            "c.id < @Cursor",
            "ORDER BY c.id DESC");
        string replies = RuntimeMetadataInspection.DescribeDeclaredMethodContaining(
            typeof(CommentQueryService),
            "c.id > @Cursor",
            "ORDER BY c.id");
        string publicPaging = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentQueryService),
            nameof(CommentQueryService.GetThreadsAsync),
            nameof(CommentQueryService.GetRepliesAsync),
            nameof(CommentQueryService.GetAttributableAsync));

        Assert.Contains("c.id < @Cursor", roots);
        Assert.Contains("c.id > @Cursor", replies);
        Assert.Contains("SliceMapToResponse", publicPaging);
        Assert.DoesNotContain("Enumerable.Skip", roots, StringComparison.Ordinal);
        Assert.DoesNotContain("Enumerable.Skip", replies, StringComparison.Ordinal);
        Assert.DoesNotContain(" OFFSET ", roots, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(" OFFSET ", replies, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CommentThreadPreviewQuery_UsesSqlPerRootWindowLimit()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeDeclaredMethodContaining(
            typeof(CommentQueryService),
            "ROW_NUMBER() OVER (PARTITION BY c.root_id ORDER BY c.id)",
            "WHERE x.rn <= @PreviewLimit");

        Assert.Contains("ROW_NUMBER() OVER (PARTITION BY c.root_id ORDER BY c.id)", runtimeShape);
        Assert.Contains("WHERE x.rn <= @PreviewLimit", runtimeShape);
        Assert.DoesNotContain("List.get_Count", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicReplyReadQueries_DoNotProjectReplyToUserIdForAuthorNames()
    {
        string repliesQuery = RuntimeMetadataInspection.DescribeDeclaredMethodContaining(
            typeof(CommentQueryService),
            "LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id",
            "c.id > @Cursor");
        string previewQuery = RuntimeMetadataInspection.DescribeDeclaredMethodContaining(
            typeof(CommentQueryService),
            "LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id",
            "ROW_NUMBER() OVER (PARTITION BY c.root_id ORDER BY c.id)");

        Assert.DoesNotContain("reply_to_user_id", repliesQuery, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ReplyToUserId", repliesQuery, StringComparison.Ordinal);
        Assert.DoesNotContain("reply_to_user_id", previewQuery, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ReplyToUserId", previewQuery, StringComparison.Ordinal);
        Assert.DoesNotContain("sys_user", repliesQuery, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("sys_user", previewQuery, StringComparison.OrdinalIgnoreCase);

        Assert.Contains("LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id", repliesQuery, StringComparison.Ordinal);
        Assert.Contains("LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id", previewQuery, StringComparison.Ordinal);
        Assert.Contains("pc.public_handle", repliesQuery, StringComparison.Ordinal);
        Assert.Contains("pc.anonymous_display_name", repliesQuery, StringComparison.Ordinal);
        Assert.Contains("pc.public_handle", previewQuery, StringComparison.Ordinal);
        Assert.Contains("pc.anonymous_display_name", previewQuery, StringComparison.Ordinal);
    }

    // Note: DeleteCommentAsync always queries DB first, so no pure validation path to test without DB mock

    // ── Private static helpers via reflection ──────────────────────────────────

    private static T InvokePrivateStatic<T>(string methodName, object?[] args)
    {
        var method = typeof(CommentService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)!;
        return (T)method.Invoke(null, args)!;
    }
    [Theory]
    [InlineData(null, "")]
    [InlineData("   ", "")]
    [InlineData("hello", "hello")]
    [InlineData("  trimmed  ", "trimmed")]
    public void NormalizeCommentContent_ReturnsExpected(string? input, string expected)
    {
        var result = InvokePrivateStatic<string>("NormalizeCommentContent", [input]);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void NormalizeCommentContent_DoesNotTruncateOversizedInput()
    {
        string longContent = new string('a', 5000);
        var result = InvokePrivateStatic<string>("NormalizeCommentContent", [longContent]);
        Assert.Equal(5000, result.Length);
    }

    [Theory]
    [InlineData("hello", true)]
    [InlineData("", false)]
    [InlineData("   ", false)]
    public void IsCommentContentWithinLimit_ReturnsExpectedForBasicInputs(string content, bool expected)
    {
        var result = InvokePrivateStatic<bool>("IsCommentContentWithinLimit", [content, AnonymousCommentPolicySnapshot.Default]);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void IsCommentContentWithinLimit_RejectsOverCharacterLimit()
    {
        string longContent = new('a', AnonymousCommentPolicySnapshot.Default.CommentMaxChars + 1);
        var result = InvokePrivateStatic<bool>("IsCommentContentWithinLimit", [longContent, AnonymousCommentPolicySnapshot.Default]);
        Assert.False(result);
    }

    [Fact]
    public void IsCommentContentWithinLimit_RejectsOverUtf8ByteLimit()
    {
        string longContent = new('你', (AnonymousCommentPolicySnapshot.Default.CommentMaxUtf8Bytes / 3) + 1);
        var result = InvokePrivateStatic<bool>("IsCommentContentWithinLimit", [longContent, AnonymousCommentPolicySnapshot.Default]);
        Assert.False(result);
    }

    [Theory]
    [InlineData(true, "content", "该回复已删除")]
    [InlineData(false, "original", "original")]
    public void ToDisplayContent_ReturnsExpected(bool isDeleted, string content, string expected)
    {
        MethodInfo method = typeof(CommentQueryService).GetMethod(
            "ToDisplayContent",
            BindingFlags.NonPublic | BindingFlags.Static)!;
        var result = (string)method.Invoke(null, [(object)isDeleted, content])!;
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("   ", false)]
    [InlineData("0", false)]
    [InlineData("-1", false)]
    [InlineData("abc", false)]
    [InlineData("123", true)]
    [InlineData("9999999", true)]
    public void TryParsePositiveCommentId_ReturnsExpected(string? raw, bool expectedSuccess)
    {
        var method = typeof(CommentService).GetMethod("TryParsePositiveCommentId", BindingFlags.NonPublic | BindingFlags.Static)!;
        var args = new object?[] { raw, (long)0 };
        var result = (bool)method.Invoke(null, args)!;
        Assert.Equal(expectedSuccess, result);
    }
}

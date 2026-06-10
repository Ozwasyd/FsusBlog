using System.Reflection;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Interfaces;
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
            messageService: Substitute.For<IMessageRealtimePublisher>(),
            messageCommandService: Substitute.For<IMessageCommandService>(),
            cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            regionLegalModerationService: new RegionLegalModerationService());
    }

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
        var svc = BuildService();
        var result = await svc.GetCommentThreadsByCursorAsync(0, MakeRequest());
        Assert.Empty(result.Data);
        Assert.Null(result.NextCursor);
        Assert.False(result.HasMore);
    }

    [Fact]
    public async Task GetCommentThreads_NegativeArticleId_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.GetCommentThreadsByCursorAsync(-1, MakeRequest());
        Assert.Empty(result.Data);
        Assert.Null(result.NextCursor);
        Assert.False(result.HasMore);
    }

    // ─── GetThreadRepliesByCursorAsync guard ─────────────────────────────────

    [Fact]
    public async Task GetThreadReplies_ArticleIdZero_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.GetThreadRepliesByCursorAsync(0, 1L, MakeRequest());
        Assert.Empty(result.Data);
    }

    [Fact]
    public async Task GetThreadReplies_RootIdZero_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.GetThreadRepliesByCursorAsync(1, 0L, MakeRequest());
        Assert.Empty(result.Data);
    }

    [Fact]
    public async Task GetThreadReplies_NegativeRootId_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.GetThreadRepliesByCursorAsync(1, -100L, MakeRequest());
        Assert.Empty(result.Data);
    }

    [Fact]
    public async Task GetThreadReplies_BothNegative_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.GetThreadRepliesByCursorAsync(-1, -1L, MakeRequest());
        Assert.Empty(result.Data);
        Assert.False(result.HasMore);
    }

    // ─── GetUserCommentsAsync guard ──────────────────────────────────────────

    [Fact]
    public async Task GetUserComments_UserIdZero_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.GetUserCommentsAsync(0, MakeRequest());
        Assert.Empty(result.Data);
        Assert.Null(result.NextCursor);
        Assert.False(result.HasMore);
    }

    [Fact]
    public async Task GetUserComments_NegativeUserId_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.GetUserCommentsAsync(-99, MakeRequest());
        Assert.Empty(result.Data);
        Assert.False(result.HasMore);
    }

    // ─── GetCommentsByCursorAsync delegates to GetCommentThreads ─────────────

    [Fact]
    public async Task GetCommentsByCursor_ArticleIdZero_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.GetCommentsByCursorAsync(0, MakeRequest());
        Assert.Empty(result.Data);
        Assert.False(result.HasMore);
    }

    [Fact]
    public async Task GetCommentsByCursor_NegativeArticleId_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.GetCommentsByCursorAsync(-5, MakeRequest());
        Assert.Empty(result.Data);
    }

    [Fact]
    public void CommentCursorQueries_UseIndexedKeysetPredicates()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src", "backend", "Services", "CommentService.cs"));

        Assert.Contains("c.Id < request.Cursor!.Value", source);
        Assert.Contains("c.Id > request.Cursor!.Value", source);
        Assert.Contains("SliceMapToResponse", source);
        Assert.DoesNotContain(".Skip(", source);
        Assert.DoesNotContain("OFFSET", source, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CommentThreadPreviewQuery_UsesSqlPerRootWindowLimit()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src", "backend", "Services", "CommentService.cs"));

        Assert.Contains("ROW_NUMBER() OVER (PARTITION BY c.root_id ORDER BY c.id)", source);
        Assert.Contains("WHERE x.rn <= @PreviewLimit", source);
        Assert.DoesNotContain("previews.Count < limit", source);
    }

    // Note: DeleteCommentAsync always queries DB first, so no pure validation path to test without DB mock

    // ── Private static helpers via reflection ──────────────────────────────────

    private static T InvokePrivateStatic<T>(string methodName, object?[] args)
    {
        var method = typeof(CommentService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)!;
        return (T)method.Invoke(null, args)!;
    }

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")) ||
                File.Exists(Path.Combine(current, "src", "backend", "Services", "CommentService.cs")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
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
        var result = InvokePrivateStatic<bool>("IsCommentContentWithinLimit", [content]);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void IsCommentContentWithinLimit_RejectsOverCharacterLimit()
    {
        string longContent = new('a', CommentLimits.ContentMaxChars + 1);
        var result = InvokePrivateStatic<bool>("IsCommentContentWithinLimit", [longContent]);
        Assert.False(result);
    }

    [Fact]
    public void IsCommentContentWithinLimit_RejectsOverUtf8ByteLimit()
    {
        string longContent = new('你', (CommentLimits.ContentMaxUtf8Bytes / 3) + 1);
        var result = InvokePrivateStatic<bool>("IsCommentContentWithinLimit", [longContent]);
        Assert.False(result);
    }

    [Theory]
    [InlineData(true, "content", "该回复已删除")]
    [InlineData(false, "original", "original")]
    public void ToDisplayContent_ReturnsExpected(bool isDeleted, string content, string expected)
    {
        var result = InvokePrivateStatic<string>("ToDisplayContent", [(object)isDeleted, content]);
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

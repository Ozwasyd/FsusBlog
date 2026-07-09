using System.Reflection;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;

namespace FsusBlog.Server.Tests.Unit;

public class PodProjectorTests
{
    // ── ProjectArticleList ──────────────────────────────────────────────────

    [Fact]
    public void ProjectArticleList_Fields_AreCorrect()
    {
        var createTime = new DateTime(2024, 6, 15, 12, 0, 0, DateTimeKind.Utc);
        var pod = PodProjector.ProjectArticleList(
            id: 42, views: 100, createTime: createTime,
            categoryId: 7, categoryName: "Tech",
            title: "Hello World",
            summary: "A summary",
            isDeleted: false,
            payload: out var payload);

        Assert.Equal(42, pod.Id);
        Assert.Equal(100, pod.Views);
        Assert.Equal(7, pod.Category.Id);
        Assert.Equal("Tech", PodUtf8Codec.FromFixed128(pod.Category.Name));
        Assert.Equal("Hello World", PodUtf8Codec.FromFixed256(pod.Title));
        Assert.Equal("A summary", PodProjector.ReadSlice(pod.Summary, payload.Span));
        Assert.Equal((byte)0, pod.IsDeleted);
        Assert.Equal((byte)1, pod.HasIsDeleted); // isDeleted was non-null
    }

    [Fact]
    public void ProjectArticleList_IsDeleted_True_SetsByte()
    {
        var pod = PodProjector.ProjectArticleList(
            1, 0, DateTime.UtcNow, 1, "C", "T", null, isDeleted: true, out _);

        Assert.Equal((byte)1, pod.IsDeleted);
        Assert.Equal((byte)1, pod.HasIsDeleted);
    }

    [Fact]
    public void ProjectArticleList_IsDeleted_Null_HasIsDeletedIsZero()
    {
        var pod = PodProjector.ProjectArticleList(
            1, 0, DateTime.UtcNow, 1, "C", "T", null, isDeleted: null, out _);

        Assert.Equal((byte)0, pod.IsDeleted);
        Assert.Equal((byte)0, pod.HasIsDeleted);
    }

    [Fact]
    public void ProjectArticleList_NullSummary_ReadsAsEmpty()
    {
        var pod = PodProjector.ProjectArticleList(
            1, 0, DateTime.UtcNow, 1, "C", "T", null, isDeleted: null, out var payload);

        Assert.Equal(string.Empty, PodProjector.ReadSlice(pod.Summary, payload.Span));
    }

    [Fact]
    public void ProjectArticleList_CreateTime_EncodesAsUnixMs()
    {
        var createTime = new DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var pod = PodProjector.ProjectArticleList(
            1, 0, createTime, 1, "C", "T", null, null, out _);

        long expected = PodTimeCodec.ToUnixMs(createTime);
        Assert.Equal(expected, pod.CreateTimeUnixMs);
    }

    // ── ProjectArticleDetail ────────────────────────────────────────────────

    [Fact]
    public void ProjectArticleDetail_Fields_AreCorrect()
    {
        var createTime = new DateTime(2024, 3, 10, 8, 0, 0, DateTimeKind.Utc);
        var pod = PodProjector.ProjectArticleDetail(
            id: 99, views: 500, createTime: createTime,
            categoryId: 3, categoryName: "Dev",
            title: "Detail Title",
            content: "Full content here",
            summary: "Short summary",
            payload: out var payload);

        Assert.Equal(99, pod.Id);
        Assert.Equal(500, pod.Views);
        Assert.Equal(3, pod.Category.Id);
        Assert.Equal("Dev", PodUtf8Codec.FromFixed128(pod.Category.Name));
        Assert.Equal("Detail Title", PodUtf8Codec.FromFixed256(pod.Title));
        Assert.Equal("Short summary", PodProjector.ReadSlice(pod.Summary, payload.Span));
        Assert.Equal("Full content here", PodProjector.ReadSlice(pod.Content, payload.Span));
    }

    [Fact]
    public void ProjectArticleDetail_NullSummary_ReadsAsEmpty()
    {
        var pod = PodProjector.ProjectArticleDetail(
            1, 0, DateTime.UtcNow, 1, "C", "T", "content", null, out var payload);

        Assert.Equal(string.Empty, PodProjector.ReadSlice(pod.Summary, payload.Span));
        Assert.Equal("content", PodProjector.ReadSlice(pod.Content, payload.Span));
    }

    // ── ProjectTag ──────────────────────────────────────────────────────────

    [Fact]
    public void ProjectTag_IdAndName_AreCorrect()
    {
        var pod = PodProjector.ProjectTag(id: 5, name: "csharp");

        Assert.Equal(5, pod.Id);
        Assert.Equal("csharp", PodUtf8Codec.FromFixed128(pod.Name));
    }

    [Fact]
    public void ProjectTag_EmptyName_ReadsAsEmpty()
    {
        var pod = PodProjector.ProjectTag(1, string.Empty);

        Assert.Equal(string.Empty, PodUtf8Codec.FromFixed128(pod.Name));
    }

    // ── ProjectPopularArticle ───────────────────────────────────────────────

    [Fact]
    public void ProjectPopularArticle_Fields_AreCorrect()
    {
        var pod = PodProjector.ProjectPopularArticle(id: 10, title: "Top Article", views: 9999);

        Assert.Equal(10, pod.Id);
        Assert.Equal(9999, pod.Views);
        Assert.Equal("Top Article", PodUtf8Codec.FromFixed256(pod.Title));
    }

    // ── ProjectCommentItem ──────────────────────────────────────────────────

    [Fact]
    public void ProjectCommentItem_Fields_AreCorrect()
    {
        var createTime = new DateTime(2024, 5, 20, 0, 0, 0, DateTimeKind.Utc);
        var pod = PodProjector.ProjectCommentItem(
            id: 123L, createTime: createTime,
            authorMode: "public", displayName: "alice", content: "Nice post!",
            payload: out var payload);

        Assert.Equal(123L, pod.Id);
        Assert.Equal(PodTimeCodec.ToUnixMs(createTime), pod.CreateTimeUnixMs);
        Assert.Equal("Nice post!", PodProjector.ReadSlice(pod.Content, payload.Span));
    }

    [Fact]
    public void ProjectCommentItem_ExposesOnlySixParameterOverload()
    {
        var overloads = typeof(PodProjector)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(static method => method.Name == nameof(PodProjector.ProjectCommentItem))
            .Select(static method => method.GetParameters().Select(static parameter => parameter.ParameterType).ToArray())
            .ToArray();

        Type[] parameters = Assert.Single(overloads);
        Assert.Equal(
            [
                typeof(long),
                typeof(DateTime),
                typeof(string),
                typeof(string),
                typeof(string),
                typeof(ReadOnlyMemory<byte>).MakeByRefType()
            ],
            parameters);
    }

    // ── ProjectUserComment ──────────────────────────────────────────────────

    [Fact]
    public void ProjectUserComment_Fields_AreCorrect()
    {
        var createTime = new DateTime(2024, 7, 1, 0, 0, 0, DateTimeKind.Utc);
        var pod = PodProjector.ProjectUserComment(
            id: 77L, articleId: 9, createTime: createTime,
            content: "My comment",
            articleTitle: "Article Title",
            rootId: 50L,
            moderationStatus: 0,
            moderationStatusLabel: "待审核，仅自己可见",
            visibilityState: "pending",
            visibilityReasonCode: "pending_review",
            isPubliclyVisible: false,
            payload: out var payload);

        Assert.Equal(77L, pod.Id);
        Assert.Equal(9, pod.ArticleId);
        Assert.Equal(50L, pod.RootId);
        Assert.Equal("My comment", PodProjector.ReadSlice(pod.Content, payload.Span));
        Assert.Equal("Article Title", PodUtf8Codec.FromFixed256(pod.ArticleTitle));
        Assert.Equal(0, pod.ModerationStatus);
        Assert.Equal((byte)0, pod.IsPubliclyVisible);
        Assert.Equal("pending", PodUtf8Codec.FromFixed32(pod.VisibilityState));
        Assert.Equal("pending_review", PodUtf8Codec.FromFixed64(pod.VisibilityReasonCode));
        Assert.Equal("待审核，仅自己可见", PodUtf8Codec.FromFixed64(pod.ModerationStatusLabel));
    }

    [Fact]
    public void ProjectUserComment_NullRootId_BecomesZero()
    {
        var pod = PodProjector.ProjectUserComment(
            1L, 1, DateTime.UtcNow, "c", "t", rootId: null,
            moderationStatus: 1,
            moderationStatusLabel: "已公开",
            visibilityState: "public",
            visibilityReasonCode: "approved_public",
            isPubliclyVisible: true,
            out _);

        Assert.Equal(0L, pod.RootId);
        Assert.Equal((byte)1, pod.IsPubliclyVisible);
    }

    // ── ProjectCommentThreadItem ────────────────────────────────────────────

    [Fact]
    public void ProjectCommentThreadItem_IsDeleted_True()
    {
        var createTime = new DateTime(2024, 8, 1, 0, 0, 0, DateTimeKind.Utc);
        var pod = PodProjector.ProjectCommentThreadItem(
            id: 1L, rootId: 2L, isDeleted: true,
            createTime: createTime, authorMode: "public", displayName: "charlie",
            content: "deleted comment",
            replyCount: 5, hasMoreReplies: true, previewReplyCount: 3,
            payload: out var payload);

        Assert.Equal(1L, pod.Id);
        Assert.Equal(2L, pod.RootId);
        Assert.Equal((byte)1, pod.IsDeleted);
        Assert.Equal((byte)1, pod.HasMoreReplies);
        Assert.Equal((byte)3, pod.PreviewReplyCount);
        Assert.Equal(5, pod.ReplyCount);
        Assert.Equal("deleted comment", PodProjector.ReadSlice(pod.Content, payload.Span));
    }

    [Fact]
    public void ProjectCommentThreadItem_IsDeleted_False()
    {
        var pod = PodProjector.ProjectCommentThreadItem(
            1L, 2L, isDeleted: false,
            DateTime.UtcNow, "public", "user", "content",
            replyCount: 0, hasMoreReplies: false, previewReplyCount: 0, out _);

        Assert.Equal((byte)0, pod.IsDeleted);
        Assert.Equal((byte)0, pod.HasMoreReplies);
    }

    [Fact]
    public void ProjectCommentThreadItem_PreviewReplyCount_ClampedAt255()
    {
        var pod = PodProjector.ProjectCommentThreadItem(
            1L, 1L, false, DateTime.UtcNow, "public", "u", "c",
            0, false, previewReplyCount: 999, out _);

        Assert.Equal((byte)255, pod.PreviewReplyCount);
    }

    // ── ProjectCommentReplyItem ─────────────────────────────────────────────

    [Fact]
    public void ProjectCommentReplyItem_Fields_AreCorrect()
    {
        var createTime = new DateTime(2024, 9, 1, 0, 0, 0, DateTimeKind.Utc);
        var pod = PodProjector.ProjectCommentReplyItem(
            id: 200L, parentId: 100L, rootId: 50L,
            replyToUserId: 7, replyToCommentId: 99L,
            depth: 2, isDeleted: false,
            createTime: createTime,
            authorMode: "public",
            displayName: "dave",
            replyToDisplayName: "eve",
            content: "reply text",
            payload: out var payload);

        Assert.Equal(200L, pod.Id);
        Assert.Equal(100L, pod.ParentId);
        Assert.Equal(50L, pod.RootId);
        Assert.Equal(7, pod.ReplyToUserId);
        Assert.Equal(99L, pod.ReplyToCommentId);
        Assert.Equal(2, pod.Depth);
        Assert.Equal((byte)0, pod.IsDeleted);
        Assert.Equal((byte)1, pod.HasReplyToUserId);
        Assert.Equal("reply text", PodProjector.ReadSlice(pod.Content, payload.Span));
    }

    [Fact]
    public void ProjectCommentReplyItem_NullOptionals_ZeroedOut()
    {
        var pod = PodProjector.ProjectCommentReplyItem(
            1L, parentId: null, rootId: 1L,
            replyToUserId: null, replyToCommentId: null,
            depth: 0, isDeleted: false,
            DateTime.UtcNow, "public", "u", replyToDisplayName: null, "c", out _);

        Assert.Equal(0L, pod.ParentId);
        Assert.Equal(0, pod.ReplyToUserId);
        Assert.Equal(0L, pod.ReplyToCommentId);
        Assert.Equal((byte)0, pod.HasReplyToUserId);
    }

    // ── ProjectRecentComment ────────────────────────────────────────────────

    [Fact]
    public void ProjectRecentComment_UsesAuthorSnapshotFields()
    {
        var pod = PodProjector.ProjectRecentComment(
            createTime: DateTime.UtcNow,
            authorDisplayName: "frank public",
            authorMode: "public",
            authorBadge: null,
            authorScopeLabel: null,
            credentialLevel: null,
            content: "recent",
            payload: out var payload);

        Assert.Equal("frank public", PodUtf8Codec.FromFixed64(pod.AuthorDisplayName));
        Assert.Equal("public", PodUtf8Codec.FromFixed32(pod.AuthorMode));
        Assert.Equal("recent", PodProjector.ReadSlice(pod.Content, payload.Span));
    }

    [Fact]
    public void ProjectRecentComment_PreservesAnonymousBadgeFields()
    {
        var pod = PodProjector.ProjectRecentComment(
            createTime: DateTime.UtcNow,
            authorDisplayName: "强匿名评论者",
            authorMode: "zk_anonymous",
            authorBadge: "已验证匿名凭证",
            authorScopeLabel: "article:42",
            credentialLevel: "strong_anonymous",
            content: "anon comment",
            payload: out var payload);

        Assert.Equal("强匿名评论者", PodUtf8Codec.FromFixed64(pod.AuthorDisplayName));
        Assert.Equal("zk_anonymous", PodUtf8Codec.FromFixed32(pod.AuthorMode));
        Assert.Equal("已验证匿名凭证", PodProjector.ReadSlice(pod.AuthorBadge, payload.Span));
        Assert.Equal("article:42", PodProjector.ReadSlice(pod.AuthorScopeLabel, payload.Span));
        Assert.Equal("strong_anonymous", PodProjector.ReadSlice(pod.CredentialLevel, payload.Span));
    }

    // ── ProjectRegionDistribution ───────────────────────────────────────────

    [Fact]
    public void ProjectRegionDistribution_Fields_AreCorrect()
    {
        var pod = PodProjector.ProjectRegionDistribution("China", 500);

        Assert.Equal(500, pod.Count);
        Assert.Equal("China", PodUtf8Codec.FromFixed128(pod.Region));
    }

    // ── ProjectSiteStats ────────────────────────────────────────────────────

    [Fact]
    public void ProjectSiteStats_Fields_AreCorrect()
    {
        var pod = PodProjector.ProjectSiteStats(
            totalArticles: 10, totalComments: 20, trashCount: 2,
            totalReads: 1000, humanVerifiedReads: 980, uniqueViewerKeyEstimate: 240, articleReads: 760, siteReads: 240,
            popularCount: 5, recentCount: 8, regionCount: 3);

        Assert.Equal(10, pod.TotalArticles);
        Assert.Equal(20, pod.TotalComments);
        Assert.Equal(2, pod.TrashCount);
        Assert.Equal(1000, pod.TotalReads);
        Assert.Equal(980, pod.HumanVerifiedReads);
        Assert.Equal(240, pod.UniqueViewerKeyEstimate);
        Assert.Equal(760, pod.ArticleReads);
        Assert.Equal(240, pod.SiteReads);
    }

    // ── ReadSlice overloads ─────────────────────────────────────────────────

    [Fact]
    public void ReadSlice_ByteArrayOverload_SameAsSpan()
    {
        var pod = PodProjector.ProjectCommentItem(1L, DateTime.UtcNow, "public", "u", "hello", out var payload);
        byte[] arr = payload.ToArray();

        string fromSpan = PodProjector.ReadSlice(pod.Content, payload.Span);
        string fromArray = PodProjector.ReadSlice(pod.Content, arr);

        Assert.Equal(fromSpan, fromArray);
        Assert.Equal("hello", fromArray);
    }
}

using System.Runtime.InteropServices;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class CommentTreeContractTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task InvalidTreeCoordinates_ReturnEmptyWithoutDatabaseAccess()
    {
        var service = new CommentQueryService(
            NSubstitute.Substitute.For<SqlSugar.ISqlSugarClient>(),
            new RegionLegalModerationService());
        var request = new FsusBlog.Server.Infrastructure.Pagination.CursorPageRequest<long>(null, null, 20);

        Assert.Empty((await service.GetTreeRootsAsync(0, request)).Data);
        Assert.Empty((await service.GetChildrenAsync(1, 0, request)).Cursor.Data);
        Assert.Equal("unavailable", (await service.GetPermalinkContextAsync(1, 0)).Status);
    }

    [Fact]
    public void RecursiveQueries_PageByDirectParentAndResolveAncestorPath()
    {
        string children = RuntimeMetadataInspection.DescribeDeclaredMethodContaining(
            typeof(CommentQueryService),
            "c.parent_id = @ParentId",
            "ORDER BY c.id");
        string path = RuntimeMetadataInspection.DescribeDeclaredMethodContaining(
            typeof(CommentQueryService),
            "ancestor_path",
            "child.parent_id = parent.id");

        Assert.Contains("c.parent_id = @ParentId", children, StringComparison.Ordinal);
        Assert.Contains("c.id > @Cursor", children, StringComparison.Ordinal);
        Assert.DoesNotContain(" OFFSET ", children, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("ancestor_path", path, StringComparison.Ordinal);
        Assert.Contains("child.parent_id = parent.id", path, StringComparison.Ordinal);
        Assert.Contains("INNER JOIN directly_visible ON directly_visible.id = c.id", path, StringComparison.Ordinal);
        Assert.Contains("NOT parent.id = ANY(child.visited)", path, StringComparison.Ordinal);
        Assert.Contains("cardinality(child.visited) < 257", path, StringComparison.Ordinal);
    }

    [Fact]
    public void TreeWirePods_HaveStablePackedSizes()
    {
        Assert.Equal(60, Marshal.SizeOf<CommentTreeNodePod>());
        Assert.Equal(32, Marshal.SizeOf<CommentChildCursorPod>());
        Assert.Equal(32, Marshal.SizeOf<CommentPermalinkContextPod>());
    }

    [Fact]
    public async Task CommentWrites_EnforceDepthAndPerParentConcurrencyLimits()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(Article), typeof(Comment), typeof(CommentRegionCompliance));
        DateTime createdAt = DateTime.UtcNow.AddMinutes(-1);
        await db.Insertable(new Article
        {
            Id = 42,
            Title = "Comment limits",
            CategoryId = 1,
            Views = 0,
            CreateTime = createdAt,
            Status = ArticleStatus.Published,
            PublishedAt = createdAt
        }).ExecuteCommandAsync();
        await db.Insertable(new[]
        {
            Comment(99, parentId: null, rootId: null, depth: 0),
            Comment(100, parentId: 99, rootId: 99, depth: 2),
            Comment(200, parentId: null, rootId: null, depth: 0),
            Comment(201, parentId: 200, rootId: 200, depth: 1)
        }).ExecuteCommandAsync();
        ICommentAttributionPrivacyService attribution = Substitute.For<ICommentAttributionPrivacyService>();
        attribution.ResolvePublicActorAsync(
                Arg.Any<int>(),
                Arg.Any<CommentDto>(),
                Arg.Any<string>(),
                Arg.Any<string?>(),
                Arg.Any<CancellationToken>())
            .Returns(new CommentActor(
                8,
                CommentAuthorModes.Public,
                "writer",
                null,
                "writer",
                "zh-CN",
                null,
                null,
                "writer-subject",
                "common",
                false));
        ICacheInvalidationDispatcher invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        ICommentNotificationService notifications = Substitute.For<ICommentNotificationService>();
        var service = new CommentCommandService(
            db,
            NullLogger<CommentCommandService>.Instance,
            notifications,
            new CommentModerationService(
                db,
                new RegionLegalModerationService(),
                invalidations,
                notifications,
                NullLogger<CommentModerationService>.Instance),
            attribution,
            invalidations,
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["CommentThreads:MaxDepth"] = "2",
                ["CommentThreads:MaxChildrenPerNode"] = "1"
            }).Build());

        Assert.False(await service.CreateCommentAsync(8, new CommentDto
        {
            ArticleId = 42,
            Content = "too deep",
            ParentId = "100",
            RootId = "99"
        }));
        Assert.False(await service.CreateCommentAsync(8, new CommentDto
        {
            ArticleId = 42,
            Content = "too many children",
            ParentId = "200",
            RootId = "200"
        }));
        Assert.Equal(4, await db.Queryable<Comment>().CountAsync());

        string runtime = RuntimeMetadataInspection.DescribeType(typeof(CommentCommandService));
        Assert.Contains("pg_advisory_xact_lock(@ParentId)", runtime, StringComparison.Ordinal);
        Assert.Contains("comment_thread_depth_limit", runtime, StringComparison.Ordinal);
        Assert.Contains("comment_child_limit", runtime, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RealtimeDepth_RemainsServerAuthoritative()
    {
        IMessageRealtimePublisher realtime = Substitute.For<IMessageRealtimePublisher>();
        var notifications = new CommentNotificationService(
            realtime,
            Substitute.For<IMessageCommandService>(),
            NullLogger<CommentNotificationService>.Instance);
        var comment = Comment(901, parentId: 900, rootId: 800, depth: 9);

        await notifications.PublishAddedAsync(comment, DateTime.UtcNow);

        await realtime.Received(1).PushCommentAddAsync(
            Arg.Is<CommentAddedNotifyDto>(notification => notification.Comment.Depth == 9),
            Arg.Any<string?>());
        string moderationRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringModerationWorkflowService),
            "PublishModerationRealtimeAsync");
        Assert.Contains("Math.Max", moderationRuntime, StringComparison.Ordinal);
    }

    private static Comment Comment(long id, long? parentId, long? rootId, int depth)
        => new()
        {
            Id = id,
            ArticleId = 42,
            UserId = 7,
            AuthorMode = CommentAuthorModes.Public,
            PublicHandle = "target",
            Content = $"comment {id}",
            CreateTime = DateTime.UtcNow.AddMinutes(-1),
            ParentId = parentId,
            RootId = rootId,
            Depth = depth,
            ModerationStatus = CommentModerationStatus.Approved
        };
}

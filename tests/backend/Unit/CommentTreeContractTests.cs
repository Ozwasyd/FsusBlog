using System.Runtime.InteropServices;

using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Shared.Contracts.Models;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentTreeContractTests
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
    public void CommentWrites_EnforceDepthAndPerParentConcurrencyLimits()
    {
        string source = File.ReadAllText(BackendTestPaths.FromRoot("src/backend/Services/CommentService.cs"));

        Assert.Contains("CommentThreads:MaxDepth", source, StringComparison.Ordinal);
        Assert.Contains("CommentThreads:MaxChildrenPerNode", source, StringComparison.Ordinal);
        Assert.Contains("pg_advisory_xact_lock(@ParentId)", source, StringComparison.Ordinal);
        Assert.Contains("comment.ParentId == parentId", source, StringComparison.Ordinal);
        Assert.Contains("comment_thread_depth_limit", source, StringComparison.Ordinal);
        Assert.Contains("comment_child_limit", source, StringComparison.Ordinal);

        string endpoint = File.ReadAllText(BackendTestPaths.FromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs"));
        Assert.Contains("ErrorCode.Conflict", endpoint, StringComparison.Ordinal);
        Assert.Contains("result.FailureCode ?? fallbackMessage", endpoint, StringComparison.Ordinal);
    }

    [Fact]
    public void RealtimeDepth_RemainsServerAuthoritative()
    {
        string direct = File.ReadAllText(BackendTestPaths.FromRoot("src/backend/Services/CommentNotificationService.cs"));
        string moderation = File.ReadAllText(BackendTestPaths.FromRoot("src/backend/Services/Authoring/AuthoringModerationWorkflowService.cs"));

        Assert.DoesNotContain("Math.Clamp(comment.Depth, 0, 2)", direct, StringComparison.Ordinal);
        Assert.DoesNotContain("Math.Min(2, Math.Max(0, row.Depth))", moderation, StringComparison.Ordinal);
        Assert.Contains("Depth = Math.Max(0, comment.Depth)", direct, StringComparison.Ordinal);
        Assert.Contains("Depth = Math.Max(0, row.Depth)", moderation, StringComparison.Ordinal);
    }
}

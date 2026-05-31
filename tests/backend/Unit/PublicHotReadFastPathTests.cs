using System.Collections.Frozen;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotReadFastPathTests
{
    [Fact]
    public async Task TryServeAsync_DetailHit_WritesPreencodedFrameWithoutNext()
    {
        byte[] frame = [0x41, 0x45, 0x44, 0x53, 2, 16];
        var store = new PublicHotReadStore();
        var articles = new ReadOnlyMemory<byte>[43];
        articles[42] = frame;
        store.Publish(new PublicHotReadSnapshot(
            1,
            articles,
            FrozenDictionary<PublicListKey, ReadOnlyMemory<byte>>.Empty,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty));
        var context = CreateContext("/api/binary/article/42.aeds");
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);
        Assert.Equal(frame.Length, context.Response.ContentLength);
        Assert.Equal("2", context.Response.Headers["X-Fsus-Frame-Version"]);
        Assert.Equal(frame, ((MemoryStream)context.Response.Body).ToArray());
    }

    [Fact]
    public async Task TryServeAsync_PublicQueryPath_IsRejectedBeforeNormalPipeline()
    {
        var context = CreateContext("/api/binary/article");
        context.Request.QueryString = new QueryString("?page=1&size=10");
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            new PublicHotReadStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
    }

    [Fact]
    public async Task TryServeAsync_AdminRoute_PassesThroughToNormalPipeline()
    {
        var context = CreateContext("/api/binary/admin/article/42");
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            new PublicHotReadStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.True(nextCalled);
    }

    [Fact]
    public void TryMatchArticleList_ParsesSegmentRoutes()
    {
        Assert.True(PublicHotReadFastPath.TryMatchArticleList("/api/binary/article/list/home/1/10.aeds", out PublicListKey home));
        Assert.Equal(new PublicListKey(PublicListKind.Home, 0, 1, 10), home);

        Assert.True(PublicHotReadFastPath.TryMatchArticleList("/api/binary/article/list/category/7/1/5.aeds", out PublicListKey category));
        Assert.Equal(new PublicListKey(PublicListKind.Category, 7, 1, 5), category);

        Assert.True(PublicHotReadFastPath.TryMatchArticleHot("/api/binary/article/hot/10.aeds", out PublicListKey hot));
        Assert.Equal(new PublicListKey(PublicListKind.Hot, 0, 1, 10), hot);
    }

    [Fact]
    public void FastPathSource_DoesNotReferenceRequestScopedOrIoHotPathDependencies()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs"));
        string fastPathSource = source[
            source.IndexOf("public static class PublicHotReadFastPath", StringComparison.Ordinal)
            ..source.IndexOf("public readonly record struct PublicHotReadCounterSnapshot", StringComparison.Ordinal)];

        Assert.DoesNotContain("RequestServices", fastPathSource, StringComparison.Ordinal);
        Assert.DoesNotContain("File.", fastPathSource, StringComparison.Ordinal);
        Assert.DoesNotContain("IConnectionMultiplexer", fastPathSource, StringComparison.Ordinal);
        Assert.DoesNotContain("IMemoryCache", fastPathSource, StringComparison.Ordinal);
        Assert.DoesNotContain("Activity", fastPathSource, StringComparison.Ordinal);
        Assert.DoesNotContain("ILogger", fastPathSource, StringComparison.Ordinal);
        Assert.DoesNotContain("IAedsEncoder", fastPathSource, StringComparison.Ordinal);
        Assert.DoesNotContain("BinaryResults", fastPathSource, StringComparison.Ordinal);
    }

    private static DefaultHttpContext CreateContext(string path)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = path;
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static string FindRepoRoot()
    {
        DirectoryInfo? current = new(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "FsusBlog.slnx")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException("repo root not found");
    }
}

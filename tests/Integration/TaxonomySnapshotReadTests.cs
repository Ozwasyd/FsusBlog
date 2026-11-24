using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.V2.Integration.Tests;

public sealed class TaxonomySnapshotReadTests
{
    [Fact]
    public async Task FilteredListsRejectAnInvalidatedSnapshotAfterReadingTheirQuery()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var ct = deadline.Token;
        var now = DateTimeOffset.UnixEpoch.AddDays(1);
        var article = new Article(1, 1, 1, 1, 1, "Withdrawn article", "Public body", now, now, now,
            Category: new(1, "Category"), Tags: [new(2, "Tag")]);
        var taxonomy = new TaxonomyRows([new(1, "Category", null)], [new(2, "Tag", null)], []);
        var pages = new WebPages("<!--fsus-public-content-->");
        var cursor = new PublicListCursor(TimeProvider.System);
        PublicSnapshot Published(long watermark, params Article[] articles) => new(watermark, articles, taxonomy, pages,
            cursor, null, NullLogger.Instance, null, null, ct);
        var original = Published(1, article);
        var replacement = Published(2);
        var current = original;
        var switchAfterCapture = 0;

        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddRateLimiter(options => options.AddConcurrencyLimiter("query", limiter => limiter.PermitLimit = 1));
        builder.Services.AddSingleton<Store>(_ => throw new InvalidOperationException("Read route expected."));
        await using var app = builder.Build();
        app.Use(async (ctx, next) =>
        {
            try { await next(ctx); }
            catch (PublicUnavailableException) { ctx.Response.StatusCode = StatusCodes.Status503ServiceUnavailable; }
        });
        app.UseRateLimiter();
        TaxonomyEndpoints.Map(app, ctx =>
        {
            var snapshot = Volatile.Read(ref current);
            ctx.Response.Headers.CacheControl = "no-store";
            ctx.Response.Headers[WireHeaders.SearchIndexGeneration] = snapshot.GenerationHeader;
            return snapshot;
        }, (ctx, snapshot) =>
        {
            if (ReferenceEquals(snapshot, Volatile.Read(ref current))) return;
            ctx.Response.Headers.Remove(WireHeaders.SearchIndexGeneration);
            throw new PublicUnavailableException();
        }, (_, _, _) =>
        {
            // This callback runs after the endpoint captured the original snapshot.
            if (Interlocked.Exchange(ref switchAfterCapture, 0) == 1) Volatile.Write(ref current, replacement);
            return null;
        }, _ => null, "unused-test-cookie", (_, _, _) => throw new InvalidOperationException("Read route expected."));
        await app.StartAsync(ct);
        using var client = new HttpClient { BaseAddress = new Uri(Assert.Single(app.Urls)) };

        foreach (var path in new[] { "/api/binary/article/list/category/1/1/10.aeds", "/api/binary/article/list/tag/2/1/10.aeds" })
        {
            Volatile.Write(ref current, original);
            using (var visible = await client.GetAsync(path, ct))
            {
                Assert.Equal(HttpStatusCode.OK, visible.StatusCode);
                Assert.Equal(original.GenerationHeader, Assert.Single(visible.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
                Assert.True(visible.Headers.CacheControl?.NoStore);
                Assert.Equal(1, Count(await visible.Content.ReadAsByteArrayAsync(ct)));
            }

            Volatile.Write(ref switchAfterCapture, 1);
            using (var withdrawn = await client.GetAsync(path, ct))
            {
                Assert.Equal(HttpStatusCode.ServiceUnavailable, withdrawn.StatusCode);
                Assert.False(withdrawn.Headers.Contains(WireHeaders.SearchIndexGeneration));
                Assert.True(withdrawn.Headers.CacheControl?.NoStore);
                Assert.Empty(await withdrawn.Content.ReadAsByteArrayAsync(ct));
            }

            using var retry = await client.GetAsync(path, ct);
            Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
            Assert.Equal(replacement.GenerationHeader, Assert.Single(retry.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
            Assert.Equal(0, Count(await retry.Content.ReadAsByteArrayAsync(ct)));
        }
    }

    private static int Count(byte[] packet) => BinaryPrimitives.ReadInt32LittleEndian(
        Aeds.Decode(packet, FrameType.ArticleList)[WireLayouts.ArticleListTotalOffset..]);
}

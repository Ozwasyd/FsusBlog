using static FsusBlog.V2.Integration.Tests.RuntimeEvidenceFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicHotArticlePostgresTests
{
    [PostgresFact]
    public async Task RankedBytesUseOnlyCurrentPublicArticlesAndReadWithoutDatabaseWork()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (_, token, _) = await fixture.SignIn("Ranking author", ct, minutes: 1);
        var route = WireRoutes.PublicArticleHot.Replace("{size}", "10");
        await using (var disabled = await ServerProcess.Start(fixture.ConnectionString, ct,
            new Dictionary<string, string> { [PublicHotArticles.Setting] = "false" }))
            await CheckStatusAsync(NotFound, disabled.Client.GetAsync(route, ct));

        using (var evidence = new RuntimeEvidenceFixture("fsusv2-hot-"))
        {
            await using var server = await evidence.Start(fixture.ConnectionString, ct,
                new Dictionary<string, string> { [PublicHotArticles.Setting] = "true" });
            var first = await Publish("First public article");
            var second = await Publish("Second public article");
            var hidden = await Command(WireRoutes.Save, 0, 0, "Private high-count article");
            await fixture.Exec("update public.article_read_epoch set last_epoch=0 where singleton");
            await fixture.Exec("insert into public.article_read_total(article_id,views) values($1,9),($2,9),($3,500)",
                first.Id, second.Id, hidden.Id);
            await fixture.Exec("""
                insert into public.article_read_hour(article_id,hour_utc,count)
                select article_id,timestamptz '2025-01-01 UTC',views from public.article_read_total
                """);
            var zero = await Publish("Third public article");
            var ranked = await RankingOf(3);
            Assert.Equal(new ArticleHotItem[] { new(second.Id, 9, second.Title), new(first.Id, 9, first.Title), new(zero.Id, 0, zero.Title) }, ranked.Items);

            var before = await evidence.Mark("measure-before", ct);
            using var bytes = Ok(await server.Client.GetAsync(route, ct));
            Assert.Equal(ranked.Tag, bytes.Headers.ETag?.ToString());
            using var request = new HttpRequestMessage(HttpMethod.Head, route + "?generation=" + ranked.Generation);
            using var head = Expect(NoContent, await server.Client.SendAsync(request, ct));
            Assert.Equal(ranked.Tag, head.Headers.ETag?.ToString());
            Assert.Empty(await head.Content.ReadAsByteArrayAsync(ct));
            var after = await evidence.Mark("measure-after", ct);
            Assert.Equal((1L, Count(before, "dbCommandStarts"), Count(before, "dbPhysicalOpenStarts")),
                (Count(after, "requestStatus200") - Count(before, "requestStatus200"), Count(after, "dbCommandStarts"), Count(after, "dbPhysicalOpenStarts")));

            await Command(WireRoutes.Retract, second.Id, second.Revision);
            Aeds.Decode(await ExpectBytes(Conflict, server.Client.GetAsync(route + "?generation=" + ranked.Generation, ct), ct), FrameType.ApiError);
            var current = await RankingOf(2);
            Assert.NotEqual(ranked.Generation, current.Generation);
            Assert.NotEqual(ranked.Tag, current.Tag);
            Assert.Equal([first.Id, zero.Id], current.Items.Select(item => item.Id));
            await CheckStatusAsync(NotFound, server.Client.GetAsync(WireRoutes.PublicArticleHot.Replace("{size}", "101"), ct));

            async Task<(IReadOnlyList<ArticleHotItem> Items, string Generation, string Tag)> RankingOf(int count)
            {
                while (true)
                {
                    using var response = await server.Client.GetAsync(route, ct);
                    if (response.StatusCode == ServiceUnavailable) { await Task.Delay(30, ct); continue; }
                    Assert.Equal(OK, response.StatusCode);
                    Assert.True(response.Headers.CacheControl?.NoStore);
                    var frame = await response.Content.ReadAsByteArrayAsync(ct);
                    var tag = $"\"{Convert.ToHexStringLower(SHA256.HashData(frame))}\"";
                    Assert.Equal(tag, response.Headers.ETag?.ToString());
                    var items = ArticleHotWire.Decode(frame);
                    Assert.Equal(count, items.Length);
                    return (items, Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration)), tag);
                }
            }

            async Task<Draft> Publish(string title)
            {
                var draft = await Command(WireRoutes.Save, 0, 0, title);
                return await Command(WireRoutes.Publish, draft.Id, draft.Revision);
            }

            Task<Draft> Command(string path, int id, long revision, string title = "") =>
                SiteAedsFixture.ArticleCommand(server.Client, path, token, null, new(id, revision, Guid.NewGuid(), title, title.Length == 0 ? "" : "body"), ct);
        }
    }
}

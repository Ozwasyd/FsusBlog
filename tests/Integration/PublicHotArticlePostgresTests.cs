using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Analytics;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicHotArticlePostgresTests
{
    [PostgresFact]
    public async Task RankedBytesUseOnlyCurrentPublicArticlesAndReadWithoutDatabaseWork()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (author, token, _) = await fixture.SignIn("Ranking author", ct, minutes: 1);
        var route = WireRoutes.PublicArticleHot.Replace("{size}", "10");
        await using (var disabled = await ServerProcess.Start(fixture.ConnectionString, ct,
            new Dictionary<string, string> { [PublicHotArticles.Setting] = "false" }))
        {
            using var response = await disabled.Client.GetAsync(route, ct);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        }

        var evidence = Directory.CreateTempSubdirectory("fsusv2-hot-");
        try
        {
            var output = Path.Combine(evidence.FullName, "runtime.ndjson");
            await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
            {
                [PublicHotArticles.Setting] = "true",
                ["FSUSBLOG_RUNTIME_EVIDENCE_CONTROL"] = evidence.FullName,
                ["FSUSBLOG_RUNTIME_EVIDENCE_OUTPUT"] = output
            });
            var first = await Publish("First public article");
            var second = await Publish("Second public article");
            var hidden = await Command(WireRoutes.Save, 0, 0, "Private high-count article");
            await Sql("update public.article_read_epoch set last_epoch=0 where singleton");
            await Sql("insert into public.article_read_total(article_id,views) values($1,9),($2,9),($3,500)",
                first.Id, second.Id, hidden.Id);
            await Sql("""
                insert into public.article_read_hour(article_id,hour_utc,count)
                select article_id,timestamptz '2025-01-01 UTC',views from public.article_read_total
                """);
            var zero = await Publish("Third public article");
            var ranked = await RankingOf(3);
            Assert.Equal(new ArticleHotItem[] { new(second.Id, 9, second.Title), new(first.Id, 9, first.Title),
                new(zero.Id, 0, zero.Title) }, ranked.Items);

            var before = await Mark("measure-before");
            using var bytes = await server.Client.GetAsync(route, ct);
            Assert.Equal(HttpStatusCode.OK, bytes.StatusCode);
            Assert.Equal(ranked.Tag, bytes.Headers.ETag?.ToString());
            using var request = new HttpRequestMessage(HttpMethod.Head, route + "?generation=" + ranked.Generation);
            using var head = await server.Client.SendAsync(request, ct);
            Assert.Equal(HttpStatusCode.NoContent, head.StatusCode);
            Assert.Equal(ranked.Tag, head.Headers.ETag?.ToString());
            Assert.Empty(await head.Content.ReadAsByteArrayAsync(ct));
            var after = await Mark("measure-after");
            Assert.Equal(1, Count(after, "requestStatus200") - Count(before, "requestStatus200"));
            Assert.Equal(Count(before, "dbCommandStarts"), Count(after, "dbCommandStarts"));
            Assert.Equal(Count(before, "dbPhysicalOpenStarts"), Count(after, "dbPhysicalOpenStarts"));

            await Command(WireRoutes.Retract, second.Id, second.Revision);
            using var stale = await server.Client.GetAsync(route + "?generation=" + ranked.Generation, ct);
            Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
            Aeds.Decode(await stale.Content.ReadAsByteArrayAsync(ct), FrameType.ApiError);
            var current = await RankingOf(2);
            Assert.NotEqual(ranked.Generation, current.Generation);
            Assert.NotEqual(ranked.Tag, current.Tag);
            Assert.Equal([first.Id, zero.Id], current.Items.Select(item => item.Id));
            using var oversized = await server.Client.GetAsync(WireRoutes.PublicArticleHot.Replace("{size}", "101"), ct);
            Assert.Equal(HttpStatusCode.NotFound, oversized.StatusCode);

            async Task<(IReadOnlyList<ArticleHotItem> Items, string Generation, string Tag)> RankingOf(int count)
            {
                while (true)
                {
                    using var response = await server.Client.GetAsync(route, ct);
                    if (response.StatusCode == HttpStatusCode.ServiceUnavailable)
                    {
                        await Task.Delay(30, ct);
                        continue;
                    }
                    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
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

            async Task<Draft> Command(string path, int id, long revision, string title = "")
            {
                var data = Wire.EncodeArticleCommand(new(id, revision, Guid.NewGuid(), title, title.Length == 0 ? "" : "body"));
                using var request = SiteAedsFixture.Request(HttpMethod.Post, path, data, token, handle: null);
                using var response = await server.Client.SendAsync(request, ct);
                response.EnsureSuccessStatusCode();
                return Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
            }

            async Task<JsonElement> Mark(string name)
            {
                var request = Path.Combine(evidence.FullName, "runtime.mark");
                var staging = Path.Combine(evidence.FullName, "staging");
                await File.WriteAllTextAsync(staging, name, ct);
                File.Move(staging, request);
                while (!File.Exists(Path.Combine(evidence.FullName, name + ".ack"))) await Task.Delay(20, ct);
                foreach (var line in await File.ReadAllLinesAsync(output, ct))
                {
                    using var row = JsonDocument.Parse(line);
                    if (row.RootElement.GetProperty("mark").GetString() == name) return row.RootElement.Clone();
                }
                throw new InvalidOperationException("A runtime mark acknowledgement has no matching observation.");
            }
        }
        finally
        {
            evidence.Delete(recursive: true);
        }

        Task Sql(string statement, params object[] values) =>
            FixtureSql.ExecuteAsync(db, null, ct, statement, values);
    }

    private static long Count(JsonElement observation, string name) =>
        observation.GetProperty(name).GetProperty("otherHttp").GetInt64();
}

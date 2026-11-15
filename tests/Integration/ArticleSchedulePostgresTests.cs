using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Xml.Linq;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Content;
using Npgsql;

public sealed class ArticleSchedulePostgresTests
{
    private const string PublicOrigin = "https://schedule.example.test";
    private static readonly XNamespace Atom = "http://www.w3.org/2005/Atom";
    private static readonly XNamespace Sitemap = "http://www.sitemaps.org/schemas/sitemap/0.9";

    [PostgresFact]
    public async Task ScheduledDraftKeepsItsPublicPredecessorAndConsumesOnlyItsExactDueCommand()
    {
        using var stop = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = stop.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (author, token, _) = await fixture.SignIn("Scheduled author", ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct,
            new Dictionary<string, string> { [PublicSiteConfiguration.OriginKey] = PublicOrigin });
        var first = await Write(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Original", "original body"));
        var published = await Write(WireRoutes.Publish, new(first.Id, first.Revision, Guid.NewGuid(), "", ""));
        var original = await ReadPublication(first.Id);
        var articleUrl = $"{PublicOrigin}/article/{first.Id}";
        var originalGeneration = await WaitForPublication(first.Id, original);
        var originalFeeds = await ReadFeeds(originalGeneration);
        VerifyFeedContent(originalFeeds, first.Id, articleUrl, original, "Original", "original body");
        var draft = await Write(WireRoutes.Save, new(first.Id, published.Revision, Guid.NewGuid(), "Replacement", "replacement body"));
        var dbNow = await Scalar<DateTime>("select clock_timestamp()");
        var future = new DateTimeOffset(dbNow).AddHours(1).ToUnixTimeMilliseconds();
        var past = new DateTimeOffset(dbNow).AddSeconds(-1).ToUnixTimeMilliseconds();
        var intent = new ArticleScheduleCommand(draft.Id, draft.Revision, Guid.NewGuid(), future);
        await Submit(intent with { DueUnixMs = past }, HttpStatusCode.BadRequest);
        var duplicates = await Task.WhenAll(Submit(intent), Submit(intent));
        Assert.Equal(duplicates[0], duplicates[1]);
        var pending = Wire.DecodeArticleSchedule(duplicates[0]);
        Assert.Equal((draft.Revision + 1, published.Revision, future), (pending.Revision, pending.PublishedRevision, pending.DueUnixMs));
        Assert.Equal(pending, await Read(draft.Id, pending.Revision));
        Assert.Contains("original body", await server.Client.GetStringAsync($"/article/{draft.Id}", ct));
        await Submit(intent with { DueUnixMs = future + 10 }, HttpStatusCode.Conflict);
        await Submit(intent with { IdempotencyKey = Guid.NewGuid() }, HttpStatusCode.Conflict);
        Assert.Equal(0, await Tick(future - 1));
        Assert.Equal(1L, await Scalar<long>("select count(*) from public.article_publication_canonical where article_id=$1", draft.Id));
        Assert.Equal(originalFeeds, await ReadFeeds(originalGeneration));

        var newDue = future + 10_000;
        var replaced = Wire.DecodeArticleSchedule(await Submit(new(draft.Id, pending.Revision, Guid.NewGuid(), newDue)));
        Assert.Equal(0, await Tick(future));
        var cancelled = Wire.DecodeArticleSchedule(await Submit(new(draft.Id, replaced.Revision, Guid.NewGuid(), 0)));
        Assert.Equal(0L, cancelled.DueUnixMs);
        Assert.Equal(0, await Tick(newDue));
        Assert.Equal(originalFeeds, await ReadFeeds(originalGeneration));
        var obsolete = Wire.DecodeArticleSchedule(await Submit(new(draft.Id, cancelled.Revision, Guid.NewGuid(), newDue)));
        var modified = await Write(WireRoutes.Save, new(draft.Id, obsolete.Revision, Guid.NewGuid(), "Replacement", "replacement body"));
        Assert.Equal(0L, (await Read(draft.Id, modified.Revision)).DueUnixMs);
        Assert.Equal(0, await Tick(newDue));
        Assert.Equal(originalFeeds, await ReadFeeds(originalGeneration));
        var finalCommand = new ArticleScheduleCommand(draft.Id, modified.Revision, Guid.NewGuid(), newDue);
        var final = Wire.DecodeArticleSchedule(await Submit(finalCommand));

        // Existing account lock order means a due pass can skip a concurrent account update without deadlocking.
        await using (var account = await db.BeginTransactionAsync(ct))
        {
            await FixtureSql.ScalarAsync(db, account, ct, "select id from public.blog_user where id=$1 for update", author);
            Assert.Equal(0, await Tick(newDue));
            await account.RollbackAsync(ct);
        }

        await Execute("alter table public.blog_outbox add constraint forced_scheduler_failure check (kind <> 'publish') not valid");
        await Assert.ThrowsAsync<PostgresException>(() => Tick(newDue));
        Assert.Equal(final, await Read(draft.Id, final.Revision));
        Assert.Equal(original.Id, await Scalar<long>("select publication_id from public.article_publication where article_id=$1", draft.Id));
        Assert.Equal(1L, await Scalar<long>("select count(*) from public.article_publication_history where article_id=$1", draft.Id));
        Assert.Equal(originalGeneration, await WaitForPublication(draft.Id, original));
        Assert.Equal(originalFeeds, await ReadFeeds(originalGeneration));
        await Execute("alter table public.blog_outbox drop constraint forced_scheduler_failure");

        var batch = await Task.WhenAll(Tick(newDue), Tick(newDue));
        Assert.Equal(new[] { 0, 1 }, batch.Order());
        Assert.Equal(final.Revision, await Scalar<long>("select revision from public.article_publication where article_id=$1", draft.Id));
        Assert.Equal(final.Revision, await Scalar<long>("select revision from public.article where id=$1", draft.Id));
        Assert.Equal(original.Id, await Scalar<long>("select supersedes_id from public.article_publication_history where article_id=$1 and event_no=2", draft.Id));
        Assert.Equal("scheduled-replaced", await Scalar<string>("select reason from public.article_publication_history where article_id=$1 and event_no=2", draft.Id));
        Assert.Equal(finalCommand.IdempotencyKey, await Scalar<Guid>("select command_id from public.article_publication_history where article_id=$1 and event_no=2", draft.Id));
        Assert.Equal(1L, await Scalar<long>("""
            select count(*) from public.article_publication_canonical c
            join public.article_publication p on p.publication_id=c.publication_id and p.published_at=c.published_at
            join public.blog_outbox o on o.id=c.outbox_id and o.kind='publish' and o.revision=p.revision
            where c.article_id=$1 and c.revision=$2 and c.transition='replace'
            """, draft.Id, final.Revision));
        var promoted = await ReadPublication(first.Id);
        Assert.Equal(final.Revision, promoted.Revision);
        Assert.NotEqual(original.Id, promoted.Id);
        Assert.Equal(original.Number + 1, promoted.Number);
        var promotedGeneration = await WaitForPublication(first.Id, promoted);
        Assert.NotEqual(originalGeneration, promotedGeneration);
        var promotedFeeds = await ReadFeeds(promotedGeneration);
        VerifyFeedContent(promotedFeeds, first.Id, articleUrl, promoted, "Replacement", "replacement body");
        Assert.True(await Scalar<bool>("select processed_at is not null from public.blog_outbox where id=$1", promoted.OutboxId));
        Assert.Equal(0, await Tick(newDue + 1));
        Assert.Equal(0L, (await Read(draft.Id, final.Revision)).DueUnixMs);
        Assert.Equal(final, Wire.DecodeArticleSchedule(await Submit(finalCommand)));
        await Submit(new(draft.Id, final.Revision, Guid.NewGuid(), 0), HttpStatusCode.Conflict);
        Assert.Equal(promotedFeeds, await ReadFeeds(promotedGeneration));
        Assert.Equal(1L, await Scalar<long>("""
            select count(*) from public.blog_outbox where article_id=$1 and revision=$2 and kind='publish'
            """, draft.Id, final.Revision));

        var neverPublic = await Write(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Never public", "private"));
        await Submit(new(neverPublic.Id, neverPublic.Revision, Guid.NewGuid(), newDue));
        await Execute("update public.blog_user set generation=generation+1 where id=$1", author);
        Assert.Equal(0, await Tick(newDue));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_schedule where article_id=$1", neverPublic.Id));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_publication where article_id=$1", neverPublic.Id));

        token = (await fixture.SignIn(author, ct)).Token;
        var workerDraft = await Write(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Real worker", "real worker body"));
        var realDue = new DateTimeOffset(await Scalar<DateTime>("select clock_timestamp()")).AddSeconds(4).ToUnixTimeMilliseconds();
        var workerReceipt = Wire.DecodeArticleSchedule(await Submit(new(workerDraft.Id, workerDraft.Revision, Guid.NewGuid(), realDue)));
        using (var hidden = await server.Client.GetAsync($"/article/{workerDraft.Id}", ct))
            Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
        using (var hidden = await server.Client.GetAsync(ArticleRoute(workerDraft.Id), ct))
            Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
        Assert.Equal(promotedFeeds, await ReadFeeds(promotedGeneration));
        using (var timer = new CancellationTokenSource(TimeSpan.FromSeconds(12)))
        {
            while (true)
            {
                using var response = await server.Client.GetAsync($"/article/{workerDraft.Id}", timer.Token);
                if (response.StatusCode == HttpStatusCode.OK)
                {
                    Assert.Contains("real worker body", await response.Content.ReadAsStringAsync(timer.Token));
                    break;
                }
                Assert.True(response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.ServiceUnavailable);
                await Task.Delay(50, timer.Token);
            }
        }
        Assert.Equal(workerReceipt.Revision,
            await Scalar<long>("select revision from public.article_publication where article_id=$1", workerDraft.Id));
        Assert.Equal("scheduled-published", await Scalar<string>("select reason from public.article_publication_history where article_id=$1",
            workerDraft.Id));
        var workerPublication = await ReadPublication(workerDraft.Id);
        var workerGeneration = await WaitForPublication(workerDraft.Id, workerPublication);
        Assert.NotEqual(promotedGeneration, workerGeneration);
        VerifyFeedContent(await ReadFeeds(workerGeneration), workerDraft.Id, $"{PublicOrigin}/article/{workerDraft.Id}",
            workerPublication, "Real worker", "real worker body", expectedCount: 2);

        async Task<FeedPublication> ReadPublication(int id)
        {
            await using var select = Store.Sql(db, null, """
                select p.revision,p.publication_id,p.publication_no,p.published_at,r.happened_at,c.outbox_id
                from public.article_publication p
                join public.article_revision r on (r.article_id,r.revision)=(p.article_id,p.revision)
                join public.article_publication_canonical c on c.publication_id=p.publication_id
                where p.article_id=$1
                """, id);
            await using var row = await select.ExecuteReaderAsync(ct);
            Assert.True(await row.ReadAsync(ct));
            return new(row.GetInt64(0), row.GetInt64(1), row.GetInt32(2), row.GetFieldValue<DateTimeOffset>(3),
                row.GetFieldValue<DateTimeOffset>(4), row.GetInt64(5));
        }

        async Task<string> WaitForPublication(int id, FeedPublication expected)
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(12));
            while (true)
            {
                using var response = await server.Client.GetAsync(ArticleRoute(id), deadline.Token);
                if (response.StatusCode == HttpStatusCode.OK)
                {
                    Assert.True(response.Headers.CacheControl?.NoStore);
                    var frame = await response.Content.ReadAsByteArrayAsync(deadline.Token);
                    var actual = ReadDetailCoordinates(frame);
                    Assert.Equal(id, actual.Article);
                    if (actual.Publication == expected.Id)
                    {
                        Assert.Equal(expected.Revision, actual.Revision);
                        Assert.Equal(expected.Number, actual.Number);
                        Assert.Equal(expected.Published.ToUnixTimeMilliseconds(), actual.PublishedMs);
                        return Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration));
                    }
                }
                else Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
                await Task.Delay(50, deadline.Token);
            }
        }

        async Task<FeedArtifacts> ReadFeeds(string generation)
        {
            return new(await ReadArtifact("/feed/rss.xml"), await ReadArtifact("/api/Article/rss"),
                await ReadArtifact("/feed/atom.xml"), await ReadArtifact("/feed/feed.json"), await ReadArtifact("/sitemap.xml"));

            async Task<string> ReadArtifact(string path)
            {
                using var response = await server.Client.GetAsync(path, ct);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                Assert.True(response.Headers.CacheControl?.NoStore);
                Assert.Equal(generation, Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
                return await response.Content.ReadAsStringAsync(ct);
            }
        }

        async Task<int> Tick(long now)
        {
            await using var connection = await fixture.DataSource.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var result = await ArticleScheduleStore.PublishDue(connection, tx, ct, DateTimeOffset.FromUnixTimeMilliseconds(now).UtcDateTime);
            await tx.CommitAsync(ct);
            return result;
        }
        async Task<ArticleSchedule> Read(int id, long revision)
        {
            var path = WireRoutes.DraftSchedule.Replace("{id:int}", id.ToString()) + $"?revision={revision}";
            return Wire.DecodeArticleSchedule(await Request(HttpMethod.Get, path, null, HttpStatusCode.OK));
        }
        async Task<Draft> Write(string route, ArticleCommand command) =>
            Wire.DecodeDraft(await Request(HttpMethod.Post, route, Wire.EncodeArticleCommand(command), HttpStatusCode.OK));
        Task<byte[]> Submit(ArticleScheduleCommand input, HttpStatusCode status = HttpStatusCode.OK) =>
            Request(HttpMethod.Post, WireRoutes.DraftScheduleCommand, Wire.EncodeArticleScheduleCommand(input), status);
        async Task<byte[]> Request(HttpMethod method, string route, byte[]? body, HttpStatusCode status)
        {
            using var request = SiteAedsFixture.Request(method, route, body, token, handle: null);
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }
        Task Execute(string sql, params object[] values) =>
            FixtureSql.ExecuteAsync(db, null, ct, sql, values);
        async Task<T> Scalar<T>(string sql, params object[] values)
        {
            return (T)(await FixtureSql.ScalarAsync(db, null, ct, sql, values))!;
        }
    }

    private sealed record FeedPublication(long Revision, long Id, int Number, DateTimeOffset Published, DateTimeOffset Edited,
        long OutboxId);

    private sealed record FeedArtifacts(string Rss, string LegacyRss, string Atom, string Json, string Sitemap);

    private static string ArticleRoute(int id) =>
        WireRoutes.PublicArticle.Replace("{id}", id.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);

    private static (int Article, long Revision, long Publication, int Number, long PublishedMs) ReadDetailCoordinates(byte[] frame)
    {
        var payload = Aeds.Decode(frame, FrameType.ArticleDetail);
        Assert.Equal(WireLayouts.ArticleDetailV5Magic, BinaryPrimitives.ReadInt32LittleEndian(payload));
        Assert.Equal(WireLayouts.ArticleDetailV5Version, BinaryPrimitives.ReadInt32LittleEndian(payload[4..]));
        var record = payload.Slice(WireLayouts.ArticleDetailHeaderSize, WireLayouts.ArticleDetailV5RecordSize);
        var coordinates = record[WireLayouts.ArticleDetailCoordinatesOffset..];
        return (BinaryPrimitives.ReadInt32LittleEndian(record[WireLayouts.ArticleIdOffset..]),
            BinaryPrimitives.ReadInt64LittleEndian(coordinates), BinaryPrimitives.ReadInt64LittleEndian(coordinates[12..]),
            BinaryPrimitives.ReadInt32LittleEndian(coordinates[20..]),
            BinaryPrimitives.ReadInt64LittleEndian(record[WireLayouts.ArticleDetailPublishedAtOffset..]));
    }

    private static void VerifyFeedContent(FeedArtifacts feeds, int article, string url, FeedPublication expected, string title, string body,
        int expectedCount = 1)
    {
        var modified = expected.Edited > expected.Published ? expected.Edited : expected.Published;
        Assert.Equal(feeds.Rss, feeds.LegacyRss);
        var rssItems = XDocument.Parse(feeds.Rss).Descendants("item").ToArray();
        Assert.Equal(expectedCount, rssItems.Length);
        var rss = Assert.Single(rssItems, item => (string?)item.Element("guid") == url);
        Assert.Equal(title, (string?)rss.Element("title"));
        Assert.Equal(body, (string?)rss.Element("description"));
        Assert.Equal(url, (string?)rss.Element("link"));
        Assert.Equal(expected.Published.ToString("r", CultureInfo.InvariantCulture), (string?)rss.Element("pubDate"));
        var atomItems = XDocument.Parse(feeds.Atom).Descendants(Atom + "entry").ToArray();
        Assert.Equal(expectedCount, atomItems.Length);
        var atom = Assert.Single(atomItems, item => (string?)item.Element(Atom + "id") == url);
        Assert.Equal(title, (string?)atom.Element(Atom + "title"));
        Assert.Equal(body, (string?)atom.Element(Atom + "summary"));
        Assert.Equal(url, (string?)atom.Element(Atom + "link")?.Attribute("href"));
        Assert.Equal(expected.Published.ToString("O", CultureInfo.InvariantCulture), (string?)atom.Element(Atom + "published"));
        Assert.Equal(modified.ToString("O", CultureInfo.InvariantCulture), (string?)atom.Element(Atom + "updated"));
        using var json = JsonDocument.Parse(feeds.Json);
        var jsonItems = json.RootElement.GetProperty("items");
        Assert.Equal(expectedCount, jsonItems.GetArrayLength());
        var item = Assert.Single(jsonItems.EnumerateArray(), row => row.GetProperty("url").GetString() == url);
        Assert.Equal(title, item.GetProperty("title").GetString());
        Assert.Equal(body, item.GetProperty("content_text").GetString());
        Assert.Equal(article.ToString(CultureInfo.InvariantCulture), item.GetProperty("id").GetString());
        Assert.Equal(expected.Published, item.GetProperty("date_published").GetDateTimeOffset());
        Assert.Equal(modified, item.GetProperty("date_modified").GetDateTimeOffset());
        var sitemap = Assert.Single(XDocument.Parse(feeds.Sitemap).Descendants(Sitemap + "url"), row => (string?)row.Element(Sitemap + "loc") == url);
        Assert.Equal(modified.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), (string?)sitemap.Element(Sitemap + "lastmod"));
    }
}

public sealed class ArticleSchedulePostgresTests
{
    private const string PublicOrigin = "https://schedule.example.test";
    private static readonly XNamespace Atom = "http://www.w3.org/2005/Atom";
    private static readonly XNamespace Sitemap = "http://www.sitemaps.org/schemas/sitemap/0.9";

    [PostgresFact]
    public async Task ScheduledDraftKeepsItsPublicPredecessorAndConsumesOnlyItsExactDueCommand()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (author, token, _) = await fixture.SignIn("Scheduled author", ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            [PublicSiteConfiguration.OriginKey] = PublicOrigin,
            ["FSUSBLOG_ADMIN_ORIGIN"] = ServerProcess.DefaultAdminOrigin,
        });
        var first = await Write(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Original", "original body"));
        var published = await Write(WireRoutes.Publish, new(first.Id, first.Revision, Guid.NewGuid(), "", ""));
        var original = await ReadPublication(first.Id);
        var articleUrl = $"{PublicOrigin}/article/{first.Id}";
        var originalGeneration = await WaitForPublication(first.Id, original);
        var originalFeeds = await ReadFeeds(originalGeneration);
        VerifyFeedContent(originalFeeds, first.Id, articleUrl, original, "Original", "original body");
        var draft = await Write(WireRoutes.Save, new(first.Id, published.Revision, Guid.NewGuid(), "Replacement", "replacement body"));
        var dbNow = await fixture.Scalar<DateTime>("select clock_timestamp()");
        var future = new DateTimeOffset(dbNow).AddHours(1).ToUnixTimeMilliseconds();
        var intent = new ArticleScheduleCommand(draft.Id, draft.Revision, Guid.NewGuid(), future);
        await Submit(intent with { DueUnixMs = new DateTimeOffset(dbNow).AddSeconds(-1).ToUnixTimeMilliseconds() }, BadRequest);
        var duplicates = await Task.WhenAll(Submit(intent), Submit(intent));
        Assert.Equal(duplicates[0], duplicates[1]);
        var pending = Wire.DecodeArticleSchedule(duplicates[0]);
        Assert.Equal((draft.Revision + 1, published.Revision, future), (pending.Revision, pending.PublishedRevision, pending.DueUnixMs));
        Assert.Equal(pending, await Read(draft.Id, pending.Revision));
        Assert.Contains("original body", await server.Client.GetStringAsync($"/article/{draft.Id}", ct));
        await Submit(intent with { DueUnixMs = future + 10 }, Conflict);
        await Submit(intent with { IdempotencyKey = Guid.NewGuid() }, Conflict);
        Assert.Equal(0, await Tick(future - 1));
        Assert.Equal(1L, await fixture.Scalar<long>("select count(*) from public.article_publication_canonical where article_id=$1", draft.Id));
        Assert.Equal(originalFeeds, await ReadFeeds(originalGeneration));

        var newDue = future + 10_000;
        var replaced = Wire.DecodeArticleSchedule(await Submit(new(draft.Id, pending.Revision, Guid.NewGuid(), newDue)));
        Assert.Equal(0, await Tick(future));
        var cancelled = Wire.DecodeArticleSchedule(await Submit(new(draft.Id, replaced.Revision, Guid.NewGuid(), 0)));
        Assert.Equal((0L, 0), (cancelled.DueUnixMs, await Tick(newDue)));
        Assert.Equal(originalFeeds, await ReadFeeds(originalGeneration));
        var obsolete = Wire.DecodeArticleSchedule(await Submit(new(draft.Id, cancelled.Revision, Guid.NewGuid(), newDue)));
        var modified = await Write(WireRoutes.Save, new(draft.Id, obsolete.Revision, Guid.NewGuid(), "Replacement", "replacement body"));
        Assert.Equal((0L, 0), ((await Read(draft.Id, modified.Revision)).DueUnixMs, await Tick(newDue)));
        Assert.Equal(originalFeeds, await ReadFeeds(originalGeneration));
        var finalCommand = new ArticleScheduleCommand(draft.Id, modified.Revision, Guid.NewGuid(), newDue);
        var final = Wire.DecodeArticleSchedule(await Submit(finalCommand));

        // Existing account lock order means a due pass can skip a concurrent account update without deadlocking.
        await fixture.WithConnection(async db =>
        {
            await using var account = await db.BeginTransactionAsync(ct);
            await FixtureSql.ScalarAsync(db, account, ct, "select id from public.admin_principal where id=$1 for update", author);
            Assert.Equal(0, await Tick(newDue));
            await account.RollbackAsync(ct);
        }, ct);

        await fixture.Exec("alter table public.blog_outbox add constraint forced_scheduler_failure check (kind <> 'publish') not valid");
        await Assert.ThrowsAsync<PostgresException>(() => Tick(newDue));
        Assert.Equal(final, await Read(draft.Id, final.Revision));
        Assert.Equal(original.Id, await fixture.Scalar<long>("select publication_id from public.article_publication where article_id=$1", draft.Id));
        Assert.Equal(1L, await fixture.Scalar<long>("select count(*) from public.article_publication_history where article_id=$1", draft.Id));
        Assert.Equal(originalGeneration, await WaitForPublication(draft.Id, original));
        Assert.Equal(originalFeeds, await ReadFeeds(originalGeneration));
        await fixture.Exec("alter table public.blog_outbox drop constraint forced_scheduler_failure");

        Assert.Equal(new[] { 0, 1 }, (await Task.WhenAll(Tick(newDue), Tick(newDue))).Order());
        Assert.Equal(final.Revision, await fixture.Scalar<long>("select revision from public.article_publication where article_id=$1", draft.Id));
        Assert.Equal(final.Revision, await fixture.Scalar<long>("select revision from public.article where id=$1", draft.Id));
        Assert.Equal((original.Id, "scheduled-replaced", finalCommand.IdempotencyKey), await fixture.QueryRow(
            "select supersedes_id,reason,command_id from public.article_publication_history where article_id=$1 and event_no=2",
            r => (r.GetInt64(0), r.GetString(1), r.GetGuid(2)), draft.Id));
        Assert.Equal(1L, await fixture.Scalar<long>("""
            select count(*) from public.article_publication_canonical c
            join public.article_publication p on p.publication_id=c.publication_id and p.published_at=c.published_at
            join public.blog_outbox o on o.id=c.outbox_id and o.kind='publish' and o.revision=p.revision
            where c.article_id=$1 and c.revision=$2 and c.transition='replace'
            """, draft.Id, final.Revision));
        var promoted = await ReadPublication(first.Id);
        Assert.Equal((final.Revision, original.Number + 1), (promoted.Revision, promoted.Number));
        Assert.NotEqual(original.Id, promoted.Id);
        var promotedGeneration = await WaitForPublication(first.Id, promoted);
        Assert.NotEqual(originalGeneration, promotedGeneration);
        var promotedFeeds = await ReadFeeds(promotedGeneration);
        VerifyFeedContent(promotedFeeds, first.Id, articleUrl, promoted, "Replacement", "replacement body");
        Assert.True(await fixture.Scalar<bool>("select processed_at is not null from public.blog_outbox where id=$1", promoted.OutboxId));
        Assert.Equal((0, 0L), (await Tick(newDue + 1), (await Read(draft.Id, final.Revision)).DueUnixMs));
        Assert.Equal(final, Wire.DecodeArticleSchedule(await Submit(finalCommand)));
        await Submit(new(draft.Id, final.Revision, Guid.NewGuid(), 0), Conflict);
        Assert.Equal(promotedFeeds, await ReadFeeds(promotedGeneration));
        Assert.Equal(1L, await fixture.Scalar<long>("select count(*) from public.blog_outbox where article_id=$1 and revision=$2 and kind='publish'", draft.Id, final.Revision));

        var neverPublic = await Write(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Never public", "private"));
        await Submit(new(neverPublic.Id, neverPublic.Revision, Guid.NewGuid(), newDue));
        await fixture.Exec("update public.admin_principal set generation=generation+1 where id=$1", author);
        Assert.Equal(0, await Tick(newDue));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.article_schedule where article_id=$1", neverPublic.Id));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.article_publication where article_id=$1", neverPublic.Id));

        token = (await fixture.SignIn(author, ct)).Token;
        var workerDraft = await Write(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Real worker", "real worker body"));
        var realDue = new DateTimeOffset(await fixture.Scalar<DateTime>("select clock_timestamp()")).AddSeconds(4).ToUnixTimeMilliseconds();
        var workerReceipt = Wire.DecodeArticleSchedule(await Submit(new(workerDraft.Id, workerDraft.Revision, Guid.NewGuid(), realDue)));
        await CheckStatusAsync(NotFound, server.Client.GetAsync($"/article/{workerDraft.Id}", ct));
        await CheckStatusAsync(NotFound, server.Client.GetAsync(ArticleRoute(workerDraft.Id), ct));
        Assert.Equal(promotedFeeds, await ReadFeeds(promotedGeneration));
        using (var timer = new CancellationTokenSource(TimeSpan.FromSeconds(12)))
        {
            while (true)
            {
                using var response = await server.Client.GetAsync($"/article/{workerDraft.Id}", timer.Token);
                if (response.StatusCode == OK)
                {
                    Assert.Contains("real worker body", await response.Content.ReadAsStringAsync(timer.Token));
                    break;
                }
                Assert.True(response.StatusCode is NotFound or ServiceUnavailable);
                await Task.Delay(50, timer.Token);
            }
        }
        Assert.Equal(workerReceipt.Revision, await fixture.Scalar<long>("select revision from public.article_publication where article_id=$1", workerDraft.Id));
        Assert.Equal("scheduled-published", await fixture.Scalar<string>("select reason from public.article_publication_history where article_id=$1", workerDraft.Id));
        var workerPublication = await ReadPublication(workerDraft.Id);
        var workerGeneration = await WaitForPublication(workerDraft.Id, workerPublication);
        Assert.NotEqual(promotedGeneration, workerGeneration);
        VerifyFeedContent(await ReadFeeds(workerGeneration), workerDraft.Id, $"{PublicOrigin}/article/{workerDraft.Id}",
            workerPublication, "Real worker", "real worker body", expectedCount: 2);

        Task<FeedPublication> ReadPublication(int id) => fixture.QueryRow("""
            select p.revision,p.publication_id,p.publication_no,p.published_at,r.happened_at,c.outbox_id
            from public.article_publication p
            join public.article_revision r on (r.article_id,r.revision)=(p.article_id,p.revision)
            join public.article_publication_canonical c on c.publication_id=p.publication_id where p.article_id=$1
            """, r => new FeedPublication(r.GetInt64(0), r.GetInt64(1), r.GetInt32(2), r.GetFieldValue<DateTimeOffset>(3),
                r.GetFieldValue<DateTimeOffset>(4), r.GetInt64(5)), id);

        async Task<string> WaitForPublication(int id, FeedPublication expected)
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(12));
            while (true)
            {
                using var response = await server.Client.GetAsync(ArticleRoute(id), deadline.Token);
                if (response.StatusCode == OK)
                {
                    Assert.True(response.Headers.CacheControl?.NoStore);
                    var actual = ReadDetailCoordinates(await response.Content.ReadAsByteArrayAsync(deadline.Token));
                    Assert.Equal(id, actual.Article);
                    if (actual.Publication == expected.Id)
                    {
                        Assert.Equal((expected.Revision, expected.Number, expected.Published.ToUnixTimeMilliseconds()),
                            (actual.Revision, actual.Number, actual.PublishedMs));
                        return Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration));
                    }
                }
                else Assert.Equal(ServiceUnavailable, response.StatusCode);
                await Task.Delay(50, deadline.Token);
            }
        }

        async Task<FeedArtifacts> ReadFeeds(string generation)
        {
            return new(await ReadArtifact("/feed/rss.xml"), await ReadArtifact("/api/Article/rss"),
                await ReadArtifact("/feed/atom.xml"), await ReadArtifact("/feed/feed.json"), await ReadArtifact("/sitemap.xml"));

            async Task<string> ReadArtifact(string path)
            {
                using var response = Ok(await server.Client.GetAsync(path, ct));
                Assert.True(response.Headers.CacheControl?.NoStore);
                Assert.Equal(generation, Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
                return await response.Content.ReadAsStringAsync(ct);
            }
        }

        Task<int> Tick(long now) => fixture.InTx((conn, tx) =>
            ArticleScheduleStore.PublishDue(conn, tx, ct, DateTimeOffset.FromUnixTimeMilliseconds(now).UtcDateTime), ct);
        async Task<ArticleSchedule> Read(int id, long revision) => Wire.DecodeArticleSchedule(
            await Request(HttpMethod.Get, WireRoutes.DraftSchedule.Replace("{id:int}", id.ToString()) + $"?revision={revision}", null, OK));
        async Task<Draft> Write(string route, ArticleCommand command) =>
            Wire.DecodeDraft(await Request(HttpMethod.Post, route, Wire.EncodeArticleCommand(command), OK));
        Task<byte[]> Submit(ArticleScheduleCommand input, HttpStatusCode status = OK) =>
            Request(HttpMethod.Post, WireRoutes.DraftScheduleCommand, Wire.EncodeArticleScheduleCommand(input), status);
        Task<byte[]> Request(HttpMethod method, string route, byte[]? body, HttpStatusCode status) =>
            SiteAedsFixture.ExpectPrivate(server.Client, method, route, body, token, null, status, ct);
    }

    private sealed record FeedPublication(long Revision, long Id, int Number, DateTimeOffset Published, DateTimeOffset Edited, long OutboxId);
    private sealed record FeedArtifacts(string Rss, string LegacyRss, string Atom, string Json, string Sitemap);
    private static string ArticleRoute(int id) => WireRoutes.PublicArticle.Replace("{id}", id.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);

    private static (int Article, long Revision, long Publication, int Number, long PublishedMs) ReadDetailCoordinates(byte[] frame)
    {
        var payload = Aeds.Decode(frame, FrameType.ArticleDetail);
        Assert.Equal((WireLayouts.ArticleDetailV5Magic, WireLayouts.ArticleDetailV5Version),
            (BinaryPrimitives.ReadInt32LittleEndian(payload), BinaryPrimitives.ReadInt32LittleEndian(payload[4..])));
        var record = payload.Slice(WireLayouts.ArticleDetailHeaderSize, WireLayouts.ArticleDetailV5RecordSize);
        var coordinates = record[WireLayouts.ArticleDetailCoordinatesOffset..];
        return (BinaryPrimitives.ReadInt32LittleEndian(record[WireLayouts.ArticleIdOffset..]),
            BinaryPrimitives.ReadInt64LittleEndian(coordinates), BinaryPrimitives.ReadInt64LittleEndian(coordinates[12..]),
            BinaryPrimitives.ReadInt32LittleEndian(coordinates[20..]),
            BinaryPrimitives.ReadInt64LittleEndian(record[WireLayouts.ArticleDetailPublishedAtOffset..]));
    }

    private static void VerifyFeedContent(FeedArtifacts feeds, int article, string url, FeedPublication expected, string title, string body, int expectedCount = 1)
    {
        var modified = expected.Edited > expected.Published ? expected.Edited : expected.Published;
        Assert.Equal(feeds.Rss, feeds.LegacyRss);
        var rssItems = XDocument.Parse(feeds.Rss).Descendants("item").ToArray();
        Assert.Equal(expectedCount, rssItems.Length);
        var rss = Assert.Single(rssItems, item => (string?)item.Element("guid") == url);
        Assert.Equal((title, body, url, expected.Published.ToString("r", CultureInfo.InvariantCulture)),
            ((string?)rss.Element("title"), (string?)rss.Element("description"), (string?)rss.Element("link"), (string?)rss.Element("pubDate")));
        var atomItems = XDocument.Parse(feeds.Atom).Descendants(Atom + "entry").ToArray();
        Assert.Equal(expectedCount, atomItems.Length);
        var atom = Assert.Single(atomItems, item => (string?)item.Element(Atom + "id") == url);
        Assert.Equal((title, body, url, expected.Published.ToString("O", CultureInfo.InvariantCulture), modified.ToString("O", CultureInfo.InvariantCulture)),
            ((string?)atom.Element(Atom + "title"), (string?)atom.Element(Atom + "summary"), (string?)atom.Element(Atom + "link")?.Attribute("href"),
                (string?)atom.Element(Atom + "published"), (string?)atom.Element(Atom + "updated")));
        using var json = JsonDocument.Parse(feeds.Json);
        var jsonItems = json.RootElement.GetProperty("items");
        Assert.Equal(expectedCount, jsonItems.GetArrayLength());
        var item = Assert.Single(jsonItems.EnumerateArray(), row => row.GetProperty("url").GetString() == url);
        Assert.Equal((title, body, article.ToString(CultureInfo.InvariantCulture), expected.Published, modified),
            (item.GetProperty("title").GetString(), item.GetProperty("content_text").GetString(), item.GetProperty("id").GetString(),
                item.GetProperty("date_published").GetDateTimeOffset(), item.GetProperty("date_modified").GetDateTimeOffset()));
        var sitemap = Assert.Single(XDocument.Parse(feeds.Sitemap).Descendants(Sitemap + "url"), row => (string?)row.Element(Sitemap + "loc") == url);
        Assert.Equal(modified.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), (string?)sitemap.Element(Sitemap + "lastmod"));
    }
}

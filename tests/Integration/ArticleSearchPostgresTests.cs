using System.Buffers.Binary;
using System.Net;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;

public sealed class ArticleSearchPostgresTests
{
    [Fact]
    public void UsesVisibleBodyLengthForNormalizationAndDoesNotScoreRepeatedQueryTerms()
    {
        var when = DateTimeOffset.UnixEpoch.AddYears(50);
        var index = ArticleSearchIndex.Build([
            new Article(1, 1, 1, 1, 1, "Needle", "brief", when, when, when),
            new Article(2, 1, 2, 1, 1, "Needle", string.Concat(Enumerable.Repeat("brief ", 60)),
                when.AddDays(2), when, when),
            new Article(3, 1, 3, 1, 1, "Needle", $"[brief]({new string('x', 5000)})", when.AddDays(1), when, when)
        ], CancellationToken.None);
        Assert.NotNull(index);
        Assert.Equal([3, 1, 2], index.Search("ＮＥＥＤＬＥ needle", CancellationToken.None).Select(article => article.Id));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.Throws<OperationCanceledException>(() => index.Search("needle", cancellation.Token));
    }

    [Fact]
    public void IndexesAsciiPrefixesAndCamelCaseSubwordsWithLowerWeightThanExactMatches()
    {
        var when = DateTimeOffset.UnixEpoch.AddYears(50);
        var index = ArticleSearchIndex.Build([
            new Article(1, 1, 1, 1, 1, "FsusBlog AEDS guide", "PostgreSQL dotNet10", when, when, when),
            new Article(2, 1, 2, 1, 1, "FsusUI tokens", "under unit testing", when.AddDays(1), when, when),
            new Article(3, 1, 3, 1, 1, "Fsu", "standalone exact term", when.AddDays(-1), when, when),
            new Article(4, 1, 4, 1, 1, "Go", "short exact word", when.AddDays(-2), when, when),
            new Article(5, 1, 5, 1, 1, "Golang handbook", "prefix candidate", when.AddDays(2), when, when)
        ], CancellationToken.None);
        Assert.NotNull(index);

        // Exact title match ("Fsu") outranks prefix title matches ("FsusBlog", "FsusUI"),
        // while both prefix matches are still recalled.
        var fsu = index.Search("Fsu", CancellationToken.None).Select(article => article.Id).ToArray();
        Assert.Equal(3, fsu[0]);
        Assert.Equal([1, 2, 3], fsu.Order());

        // CamelCase / acronym / digit-boundary subwords match without matching unrelated prefixes.
        Assert.Equal([1], index.Search("Blog", CancellationToken.None).Select(article => article.Id));
        Assert.Equal([2], index.Search("UI", CancellationToken.None).Select(article => article.Id));
        Assert.Equal([1], index.Search("SQL", CancellationToken.None).Select(article => article.Id));
        Assert.Equal([1], index.Search("post", CancellationToken.None).Select(article => article.Id));
        Assert.Equal([1], index.Search("net", CancellationToken.None).Select(article => article.Id));
        Assert.Equal([1], index.Search("10", CancellationToken.None).Select(article => article.Id));

        // 1-2 char ASCII queries recall metadata word/subword prefixes (e.g. A/AE -> AEDS, fs -> Fsus*, bl -> Blog),
        // with exact matches outranking short prefixes and without scanning body-only or mid-word substrings.
        Assert.Equal([1], index.Search("A", CancellationToken.None).Select(article => article.Id));
        Assert.Equal([1], index.Search("AE", CancellationToken.None).Select(article => article.Id));
        Assert.Equal([1], index.Search("ＡＥ", CancellationToken.None).Select(article => article.Id));
        Assert.Equal([1, 2, 3], index.Search("fs", CancellationToken.None).Select(article => article.Id).Order());
        Assert.Equal([1], index.Search("bl", CancellationToken.None).Select(article => article.Id));
        Assert.Equal([4, 5], index.Search("go", CancellationToken.None).Select(article => article.Id));
        Assert.Empty(index.Search("po", CancellationToken.None));
        Assert.Empty(index.Search("un", CancellationToken.None));
        Assert.Empty(index.Search("ed", CancellationToken.None));

        // Query-time tokenization stays exact-only so "FsusBlog" never falsely matches "FsusUI".
        Assert.Equal([1], index.Search("FsusBlog", CancellationToken.None).Select(article => article.Id));
        Assert.Equal([2], index.Search("FsusUI", CancellationToken.None).Select(article => article.Id));
    }

    [PostgresFact]
    public async Task DedicatedFas4RanksCurrentPublicFieldsAndFailsClosedAcrossWithdrawal()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (author, token, _) = await fixture.SignIn("FAS4 author", ct, minutes: 1);
        await using (var transaction = await db.BeginTransactionAsync(ct))
        {
            await FixtureSql.ExecuteAsync(db, transaction, ct, """
                insert into public.article (id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at)
                overriding system value
                select id,$1,1,title,body,case when id=9 then null else 1 end,case when id=9 then 0 else 1 end,false,
                       timestamptz '2024-01-01 UTC' + offset_days * interval '1 day',timestamptz '2024-01-01 UTC'
                from (
                    values
                        (1,'Needle','silence',0),(2,'Metadata','silence',0),(3,'Body',repeat('#',220)||' Needle',3),
                        (4,'Summary','Needle',2),(5,'Taxonomy','silence',1),(6,'Alternatives','Zeta',0),
                        (7,'公开页','silence',0),(8,'公开','silence',0),(9,'private needle zeta','Batch-Item_8',0),
                        (10,'Batch-ITEM_7','silence',0),(11,'Batch Item 7','xBatch-Item_7 Batch-Item_7-extra',0),
                        (12,'Job','Section '||repeat('#',220)||' `BATCH-ITEM_7`',0),
                        (13,repeat('a',126)||'-1','silence',0)
                ) fixture(id,title,body,offset_days)
                union all
                select id,$1,1,'Common Batch Item 7','silence',1,1,false,timestamptz '2024-01-01 UTC',timestamptz '2024-01-01 UTC'
                from generate_series(1001,1205) id
                """, author);
            await FixtureSql.ExecuteAsync(db, transaction, ct, """
                insert into public.category(id,name) values (41,'Needle');
                insert into public.tag(id,name) values (81,'Needle');
                insert into public.article_revision(article_id,revision,title,body,happened_at)
                    select id,revision,title,body,created_at from public.article;
                insert into public.article_revision_category(article_id,revision,category_id) values (2,1,41);
                insert into public.article_revision_tag(article_id,revision,tag_id) values (5,1,81);
                insert into public.article_publication(article_id,revision,publication_id,published_at)
                    select id,revision,10000+id,created_at from public.article where published_revision is not null;
                insert into public.article_revision_rights (
                    article_id,revision,enabled,license_type,copyright_holder,copyright_year,rights_statement,attribution_template,
                    copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,proof_binding_enabled)
                    select article_id,revision,true,'all-rights-reserved','',0,'','','append-attribution',300,true,true,true
                    from public.article_publication;
                insert into public.article_publication_rights (article_id,publication_id,revision)
                    select article_id,publication_id,revision from public.article_publication;
                """);
            await transaction.CommitAsync(ct);
        }

        var evidence = Directory.CreateTempSubdirectory("fsusv2-fas4-");
        try
        {
            var output = Path.Combine(evidence.FullName, "runtime.ndjson");
            var config = new Dictionary<string, string>
            {
                ["FSUSBLOG_RUNTIME_EVIDENCE_CONTROL"] = evidence.FullName,
                ["FSUSBLOG_RUNTIME_EVIDENCE_OUTPUT"] = output
            };
            await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, config);
            var client = server.Client;
            var before = await Mark("measure-before");
            var (needle, generation) = await Search("  ＮＥＥＤＬＥ needle\t ");
            Assert.Equal([1, 4, 5, 2, 3], needle.Select(item => item.Id));
            Assert.Equal(new Hit(1, 1, 1, 10_001, 1), needle[0]);
            var (union, _) = await Search("zeta needle");
            Assert.Equal([1, 2, 3, 4, 5, 6], union.Select(item => item.Id).Order());
            Assert.Equal(union, (await Search("needle zeta")).Hits);
            Assert.Equal(7, Assert.Single((await Search("公开页")).Hits).Id);
            Assert.Equal(8, Assert.Single((await Search("公开")).Hits).Id);
            var (capped, _) = await Search("common");
            Assert.Equal(Enumerable.Range(1006, 200).Reverse(), capped.Select(item => item.Id));
            var (compound, compoundGeneration) = await Search("  ＢＡＴＣＨ-Item_7  ");
            Assert.Equal([10, 12], compound.Select(item => item.Id));
            Assert.Equal(generation, compoundGeneration);
            Assert.Empty((await Search("Batch-Item_8")).Hits);
            Assert.Equal(200, (await Search("batch-item")).Hits.Length);
            var maxIdentifier = new string('A', 126) + "-1";
            Assert.Equal(13, Assert.Single((await Search(maxIdentifier)).Hits).Id);
            Assert.Empty((await Search(maxIdentifier + "2")).Hits);
            var (latestPage1, _, latestTotal1) = await SearchPage("needle", "latest", 1, 2);
            Assert.Equal(5, latestTotal1);
            Assert.Equal([3, 4], latestPage1.Select(item => item.Id));
            var (latestPage2, _, latestTotal2) = await SearchPage("needle", "latest", 2, 2);
            Assert.Equal(5, latestTotal2);
            Assert.Equal([5, 1], latestPage2.Select(item => item.Id));
            var (latestPage3, _, latestTotal3) = await SearchPage("needle", "latest", 3, 2);
            Assert.Equal(5, latestTotal3);
            Assert.Equal([2], latestPage3.Select(item => item.Id));
            var (latestPage4, _, latestTotal4) = await SearchPage("needle", "latest", 4, 2);
            Assert.Equal(5, latestTotal4);
            Assert.Empty(latestPage4);
            var (commonTail, _, commonTotal) = await SearchPage("common", "relevance", 21, 10);
            Assert.Equal(205, commonTotal);
            Assert.Equal(Enumerable.Range(1001, 5).Reverse(), commonTail.Select(item => item.Id));
            var after = await Mark("measure-after");
            Assert.Equal(16, Count(after, "requestStatus200") - Count(before, "requestStatus200"));
            Assert.Equal(Count(before, "dbCommandStarts"), Count(after, "dbCommandStarts"));
            Assert.Equal(Count(before, "dbPhysicalOpenStarts"), Count(after, "dbPhysicalOpenStarts"));
            using (var corpus = await client.GetAsync(WireRoutes.PublicSearchCorpus, ct))
                Assert.Equal(generation, Assert.Single(corpus.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
            await ExpectError(WireRoutes.PublicSearch, HttpStatusCode.BadRequest);
            await ExpectError($"{PathFor("needle")}&sort=hot", HttpStatusCode.BadRequest);
            await ExpectError($"{PathFor("needle")}&page=0", HttpStatusCode.BadRequest);
            await ExpectError($"{PathFor("needle")}&size=101", HttpStatusCode.BadRequest);

            var retract = Wire.EncodeArticleCommand(new(1, 1, Guid.NewGuid(), "", ""));
            await Sql("alter table public.blog_outbox add constraint block_fas4_refresh check (kind <> 'retract' or processed_at is null)");
            await Retract(HttpStatusCode.ServiceUnavailable);
            await ExpectError(PathFor("needle"), HttpStatusCode.ServiceUnavailable);
            await Sql("alter table public.blog_outbox drop constraint block_fas4_refresh");
            await Retract(HttpStatusCode.OK);
            var (current, newGeneration) = await Search("needle");
            Assert.Equal([4, 5, 2, 3], current.Select(item => item.Id));
            Assert.NotEqual(generation, newGeneration);

            async Task<(Hit[] Hits, string Generation)> Search(string keyword)
            {
                using var response = await client.GetAsync(PathFor(keyword), ct);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                Assert.True(response.Headers.CacheControl?.NoStore);
                Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
                Assert.Single(response.Headers.GetValues(WireHeaders.SearchTotal));
                return (ReadHits(await response.Content.ReadAsByteArrayAsync(ct)),
                    Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
            }

            async Task<(Hit[] Hits, string Generation, int Total)> SearchPage(string keyword, string sort, int page, int size)
            {
                using var response = await client.GetAsync(
                    $"{PathFor(keyword)}&sort={Uri.EscapeDataString(sort)}&page={page}&size={size}", ct);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                Assert.True(response.Headers.CacheControl?.NoStore);
                Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
                return (ReadHits(await response.Content.ReadAsByteArrayAsync(ct)),
                    Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration)),
                    int.Parse(Assert.Single(response.Headers.GetValues(WireHeaders.SearchTotal))));
            }

            async Task ExpectError(string path, HttpStatusCode status)
            {
                using var response = await client.GetAsync(path, ct);
                Assert.Equal(status, response.StatusCode);
                Aeds.Decode(await response.Content.ReadAsByteArrayAsync(ct), FrameType.ApiError);
            }

            async Task Retract(HttpStatusCode status)
            {
                using var request = SiteAedsFixture.Request(HttpMethod.Post, WireRoutes.Retract, retract, token, handle: null);
                using var response = await client.SendAsync(request, ct);
                Assert.Equal(status, response.StatusCode);
            }

            async Task<JsonElement> Mark(string name)
            {
                var request = Path.Combine(evidence.FullName, "runtime.mark");
                var staging = Path.Combine(evidence.FullName, "stage");
                await File.WriteAllTextAsync(staging, name, ct);
                File.Move(staging, request);
                while (!File.Exists(Path.Combine(evidence.FullName, name + ".ack"))) await Task.Delay(20, ct);
                var matches = new List<JsonElement>();
                foreach (var line in await File.ReadAllLinesAsync(output, ct))
                {
                    using var row = JsonDocument.Parse(line);
                    if (row.RootElement.GetProperty("mark").GetString() == name) matches.Add(row.RootElement.Clone());
                }
                return Assert.Single(matches);
            }
        }
        finally
        {
            evidence.Delete(recursive: true);
        }

        Task Sql(string statement, params object[] inputs) =>
            FixtureSql.ExecuteAsync(db, null, ct, statement, inputs);
    }

    [PostgresFact]
    public async Task PublicSearchModeConfigControlsHtmlMetaAndFailsFastOnInvalidValue()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);

        await using (var autoServer = await ServerProcess.Start(fixture.ConnectionString, ct))
        {
            var html = await autoServer.Client.GetStringAsync("/search", ct);
            Assert.DoesNotContain("fsus-public-search-mode", html, StringComparison.Ordinal);
        }

        await using (var serverMode = await ServerProcess.Start(fixture.ConnectionString, ct,
            new Dictionary<string, string> { ["FSUSBLOG_PUBLIC_SEARCH_MODE"] = "server" }))
        {
            var html = await serverMode.Client.GetStringAsync("/search", ct);
            Assert.Contains("<meta name=\"fsus-public-search-mode\" content=\"server\">", html, StringComparison.Ordinal);
        }

        await using (var localMode = await ServerProcess.Start(fixture.ConnectionString, ct,
            new Dictionary<string, string> { ["FSUSBLOG_PUBLIC_SEARCH_MODE"] = "local" }))
        {
            var html = await localMode.Client.GetStringAsync("/search", ct);
            Assert.Contains("<meta name=\"fsus-public-search-mode\" content=\"local\">", html, StringComparison.Ordinal);
        }

        var failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            ServerProcess.Start(fixture.ConnectionString, ct,
                new Dictionary<string, string> { ["FSUSBLOG_PUBLIC_SEARCH_MODE"] = "hybrid" }));
        Assert.Contains("FSUSBLOG_PUBLIC_SEARCH_MODE", failure.Message, StringComparison.Ordinal);
    }

    [PostgresFact]
    public async Task DedicatedFas4SupportsLatestSortBoundedPaginationAndZeroDbQueries()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (author, _, _) = await fixture.SignIn("FAS4 paged author", ct, minutes: 1);
        await using (var transaction = await db.BeginTransactionAsync(ct))
        {
            await FixtureSql.ExecuteAsync(db, transaction, ct, """
                insert into public.article (id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at)
                overriding system value
                select id,$1,1,title,body,1,1,false,
                       timestamptz '2024-01-01 UTC' + offset_days * interval '1 day',timestamptz '2024-01-01 UTC'
                from (
                    values
                        (1,'Needle Needle Needle','silence',0),
                        (2,'Quiet','Needle',3),
                        (3,'Summary','Needle',2),
                        (4,'Batch-ITEM_7','silence',1),
                        (5,'Job','Section `BATCH-ITEM_7`',4)
                ) fixture(id,title,body,offset_days)
                union all
                select id,$1,1,'Common Entry','silence',1,1,false,
                       timestamptz '2024-01-01 UTC' + (id - 1000) * interval '1 minute',timestamptz '2024-01-01 UTC'
                from generate_series(1001,1205) id
                """, author);
            await FixtureSql.ExecuteAsync(db, transaction, ct, """
                insert into public.article_revision(article_id,revision,title,body,happened_at)
                    select id,revision,title,body,created_at from public.article;
                insert into public.article_publication(article_id,revision,publication_id,published_at)
                    select id,revision,10000+id,created_at from public.article;
                insert into public.article_revision_rights (
                    article_id,revision,enabled,license_type,copyright_holder,copyright_year,rights_statement,attribution_template,
                    copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,proof_binding_enabled)
                    select article_id,revision,true,'all-rights-reserved','',0,'','','append-attribution',300,true,true,true
                    from public.article_publication;
                insert into public.article_publication_rights (article_id,publication_id,revision)
                    select article_id,publication_id,revision from public.article_publication;
                """);
            await transaction.CommitAsync(ct);
        }

        var evidence = Directory.CreateTempSubdirectory("fsusv2-fas4-paged-");
        try
        {
            var output = Path.Combine(evidence.FullName, "runtime.ndjson");
            await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
            {
                ["FSUSBLOG_RUNTIME_EVIDENCE_CONTROL"] = evidence.FullName,
                ["FSUSBLOG_RUNTIME_EVIDENCE_OUTPUT"] = output
            });
            var client = server.Client;
            var before = await Mark("measure-before");

            var (rel, relTotal) = await Query("needle", "relevance", 1, 10);
            Assert.Equal(3, relTotal);
            Assert.Equal([1, 2, 3], rel.Select(item => item.Id));

            var (lat1, latTotal1) = await Query("needle", "latest", 1, 2);
            Assert.Equal(3, latTotal1);
            Assert.Equal([2, 3], lat1.Select(item => item.Id));

            var (lat2, latTotal2) = await Query("needle", "latest", 2, 2);
            Assert.Equal(3, latTotal2);
            Assert.Equal([1], lat2.Select(item => item.Id));

            var (lat3, latTotal3) = await Query("needle", "latest", 3, 2);
            Assert.Equal(3, latTotal3);
            Assert.Empty(lat3);

            var (compoundRel, compoundRelTotal) = await Query("batch-item_7", "relevance", 1, 10);
            Assert.Equal(2, compoundRelTotal);
            Assert.Equal([4, 5], compoundRel.Select(item => item.Id));

            var (compoundLatest, compoundLatestTotal) = await Query("batch-item_7", "latest", 1, 10);
            Assert.Equal(2, compoundLatestTotal);
            Assert.Equal([5, 4], compoundLatest.Select(item => item.Id));

            var (commonPage21, commonTotal) = await Query("common", "relevance", 21, 10);
            Assert.Equal(205, commonTotal);
            Assert.Equal([1005, 1004, 1003, 1002, 1001], commonPage21.Select(item => item.Id));

            var after = await Mark("measure-after");
            Assert.Equal(7, Count(after, "requestStatus200") - Count(before, "requestStatus200"));
            Assert.Equal(Count(before, "dbCommandStarts"), Count(after, "dbCommandStarts"));
            Assert.Equal(Count(before, "dbPhysicalOpenStarts"), Count(after, "dbPhysicalOpenStarts"));

            foreach (var bad in new[]
            {
                $"{PathFor("needle")}&sort=hot",
                $"{PathFor("needle")}&page=0",
                $"{PathFor("needle")}&page=10001",
                $"{PathFor("needle")}&size=0",
                $"{PathFor("needle")}&size=101"
            })
            {
                using var response = await client.GetAsync(bad, ct);
                Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
                Aeds.Decode(await response.Content.ReadAsByteArrayAsync(ct), FrameType.ApiError);
            }

            async Task<(Hit[] Hits, int Total)> Query(string keyword, string sort, int page, int size)
            {
                using var response = await client.GetAsync(
                    $"{PathFor(keyword)}&sort={sort}&page={page}&size={size}", ct);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                Assert.True(response.Headers.CacheControl?.NoStore);
                Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
                Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration));
                return (ReadHits(await response.Content.ReadAsByteArrayAsync(ct)),
                    int.Parse(Assert.Single(response.Headers.GetValues(WireHeaders.SearchTotal))));
            }

            async Task<JsonElement> Mark(string name)
            {
                var request = Path.Combine(evidence.FullName, "runtime.mark");
                var staging = Path.Combine(evidence.FullName, "stage");
                await File.WriteAllTextAsync(staging, name, ct);
                File.Move(staging, request);
                while (!File.Exists(Path.Combine(evidence.FullName, name + ".ack"))) await Task.Delay(20, ct);
                var matches = new List<JsonElement>();
                foreach (var line in await File.ReadAllLinesAsync(output, ct))
                {
                    using var row = JsonDocument.Parse(line);
                    if (row.RootElement.GetProperty("mark").GetString() == name) matches.Add(row.RootElement.Clone());
                }
                return Assert.Single(matches);
            }
        }
        finally
        {
            evidence.Delete(recursive: true);
        }
    }

    private static string PathFor(string keyword) => $"{WireRoutes.PublicSearch}?q={Uri.EscapeDataString(keyword)}";

    private static long Count(JsonElement marker, string bucket) => marker.GetProperty(bucket).GetProperty("otherHttp").GetInt64();

    private static Hit[] ReadHits(byte[] frame)
    {
        // Fixed v1 FAS4 layout: 420 B POD, count and 132 B tags, length and text, then 24 B coordinates.
        var payload = Aeds.Decode(frame, FrameType.ArticleSearch);
        Assert.True(payload[..4].SequenceEqual("FAS4"u8));
        Assert.Equal(4, I32(payload, 4));
        var hits = new Hit[I32(payload, 8)];
        var offset = 12;
        for (var index = 0; index < hits.Length; index++)
        {
            var id = I32(payload, offset);
            offset += 420;
            offset += 4 + 132 * I32(payload, offset);
            offset += 4 + I32(payload, offset);
            hits[index] = new Hit(id, I64(payload, offset), I32(payload, offset + 8), I64(payload, offset + 12), I32(payload, offset + 20));
            offset += 24;
        }
        Assert.Equal(payload.Length, offset);
        return hits;

        static int I32(ReadOnlySpan<byte> bytes, int at) => BinaryPrimitives.ReadInt32LittleEndian(bytes[at..]);
        static long I64(ReadOnlySpan<byte> bytes, int at) => BinaryPrimitives.ReadInt64LittleEndian(bytes[at..]);
    }

    private sealed record Hit(int Id, long Revision, int RevisionNo, long Publication, int PublicationNo);
}

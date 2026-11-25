public sealed class ArticleSearchPostgresTests
{
    [Fact]
    public void UsesVisibleBodyLengthForNormalizationAndDoesNotScoreRepeatedQueryTerms()
    {
        var when = DateTimeOffset.UnixEpoch.AddYears(50);
        var bodyIndex = ArticleSearchIndex.Build([
            new Article(1, 1, 1, 1, 1, "Quiet", "Needle brief", when, when, when),
            new Article(2, 1, 2, 1, 1, "Quiet", "Needle " + string.Concat(Enumerable.Repeat("brief ", 60)), when.AddDays(2), when, when),
            new Article(3, 1, 3, 1, 1, "Quiet", $"Needle [brief]({new string('x', 5000)})", when.AddDays(1), when, when)
        ], CancellationToken.None);
        Assert.NotNull(bodyIndex);
        // Visible Body length excludes the 5,000-char hidden Markdown URL; article 3 and 1 tie on body length (2) and break by CreatedAt desc.
        Assert.Equal([3, 1, 2], bodyIndex.Search("ＮＥＥＤＬＥ needle", CancellationToken.None).Select(article => article.Id));

        // Under BM25F (#46), Title matches normalize by Title length rather than Body length, so identical titles break ties by CreatedAt desc.
        var titleIndex = ArticleSearchIndex.Build([
            new Article(1, 1, 1, 1, 1, "Needle", "brief", when, when, when),
            new Article(2, 1, 2, 1, 1, "Needle", string.Concat(Enumerable.Repeat("brief ", 60)), when.AddDays(2), when, when),
            new Article(3, 1, 3, 1, 1, "Needle", $"[brief]({new string('x', 5000)})", when.AddDays(1), when, when)
        ], CancellationToken.None);
        Assert.NotNull(titleIndex);
        Assert.Equal([2, 3, 1], titleIndex.Search("ＮＥＥＤＬＥ needle", CancellationToken.None).Select(article => article.Id));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.Throws<OperationCanceledException>(() => bodyIndex.Search("needle", cancellation.Token));
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

        // Exact title match ("Fsu") outranks prefix title matches ("FsusBlog", "FsusUI"), while both prefix matches are still recalled.
        var fsu = index.Search("Fsu", CancellationToken.None).Select(article => article.Id).ToArray();
        Assert.Equal(3, fsu[0]);
        Assert.Equal([1, 2, 3], fsu.Order());
        Assert.Equal([1, 2, 3], index.Search("fs", CancellationToken.None).Select(article => article.Id).Order());

        // CamelCase/subword, 1-2 char metadata prefix, non-matches, and exact query-time tokenization.
        foreach (var (term, expected) in new (string, int[])[]
        {
            ("Blog", [1]), ("UI", [2]), ("SQL", [1]), ("post", [1]), ("net", [1]), ("10", [1]),
            ("A", [1]), ("AE", [1]), ("ＡＥ", [1]), ("bl", [1]), ("go", [4, 5]),
            ("po", []), ("un", []), ("ed", []), ("FsusBlog", [1]), ("FsusUI", [2]),
        })
            Assert.Equal(expected, index.Search(term, CancellationToken.None).Select(article => article.Id));
    }

    [Fact]
    public void UnifiedAnalyzerHandlesMarkdownBoundariesScTcTechnicalPunctuationAndVersionBinding()
    {
        var when = DateTimeOffset.UnixEpoch.AddYears(50);
        var articles = new[]
        {
            new Article(1, 1, 1, 1, 1, "C# 与 .NET 10 实践", "说明 `ASP.NET` 和 `C#` 边界", when, when, when),
            new Article(2, 1, 2, 1, 1, "C++ 23 原生解析器", "使用 C++ 编写零未定义行为解析器", when, when, when),
            new Article(3, 1, 3, 1, 1, "普通 C 语言指针", "讲解标准 C 语法，不含井号或加号", when, when, when),
            new Article(4, 1, 4, 1, 1, "软件架构与数据库", "介绍现代软件架构与数据库索引设计", when, when, when),
            new Article(5, 1, 5, 1, 1, "開源社區文檔規範", "整理開源社區的文檔規範實踐", when, when, when),
            new Article(6, 1, 6, 1, 1, "Markdown 边界",
                "# VisibleTitleMark\n\n[可见链接词](https://hidden.invalid/url-only-45)\n\n<!-- comment-only-45 -->\n<div data-x=\"attr-only-45\">VisibleHtmlInner45</div>\n<script>var script_only_45 = 1;</script>\n\n```csharp\nFencedCodeMark45();\n```",
                when, when, when)
        };
        var index = Assert.IsType<ArticleSearchIndex>(ArticleSearchIndex.Build(articles, CancellationToken.None));
        Assert.Equal(WireLimits.SearchAnalyzerVersion, index.AnalyzerVersion);

        // Technical punctuation isolation: C# vs C++ vs C, .NET vs ASP.NET
        Assert.Equal([1], index.Search("C#", CancellationToken.None).Select(a => a.Id));
        Assert.Equal([2], index.Search("C++", CancellationToken.None).Select(a => a.Id));
        Assert.Equal([1], index.Search(".NET", CancellationToken.None).Select(a => a.Id));
        Assert.Equal([1], index.Search("ASP.NET", CancellationToken.None).Select(a => a.Id));

        // Bidirectional controlled SC/TC recall (1-to-1 character conversion under concept coverage)
        Assert.Contains(4, index.Search("軟件架構", CancellationToken.None).Select(a => a.Id));
        Assert.Empty(index.Search("軟體架構", CancellationToken.None)); // 軟體 != 軟件 under concept coverage
        Assert.Contains(4, index.Search("數據庫", CancellationToken.None).Select(a => a.Id));
        Assert.Contains(5, index.Search("开源社区", CancellationToken.None).Select(a => a.Id));

        // Published Markdown visible content is searchable while hidden markup/URLs/comments/scripts are excluded
        Assert.Equal([6], index.Search("VisibleTitleMark", CancellationToken.None).Select(a => a.Id));
        Assert.Equal([6], index.Search("可见链接词", CancellationToken.None).Select(a => a.Id));
        Assert.Equal([6], index.Search("VisibleHtmlInner45", CancellationToken.None).Select(a => a.Id));
        Assert.Equal([6], index.Search("FencedCodeMark45", CancellationToken.None).Select(a => a.Id));
        foreach (var hidden in new[] { "url-only-45", "comment-only-45", "attr-only-45", "script_only_45" })
            Assert.Empty(index.Search(hidden, CancellationToken.None));
    }

    [PostgresFact]
    public async Task DedicatedFas4RanksCurrentPublicFieldsAndFailsClosedAcrossWithdrawal()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (author, token, _) = await fixture.SignIn("FAS4 author", ct, minutes: 1);
        await fixture.InTx(async (db, tx) =>
        {
            await FixtureSql.ExecuteAsync(db, tx, ct, """
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
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.category(id,name) values (41,'Needle');
                insert into public.tag(id,name) values (81,'Needle');
                insert into public.article_revision(article_id,revision,title,body,happened_at)
                    select id,revision,title,body,created_at from public.article;
                insert into public.article_revision_category(article_id,revision,category_id) values (2,1,41);
                insert into public.article_revision_tag(article_id,revision,tag_id) values (5,1,81);
                insert into public.article_publication(article_id,revision,publication_id,published_at)
                    select id,revision,10000+id,created_at from public.article where published_revision is not null;
                """ + "\n" + PublicationFixture.DefaultRightsForPublishedArticles);
        }, ct);

        var evidence = Directory.CreateTempSubdirectory("fsusv2-fas4-");
        using (new MediaFixture.DirectoryCleanup(evidence))
        {
            var output = Path.Combine(evidence.FullName, "runtime.ndjson");
            await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
            {
                ["FSUSBLOG_RUNTIME_EVIDENCE_CONTROL"] = evidence.FullName,
                ["FSUSBLOG_RUNTIME_EVIDENCE_OUTPUT"] = output
            });
            var client = server.Client;
            var before = await Mark(evidence, output, "measure-before", ct);
            var (needle, generation, _) = await Query(client, PathFor("  ＮＥＥＤＬＥ needle\t "), ct);
            Assert.Equal([1, 4, 5, 2, 3], needle.Select(item => item.Id));
            Assert.Equal(new Hit(1, 1, 1, 10_001, 1), needle[0]);
            // Profile v3 (#46): 2-concept queries require full concept coverage (possibly across distinct fields)
            Assert.Empty((await Query(client, PathFor("zeta needle"), ct)).Hits);
            var (crossField, _, _) = await Query(client, PathFor("metadata needle"), ct);
            Assert.Equal([2], crossField.Select(item => item.Id));
            Assert.Equal(crossField, (await Query(client, PathFor("needle metadata"), ct)).Hits);
            Assert.Equal(7, Assert.Single((await Query(client, PathFor("公开页"), ct)).Hits).Id);
            Assert.Equal([8, 7], (await Query(client, PathFor("公开"), ct)).Hits.Select(item => item.Id));
            Assert.Equal(Enumerable.Range(1006, 200).Reverse(), (await Query(client, PathFor("common"), ct)).Hits.Select(item => item.Id));
            var (compound, compoundGeneration, _) = await Query(client, PathFor("  ＢＡＴＣＨ-Item_7  "), ct);
            Assert.Equal([10, 12], compound.Select(item => item.Id));
            Assert.Equal(generation, compoundGeneration);
            Assert.Empty((await Query(client, PathFor("Batch-Item_8"), ct)).Hits);
            Assert.Equal(200, (await Query(client, PathFor("batch-item"), ct)).Hits.Length);
            var maxIdentifier = new string('A', 126) + "-1";
            Assert.Equal(13, Assert.Single((await Query(client, PathFor(maxIdentifier), ct)).Hits).Id);
            Assert.Empty((await Query(client, PathFor(maxIdentifier + "2"), ct)).Hits);
            foreach (var (term, sort, page, size, total, expected) in new (string, string, int, int, int, IEnumerable<int>)[]
            {
                ("needle", "latest", 1, 2, 5, [3, 4]),
                ("needle", "latest", 2, 2, 5, [5, 1]),
                ("needle", "latest", 3, 2, 5, [2]),
                ("needle", "latest", 4, 2, 5, []),
                ("common", "relevance", 21, 10, 205, Enumerable.Range(1001, 5).Reverse()),
            })
            {
                var (hits, _, gotTotal) = await Query(client, PagePath(term, sort, page, size), ct);
                Assert.Equal(total, gotTotal);
                Assert.Equal(expected, hits.Select(item => item.Id));
            }
            var after = await Mark(evidence, output, "measure-after", ct);
            Assert.Equal(17, Count(after, "requestStatus200") - Count(before, "requestStatus200"));
            Assert.Equal(Count(before, "dbCommandStarts"), Count(after, "dbCommandStarts"));
            Assert.Equal(Count(before, "dbPhysicalOpenStarts"), Count(after, "dbPhysicalOpenStarts"));
            using (var corpus = await client.GetAsync(WireRoutes.PublicSearchCorpus, ct))
                Assert.Equal(generation, Assert.Single(corpus.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
            foreach (var bad in new[] { WireRoutes.PublicSearch, $"{PathFor("needle")}&sort=hot", $"{PathFor("needle")}&page=0", $"{PathFor("needle")}&size=101" })
                await ExpectError(client, bad, BadRequest, ct);

            var retract = Wire.EncodeArticleCommand(new(1, 1, Guid.NewGuid(), "", ""));
            await fixture.Exec("alter table public.blog_outbox add constraint block_fas4_refresh check (kind <> 'retract' or processed_at is null)");
            await SiteAedsFixture.SendStatus(client, HttpMethod.Post, WireRoutes.Retract, retract, token, null, ServiceUnavailable, ct);
            await ExpectError(client, PathFor("needle"), ServiceUnavailable, ct);
            await fixture.Exec("alter table public.blog_outbox drop constraint block_fas4_refresh");
            await SiteAedsFixture.SendStatus(client, HttpMethod.Post, WireRoutes.Retract, retract, token, null, OK, ct);
            var (current, newGeneration, _) = await Query(client, PathFor("needle"), ct);
            Assert.Equal([4, 5, 2, 3], current.Select(item => item.Id));
            Assert.NotEqual(generation, newGeneration);
        }
    }

    [PostgresFact]
    public async Task PublicSearchModeConfigControlsHtmlMetaAndFailsFastOnInvalidValue()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using (var autoServer = await ServerProcess.Start(fixture.ConnectionString, ct))
            Assert.DoesNotContain("fsus-public-search-mode", await autoServer.Client.GetStringAsync("/search", ct), StringComparison.Ordinal);
        foreach (var mode in new[] { "server", "local" })
        {
            await using var modeServer = await ServerProcess.Start(fixture.ConnectionString, ct,
                new Dictionary<string, string> { ["FSUSBLOG_PUBLIC_SEARCH_MODE"] = mode });
            Assert.Contains($"<meta name=\"fsus-public-search-mode\" content=\"{mode}\">",
                await modeServer.Client.GetStringAsync("/search", ct), StringComparison.Ordinal);
        }
        var failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string> { ["FSUSBLOG_PUBLIC_SEARCH_MODE"] = "hybrid" }));
        Assert.Contains("FSUSBLOG_PUBLIC_SEARCH_MODE", failure.Message, StringComparison.Ordinal);
    }

    [PostgresFact]
    public async Task DedicatedFas4SupportsLatestSortBoundedPaginationAndZeroDbQueries()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (author, _, _) = await fixture.SignIn("FAS4 paged author", ct, minutes: 1);
        await fixture.InTx(async (db, tx) =>
        {
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.article (id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at)
                overriding system value
                select id,$1,1,title,body,1,1,false,
                       timestamptz '2024-01-01 UTC' + offset_days * interval '1 day',timestamptz '2024-01-01 UTC'
                from (
                    values
                        (1,'Needle Needle Needle','silence',0),(2,'Quiet','Needle',3),(3,'Summary','Needle',2),
                        (4,'Batch-ITEM_7','silence',1),(5,'Job','Section `BATCH-ITEM_7`',4)
                ) fixture(id,title,body,offset_days)
                union all
                select id,$1,1,'Common Entry','silence',1,1,false,
                       timestamptz '2024-01-01 UTC' + (id - 1000) * interval '1 minute',timestamptz '2024-01-01 UTC'
                from generate_series(1001,1205) id
                """, author);
            await FixtureSql.ExecuteAsync(db, tx, ct, PublicationFixture.AllCurrentArticlesWithDefaultRights);
        }, ct);

        var evidence = Directory.CreateTempSubdirectory("fsusv2-fas4-paged-");
        using (new MediaFixture.DirectoryCleanup(evidence))
        {
            var output = Path.Combine(evidence.FullName, "runtime.ndjson");
            await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
            {
                ["FSUSBLOG_RUNTIME_EVIDENCE_CONTROL"] = evidence.FullName,
                ["FSUSBLOG_RUNTIME_EVIDENCE_OUTPUT"] = output
            });
            var client = server.Client;
            var before = await Mark(evidence, output, "measure-before", ct);
            foreach (var (term, sort, page, size, total, expected) in new (string, string, int, int, int, int[])[]
            {
                ("needle", "relevance", 1, 10, 3, [1, 2, 3]),
                ("needle", "latest", 1, 2, 3, [2, 3]),
                ("needle", "latest", 2, 2, 3, [1]),
                ("needle", "latest", 3, 2, 3, []),
                ("batch-item_7", "relevance", 1, 10, 2, [4, 5]),
                ("batch-item_7", "latest", 1, 10, 2, [5, 4]),
                ("common", "relevance", 21, 10, 205, [1005, 1004, 1003, 1002, 1001]),
            })
            {
                var (hits, _, gotTotal) = await Query(client, PagePath(term, sort, page, size), ct);
                Assert.Equal(total, gotTotal);
                Assert.Equal(expected, hits.Select(item => item.Id));
            }
            var after = await Mark(evidence, output, "measure-after", ct);
            Assert.Equal(7, Count(after, "requestStatus200") - Count(before, "requestStatus200"));
            Assert.Equal(Count(before, "dbCommandStarts"), Count(after, "dbCommandStarts"));
            Assert.Equal(Count(before, "dbPhysicalOpenStarts"), Count(after, "dbPhysicalOpenStarts"));
            foreach (var bad in new[] { "&sort=hot", "&page=0", "&page=10001", "&size=0", "&size=101" })
                await ExpectError(client, PathFor("needle") + bad, BadRequest, ct);
        }
    }

    private static async Task<(Hit[] Hits, string Generation, int Total)> Query(HttpClient client, string path, CancellationToken ct)
    {
        using var response = Ok(await client.GetAsync(path, ct));
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
        return (ReadHits(await response.Content.ReadAsByteArrayAsync(ct)),
            Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration)),
            int.Parse(Assert.Single(response.Headers.GetValues(WireHeaders.SearchTotal))));
    }

    private static async Task ExpectError(HttpClient client, string path, HttpStatusCode status, CancellationToken ct) =>
        Aeds.Decode(await ExpectBytes(status, client.GetAsync(path, ct), ct), FrameType.ApiError);

    private static async Task<JsonElement> Mark(DirectoryInfo evidence, string output, string name, CancellationToken ct)
    {
        var staging = Path.Combine(evidence.FullName, "stage");
        await File.WriteAllTextAsync(staging, name, ct);
        File.Move(staging, Path.Combine(evidence.FullName, "runtime.mark"));
        while (!File.Exists(Path.Combine(evidence.FullName, name + ".ack"))) await Task.Delay(20, ct);
        var matches = new List<JsonElement>();
        foreach (var line in await File.ReadAllLinesAsync(output, ct))
        {
            using var row = JsonDocument.Parse(line);
            if (row.RootElement.GetProperty("mark").GetString() == name) matches.Add(row.RootElement.Clone());
        }
        return Assert.Single(matches);
    }

    private static string PathFor(string keyword) => $"{WireRoutes.PublicSearch}?q={Uri.EscapeDataString(keyword)}";
    private static string PagePath(string keyword, string sort, int page, int size) =>
        $"{PathFor(keyword)}&sort={Uri.EscapeDataString(sort)}&page={page}&size={size}";
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

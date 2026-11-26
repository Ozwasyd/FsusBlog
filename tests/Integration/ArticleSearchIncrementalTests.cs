using System.Diagnostics;

namespace FsusBlog.V2.Integration.Tests;

public sealed class ArticleSearchIncrementalTests
{
    private static readonly DateTimeOffset BaseTime = DateTimeOffset.FromUnixTimeMilliseconds(1_760_000_000_000);
    private static readonly WebPages EmptyPages = new("<html><body><!--fsus-public-content--></body></html>");

    [Fact]
    public void ServerOnlyModeSkipsLocalCorpusArtifactsPreservesRestartDeterminismAndBindsAllInputs()
    {
        var articles = Enumerable.Range(1, 25).Select(MakeArticle).ToArray();
        var cursor = new PublicListCursor(TimeProvider.System);

        var serverOnly1 = CreateSnapshot(1, articles, previous: null, cursor, buildLocalCorpus: false);
        var serverOnlyRestart = CreateSnapshot(1, articles, previous: null, cursor, buildLocalCorpus: false);
        var corpusEnabled = CreateSnapshot(1, articles, previous: null, cursor, buildLocalCorpus: true);

        // Zero local corpus artifacts built or retained in server-only mode
        Assert.Equal((0, 0), (serverOnly1.CorpusPageCount, serverOnly1.ReusedCorpusPageCount));
        Assert.Null(serverOnly1.Corpus(1));
        Assert.True(serverOnly1.HasSearchIndex);
        Assert.Equal(25, serverOnly1.SearchBuildStats.TotalLiveDocuments);

        // 100% deterministic across cold restart, and domain-separated from corpus-enabled mode
        Assert.Equal(serverOnly1.Generation, serverOnlyRestart.Generation);
        Assert.NotEqual(corpusEnabled.Generation, serverOnly1.Generation);

        // Every visibility/content/coordinate/taxonomy/cover/epoch change MUST advance PublicGeneration even when corpus is disabled!
        var mutators = new (string Name, Func<Article[], Article[]> Mutate, long Epoch)[]
        {
            ("Body change at identical coordinates", a => Replace(a, 0, a[0] with { Body = a[0].Body + " modified_body" }), 0),
            ("Title change at identical coordinates", a => Replace(a, 0, a[0] with { Title = a[0].Title + "!" }), 0),
            ("Summary change at identical coordinates", a => Replace(a, 0, a[0] with { Summary = "new summary" }), 0),
            ("Taxonomy rename at identical coordinates", a => Replace(a, 0, a[0] with { Category = new TaxonomyName(1, "RenamedCat") }), 0),
            ("Tag change at identical coordinates", a => Replace(a, 0, a[0] with { Tags = [new TaxonomyName(99, "ExtraTag")] }), 0),
            ("Publication coordinate change", a => Replace(a, 0, a[0] with { Publication = a[0].Publication + 100 }), 0),
            ("Cover digest change", a => Replace(a, 0, a[0] with { CoverMediaDigest = new string('a', 64) }), 0),
            ("TaxonomyEpoch change", a => a, 7),
            ("Withdrawal", a => a[..^1], 0),
        };

        foreach (var (name, mutate, epoch) in mutators)
        {
            var mutated = mutate(articles);
            var next = CreateSnapshot(2, mutated, previous: serverOnly1, cursor, taxonomyEpoch: epoch, buildLocalCorpus: false);
            Assert.Equal(0, next.CorpusPageCount);
            Assert.NotEqual(serverOnly1.Generation, next.Generation);
            // Verify restart determinism of the mutated state too
            var restarted = CreateSnapshot(2, mutated, previous: null, cursor, taxonomyEpoch: epoch, buildLocalCorpus: false);
            Assert.Equal(next.Generation, restarted.Generation);

            // Verify incremental search index skipped unchanged articles
            if (name != "TaxonomyEpoch change" && name != "Cover digest change")
            {
                Assert.True(next.SearchBuildStats.SkippedAnalysisDocuments >= 24,
                    $"[{name}] expected >=24 skipped unchanged docs, got {next.SearchBuildStats}");
            }
            else
            {
                Assert.Equal(0, next.SearchBuildStats.AnalyzedDocuments);
                Assert.Equal(25, next.SearchBuildStats.SkippedAnalysisDocuments);
            }
        }

        static Article[] Replace(Article[] source, int idx, Article replacement)
        {
            var copy = (Article[])source.Clone();
            copy[idx] = replacement;
            return copy;
        }
    }

    [Fact]
    public async Task ConcurrentReadersObserveCoherentGenerationsAndNeverSeeWithdrawnDocsAcrossCompaction()
    {
        var cursor = new PublicListCursor(TimeProvider.System);
        var articles = Enumerable.Range(1, 80).Select(id => MakeArticle(id) with
        {
            Body = id <= 10 ? $"canary_doc_{id} shared_reader_token" : $"shared_reader_token body {id}"
        }).ToList();

        var projection = new PublicProjection();
        var current = CreateSnapshot(1, articles, previous: null, cursor, buildLocalCorpus: false);
        projection.Replace(current);

        // Track withdrawn canaries paired with the exact generation where they were removed
        var withdrawnLock = new object();
        var withdrawnByGen = new Dictionary<long, string[]>();
        var retiredCanaries = new List<string>();

        using var stop = new CancellationTokenSource();
        var readerErrors = new System.Collections.Concurrent.ConcurrentQueue<Exception>();
        var totalReads = 0;

        // Use cooperative async reader tasks (yielding each iteration) so concurrent xUnit tests
        // on low-core CI runners never suffer .NET ThreadPool starvation during heartbeat/lease checks.
        var readers = Enumerable.Range(0, 4).Select(workerId => Task.Run(async () =>
        {
            var iter = 0;
            while (!stop.IsCancellationRequested)
            {
                try
                {
                    var snap = projection.Current?.Source;
                    if (snap is null)
                    {
                        await Task.Yield();
                        continue;
                    }
                    var gen = snap.Generation;

                    string[]? forbidden;
                    lock (withdrawnLock)
                        withdrawnByGen.TryGetValue(gen, out forbidden);

                    var shared = Wire.DecodePublicSearchResult(
                        snap.SearchV2("shared_reader_token", ArticleSearchSort.Relevance, 10, null, CancellationToken.None));
                    Assert.Equal(gen, shared.Generation);
                    Assert.Equal(snap.PublicArticleCount, shared.TotalCount);

                    if (forbidden is { Length: > 0 })
                    {
                        // Check the most recently withdrawn canary plus one rotating historical canary each pass
                        var latest = forbidden[^1];
                        var latestRes = Wire.DecodePublicSearchResult(
                            snap.SearchV2(latest, ArticleSearchSort.Relevance, 5, null, CancellationToken.None));
                        Assert.Equal(gen, latestRes.Generation);
                        Assert.Empty(latestRes.Items);
                        Assert.Equal(0, latestRes.TotalCount);

                        var historical = forbidden[(workerId + iter) % forbidden.Length];
                        if (historical != latest)
                        {
                            var histRes = Wire.DecodePublicSearchResult(
                                snap.SearchV2(historical, ArticleSearchSort.Relevance, 5, null, CancellationToken.None));
                            Assert.Equal(gen, histRes.Generation);
                            Assert.Empty(histRes.Items);
                            Assert.Equal(0, histRes.TotalCount);
                        }
                    }

                    Interlocked.Increment(ref totalReads);
                    iter++;
                    await Task.Yield();
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    readerErrors.Enqueue(ex);
                    return;
                }
            }
        })).ToArray();

        // Run 16 incremental publishes, edits, withdrawals, and compactions while readers actively query!
        for (var step = 1; step <= 16; step++)
        {
            if (step <= 10)
            {
                articles.RemoveAll(a => a.Id == step);
                retiredCanaries.Add($"canary_doc_{step}");
            }
            articles.Add(MakeArticle(1000 + step) with { Body = $"shared_reader_token wave_{step}" });

            var next = CreateSnapshot(step + 1, articles, previous: current, cursor, buildLocalCorpus: false);
            lock (withdrawnLock)
                withdrawnByGen[next.Generation] = [.. retiredCanaries];

            var readsBefore = Volatile.Read(ref totalReads);
            projection.Replace(next);
            current = next;

            // Let concurrent readers observe this generation without spinning the ThreadPool
            var waitStart = Stopwatch.GetTimestamp();
            while (Volatile.Read(ref totalReads) - readsBefore < 4 &&
                   Stopwatch.GetElapsedTime(waitStart) < TimeSpan.FromMilliseconds(100))
            {
                await Task.Delay(1);
            }
        }

        stop.Cancel();
        await Task.WhenAll(readers);
        Assert.Empty(readerErrors);
        Assert.True(Volatile.Read(ref totalReads) >= 32, $"Expected active concurrent reads, got {totalReads}.");

        // Final exhaustive sweep on the compacted generation confirming zero withdrawn canaries exist
        foreach (var canary in retiredCanaries)
        {
            var finalRes = Wire.DecodePublicSearchResult(
                current.SearchV2(canary, ArticleSearchSort.Relevance, 10, null, CancellationToken.None));
            Assert.Empty(finalRes.Items);
            Assert.Equal(0, finalRes.TotalCount);
        }
    }

    [Fact]
    public async Task CoordinatorBoundsSimultaneousCandidatesSupersedesStaleWorkAndFencesInstallationAndLease()
    {
        using var coordinator = new PublicSnapshotCoordinator();
        var activeValue = "initial";

        // 1. Slow candidate A starts at epoch 0; Invalidate advances to epoch 1 -> A is cancelled immediately,
        //    candidate B runs strictly AFTER A releases the single-candidate gate (PeakActiveBuilds == 1)!
        var epochA = coordinator.CurrentEpoch;
        var aStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var aObservedCancel = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var taskA = Task.Run(() => coordinator.BuildCandidateAsync(
            epochA,
            ct =>
            {
                aStarted.SetResult();
                try { ct.WaitHandle.WaitOne(TimeSpan.FromSeconds(5)); }
                catch (ObjectDisposedException) { }
                ct.ThrowIfCancellationRequested();
                return "candidate-A";
            },
            CancellationToken.None,
            CancellationToken.None));

        await aStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var epochB = coordinator.Invalidate(() => activeValue = "invalidated");

        var resA = await taskA.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(resA.StillCurrent);
        Assert.True(coordinator.SupersededCount >= 1);

        var resB = await coordinator.BuildCandidateAsync(epochB, _ => "candidate-B", CancellationToken.None, CancellationToken.None);
        Assert.True(resB.StillCurrent);
        Assert.Equal("candidate-B", resB.Candidate);
        Assert.True(coordinator.TryCommitCandidate(epochB, () => true, () => activeValue = resB.Candidate!));
        Assert.Equal("candidate-B", activeValue);
        Assert.Equal(1, coordinator.PeakActiveBuilds);

        // 2. Generation-installation race: an obsolete candidate attempting to commit with stale epoch MUST be rejected!
        Assert.False(coordinator.TryCommitCandidate(epochA, () => true, () => activeValue = "stale-A"));
        Assert.Equal("candidate-B", activeValue);
        Assert.Equal(1, coordinator.RejectedInstallCount);

        // 3. Lease loss right before commit: MUST reject installation even with matching epoch!
        var epochC = coordinator.CurrentEpoch;
        Assert.False(coordinator.TryCommitCandidate(epochC, () => false, () => activeValue = "lost-lease"));
        Assert.Equal("candidate-B", activeValue);
        Assert.Equal(2, coordinator.RejectedInstallCount);

        // 4. Lease-stop CancellationToken cancels an active build cleanly with OperationCanceledException
        using var leaseStop = new CancellationTokenSource();
        var cStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var taskC = Task.Run(() => coordinator.BuildCandidateAsync(
            epochC,
            ct =>
            {
                cStarted.SetResult();
                ct.WaitHandle.WaitOne(TimeSpan.FromSeconds(5));
                ct.ThrowIfCancellationRequested();
                return "candidate-C";
            },
            CancellationToken.None,
            leaseStop.Token));
        await cStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        leaseStop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => taskC.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(0, coordinator.ActiveBuilds);
    }

    [PostgresFact]
    public async Task PostgresIncrementalUpdatesSkipUnchangedDocsPreventWithdrawnLeaksAndKeepZeroSqlOnSearch()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        var (author, token, _) = await fixture.SignIn("Incremental author", ct, canAuthor: true, minutes: 2);
        await fixture.InTx(async (db, tx) =>
        {
            await FixtureSql.ExecuteAsync(db, tx, ct, "insert into public.category (id, name) overriding system value values (1, 'Platform'), (2, 'Storage')");
            await FixtureSql.ExecuteAsync(db, tx, ct, "insert into public.tag (id, name) overriding system value values (1, 'SearchTag')");
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.article (id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at)
                overriding system value
                select id,$1,1,'Incremental Base ' || id,'SharedIncrementalToken body content for article ' || id ||
                    case when id = 5 then ' target_withdraw_canary_5' else '' end,
                    1,1,false,timestamptz '2025-01-01 UTC' + id * interval '1 minute',timestamptz '2025-01-01 UTC' + id * interval '1 minute'
                from generate_series(1, 30) id
                """, author);
            await FixtureSql.ExecuteAsync(db, tx, ct, PublicationFixture.AllCurrentArticlesWithDefaultRights);
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.article_revision_category (article_id, revision, category_id)
                select id, 1, case when id <= 15 then 1 else 2 end from generate_series(1, 30) id
                """);
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.article_revision_tag (article_id, revision, tag_id)
                select id, 1, 1 from generate_series(1, 30) id
                """);
        }, ct);

        using var evidence = new RuntimeEvidenceFixture("fsusblog-inc-ev-");
        await using var server = await evidence.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            ["FSUSBLOG_LOCAL_SEARCH_CORPUS"] = "false",
            ["FSUSBLOG_WIDE_SEARCH_CORPUS"] = "false",
        });
        var client = server.Client;

        // 1. Initial V2 search works, local & wide corpus endpoints return 404
        var initial = Wire.DecodePublicSearchResult(await ExpectBytes(OK, client.GetAsync($"{WireRoutes.PublicSearchV2}?q=SharedIncrementalToken&size=10", ct), ct));
        Assert.Equal((30, PublicSearchTotalRelation.Exact, true), (initial.TotalCount, initial.TotalRelation, initial.HasMore));
        Assert.NotEmpty(initial.NextCursor);
        await CheckStatusAsync(NotFound, client.GetAsync(WireRoutes.PublicSearchCorpus, ct));
        await CheckStatusAsync(NotFound, client.GetAsync(WireRoutes.PublicSearchWideManifest, ct));

        // 2. Edit article 10 -> generation changes, old cursor gets 409, edited token immediately searchable!
        var saved = await SiteAedsFixture.SaveDraft(client, token, null, 10, 1, "Incremental Edited 10",
            "SharedIncrementalToken body edited_token_inc_10", ct);
        var pub = await SiteAedsFixture.ArticleCommand(client, WireRoutes.Publish, token, null, new(saved.Id, saved.Revision, Guid.NewGuid(), "", ""), ct);
        Assert.True(pub.Published);

        var staleCursorUrl = $"{WireRoutes.PublicSearchV2}?q=SharedIncrementalToken&size=10&cursor={Uri.EscapeDataString(initial.NextCursor)}";
        await CheckStatusAsync(Conflict, client.GetAsync(staleCursorUrl, ct));

        var afterEdit = Wire.DecodePublicSearchResult(await ExpectBytes(OK, client.GetAsync($"{WireRoutes.PublicSearchV2}?q=edited_token_inc_10&size=10", ct), ct));
        Assert.NotEqual(initial.Generation, afterEdit.Generation);
        Assert.Equal([10], afterEdit.Items.Select(static i => i.Id));

        // 3. Withdraw article 5 -> immediately unsearchable, count drops to 29!
        var retracted = await SiteAedsFixture.ArticleCommand(client, WireRoutes.Retract, token, null, new(5, 1, Guid.NewGuid(), "", ""), ct);
        Assert.False(retracted.Published);

        var before = await evidence.Mark("measure-before", ct);
        var canaryRes = Wire.DecodePublicSearchResult(await ExpectBytes(OK, client.GetAsync($"{WireRoutes.PublicSearchV2}?q=target_withdraw_canary_5&size=10", ct), ct));
        var countRes = Wire.DecodePublicSearchResult(await ExpectBytes(OK, client.GetAsync($"{WireRoutes.PublicSearchV2}?q=SharedIncrementalToken&size=10", ct), ct));
        var after = await evidence.Mark("measure-after", ct);

        Assert.Empty(canaryRes.Items);
        Assert.Equal(0, canaryRes.TotalCount);
        Assert.Equal(29, countRes.TotalCount);
        Assert.NotEqual(afterEdit.Generation, countRes.Generation);

        // Verify ZERO SQL commands and ZERO physical DB connections during search!
        RuntimeEvidenceFixture.AssertNoDatabaseActivity(before, after);

        // 4. Republish article 5 -> immediately visible again, count returns to 30!
        var repub = await SiteAedsFixture.ArticleCommand(client, WireRoutes.Publish, token, null, new(5, retracted.Revision, Guid.NewGuid(), "", ""), ct);
        Assert.True(repub.Published);
        var repubRes = Wire.DecodePublicSearchResult(await ExpectBytes(OK, client.GetAsync($"{WireRoutes.PublicSearchV2}?q=target_withdraw_canary_5&size=10", ct), ct));
        Assert.Equal([5], repubRes.Items.Select(static i => i.Id));

        // 5. Directly verify in-process Publications against real PostgreSQL rows: edit analyzes 1 & skips unchanged, withdraw analyzes 0!
        await using var dataSource = NpgsqlDataSource.Create(fixture.ConnectionString);
        var store = new Store(dataSource);
        var publications = new Publications(dataSource, EmptyPages, NullLogger<Publications>.Instance, buildLocalCorpus: false);
        await publications.Refresh(ct);
        var snap0 = Assert.IsType<PublicSnapshot>(publications.Snapshot);
        Assert.Equal((30, 0, "full-cold"), (snap0.SearchBuildStats.TotalLiveDocuments, snap0.CorpusPageCount, snap0.SearchBuildStats.BuildMode));

        var draftRes = await publications.Command(store, token, ArticleAction.Save,
            new Edit(12, 1, Guid.NewGuid(), "Direct Inc 12", "SharedIncrementalToken direct_inc_edit_12"), ct);
        var pubRes = await publications.Command(store, token, ArticleAction.Publish,
            new Edit(12, draftRes.Article.Revision, Guid.NewGuid(), "", ""), ct);
        Assert.True(pubRes.Changed);
        var snap1 = Assert.IsType<PublicSnapshot>(publications.Snapshot);
        Assert.Equal((1, 29, 1, 0), (
            snap1.SearchBuildStats.AnalyzedDocuments,
            snap1.SearchBuildStats.SkippedAnalysisDocuments,
            snap1.SearchBuildStats.ReusedSegments,
            snap1.CorpusPageCount));
        Assert.Equal("incremental", snap1.SearchBuildStats.BuildMode);

        var retRes = await publications.Command(store, token, ArticleAction.Retract,
            new Edit(12, pubRes.Article.Revision, Guid.NewGuid(), "", ""), ct);
        Assert.True(retRes.Changed);
        var snap2 = Assert.IsType<PublicSnapshot>(publications.Snapshot);
        Assert.Equal((0, 29, 1), (
            snap2.SearchBuildStats.AnalyzedDocuments,
            snap2.SearchBuildStats.SkippedAnalysisDocuments,
            snap2.SearchBuildStats.RemovedDocuments));
        Assert.Empty(Wire.DecodePublicSearchResult(snap2.SearchV2("direct_inc_edit_12", ArticleSearchSort.Relevance, 10, null, ct)).Items);
    }

    [PostgresFact]
    public async Task PostgresModeCombinationsPreserveEndpointsAndRestartDeterminism()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        var (author, _, _) = await fixture.SignIn("Modes author", ct, canAuthor: true, minutes: 2);
        await fixture.InTx(async (db, tx) =>
        {
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.article (id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at)
                overriding system value
                select id,$1,1,'Mode Article ' || id,'DeterministicModeNeedle article ' || id,1,1,false,
                       timestamptz '2025-02-01 UTC' + id * interval '1 minute',timestamptz '2025-02-01 UTC' + id * interval '1 minute'
                from generate_series(1, 8) id;
                """, author);
            await FixtureSql.ExecuteAsync(db, tx, ct, PublicationFixture.AllCurrentArticlesWithDefaultRights);
        }, ct);

        // Mode A: default (server + local corpus enabled) — check restart determinism
        long genCorpus1, genCorpus2;
        await using (var s1 = await ServerProcess.Start(fixture.ConnectionString, ct))
        {
            var r1 = Wire.DecodePublicSearchResult(await ExpectBytes(OK, s1.Client.GetAsync($"{WireRoutes.PublicSearchV2}?q=DeterministicModeNeedle&size=10", ct), ct));
            Assert.Equal(8, r1.TotalCount);
            genCorpus1 = r1.Generation;
            await CheckStatusAsync(OK, s1.Client.GetAsync(WireRoutes.PublicSearchCorpus, ct));
        }
        await using (var s2 = await ServerProcess.Start(fixture.ConnectionString, ct))
        {
            var r2 = Wire.DecodePublicSearchResult(await ExpectBytes(OK, s2.Client.GetAsync($"{WireRoutes.PublicSearchV2}?q=DeterministicModeNeedle&size=10", ct), ct));
            genCorpus2 = r2.Generation;
        }
        Assert.Equal(genCorpus1, genCorpus2);

        // Mode B: server-only (local & wide corpus disabled) — 404 on corpus endpoints, deterministic across restart, domain-separated from Mode A
        long genServerOnly1, genServerOnly2;
        var serverOnlyEnv = new Dictionary<string, string>
        {
            ["FSUSBLOG_PUBLIC_SEARCH_MODE"] = "server",
            ["FSUSBLOG_LOCAL_SEARCH_CORPUS"] = "false",
            ["FSUSBLOG_WIDE_SEARCH_CORPUS"] = "false",
        };
        await using (var s3 = await ServerProcess.Start(fixture.ConnectionString, ct, serverOnlyEnv))
        {
            var r3 = Wire.DecodePublicSearchResult(await ExpectBytes(OK, s3.Client.GetAsync($"{WireRoutes.PublicSearchV2}?q=DeterministicModeNeedle&size=10", ct), ct));
            Assert.Equal(8, r3.TotalCount);
            genServerOnly1 = r3.Generation;
            await CheckStatusAsync(NotFound, s3.Client.GetAsync(WireRoutes.PublicSearchCorpus, ct));
            await CheckStatusAsync(NotFound, s3.Client.GetAsync(WireRoutes.PublicSearchWideManifest, ct));
        }
        await using (var s4 = await ServerProcess.Start(fixture.ConnectionString, ct, serverOnlyEnv))
        {
            var r4 = Wire.DecodePublicSearchResult(await ExpectBytes(OK, s4.Client.GetAsync($"{WireRoutes.PublicSearchV2}?q=DeterministicModeNeedle&size=10", ct), ct));
            genServerOnly2 = r4.Generation;
        }
        Assert.Equal(genServerOnly1, genServerOnly2);
        Assert.NotEqual(genCorpus1, genServerOnly1);

        // Mode C: auto + local corpus disabled -> boots cleanly, 404 on compact corpus, V2 server search returns 200
        await using (var s5 = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            ["FSUSBLOG_PUBLIC_SEARCH_MODE"] = "auto",
            ["FSUSBLOG_LOCAL_SEARCH_CORPUS"] = "false",
            ["FSUSBLOG_WIDE_SEARCH_CORPUS"] = "false",
        }))
        {
            var html = await OkString(s5.Client.GetAsync("/", ct), ct);
            Assert.Contains("name=\"fsus-public-search-mode\" content=\"auto\"", html, StringComparison.Ordinal);
            await CheckStatusAsync(NotFound, s5.Client.GetAsync(WireRoutes.PublicSearchCorpus, ct));
            var r5 = Wire.DecodePublicSearchResult(await ExpectBytes(OK, s5.Client.GetAsync($"{WireRoutes.PublicSearchV2}?q=DeterministicModeNeedle&size=10", ct), ct));
            Assert.Equal((8, genServerOnly1), (r5.TotalCount, r5.Generation));
        }
    }

    private static Article MakeArticle(int id) => new(
        id, 1, 1000 + id, 1, 1,
        $"Article {id} Title",
        $"## Heading {id}\n\nBody text for article {id} with 性能 and PostgreSQL",
        BaseTime.AddMinutes(id), BaseTime.AddMinutes(id), BaseTime.AddMinutes(id),
        $"Summary {id}",
        new TaxonomyName(1, "Engineering"),
        [new TaxonomyName(10, "Search")]);

    private static PublicSnapshot CreateSnapshot(long watermark, IReadOnlyList<Article> articles,
        PublicSnapshot? previous, PublicListCursor cursor, long taxonomyEpoch = 0, bool buildLocalCorpus = true) =>
        new(watermark, articles, new([], [], []), EmptyPages, cursor, previous, NullLogger.Instance,
            null, null, CancellationToken.None, taxonomyEpoch, buildLocalCorpus: buildLocalCorpus);
}

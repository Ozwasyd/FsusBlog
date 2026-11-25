using System.Diagnostics;
using System.Text.Json;

internal static class SearchEvalRunner
{
    private sealed record EvalCategory(int Id, string Name);
    private sealed record EvalArticle(
        int Id, long Revision, long Publication, int RevisionNo, int PublicationNo,
        string Title, string? Summary, string Body,
        DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, DateTimeOffset PublishedAt,
        EvalCategory? Category, EvalCategory[]? Tags);
    private sealed record EvalCorpusFile(string CorpusVersion, EvalArticle[] Articles);
    private sealed record EvalQuery(string Id, string Split, string Category, string Query, string Rarity, bool ExpectedEmpty);
    private sealed record EvalQueryFile(string QuerySetVersion, EvalQuery[] Queries);

    internal static void Run(string[] args)
    {
        string? corpusPath = null, queriesPath = null, outputPath = null, emitFspkDir = null;
        var iterations = 3;
        var concurrency = 4;
        var churnOps = 12;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--corpus": corpusPath = args[++i]; break;
                case "--queries": queriesPath = args[++i]; break;
                case "--out": outputPath = args[++i]; break;
                case "--emit-fspk-dir": emitFspkDir = args[++i]; break;
                case "--iterations": iterations = int.Parse(args[++i], System.Globalization.CultureInfo.InvariantCulture); break;
                case "--concurrency": concurrency = int.Parse(args[++i], System.Globalization.CultureInfo.InvariantCulture); break;
                case "--churn-ops": churnOps = int.Parse(args[++i], System.Globalization.CultureInfo.InvariantCulture); break;
                default: throw new ArgumentException($"Unknown --search-eval argument: {args[i]}");
            }
        }
        if (corpusPath is null || queriesPath is null || outputPath is null)
            throw new ArgumentException("Usage: --search-eval --corpus FILE --queries FILE --out FILE [--emit-fspk-dir DIR]");

        var jsonOptions = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        var corpusDoc = JsonSerializer.Deserialize<EvalCorpusFile>(File.ReadAllText(corpusPath), jsonOptions)
            ?? throw new InvalidDataException("Invalid corpus JSON");
        var queryDoc = JsonSerializer.Deserialize<EvalQueryFile>(File.ReadAllText(queriesPath), jsonOptions)
            ?? throw new InvalidDataException("Invalid queries JSON");

        var articles = corpusDoc.Articles.Select(a => new Article(
            a.Id, a.Revision, a.Publication, a.RevisionNo, a.PublicationNo,
            a.Title, a.Body, a.CreatedAt, a.UpdatedAt, a.PublishedAt,
            a.Summary,
            a.Category is null ? null : new TaxonomyName(a.Category.Id, a.Category.Name),
            a.Tags?.Select(t => new TaxonomyName(t.Id, t.Name)).ToArray())).ToArray();

        long corpusTextBytes = articles.Sum(a =>
            (long)System.Text.Encoding.UTF8.GetByteCount(a.Title) +
            System.Text.Encoding.UTF8.GetByteCount(a.Summary ?? "") +
            System.Text.Encoding.UTF8.GetByteCount(a.Body));

        // 1. Measure server index build
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        var proc = Process.GetCurrentProcess();
        var memBefore = GC.GetTotalMemory(true);
        var allocBefore = GC.GetTotalAllocatedBytes(true);
        var cpuBefore = proc.TotalProcessorTime;
        var sw = Stopwatch.StartNew();
        var index = ArticleSearchIndex.Build(articles, CancellationToken.None)
            ?? throw new InvalidOperationException("ArticleSearchIndex.Build returned null");
        sw.Stop();
        var buildCpuMs = (proc.TotalProcessorTime - cpuBefore).TotalMilliseconds;
        var buildAllocBytes = GC.GetTotalAllocatedBytes(true) - allocBefore;
        var peakWorkingSet = proc.WorkingSet64;
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        var memAfter = GC.GetTotalMemory(true);
        var retainedIndexBytes = Math.Max(0, memAfter - memBefore);
        var buildWallMs = sw.Elapsed.TotalMilliseconds;

        // 2. Build LocalSearchCorpusSnapshot and optionally emit FSPK v4 pages for Node/TS local evaluator
        var fspkCpuBefore = proc.TotalProcessorTime;
        var fspkAllocBefore = GC.GetTotalAllocatedBytes(true);
        var fspkSw = Stopwatch.StartNew();
        var corpusSnapshot = LocalSearchCorpus.BuildSnapshot(articles, null, CancellationToken.None)
            ?? throw new InvalidOperationException("LocalSearchCorpus.BuildSnapshot returned null");
        fspkSw.Stop();
        var fspkWallMs = fspkSw.Elapsed.TotalMilliseconds;
        var fspkCpuMs = (proc.TotalProcessorTime - fspkCpuBefore).TotalMilliseconds;
        var fspkAllocBytes = GC.GetTotalAllocatedBytes(true) - fspkAllocBefore;
        long fspkTotalBytes = corpusSnapshot.Pages.Sum(p => (long)p.Length);

        if (emitFspkDir is not null)
        {
            Directory.CreateDirectory(emitFspkDir);
            for (var p = 0; p < corpusSnapshot.Pages.Count; p++)
                File.WriteAllBytes(Path.Combine(emitFspkDir, $"page-{p + 1:D3}.fspk"), corpusSnapshot.Pages[p]);
            File.WriteAllText(Path.Combine(emitFspkDir, "manifest.json"), JsonSerializer.Serialize(new
            {
                pageCount = corpusSnapshot.Pages.Count,
                totalBytes = fspkTotalBytes,
                documentCount = articles.Length
            }));
        }

        // 3. Warm-up pass
        foreach (var q in queryDoc.Queries.Take(30))
            _ = index.SearchPage(q.Query, ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);

        // 4. Relevance & per-query pass (also encode FAS4 response bytes to measure real payload bytes)
        var queryResults = new List<object>(queryDoc.Queries.Length);
        var allLatenciesMs = new List<double>(queryDoc.Queries.Length);
        var rareLatenciesMs = new List<double>();
        var commonLatenciesMs = new List<double>();
        long totalResponseBytes = 0;
        var failedCount = 0;

        var qCpuBefore = proc.TotalProcessorTime;
        var qAllocBefore = GC.GetTotalAllocatedBytes(true);
        var qWallSw = Stopwatch.StartNew();
        foreach (var q in queryDoc.Queries)
        {
            var qsw = Stopwatch.StartNew();
            try
            {
                var page = index.SearchPage(q.Query, ArticleSearchSort.Relevance, 1, 20, CancellationToken.None);
                var wireBytes = PublicArticles.EncodeSearch(page.Articles.Take(10).ToArray(), page.Articles.Length > 10 ? 10 : page.Articles.Length);
                qsw.Stop();
                var ms = qsw.Elapsed.TotalMilliseconds;
                allLatenciesMs.Add(ms);
                if (q.Rarity == "rare") rareLatenciesMs.Add(ms);
                else if (q.Rarity == "common") commonLatenciesMs.Add(ms);
                totalResponseBytes += wireBytes.Length;
                queryResults.Add(new
                {
                    id = q.Id,
                    ok = true,
                    total = page.Total,
                    articleIds = page.Articles.Select(a => a.Id).ToArray(),
                    latencyMs = ms,
                    responseBytes = wireBytes.Length
                });
            }
            catch (Exception ex)
            {
                qsw.Stop();
                failedCount++;
                queryResults.Add(new
                {
                    id = q.Id,
                    ok = false,
                    error = ex.GetType().Name,
                    total = 0,
                    articleIds = Array.Empty<int>(),
                    latencyMs = qsw.Elapsed.TotalMilliseconds,
                    responseBytes = 0
                });
            }
        }
        qWallSw.Stop();
        var queryCpuMs = (proc.TotalProcessorTime - qCpuBefore).TotalMilliseconds;
        var queryAllocBytes = GC.GetTotalAllocatedBytes(true) - qAllocBefore;

        // 4b. Measure #47 PublicSearchResult V2 payload bytes & snippet extraction cost + #48 execution stats
        var v2LatenciesMs = new List<double>(queryDoc.Queries.Length);
        var v2RareLatenciesMs = new List<double>();
        var v2CommonLatenciesMs = new List<double>();
        var snippetOnlyLatenciesMs = new List<double>(queryDoc.Queries.Length);
        var v2PayloadBytesList = new List<double>(queryDoc.Queries.Length);
        long v2TotalPayloadBytes = 0;
        var v2SnippetsGenerated = 0;
        long v2PostingsDecoded = 0, v2BlocksVisited = 0, v2BlocksSkipped = 0, v2PositionsRead = 0, v2CandidatesScored = 0, v2PosSkipsByBound = 0;
        var pathCounts = new Dictionary<string, int>();
        var v2CpuBefore = proc.TotalProcessorTime;
        var v2AllocBefore = GC.GetTotalAllocatedBytes(true);
        var v2WallSw = Stopwatch.StartNew();
        foreach (var q in queryDoc.Queries)
        {
            var plan = SearchQueryPlan.Build(q.Query, CancellationToken.None);
            var swTotal = Stopwatch.StartNew();
            var cPage = index.SearchWithCursor(plan, ArticleSearchSort.Relevance, 10, null, 0, CancellationToken.None, out var stats);
            v2PostingsDecoded += stats.PostingsDecoded;
            v2BlocksVisited += stats.BlocksVisited;
            v2BlocksSkipped += stats.BlocksSkipped;
            v2PositionsRead += stats.PositionsRead;
            v2CandidatesScored += stats.CandidatesScored;
            v2PosSkipsByBound += stats.PositionSkipsByBound;
            var pathName = stats.Path.ToString();
            pathCounts[pathName] = pathCounts.GetValueOrDefault(pathName) + 1;

            var swSnip = Stopwatch.StartNew();
            var hits = new PublicSearchHit[cPage.Hits.Length];
            for (var i = 0; i < cPage.Hits.Length; i++)
            {
                var hit = cPage.Hits[i];
                var a = hit.Article;
                var snip = SearchSnippetExtractor.Extract(a, plan, CancellationToken.None);
                v2SnippetsGenerated++;
                hits[i] = new PublicSearchHit(
                    a.Id, a.Revision, a.RevisionNo, a.Publication, a.PublicationNo,
                    a.PublishedAt.ToUnixTimeMilliseconds(), a.CreatedAt.ToUnixTimeMilliseconds(), 0,
                    a.Category?.Id ?? 0, a.Category?.Name ?? "",
                    a.Tags is { Count: > 0 } ts ? ts.Select(static t => new PublicSearchTag(t.Id, t.Name)).ToArray() : [],
                    a.Title, a.Summary ?? "",
                    hit.Tier == SearchMatchTier.Relaxed ? PublicSearchMatchTier.Relaxed : PublicSearchMatchTier.Primary,
                    snip.Field, snip.Text, snip.Highlights);
            }
            swSnip.Stop();
            var v2Frame = Wire.EncodePublicSearchResult(new PublicSearchResult(
                123456789L, index.ProfileVersion, index.AnalyzerVersion,
                cPage.TotalCount, cPage.TotalRelation, cPage.PrimaryCount, cPage.RelaxedCount,
                cPage.HasMore, cPage.HasMore ? new string('A', 162) : "", hits));
            swTotal.Stop();
            var totalMs = swTotal.Elapsed.TotalMilliseconds;
            v2TotalPayloadBytes += v2Frame.Length;
            v2PayloadBytesList.Add(v2Frame.Length);
            v2LatenciesMs.Add(totalMs);
            if (q.Rarity == "rare") v2RareLatenciesMs.Add(totalMs);
            else if (q.Rarity == "common") v2CommonLatenciesMs.Add(totalMs);
            snippetOnlyLatenciesMs.Add(swSnip.Elapsed.TotalMilliseconds);
        }
        v2WallSw.Stop();
        var v2CpuMs = (proc.TotalProcessorTime - v2CpuBefore).TotalMilliseconds;
        var v2AllocBytes = GC.GetTotalAllocatedBytes(true) - v2AllocBefore;

        // 4c. Deterministic 2,500-document multi-block broad-query pruning benchmark (#48)
        var broadBenchmark = RunBroadCorpusPruningBenchmark(articles);

        // 4d. Hit-rate sensitivity & single-flight coalescing benchmark (#50)
        // Measures realistic low (10%), medium (40%), and high (75%) repeat rates plus concurrent burst coalescing
        // against an uncached 0% baseline without relying on unrealistic 100%-hit workloads.
        var cacheSensitivity = RunCacheSensitivityBenchmark(index, queryDoc.Queries, concurrency);

        // 5. Repeated warm query stream vs unique query stream (cache-hit vs cache-miss baseline; currently uncached)
        var hotQueries = queryDoc.Queries.Where(q => q.Rarity == "common").Take(8).ToArray();
        if (hotQueries.Length == 0) hotQueries = queryDoc.Queries.Take(8).ToArray();
        var repeatedLatencies = new List<double>();
        var repCpuBefore = proc.TotalProcessorTime;
        var repAllocBefore = GC.GetTotalAllocatedBytes(true);
        var repSw = Stopwatch.StartNew();
        for (var r = 0; r < iterations * 10; r++)
        {
            var q = hotQueries[r % hotQueries.Length];
            var t = Stopwatch.StartNew();
            _ = index.SearchPage(q.Query, ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
            t.Stop();
            repeatedLatencies.Add(t.Elapsed.TotalMilliseconds);
        }
        repSw.Stop();
        var repCpuMs = (proc.TotalProcessorTime - repCpuBefore).TotalMilliseconds;
        var repAllocBytes = GC.GetTotalAllocatedBytes(true) - repAllocBefore;

        // 6. Concurrent searches
        var concurrentTotal = queryDoc.Queries.Length * Math.Max(1, iterations);
        var concurrentLatencies = new double[concurrentTotal];
        var concurrentFailures = 0;
        var concCpuBefore = proc.TotalProcessorTime;
        var concAllocBefore = GC.GetTotalAllocatedBytes(true);
        var concSw = Stopwatch.StartNew();
        Parallel.For(0, concurrentTotal, new ParallelOptions { MaxDegreeOfParallelism = concurrency }, idx =>
        {
            var q = queryDoc.Queries[idx % queryDoc.Queries.Length];
            var t = Stopwatch.StartNew();
            try
            {
                _ = index.SearchPage(q.Query, ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
            }
            catch
            {
                Interlocked.Increment(ref concurrentFailures);
            }
            t.Stop();
            concurrentLatencies[idx] = t.Elapsed.TotalMilliseconds;
        });
        concSw.Stop();
        var concCpuMs = (proc.TotalProcessorTime - concCpuBefore).TotalMilliseconds;
        var concAllocBytes = GC.GetTotalAllocatedBytes(true) - concAllocBefore;

        // 7. Cancellation check
        var cancelSucceeded = 0;
        var cancelLatencies = new List<double>();
        for (var c = 0; c < 10; c++)
        {
            using var cts = new CancellationTokenSource();
            cts.Cancel();
            var t = Stopwatch.StartNew();
            try
            {
                _ = index.SearchPage("博客搜索 公开页", ArticleSearchSort.Relevance, 1, 10, cts.Token);
            }
            catch (OperationCanceledException)
            {
                cancelSucceeded++;
            }
            t.Stop();
            cancelLatencies.Add(t.Elapsed.TotalMilliseconds);
        }

        // 8. Publication churn (simulated edit / withdraw / republish rebuilds)
        var churnArticles = articles.ToList();
        var prevCorpus = corpusSnapshot;
        var churnServerWall = new List<double>();
        var churnCorpusWall = new List<double>();
        var churnReusedPages = 0;
        var churnTotalPages = 0;
        long churnCorpusRewrittenBytes = 0;
        var churnCpuBefore = proc.TotalProcessorTime;
        var churnAllocBefore = GC.GetTotalAllocatedBytes(true);
        for (var op = 0; op < churnOps; op++)
        {
            var targetIdx = (op * 37) % churnArticles.Count;
            if (op % 3 == 0)
            {
                var orig = churnArticles[targetIdx];
                churnArticles[targetIdx] = orig with
                {
                    Revision = orig.Revision + 1,
                    RevisionNo = orig.RevisionNo + 1,
                    Publication = orig.Publication + 1000,
                    PublicationNo = orig.PublicationNo + 1,
                    Body = orig.Body + $"\nUpdate cycle {op}."
                };
            }
            else if (op % 3 == 1 && churnArticles.Count > 10)
            {
                churnArticles.RemoveAt(churnArticles.Count - 1);
            }
            else
            {
                var newId = 10_000 + op;
                var template = articles[0];
                churnArticles.Add(template with
                {
                    Id = newId,
                    Publication = 200_000 + op,
                    Title = $"Churn published article {newId}",
                    Body = $"Churn article body {op} for incremental indexing baseline."
                });
            }

            var sSw = Stopwatch.StartNew();
            var nextServer = ArticleSearchIndex.Build(churnArticles, CancellationToken.None)
                ?? throw new InvalidOperationException("Churn server build returned null");
            sSw.Stop();
            churnServerWall.Add(sSw.Elapsed.TotalMilliseconds);
            GC.KeepAlive(nextServer);

            var cSw = Stopwatch.StartNew();
            var nextCorpus = LocalSearchCorpus.BuildSnapshot(churnArticles, prevCorpus, CancellationToken.None)
                ?? throw new InvalidOperationException("Churn corpus build returned null");
            cSw.Stop();
            churnCorpusWall.Add(cSw.Elapsed.TotalMilliseconds);
            churnReusedPages += nextCorpus.ReusedPageCount;
            churnTotalPages += nextCorpus.Pages.Count;
            for (var p = 0; p < nextCorpus.Pages.Count; p++)
                if (nextCorpus.ReusedFromPageIndex(p) < 0)
                    churnCorpusRewrittenBytes += nextCorpus.Pages[p].Length;
            prevCorpus = nextCorpus;
        }
        var churnCpuMs = (proc.TotalProcessorTime - churnCpuBefore).TotalMilliseconds;
        var churnAllocBytes = GC.GetTotalAllocatedBytes(true) - churnAllocBefore;

        var report = new
        {
            engine = "server-fas4",
            runtime = Environment.Version.ToString(),
            os = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
            arch = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString(),
            processorCount = Environment.ProcessorCount,
            buildConfig = "Release",
            corpus = new
            {
                version = corpusDoc.CorpusVersion,
                documentCount = articles.Length,
                textBytes = corpusTextBytes,
                serverTermCount = index.TermCount,
                serverPostingCount = index.PostingCount,
                usesWideProfile = index.UsesWideProfile,
                fspkPageCount = corpusSnapshot.Pages.Count,
                fspkTotalBytes
            },
            indexing = new
            {
                serverBuildWallMs = buildWallMs,
                serverBuildCpuMs = buildCpuMs,
                serverBuildAllocBytes = buildAllocBytes,
                serverRetainedBytes = retainedIndexBytes,
                peakWorkingSetBytes = Math.Max(peakWorkingSet, proc.WorkingSet64),
                fspkBuildWallMs = fspkWallMs,
                fspkBuildCpuMs = fspkCpuMs,
                fspkBuildAllocBytes = fspkAllocBytes
            },
            queryPass = new
            {
                offered = queryDoc.Queries.Length,
                succeeded = queryDoc.Queries.Length - failedCount,
                failed = failedCount,
                wallMs = qWallSw.Elapsed.TotalMilliseconds,
                cpuMs = queryCpuMs,
                allocBytes = queryAllocBytes,
                totalResponseBytes,
                latencyMs = Summarize(allLatenciesMs),
                rareLatencyMs = Summarize(rareLatenciesMs),
                commonLatencyMs = Summarize(commonLatenciesMs)
            },
            v2PayloadAndSnippets = new
            {
                queries = queryDoc.Queries.Length,
                snippetsGenerated = v2SnippetsGenerated,
                totalResponseBytes = v2TotalPayloadBytes,
                fas4TotalResponseBytes = totalResponseBytes,
                responseBytes = Summarize(v2PayloadBytesList),
                wallMs = v2WallSw.Elapsed.TotalMilliseconds,
                cpuMs = v2CpuMs,
                allocBytes = v2AllocBytes,
                endToEndLatencyMs = Summarize(v2LatenciesMs),
                rareEndToEndLatencyMs = Summarize(v2RareLatenciesMs),
                commonEndToEndLatencyMs = Summarize(v2CommonLatenciesMs),
                snippetOnlyLatencyMs = Summarize(snippetOnlyLatenciesMs),
                executionStats = new
                {
                    postingsDecoded = v2PostingsDecoded,
                    blocksVisited = v2BlocksVisited,
                    blocksSkipped = v2BlocksSkipped,
                    positionsRead = v2PositionsRead,
                    positionSkipsByBound = v2PosSkipsByBound,
                    candidatesScored = v2CandidatesScored,
                    pathCounts
                }
            },
            broadCorpusPruning = broadBenchmark,
            cacheSensitivity,
            repeatedHot = new
            {
                offered = repeatedLatencies.Count,
                wallMs = repSw.Elapsed.TotalMilliseconds,
                cpuMs = repCpuMs,
                allocBytes = repAllocBytes,
                latencyMs = Summarize(repeatedLatencies)
            },
            concurrent = new
            {
                workers = concurrency,
                offered = concurrentTotal,
                succeeded = concurrentTotal - concurrentFailures,
                failed = concurrentFailures,
                wallMs = concSw.Elapsed.TotalMilliseconds,
                throughputQps = concSw.Elapsed.TotalSeconds > 0 ? (concurrentTotal - concurrentFailures) / concSw.Elapsed.TotalSeconds : 0,
                cpuMs = concCpuMs,
                allocBytes = concAllocBytes,
                latencyMs = Summarize(concurrentLatencies)
            },
            cancellation = new
            {
                attempted = 10,
                cancelledCleanly = cancelSucceeded,
                latencyMs = Summarize(cancelLatencies)
            },
            publicationChurn = new
            {
                operations = churnOps,
                serverRebuildLatencyMs = Summarize(churnServerWall),
                fspkRebuildLatencyMs = Summarize(churnCorpusWall),
                fspkReusedPages = churnReusedPages,
                fspkTotalPages = churnTotalPages,
                fspkRewrittenBytes = churnCorpusRewrittenBytes,
                cpuMs = churnCpuMs,
                allocBytes = churnAllocBytes
            },
            results = queryResults
        };

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))!);
        File.WriteAllText(outputPath, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static object RunBroadCorpusPruningBenchmark(Article[] seedArticles)
    {
        const int totalDocs = 2_500;
        var baseTime = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var docs = new Article[totalDocs];
        for (var i = 0; i < totalDocs; i++)
        {
            var src = seedArticles[i % seedArticles.Length];
            var id = i + 1;
            var pub = i < 20 ? baseTime.AddDays(3000 - i) : baseTime.AddHours(i);
            var title = i < 24
                ? $"{src.Title} 性能 优化 架构"
                : (i is 1200 or 2300 ? $"{src.Title} 性能 优化 架构 量子核" : $"日常记录条目 {id} {src.Title}");
            var body = i < 24
                ? $"## 性能 优化 架构\n\n性能 优化 架构 详解。{src.Body}"
                : $"常规说明段落用于构建多块高频词倒排测试，涵盖 性能 与 架构 以及 优化 相关背景说明{(i < 240 ? "，以及 少见词项" : "")}。{src.Body}";
            docs[i] = src with { Id = id, Publication = 500_000 + id, Title = title, Body = body, PublishedAt = pub, CreatedAt = pub };
        }

        var buildSw = Stopwatch.StartNew();
        var broadIndex = ArticleSearchIndex.Build(docs, CancellationToken.None)
            ?? throw new InvalidOperationException("Broad benchmark index build returned null");
        buildSw.Stop();

        var queries = new (string Label, string Rarity, string Query, ArticleSearchSort Sort)[]
        {
            ("single_common_rel", "common", "性能", ArticleSearchSort.Relevance),
            ("single_common_latest", "common", "性能", ArticleSearchSort.Latest),
            ("conj2_common_rel", "common", "性能 架构", ArticleSearchSort.Relevance),
            ("conj2_common_latest", "common", "性能 架构", ArticleSearchSort.Latest),
            ("relaxed_bmw_score_rel", "common", "性能 优化 架构 少见词项", ArticleSearchSort.Relevance),
            ("relaxed_bmw_elig_rel", "common", "性能 优化 架构 量子核", ArticleSearchSort.Relevance),
            ("relaxed_bmw_latest", "common", "性能 优化 架构 少见词项", ArticleSearchSort.Latest),
            ("rare_exact_rel", "rare", "量子核", ArticleSearchSort.Relevance),
            ("rare_conj_rel", "rare", "量子核 性能", ArticleSearchSort.Relevance)
        };

        // Warm-up
        foreach (var q in queries)
            _ = broadIndex.SearchWithCursor(q.Query, q.Sort, 10, null, 0, CancellationToken.None, out _);

        var rows = new List<object>(queries.Length);
        foreach (var q in queries)
        {
            const int reps = 20;
            var allocBefore = GC.GetTotalAllocatedBytes(true);
            var lats = new double[reps];
            SearchExecutionStats lastStats = default;
            ArticleSearchCursorPage lastPage = default;
            for (var r = 0; r < reps; r++)
            {
                var sw = Stopwatch.StartNew();
                lastPage = broadIndex.SearchWithCursor(q.Query, q.Sort, 10, null, 0, CancellationToken.None, out lastStats);
                sw.Stop();
                lats[r] = sw.Elapsed.TotalMilliseconds;
            }
            var allocPerQuery = (GC.GetTotalAllocatedBytes(true) - allocBefore) / (double)reps;
            rows.Add(new
            {
                label = q.Label,
                rarity = q.Rarity,
                query = q.Query,
                sort = q.Sort.ToString(),
                path = lastStats.Path.ToString(),
                hits = lastPage.Hits.Length,
                totalCount = lastPage.TotalCount,
                totalRelation = lastPage.TotalRelation.ToString(),
                postingsDecoded = lastStats.PostingsDecoded,
                blocksVisited = lastStats.BlocksVisited,
                blocksSkipped = lastStats.BlocksSkipped,
                positionsRead = lastStats.PositionsRead,
                positionSkipsByBound = lastStats.PositionSkipsByBound,
                candidatesScored = lastStats.CandidatesScored,
                allocBytesPerQuery = allocPerQuery,
                latencyMs = Summarize(lats)
            });
        }

        return new
        {
            documentCount = totalDocs,
            termCount = broadIndex.TermCount,
            postingCount = broadIndex.PostingCount,
            blockCount = broadIndex.BlockCount,
            buildWallMs = buildSw.Elapsed.TotalMilliseconds,
            queries = rows
        };
    }

    private static object RunCacheSensitivityBenchmark(ArticleSearchIndex index, EvalQuery[] queries, int concurrency)
    {
        var proc = Process.GetCurrentProcess();
        const long evalGeneration = 900_001L;
        const int streamLength = 300;
        var positiveQueries = queries.Where(static q => !q.ExpectedEmpty).ToArray();
        if (positiveQueries.Length < 10) positiveQueries = queries;

        byte[] ComputeV2Frame(SearchQueryPlan plan, ArticleSearchSort sort, int size, CancellationToken ct)
        {
            var cPage = index.SearchWithCursor(plan, sort, size, null, 0, ct);
            var hits = new PublicSearchHit[cPage.Hits.Length];
            for (var i = 0; i < cPage.Hits.Length; i++)
            {
                var hit = cPage.Hits[i];
                var a = hit.Article;
                var snip = SearchSnippetExtractor.Extract(a, plan, ct);
                hits[i] = new PublicSearchHit(
                    a.Id, a.Revision, a.RevisionNo, a.Publication, a.PublicationNo,
                    a.PublishedAt.ToUnixTimeMilliseconds(), a.CreatedAt.ToUnixTimeMilliseconds(), 0,
                    a.Category?.Id ?? 0, a.Category?.Name ?? "",
                    a.Tags is { Count: > 0 } ts ? ts.Select(static t => new PublicSearchTag(t.Id, t.Name)).ToArray() : [],
                    a.Title, a.Summary ?? "",
                    hit.Tier == SearchMatchTier.Relaxed ? PublicSearchMatchTier.Relaxed : PublicSearchMatchTier.Primary,
                    snip.Field, snip.Text, snip.Highlights);
            }
            return Wire.EncodePublicSearchResult(new PublicSearchResult(
                evalGeneration, index.ProfileVersion, index.AnalyzerVersion,
                cPage.TotalCount, cPage.TotalRelation, cPage.PrimaryCount, cPage.RelaxedCount,
                cPage.HasMore, cPage.HasMore ? new string('A', 162) : "", hits));
        }

        // Build deterministic query streams of REAL matching queries with exact target repeat rates (0%, 10%, 40%, 75%)
        (string Query, ArticleSearchSort Sort, int Size)[] BuildStream(double targetHitRate)
        {
            var hotPool = positiveQueries.Take(12).Select(static q => (q.Query, ArticleSearchSort.Relevance, 10)).ToArray();
            // Pool of > 600 distinct real matching (query, sort, size) requests so unique tail misses execute real search + snippets
            var uniquePool = new List<(string Query, ArticleSearchSort Sort, int Size)>(positiveQueries.Length * 2);
            foreach (var sort in new[] { ArticleSearchSort.Relevance, ArticleSearchSort.Latest })
            {
                foreach (var pq in positiveQueries.Skip(12))
                    uniquePool.Add((pq.Query, sort, 10));
            }
            var result = new (string Query, ArticleSearchSort Sort, int Size)[streamLength];
            var seedCount = targetHitRate > 0 ? Math.Min(hotPool.Length, streamLength) : 0;
            for (var i = 0; i < seedCount; i++) result[i] = hotPool[i];
            var desiredHits = (int)Math.Round(targetHitRate * streamLength);
            var hitCount = 0;
            var uniqueSeq = 0;
            for (var i = seedCount; i < streamLength; i++)
            {
                var remaining = streamLength - i;
                var neededHits = desiredHits - hitCount;
                var pickHit = neededHits > 0 && (neededHits >= remaining || ((i * 7 + 3) % 100) < (int)(targetHitRate * 100));
                if (pickHit)
                {
                    result[i] = hotPool[hitCount % hotPool.Length];
                    hitCount++;
                }
                else
                {
                    result[i] = uniquePool[uniqueSeq % uniquePool.Count];
                    uniqueSeq++;
                }
            }
            return result;
        }

        object MeasureStream(string label, double targetHitRate, bool useCache)
        {
            var stream = BuildStream(targetHitRate);
            var options = new SearchResultCacheOptions(
                MaxEntries: 512,
                MaxRetainedBytes: 8 * 1024 * 1024,
                MaxInFlightKeys: 32,
                MaxWaitersPerKey: 16,
                MaxTotalWaiters: 32,
                MaxRetainedGenerations: 1);
            using var cache = new SearchResultCache(options);
            var lats = new double[stream.Length];
            var cpuBefore = proc.TotalProcessorTime;
            var allocBefore = GC.GetTotalAllocatedBytes(true);
            var swAll = Stopwatch.StartNew();

            for (var i = 0; i < stream.Length; i++)
            {
                var (q, sort, size) = stream[i];
                var sw = Stopwatch.StartNew();
                var plan = SearchQueryPlan.Build(q, CancellationToken.None);
                if (!useCache)
                {
                    _ = ComputeV2Frame(plan, sort, size, CancellationToken.None);
                }
                else
                {
                    var key = new SearchResultCacheKey(
                        SearchCacheEndpointKind.V2, evalGeneration, index.ProfileVersion, index.AnalyzerVersion,
                        index.UsesWideProfile, plan.BuildCanonicalCacheKey(), sort,
                        0, size, true, SearchCursorCacheKey.None, ArticleSearchIndex.MaxPaginatedResults,
                        ArticleSearchIndex.DefaultWorkBudgetCandidates);
                    _ = cache.GetOrExecuteAsync(key, ct => ValueTask.FromResult(new CachedSearchPayload(ComputeV2Frame(plan, sort, size, ct), 0)), CancellationToken.None)
                        .AsTask().GetAwaiter().GetResult();
                }
                sw.Stop();
                lats[i] = sw.Elapsed.TotalMilliseconds;
            }
            swAll.Stop();
            var cpuMs = (proc.TotalProcessorTime - cpuBefore).TotalMilliseconds;
            var allocBytes = GC.GetTotalAllocatedBytes(true) - allocBefore;
            var stats = cache.SnapshotStats();
            var executions = useCache ? stats.Executions : stream.Length;
            var saved = stream.Length - executions;

            return new
            {
                label,
                useCache,
                targetHitRate,
                offered = stream.Length,
                hits = useCache ? stats.Hits : 0L,
                misses = useCache ? stats.Misses : (long)stream.Length,
                coalescedWaiters = stats.CoalescedWaiters,
                executions,
                savedExecutions = saved,
                savedExecutionRate = stream.Length > 0 ? (double)saved / stream.Length : 0.0,
                evictions = stats.Evictions,
                retainedBytes = stats.RetainedBytes,
                maxRetainedBytes = options.MaxRetainedBytes,
                entryCount = stats.EntryCount,
                maxEntries = options.MaxEntries,
                wallMs = swAll.Elapsed.TotalMilliseconds,
                cpuMs,
                allocBytes,
                latencyMs = Summarize(lats)
            };
        }

        // Concurrent burst coalescing benchmark: waves of 8 simultaneous identical requests across 12 distinct queries
        object MeasureConcurrentBurst()
        {
            var burstQueries = positiveQueries.Take(12).Select(static q => q.Query).ToArray();
            var waves = 12;
            var fanout = Math.Max(4, concurrency * 2);
            var totalOffered = waves * fanout;
            var options = new SearchResultCacheOptions(
                MaxEntries: 512,
                MaxRetainedBytes: 8 * 1024 * 1024,
                MaxInFlightKeys: 32,
                MaxWaitersPerKey: 16,
                MaxTotalWaiters: 32,
                MaxRetainedGenerations: 1);
            using var cache = new SearchResultCache(options);
            var lats = new double[totalOffered];
            var cpuBefore = proc.TotalProcessorTime;
            var allocBefore = GC.GetTotalAllocatedBytes(true);
            var swAll = Stopwatch.StartNew();

            for (var w = 0; w < waves; w++)
            {
                var q = burstQueries[w % burstQueries.Length];
                var plan = SearchQueryPlan.Build(q, CancellationToken.None);
                var key = new SearchResultCacheKey(
                    SearchCacheEndpointKind.V2, evalGeneration, index.ProfileVersion, index.AnalyzerVersion,
                    index.UsesWideProfile, plan.BuildCanonicalCacheKey(), ArticleSearchSort.Relevance,
                    0, 10, true, SearchCursorCacheKey.None, ArticleSearchIndex.MaxPaginatedResults,
                    ArticleSearchIndex.DefaultWorkBudgetCandidates);
                using var barrier = new ManualResetEventSlim(false);
                var tasks = new Task[fanout];
                for (var f = 0; f < fanout; f++)
                {
                    var slotIdx = w * fanout + f;
                    tasks[f] = Task.Run(async () =>
                    {
                        barrier.Wait();
                        var sw = Stopwatch.StartNew();
                        _ = await cache.GetOrExecuteAsync(key, ct => ValueTask.FromResult(new CachedSearchPayload(ComputeV2Frame(plan, ArticleSearchSort.Relevance, 10, ct), 0)), CancellationToken.None);
                        sw.Stop();
                        lats[slotIdx] = sw.Elapsed.TotalMilliseconds;
                    });
                }
                barrier.Set();
                Task.WaitAll(tasks);
            }

            swAll.Stop();
            var cpuMs = (proc.TotalProcessorTime - cpuBefore).TotalMilliseconds;
            var allocBytes = GC.GetTotalAllocatedBytes(true) - allocBefore;
            var stats = cache.SnapshotStats();
            var saved = totalOffered - stats.Executions;

            return new
            {
                label = "concurrent_burst",
                waves,
                fanoutPerWave = fanout,
                offered = totalOffered,
                hits = stats.Hits,
                misses = stats.Misses,
                coalescedWaiters = stats.CoalescedWaiters,
                executions = stats.Executions,
                savedExecutions = saved,
                savedExecutionRate = totalOffered > 0 ? (double)saved / totalOffered : 0.0,
                retainedBytes = stats.RetainedBytes,
                maxRetainedBytes = options.MaxRetainedBytes,
                entryCount = stats.EntryCount,
                wallMs = swAll.Elapsed.TotalMilliseconds,
                cpuMs,
                allocBytes,
                latencyMs = Summarize(lats)
            };
        }

        return new
        {
            profiles = new[]
            {
                MeasureStream("uncached_0pct", 0.0, useCache: false),
                MeasureStream("low_hit_10pct", 0.10, useCache: true),
                MeasureStream("medium_hit_40pct", 0.40, useCache: true),
                MeasureStream("high_hit_75pct", 0.75, useCache: true)
            },
            concurrentBurst = MeasureConcurrentBurst()
        };
    }

    private static object Summarize(IReadOnlyList<double> values)
    {
        if (values.Count == 0) return new { count = 0, mean = 0.0, p50 = 0.0, p95 = 0.0, p99 = 0.0, max = 0.0 };
        var sorted = values.OrderBy(static v => v).ToArray();
        return new
        {
            count = sorted.Length,
            mean = sorted.Average(),
            p50 = Percentile(sorted, 0.50),
            p95 = Percentile(sorted, 0.95),
            p99 = Percentile(sorted, 0.99),
            max = sorted[^1]
        };
    }

    private static double Percentile(double[] sorted, double p)
    {
        if (sorted.Length == 1) return sorted[0];
        var rank = p * (sorted.Length - 1);
        var low = (int)Math.Floor(rank);
        var high = (int)Math.Ceiling(rank);
        return low == high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
    }
}

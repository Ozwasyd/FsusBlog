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

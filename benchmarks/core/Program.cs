using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Runtime.Intrinsics;
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Configs;
using BenchmarkDotNet.Jobs;
using BenchmarkDotNet.Running;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Outputs;

if (args.Contains("--verify-contract", StringComparer.Ordinal))
{
    return ContractVerifier.Run();
}

if (args.Contains("--compare-http", StringComparer.Ordinal))
{
    return await HttpParityVerifier.RunAsync(args);
}

BenchmarkRunner.Run<PodMappingBenchmarks>(
    ManualConfig.Create(DefaultConfig.Instance)
        .AddJob(Job.ShortRun));
return 0;

[MemoryDiagnoser]
public class PodMappingBenchmarks
{
    private readonly string _title = "FsusBlog-Article-Title";
    private readonly string _summary = "High frequency mapping benchmark summary";
    private readonly string _snippet = "This snippet emulates a hot-path list projection.";
    private readonly string _content = new('x', 256);
    private readonly string _userName = "benchmark-user";

    private readonly CorePageResult<ArticleListCoreModel> _pageResult;
    private readonly byte[] _encodedArticlePage;
    private readonly PublicAotShellBundleContract _aotBundle;
    private readonly string[] _searchDocuments;
    private readonly Dictionary<string, Dictionary<int, int>> _searchIndex;
    private readonly IAedsEncoder _aedsEncoder;
    private readonly AedsDecoderValidator _aedsValidator;

    public PodMappingBenchmarks()
    {
        _aedsEncoder = new AedsEncoder();
        _aedsValidator = new AedsDecoderValidator(_aedsEncoder);

        var pod = PodProjector.ProjectArticleList(1, 99, DateTime.UtcNow, 2, "分类", _title, _summary, false, out _);
        _pageResult = new CorePageResult<ArticleListCoreModel>(
            [new ArticleListCoreModel(
                pod,
                1,
                _title,
                _summary,
                null,
                _snippet,
                99,
                DateTime.UtcNow,
                new ArticleCategoryCoreModel(2, "分类"),
                [new TagCoreModel(10, "tag-a")],
                false)],
            1);
        _encodedArticlePage = PodBinaryCodec.EncodeArticlePage(_pageResult);
        _aotBundle = new PublicAotShellBundleContract
        {
            GeneratedAtUtc = DateTimeOffset.UtcNow,
            Entries =
            [
                new PublicAotShellEntryContract
                {
                    PageId = PublicPageId.Home,
                    RouteKey = "home",
                    Html = "<main><article>benchmark public AOT shell</article></main>",
                    BootstrapPayload = "bootstrap",
                    HydrationPropsPayload = "props",
                    IslandsPayload = "islands",
                    RendererVersion = "bench-renderer",
                    Title = "Benchmark",
                    BaseUrl = "https://example.test"
                }
            ]
        };
        _searchDocuments = Enumerable.Range(0, 256)
            .Select(i => $"fsus blog search benchmark document {i} category {(i % 8)} tag {(i % 13)} content token {(i % 21)}")
            .ToArray();
        _searchIndex = BuildSyntheticSearchIndex(_searchDocuments);
    }

    [Benchmark(Baseline = true)]
    public int LegacyLike_StringOnly()
    {
        string t = _title;
        string s = _summary;
        string n = _snippet;
        return t.Length + s.Length + n.Length;
    }

    [Benchmark]
    public int ArticleList_PodProjection()
    {
        var pod = PodProjector.ProjectArticleList(1, 99, DateTime.UtcNow, 2, "分类", _title, _summary, false, out var payload);
        return payload.Length + pod.GetHashCode();
    }

    [Benchmark]
    public int CommentItem_PodProjection()
    {
        var pod = PodProjector.ProjectCommentItem(1001, DateTime.UtcNow, _userName, _content, out var payload);
        return payload.Length + pod.GetHashCode();
    }

    [Benchmark]
    public int Stats_PodProjection()
    {
        var pod = PodProjector.ProjectSiteStats(100, 200, 10, 10000, 6000, 4000, 5, 5, 8);
        return pod.GetHashCode() + (Vector256.IsHardwareAccelerated ? 1 : 0);
    }

    [Benchmark]
    public int ArticlePage_PodBinary_RoundTrip()
    {
        byte[] bytes = PodBinaryCodec.EncodeArticlePage(_pageResult);
        bool ok = PodBinaryCodec.TryDecodeArticlePage(bytes, out var result);
        return ok ? result.Items.Count : 0;
    }

    [Benchmark]
    public int CacheHit_ArticlePageDecode()
    {
        bool ok = PodBinaryCodec.TryDecodeArticlePage(_encodedArticlePage, out var result);
        return ok ? result.Items.Count : 0;
    }

    [Benchmark]
    public int CacheHit_RawDefensiveCopy_L1()
    {
        byte[] callerOwned = _encodedArticlePage.ToArray();
        return callerOwned.Length;
    }

    [Benchmark]
    public int CacheHit_RawReadonly_L1()
    {
        ReadOnlyMemory<byte> readonlyPayload = _encodedArticlePage;
        return readonlyPayload.Length;
    }

    [Benchmark]
    public int Aeds_Encode_ArticleList()
    {
        byte[] payload = PodBinaryCodec.EncodeArticlePage(_pageResult);
        byte[] frame = _aedsEncoder.Encode(AedsFrameType.ArticleList, payload);
        return frame.Length;
    }

    [Benchmark]
    public int Aeds_Decode_ArticleList()
    {
        byte[] payload = PodBinaryCodec.EncodeArticlePage(_pageResult);
        byte[] frame = _aedsEncoder.Encode(AedsFrameType.ArticleList, payload);
        var decoded = _aedsEncoder.TryDecode(frame);
        return decoded.IsSuccess ? decoded.Value.Payload.Length : 0;
    }

    [Benchmark]
    public int Aeds_RoundTrip_Validate()
    {
        byte[] payload = PodBinaryCodec.EncodeArticlePage(_pageResult);
        var result = _aedsValidator.ValidateRoundTrip(AedsFrameType.ArticleList, payload);
        return result.IsSuccess ? payload.Length : 0;
    }

    [Benchmark]
    public int PublicAotBundle_Encode()
    {
        byte[] bytes = PodBinaryCodec.EncodePublicAotBundle(_aotBundle);
        return bytes.Length;
    }

    [Benchmark]
    public int PublicAotBundle_Decode()
    {
        byte[] bytes = PodBinaryCodec.EncodePublicAotBundle(_aotBundle);
        bool ok = PodBinaryCodec.TryDecodePublicAotBundle(bytes, out var bundle);
        return ok ? bundle.Entries.Count : 0;
    }

    [Benchmark]
    public int SearchRebuild_SyntheticInvertedIndex()
    {
        Dictionary<string, Dictionary<int, int>> index = BuildSyntheticSearchIndex(_searchDocuments);
        return index.Count;
    }

    [Benchmark]
    public double SearchQuery_SyntheticBm25()
        => QuerySyntheticSearchIndex(_searchIndex, _searchDocuments, ["fsus", "benchmark", "token"]);

    private static Dictionary<string, Dictionary<int, int>> BuildSyntheticSearchIndex(IReadOnlyList<string> documents)
    {
        var index = new Dictionary<string, Dictionary<int, int>>(StringComparer.Ordinal);
        for (int docId = 0; docId < documents.Count; docId++)
        {
            foreach (string token in documents[docId].Split(' ', StringSplitOptions.RemoveEmptyEntries))
            {
                string normalized = token.ToLowerInvariant();
                if (!index.TryGetValue(normalized, out Dictionary<int, int>? postings))
                {
                    postings = [];
                    index[normalized] = postings;
                }

                postings.TryGetValue(docId, out int tf);
                postings[docId] = tf + 1;
            }
        }

        return index;
    }

    private static double QuerySyntheticSearchIndex(
        IReadOnlyDictionary<string, Dictionary<int, int>> index,
        IReadOnlyList<string> documents,
        IReadOnlyList<string> queryTokens)
    {
        double score = 0d;
        double averageLength = documents.Average(static document => document.Length);
        foreach (string token in queryTokens)
        {
            if (!index.TryGetValue(token, out Dictionary<int, int>? postings))
            {
                continue;
            }

            foreach ((int docId, int tf) in postings)
            {
                double idf = Math.Log(1d + ((documents.Count - postings.Count + 0.5d) / (postings.Count + 0.5d)));
                double norm = 1.2d * (1d - 0.75d + (0.75d * documents[docId].Length / Math.Max(averageLength, 1d)));
                score += idf * ((tf * 2.2d) / (tf + norm));
            }
        }

        return score;
    }
}

internal static class ContractVerifier
{
    public static int Run()
    {
        bool articleOk = VerifyArticle();
        bool commentOk = VerifyComment();
        bool statsOk = VerifyStats();
        bool semanticOk = VerifySemanticParity();
        Console.WriteLine($"contract_verify article={articleOk} comment={commentOk} stats={statsOk} semantic={semanticOk}");
        return articleOk && commentOk && statsOk && semanticOk ? 0 : 1;
    }

    private static bool VerifyArticle()
    {
        var pod = PodProjector.ProjectArticleList(11, 23, DateTime.UnixEpoch.AddDays(3), 7, "cat", "title", "summary", false, out _);
        var page = new CorePageResult<ArticleListCoreModel>(
            [new ArticleListCoreModel(
                pod,
                11,
                "title",
                "summary",
                null,
                "snippet",
                23,
                DateTime.UnixEpoch.AddDays(3),
                new ArticleCategoryCoreModel(7, "cat"),
                [new TagCoreModel(2, "tag-a")],
                false)],
            1);

        byte[] bytes = PodBinaryCodec.EncodeArticlePage(page);
        bool ok = PodBinaryCodec.TryDecodeArticlePage(bytes, out var decoded);
        return ok && decoded.Total == 1 && decoded.Items.Count == 1 && decoded.Items[0].Id == 11 && decoded.Items[0].Tags.Count == 1;
    }

    private static bool VerifyComment()
    {
        var pod = PodProjector.ProjectCommentItem(101, DateTime.UnixEpoch.AddMinutes(9), "u1", "hello", out _);
        var source = new CoreCursorResult<CommentQueryCoreModel>(
            [new CommentQueryCoreModel(pod, 101, "hello", DateTime.UnixEpoch.AddMinutes(9), "u1")],
            999,
            true);

        byte[] bytes = PodBinaryCodec.EncodeCommentCursor(source);
        bool ok = PodBinaryCodec.TryDecodeCommentCursor(bytes, out var decoded);
        return ok && decoded.HasMore && decoded.NextCursor == 999 && decoded.Data.Count == 1 && decoded.Data[0].Id == 101;
    }

    private static bool VerifyStats()
    {
        var sitePod = PodProjector.ProjectSiteStats(3, 4, 1, 100, 60, 40, 1, 1, 1);
        var popular = new PopularArticleCoreModel(PodProjector.ProjectPopularArticle(3, "hot", 77), 3, "hot", 77);
        var recent = new RecentCommentCoreModel(
            PodProjector.ProjectRecentComment(4, DateTime.UnixEpoch.AddDays(1), "u4", "c4", out _),
            4,
            "u4",
            "c4",
            DateTime.UnixEpoch.AddDays(1));
        var region = new RegionDistributionCoreModel(PodProjector.ProjectRegionDistribution("CN-SH", 9), "CN-SH", 9);
        var source = new SiteStatsCoreModel(sitePod, 3, 4, 1, 100, 60, 40, [popular], [recent], [region]);

        byte[] bytes = PodBinaryCodec.EncodeSiteStats(source);
        bool ok = PodBinaryCodec.TryDecodeSiteStats(bytes, out var decoded);
        return ok && decoded.TotalArticles == 3 && decoded.PopularArticles.Count == 1 && decoded.RecentComments.Count == 1 && decoded.RegionDistributions.Count == 1;
    }

    private static bool VerifySemanticParity()
    {
        var pod = PodProjector.ProjectArticleList(21, 88, DateTime.UnixEpoch.AddHours(2), 5, "cat-x", "title-x", "summary-x", false, out _);
        var source = new CorePageResult<ArticleListCoreModel>(
            [new ArticleListCoreModel(
                pod,
                21,
                "title-x",
                "summary-x",
                null,
                "snippet-x",
                88,
                DateTime.UnixEpoch.AddHours(2),
                new ArticleCategoryCoreModel(5, "cat-x"),
                [new TagCoreModel(1, "tag-1"), new TagCoreModel(2, "tag-2")],
                false)],
            1);

        byte[] bytes = PodBinaryCodec.EncodeArticlePage(source);
        bool ok = PodBinaryCodec.TryDecodeArticlePage(bytes, out var decoded);
        if (!ok || decoded.Items.Count != source.Items.Count)
        {
            return false;
        }

        ArticleListCoreModel a = source.Items[0];
        ArticleListCoreModel b = decoded.Items[0];
        return a.Id == b.Id
            && a.Title == b.Title
            && a.Summary == b.Summary
            && a.Snippet == b.Snippet
            && a.Views == b.Views
            && a.Category.Id == b.Category.Id
            && a.Category.Name == b.Category.Name
            && a.Tags.Count == b.Tags.Count
            && a.Tags[0].Name == b.Tags[0].Name
            && a.Tags[1].Name == b.Tags[1].Name;
    }
}

internal static class HttpParityVerifier
{
    public static async Task<int> RunAsync(string[] args)
    {
        string baseUrl = GetArg(args, "--base-url") ?? "http://localhost:5032";
        string? cookie = GetArg(args, "--cookie");

        try
        {
            using var client = new HttpClient { BaseAddress = new Uri(baseUrl, UriKind.Absolute) };
            if (!string.IsNullOrWhiteSpace(cookie))
            {
                client.DefaultRequestHeaders.Add("Cookie", cookie);
            }

            var aeds = new AedsEncoder();
            bool articleListOk = await CompareArticleListAsync(client, aeds);
            bool articleHotOk = await CompareArticleHotAsync(client, aeds);
            bool articleDetailOk = await CompareArticleDetailAsync(client, aeds);
            bool commentCursorOk = await CompareCommentCursorAsync(client, aeds);
            bool statsOk = await CompareStatsAsync(client, aeds);

            Console.WriteLine($"http_parity article_list={articleListOk} article_hot={articleHotOk} article_detail={articleDetailOk} comment_cursor={commentCursorOk} stats={statsOk}");
            return articleListOk && articleHotOk && articleDetailOk && commentCursorOk && statsOk ? 0 : 1;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"http_parity_failed reason={ex.GetType().Name} message={ex.Message}");
            return 2;
        }
    }

    private static async Task<bool> CompareArticleListAsync(HttpClient client, IAedsEncoder aeds)
    {
        string jsonPath = "/api/Article?page=1&size=5&isDeleted=false";
        string binPath = "/api/binary/article?page=1&size=5&isDeleted=false";

        JsonElement? jsonData = await FetchApiDataAsync(client, jsonPath);
        if (jsonData is null || !jsonData.Value.TryGetProperty("items", out JsonElement jsonItems))
        {
            return false;
        }

        var binary = await FetchBinaryPayloadAsync(client, binPath, aeds, AedsFrameType.ArticleList);
        if (!binary.ok)
        {
            return false;
        }

        bool ok = PodBinaryCodec.TryDecodeArticlePage(binary.payload, out var page);
        if (!ok)
        {
            return false;
        }

        int jsonCount = jsonItems.GetArrayLength();
        int podCount = page.Items.Count;
        if (jsonCount != podCount)
        {
            return false;
        }

        if (jsonCount == 0)
        {
            return true;
        }

        JsonElement first = jsonItems[0];
        ArticleListCoreModel pod = page.Items[0];
        return first.GetProperty("id").GetInt32() == pod.Id
            && first.GetProperty("title").GetString() == pod.Title
            && first.GetProperty("views").GetInt32() == pod.Views;
    }

    private static async Task<bool> CompareArticleHotAsync(HttpClient client, IAedsEncoder aeds)
    {
        string jsonPath = "/api/Article/hot?size=5";
        string binPath = "/api/binary/article/hot?size=5";

        JsonElement? jsonData = await FetchApiDataAsync(client, jsonPath);
        if (jsonData is null || jsonData.Value.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        var binary = await FetchBinaryPayloadAsync(client, binPath, aeds, AedsFrameType.ArticleHot);
        if (!binary.ok)
        {
            return false;
        }

        bool ok = PodBinaryCodec.TryDecodePopularArticles(binary.payload, out var list);
        if (!ok)
        {
            return false;
        }

        if (jsonData.Value.GetArrayLength() != list.Count)
        {
            return false;
        }

        if (list.Count == 0)
        {
            return true;
        }

        JsonElement first = jsonData.Value[0];
        PopularArticleCoreModel pod = list[0];
        return first.GetProperty("id").GetInt32() == pod.Id
            && first.GetProperty("title").GetString() == pod.Title
            && first.GetProperty("views").GetInt32() == pod.Views;
    }

    private static async Task<bool> CompareArticleDetailAsync(HttpClient client, IAedsEncoder aeds)
    {
        JsonElement? listData = await FetchApiDataAsync(client, "/api/Article?page=1&size=5&isDeleted=false");
        if (listData is null || !listData.Value.TryGetProperty("items", out JsonElement items) || items.GetArrayLength() == 0)
        {
            return false;
        }

        int articleId = items[0].GetProperty("id").GetInt32();
        string jsonPath = $"/api/Article/{articleId}";
        string binPath = $"/api/binary/article/{articleId}";

        JsonElement? jsonData = await FetchApiDataAsync(client, jsonPath);
        if (jsonData is null)
        {
            return false;
        }

        var binary = await FetchBinaryPayloadAsync(client, binPath, aeds, AedsFrameType.ArticleDetail);
        if (!binary.ok)
        {
            return false;
        }

        bool ok = PodBinaryCodec.TryDecodeArticleDetail(binary.payload, out var detail);
        if (!ok)
        {
            return false;
        }

        return jsonData.Value.GetProperty("id").GetInt32() == detail.Id
            && jsonData.Value.GetProperty("title").GetString() == detail.Title
            && jsonData.Value.GetProperty("views").GetInt32() == detail.Views;
    }

    private static async Task<bool> CompareCommentCursorAsync(HttpClient client, IAedsEncoder aeds)
    {
        JsonElement? listData = await FetchApiDataAsync(client, "/api/Article?page=1&size=5&isDeleted=false");
        if (listData is null || !listData.Value.TryGetProperty("items", out JsonElement items) || items.GetArrayLength() == 0)
        {
            return false;
        }

        int articleId = items[0].GetProperty("id").GetInt32();
        string jsonPath = $"/api/Comment/{articleId}?limit=5";
        string binPath = $"/api/binary/comment/{articleId}?limit=5";

        JsonElement? jsonData = await FetchApiDataAsync(client, jsonPath);
        if (jsonData is null || !jsonData.Value.TryGetProperty("data", out JsonElement jsonItems))
        {
            return false;
        }

        var binary = await FetchBinaryPayloadAsync(client, binPath, aeds, AedsFrameType.CommentArticleCursor);
        if (!binary.ok)
        {
            return false;
        }

        bool ok = PodBinaryCodec.TryDecodeCommentCursor(binary.payload, out var cursor);
        if (!ok)
        {
            return false;
        }

        int jsonCount = jsonItems.GetArrayLength();
        if (jsonCount != cursor.Data.Count)
        {
            return false;
        }

        if (jsonCount == 0)
        {
            return true;
        }

        JsonElement first = jsonItems[0];
        var pod = cursor.Data[0];
        string jsonId = first.GetProperty("id").GetString() ?? "0";
        bool parsed = long.TryParse(jsonId, out long id);
        return parsed && id == pod.Id
            && first.GetProperty("content").GetString() == pod.Content
            && first.GetProperty("userName").GetString() == pod.UserName;
    }

    private static async Task<bool> CompareStatsAsync(HttpClient client, IAedsEncoder aeds)
    {
        JsonElement? jsonData = await FetchApiDataAsync(client, "/api/Stats");
        if (jsonData is null)
        {
            return false;
        }

        var binary = await FetchBinaryPayloadAsync(client, "/api/binary/stats", aeds, AedsFrameType.AdminStats);
        if (!binary.ok)
        {
            return false;
        }

        bool ok = PodBinaryCodec.TryDecodeSiteStats(binary.payload, out var stats);
        if (!ok)
        {
            return false;
        }

        return jsonData.Value.GetProperty("totalArticles").GetInt32() == stats.TotalArticles
            && jsonData.Value.GetProperty("totalComments").GetInt32() == stats.TotalComments
            && jsonData.Value.GetProperty("trashCount").GetInt32() == stats.TrashCount;
    }

    private static async Task<JsonElement?> FetchApiDataAsync(HttpClient client, string path)
    {
        using var response = await client.GetAsync(path);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        using var stream = await response.Content.ReadAsStreamAsync();
        using JsonDocument doc = await JsonDocument.ParseAsync(stream);

        JsonElement root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("data", out JsonElement data))
        {
            return null;
        }

        return data.Clone();
    }

    private static async Task<(bool ok, byte[] payload)> FetchBinaryPayloadAsync(
        HttpClient client,
        string path,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        using var response = await client.SendAsync(request);
        if (!response.IsSuccessStatusCode)
        {
            return (false, []);
        }

        byte[] frame = await response.Content.ReadAsByteArrayAsync();
        var decode = aeds.TryDecode(frame);
        if (!decode.IsSuccess || decode.Value.FrameType != expectedFrameType)
        {
            return (false, []);
        }

        return (true, decode.Value.Payload.ToArray());
    }

    private static string? GetArg(string[] args, string name)
    {
        int idx = Array.IndexOf(args, name);
        if (idx < 0 || idx + 1 >= args.Length)
        {
            return null;
        }

        return args[idx + 1];
    }
}

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Sse;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.Sse;
using SqlSugar;
using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Frozen;
using System.Collections.Immutable;
using System.Globalization;
using System.IO.MemoryMappedFiles;
using Microsoft.Win32.SafeHandles;
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Services;

/// <summary>
/// 搜索离线索引编译服务。
/// 直接生成多分片 search index 与 append+tombstone patch。
/// </summary>
public sealed partial class SearchIndexService(
    IServiceScopeFactory scopeFactory,
    IWebHostEnvironment environment,
    ISsePublisher ssePublisher,
    ILogger<SearchIndexService> logger) : ISearchIndexService
{
    private const uint ShardMagic = 0x32534846; // FHS2
    private const uint PatchMagic = 0x54505346; // FSPT
    private const uint PackageMagic = 0x4B505346; // FSPK
    private const uint SearchShardVersion = 2;
    private const uint SearchPatchVersion = 2;
    private const uint SearchPackageVersion = 2;
    private const int MaxSummaryLength = 180;
    private const int QuantizedTfMaxExact = 10;
    private const int HotFrequencyPercentile = 95;
    private const int RecentYearsWindow = 2;
    private const int SearchManifestSchemaVersion = 2;
    private const int PatchRebuildDocThresholdPercent = 20;
    private const int PatchRebuildByteThresholdPercent = 25;
    private const int PatchRebuildTombstoneThresholdPercent = 15;
    private const string SearchIndexDirectory = "search";
    private const string SearchPatchDirectory = "patches";
    private const string SearchDictionaryDirectory = "dictionaries";
    private const string SearchManifestFileName = "index.manifest.json";
    private const string SearchAliasFileName = "index.bin";
    private const string SearchLexiconSourceDirectory = "Dictionaries/Search";
    private const string SearchLexiconBinaryFileName = "lexicon.bin";
    private const int HeaderSize = 72;
    private const int TermMetadataSize = 24;
    private const int DocMetadataSize = 52;
    private const int DictionaryMetadataSize = 16;
    private static readonly Lock SearchIndexWriteGate = new();
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly FrozenDictionary<SearchShardRole, int> DefaultLoadPhase = new Dictionary<SearchShardRole, int>
    {
        [SearchShardRole.Core] = 0,
        [SearchShardRole.Recent] = 0,
        [SearchShardRole.Archive] = 1,
        [SearchShardRole.Body] = 2
    }.ToFrozenDictionary();

    [GeneratedRegex(@"<.*?>", RegexOptions.Compiled)]
    private static partial Regex HtmlTagRegex();

    [GeneratedRegex(@"!?\[(?<text>.*?)\]\(.*?\)", RegexOptions.Compiled)]
    private static partial Regex MdLinkRegex();

    [GeneratedRegex(@"[`#>*_~\-]+", RegexOptions.Compiled)]
    private static partial Regex MdSymbolRegex();

    [GeneratedRegex(@"\s+", RegexOptions.Compiled)]
    private static partial Regex WhiteSpaceRegex();

    public Task BuildIndexAsync(List<Article> articles)
        => RebuildSearchIndexAsync([], []);

    public Task<List<Article>> SearchAsync(string keyword)
        => BoundaryExecutor.ExecuteValueAsync(
            async () =>
            {
                if (string.IsNullOrWhiteSpace(keyword))
                {
                    return [];
                }

                string normalizedKeyword = keyword.Trim();
                await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
                ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
                var rows = await db.Queryable<Article>()
                    .LeftJoin<ArticleBody>((article, body) => article.Id == body.ArticleId)
                    .Where((article, body) =>
                        !article.IsDeleted
                        && (article.Title.Contains(normalizedKeyword)
                            || article.Summary!.Contains(normalizedKeyword)
                            || body.MarkdownContent.Contains(normalizedKeyword)))
                    .OrderByDescending((article, body) => article.Views)
                    .OrderByDescending((article, body) => article.CreateTime)
                    .Take(200)
                    .Select((article, body) => new SearchArticleResultRow
                    {
                        Id = article.Id,
                        Title = article.Title,
                        Summary = article.Summary,
                        MarkdownContent = body.MarkdownContent
                    })
                    .ToListAsync();

                var results = new List<Article>(rows.Count);
                foreach (SearchArticleResultRow row in rows)
                {
                    results.Add(new Article
                    {
                        Id = row.Id,
                        Title = row.Title ?? string.Empty,
                        Content = BuildServerSearchSnippet(normalizedKeyword, row.Title, row.Summary, row.MarkdownContent)
                    });
                }

                return results;
            },
            _ => [],
            logger,
            "search-index-search",
            LogLevel.Error);

    public Task AddOrUpdateIndexAsync(Article article)
        => RebuildSearchIndexAsync([article.Id], []);

    public Task DeleteIndexAsync(int id)
        => RebuildSearchIndexAsync([], [id]);

    public static string? NormalizeTokenForTests(string input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return null;
        }

        string trimmed = input.Trim();
        Span<char> buffer = trimmed.Length <= 256 ? stackalloc char[trimmed.Length] : new char[trimmed.Length];
        trimmed.AsSpan().CopyTo(buffer);
        for (int i = 0; i < buffer.Length; i++)
        {
            char value = buffer[i];
            if (value is >= 'A' and <= 'Z')
            {
                buffer[i] = (char)(value + 32);
            }
        }

        return new string(buffer);
    }

    public static uint HashTokenForTests(string input)
    {
        int byteCount = Encoding.UTF8.GetByteCount(input);
        byte[]? rented = null;
        Span<byte> bytes = byteCount <= 512
            ? stackalloc byte[byteCount]
            : (rented = ArrayPool<byte>.Shared.Rent(byteCount)).AsSpan(0, byteCount);

        try
        {
            Encoding.UTF8.GetBytes(input.AsSpan(), bytes);
            return MurmurHash3.HashBytes(bytes[..byteCount]);
        }
        finally
        {
            if (rented is not null)
            {
                ArrayPool<byte>.Shared.Return(rented, clearArray: true);
            }
        }
    }

    internal static void ValidateDictionaryHeaderForTests(string path)
    {
        using var runtime = SearchDictionaryRuntime.Open(path);
    }

    private Task RebuildSearchIndexAsync(IReadOnlyCollection<int> upsertArticleIds, IReadOnlyCollection<int> deletedArticleIds)
        => BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
                ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();

                List<SearchSourceArticle> articles = await LoadArticlesAsync(db);
                string root = ResolveSearchRoot();
                string dictionariesDirectory = Path.Combine(root, SearchDictionaryDirectory);
                Directory.CreateDirectory(dictionariesDirectory);

                string lexiconPath = Path.Combine(dictionariesDirectory, SearchLexiconBinaryFileName);
                SearchDictionaryCompiler.CompileIfNeeded(
                    Path.Combine(environment.ContentRootPath, SearchLexiconSourceDirectory),
                    lexiconPath,
                    logger);

                using var dictionary = SearchDictionaryRuntime.Open(lexiconPath);

                SearchBuildArtifacts artifacts = BuildArtifacts(articles, dictionary);
                await PublishArtifactsAsync(root, artifacts, upsertArticleIds, deletedArticleIds);
            },
            logger,
            "search-index-rebuild",
            LogLevel.Error);

    private string ResolveSearchRoot()
    {
        string root = environment.WebRootPath;
        if (string.IsNullOrWhiteSpace(root))
        {
            root = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        }

        return Path.Combine(root, SearchIndexDirectory);
    }

    private SearchBuildArtifacts BuildArtifacts(List<SearchSourceArticle> articles, SearchDictionaryRuntime dictionary)
    {
        DateTime nowUtc = DateTime.UtcNow;
        DateTime recentBoundary = nowUtc.AddYears(-RecentYearsWindow);

        var categoryDictionary = BuildCategoryDictionary(articles);
        var tagDictionary = BuildTagDictionary(articles);
        ImmutableArray<SearchDocEntry> docEntries = BuildDocEntries(articles, categoryDictionary.IndexByCategoryId, tagDictionary.IndexByTagId);

        SearchShardData coreShard = BuildShard(
            SearchShardRole.Core,
            articles,
            dictionary,
            categoryDictionary,
            tagDictionary,
            docEntries,
            static article => true,
            includeDocMetadata: true,
            includeCoreFields: true,
            includeBodyField: false);

        SearchShardData recentShard = BuildShard(
            SearchShardRole.Recent,
            articles,
            dictionary,
            categoryDictionary,
            tagDictionary,
            docEntries,
            article => article.CreateTime >= recentBoundary,
            includeDocMetadata: false,
            includeCoreFields: false,
            includeBodyField: true);

        SearchShardData archiveShard = BuildShard(
            SearchShardRole.Archive,
            articles,
            dictionary,
            categoryDictionary,
            tagDictionary,
            docEntries,
            article => article.CreateTime < recentBoundary,
            includeDocMetadata: false,
            includeCoreFields: false,
            includeBodyField: true);

        SearchShardData bodyShard = BuildShard(
            SearchShardRole.Body,
            articles,
            dictionary,
            categoryDictionary,
            tagDictionary,
            docEntries,
            static article => true,
            includeDocMetadata: false,
            includeCoreFields: false,
            includeBodyField: true);

        byte[] coreBytes = SerializeShard(coreShard);
        byte[] recentBytes = SerializeShard(recentShard);
        byte[] archiveBytes = SerializeShard(archiveShard);
        byte[] bodyBytes = SerializeShard(bodyShard);

        string version = ComputeVersion(coreBytes, recentBytes, archiveBytes, bodyBytes);
        byte[] aliasPackage = BuildPackage([
            new SearchPackageEntry(SearchPackageEntryKind.Shard, SearchShardRole.Core, coreBytes),
            new SearchPackageEntry(SearchPackageEntryKind.Shard, SearchShardRole.Recent, recentBytes)
        ]);

        return new SearchBuildArtifacts(
            version,
            nowUtc,
            [
                new SearchShardArtifact(SearchShardRole.Core, coreShard, coreBytes),
                new SearchShardArtifact(SearchShardRole.Recent, recentShard, recentBytes),
                new SearchShardArtifact(SearchShardRole.Archive, archiveShard, archiveBytes),
                new SearchShardArtifact(SearchShardRole.Body, bodyShard, bodyBytes)
            ],
            aliasPackage);
    }

    private async Task PublishArtifactsAsync(
        string root,
        SearchBuildArtifacts artifacts,
        IReadOnlyCollection<int> upsertArticleIds,
        IReadOnlyCollection<int> deletedArticleIds)
    {
        Directory.CreateDirectory(root);
        string patchRoot = Path.Combine(root, SearchPatchDirectory);
        Directory.CreateDirectory(patchRoot);

        string aliasPath = Path.Combine(root, SearchAliasFileName);
        string manifestPath = Path.Combine(root, SearchManifestFileName);
        SearchIndexManifest? previousManifest = ReadManifest(manifestPath);
        IReadOnlyList<SearchShardManifest> previousShards = previousManifest?.Shards ?? [];

        var shardManifests = new List<SearchShardManifest>(artifacts.Shards.Length);

        HashSet<int> changedDocumentIds = [.. upsertArticleIds];
        changedDocumentIds.UnionWith(deletedArticleIds);

        lock (SearchIndexWriteGate)
        {
            foreach (SearchShardArtifact shard in artifacts.Shards)
            {
                string shardVersionedFile = $"index.{shard.Role.ToString().ToLowerInvariant()}.{artifacts.Version}.bin";
                string shardVersionedPath = Path.Combine(root, shardVersionedFile);
                string shardUrl = $"/search/{shardVersionedFile}";
                WriteFileAtomically(shardVersionedPath, shard.Bytes);

                SearchShardManifest? previousShard = previousShards.FirstOrDefault(it => it.Role == shard.Role);
                string? patchUrl = null;
                string? patchSha = null;
                if (previousShard is not null
                    && changedDocumentIds.Count > 0
                    && File.Exists(Path.Combine(environment.WebRootPath ?? Path.Combine(AppContext.BaseDirectory, "wwwroot"), previousShard.FullUrl.TrimStart('/').Replace('/', Path.DirectorySeparatorChar))))
                {
                    SearchShardData patchShard = BuildPatchShard(shard.Data, changedDocumentIds);
                    byte[] patchShardBytes = SerializeShard(patchShard);
                    byte[] patchBytes = SearchIndexDeltaCodec.CreatePatch(
                        changedDocumentIds.Select(id => (uint)id).Distinct().OrderBy(id => id).ToArray(),
                        patchShardBytes);
                    if (ShouldEmitPatch(
                        shard.Data.Documents.Length,
                        patchShard.Documents.Length,
                        changedDocumentIds.Count,
                        patchBytes.Length,
                        shard.Bytes.Length))
                    {
                        string patchFileName = $"index.{shard.Role.ToString().ToLowerInvariant()}.{previousShard.FullSha256[..16]}-{artifacts.Version}.patch";
                        string patchPath = Path.Combine(patchRoot, patchFileName);
                        patchUrl = $"/search/{SearchPatchDirectory}/{patchFileName}";
                        patchSha = ToLowerHex(SHA256.HashData(patchBytes));
                        WriteFileAtomically(patchPath, patchBytes);
                    }
                    else
                    {
                        logger.LogInformation(
                            "search shard {Role} skipped patch publish and will rely on full shard refresh (patchDocs={PatchDocs}, tombstones={Tombstones}, patchBytes={PatchBytes}, shardBytes={ShardBytes})",
                            shard.Role,
                            patchShard.Documents.Length,
                            changedDocumentIds.Count,
                            patchBytes.Length,
                            shard.Bytes.Length);
                    }
                }

                shardManifests.Add(new SearchShardManifest(
                    shard.Role,
                    shardUrl,
                    ToLowerHex(SHA256.HashData(shard.Bytes)),
                    patchUrl,
                    patchSha,
                    DefaultLoadPhase[shard.Role]));
            }

            SearchIndexManifest manifest = new(
                SearchManifestSchemaVersion,
                artifacts.Version,
                artifacts.GeneratedAt,
                shardManifests,
                ["core", "recent"],
                ["archive"],
                ["body"]);

            WriteFileAtomically(aliasPath, artifacts.AliasPackage);
            WriteTextAtomically(manifestPath, JsonSerializer.Serialize(manifest, JsonOptions));
        }

        if (!string.Equals(previousManifest?.CurrentVersion, artifacts.Version, StringComparison.Ordinal))
        {
            await ssePublisher.PublishAsync(
                SseEventType.SearchIndexUpdated,
                new SearchIndexUpdatePayload(artifacts.Version, "/search/index.manifest.json", artifacts.GeneratedAt),
                new GroupTarget(SseGroups.ContentFeed));
        }
    }

    private static SearchShardData BuildPatchShard(SearchShardData shard, IReadOnlySet<int> changedDocumentIds)
    {
        ImmutableArray<SearchDocEntry> docs = shard.Documents
            .Where(doc => changedDocumentIds.Contains(doc.ArticleId))
            .ToImmutableArray();

        SearchTermEntry[] terms = shard.Terms
            .Select(term =>
            {
                SearchPostingEntry[] postings = term.Postings
                    .Where(posting => changedDocumentIds.Contains((int)posting.ArticleId))
                    .ToArray();
                return postings.Length == 0 ? null : new SearchTermEntry(term.Hash, term.Idf, term.HasPositions, postings);
            })
            .Where(term => term is not null)
            .Select(term => term!)
            .ToArray();

        return new SearchShardData(
            shard.Role,
            docs,
            shard.Categories,
            shard.Tags,
            terms,
            shard.AverageDocLength);
    }

    private static SearchIndexManifest? ReadManifest(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<SearchIndexManifest>(File.ReadAllText(path, Encoding.UTF8), JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    private static void WriteFileAtomically(string path, byte[] bytes)
    {
        string temp = $"{path}.tmp";
        File.WriteAllBytes(temp, bytes);
        File.Move(temp, path, true);
    }

    private static void WriteTextAtomically(string path, string content)
    {
        string temp = $"{path}.tmp";
        File.WriteAllText(temp, content, Encoding.UTF8);
        File.Move(temp, path, true);
    }

    private static string ComputeVersion(params byte[][] payloads)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (byte[] payload in payloads)
        {
            hash.AppendData(payload);
        }

        return ToLowerHex(hash.GetHashAndReset())[..16];
    }

    private static string ToLowerHex(byte[] value)
        => Convert.ToHexString(value).ToLowerInvariant();

    private static SearchCategoryDictionary BuildCategoryDictionary(List<SearchSourceArticle> articles)
    {
        var byId = new Dictionary<int, SearchCategoryDictionaryEntry>();
        foreach (SearchSourceArticle article in articles)
        {
            if (!byId.ContainsKey(article.CategoryId))
            {
                byId[article.CategoryId] = new SearchCategoryDictionaryEntry(article.CategoryId, article.CategoryName);
            }
        }

        SearchCategoryDictionaryEntry[] entries = byId.Values.OrderBy(it => it.OriginalCategoryId).ToArray();
        var index = new Dictionary<int, ushort>(entries.Length);
        for (ushort i = 0; i < entries.Length; i++)
        {
            index[entries[i].OriginalCategoryId] = i;
        }

        return new SearchCategoryDictionary(entries.ToImmutableArray(), index.ToFrozenDictionary());
    }

    private static SearchTagDictionary BuildTagDictionary(List<SearchSourceArticle> articles)
    {
        var byId = new Dictionary<int, SearchTagDictionaryEntry>();
        foreach (SearchSourceArticle article in articles)
        {
            foreach (SearchTagItem tag in article.Tags)
            {
                if (!byId.ContainsKey(tag.Id))
                {
                    byId[tag.Id] = new SearchTagDictionaryEntry(tag.Id, tag.Name);
                }
            }
        }

        SearchTagDictionaryEntry[] entries = byId.Values.OrderBy(it => it.OriginalTagId).ToArray();
        var index = new Dictionary<int, ushort>(entries.Length);
        for (ushort i = 0; i < entries.Length; i++)
        {
            index[entries[i].OriginalTagId] = i;
        }

        return new SearchTagDictionary(entries.ToImmutableArray(), index.ToFrozenDictionary());
    }

    private static ImmutableArray<SearchDocEntry> BuildDocEntries(
        List<SearchSourceArticle> articles,
        FrozenDictionary<int, ushort> categoryIndex,
        FrozenDictionary<int, ushort> tagIndex)
    {
        var docs = ImmutableArray.CreateBuilder<SearchDocEntry>(articles.Count);
        foreach (SearchSourceArticle article in articles.OrderBy(it => it.Id))
        {
            ushort[] tagRefs = article.Tags
                .Select(tag => tagIndex.TryGetValue(tag.Id, out ushort value) ? value : (ushort)0)
                .ToArray();

            docs.Add(new SearchDocEntry(
                article.Id,
                categoryIndex.TryGetValue(article.CategoryId, out ushort categoryRef) ? categoryRef : (ushort)0,
                new DateTimeOffset(article.CreateTime).ToUnixTimeMilliseconds(),
                article.Views,
                article.CommentCount,
                article.DocLength,
                article.Title,
                article.Summary,
                tagRefs));
        }

        return docs.MoveToImmutable();
    }

    private SearchShardData BuildShard(
        SearchShardRole role,
        List<SearchSourceArticle> articles,
        SearchDictionaryRuntime dictionary,
        SearchCategoryDictionary categoryDictionary,
        SearchTagDictionary tagDictionary,
        ImmutableArray<SearchDocEntry> allDocs,
        Func<SearchSourceArticle, bool> articlePredicate,
        bool includeDocMetadata,
        bool includeCoreFields,
        bool includeBodyField)
    {
        SearchSourceArticle[] selectedArticles = articles
            .Where(articlePredicate)
            .OrderBy(it => it.Id)
            .ToArray();

        var accumulators = new Dictionary<uint, TermAccumulator>();
        int totalDocLength = 0;
        foreach (SearchSourceArticle article in selectedArticles)
        {
            if (includeCoreFields)
            {
                EnumerateFieldTokens(dictionary, article.Title, SearchFieldKind.Title, static (token, state) => state.AddToken(token), new TokenEmissionContext(article.Id, accumulators));
                EnumerateFieldTokens(dictionary, article.Summary, SearchFieldKind.Summary, static (token, state) => state.AddToken(token), new TokenEmissionContext(article.Id, accumulators));
                EnumerateFieldTokens(dictionary, article.CategoryName, SearchFieldKind.Meta, static (token, state) => state.AddToken(token), new TokenEmissionContext(article.Id, accumulators));
                foreach (SearchTagItem tag in article.Tags)
                {
                    EnumerateFieldTokens(dictionary, tag.Name, SearchFieldKind.Meta, static (token, state) => state.AddToken(token), new TokenEmissionContext(article.Id, accumulators));
                }
            }

            if (includeBodyField)
            {
                EnumerateFieldTokens(dictionary, article.Body, SearchFieldKind.Body, static (token, state) => state.AddToken(token), new TokenEmissionContext(article.Id, accumulators));
            }

            totalDocLength += Math.Max(article.DocLength, 1);
        }

        int dfCutoff = ResolveDocumentFrequencyCutoff(accumulators, selectedArticles.Length);
        SearchTermEntry[] terms = BuildTerms(accumulators, selectedArticles.Length, dfCutoff);
        ImmutableArray<SearchDocEntry> docs = includeDocMetadata
            ? allDocs.Where(doc => selectedArticles.Any(article => article.Id == doc.ArticleId)).ToImmutableArray()
            : selectedArticles.Select(article => SearchDocEntry.Minimal(article.Id)).ToImmutableArray();

        float avgDocLength = selectedArticles.Length == 0 ? 1f : Math.Max((float)totalDocLength / selectedArticles.Length, 1f);
        return new SearchShardData(role, docs, categoryDictionary.Entries, tagDictionary.Entries, terms, avgDocLength);
    }

    private static int ResolveDocumentFrequencyCutoff(Dictionary<uint, TermAccumulator> accumulators, int documentCount)
    {
        if (accumulators.Count == 0 || documentCount <= 0)
        {
            return int.MaxValue;
        }

        int[] dfs = accumulators.Values.Select(it => it.DocumentFrequency).OrderBy(it => it).ToArray();
        int percentileIndex = (int)Math.Floor((dfs.Length - 1) * (HotFrequencyPercentile / 100d));
        return dfs[Math.Clamp(percentileIndex, 0, dfs.Length - 1)];
    }

    private static SearchTermEntry[] BuildTerms(Dictionary<uint, TermAccumulator> accumulators, int docCount, int dfCutoff)
    {
        uint[] hashes = accumulators.Keys.ToArray();
        Array.Sort(hashes);
        var terms = new SearchTermEntry[hashes.Length];
        for (int i = 0; i < hashes.Length; i++)
        {
            uint hash = hashes[i];
            TermAccumulator accumulator = accumulators[hash];
            bool keepPositions = ShouldKeepPositions(accumulator.DocumentFrequency, dfCutoff, accumulator.Stopword, accumulator.KeepPositions);
            SearchPostingEntry[] postings = accumulator.Postings.Values
                .OrderBy(it => it.ArticleId)
                .Select(posting => posting.Build(keepPositions))
                .ToArray();
            terms[i] = new SearchTermEntry(hash, ComputeIdf(docCount, accumulator.DocumentFrequency), keepPositions, postings);
        }

        return terms;
    }

    private static float ComputeIdf(int docCount, int df)
    {
        if (docCount <= 0 || df <= 0)
        {
            return 0f;
        }

        return (float)Math.Log(1d + ((docCount - df + 0.5d) / (df + 0.5d)));
    }

    private static bool ShouldKeepPositions(int documentFrequency, int dfCutoff, bool stopword, bool keepPositionsCandidate)
        => keepPositionsCandidate
            && !stopword
            && documentFrequency > 0
            && documentFrequency < dfCutoff;

    private static bool ShouldEmitPatch(
        int shardDocCount,
        int patchDocCount,
        int tombstoneCount,
        int patchBytesLength,
        int shardBytesLength)
    {
        if (patchDocCount <= 0 && tombstoneCount <= 0)
        {
            return false;
        }

        int safeDocCount = Math.Max(shardDocCount, 1);
        int safeShardBytes = Math.Max(shardBytesLength, 1);
        if (patchDocCount * 100 > safeDocCount * PatchRebuildDocThresholdPercent)
        {
            return false;
        }

        if (tombstoneCount * 100 > safeDocCount * PatchRebuildTombstoneThresholdPercent)
        {
            return false;
        }

        if (patchBytesLength * 100 > safeShardBytes * PatchRebuildByteThresholdPercent)
        {
            return false;
        }

        return true;
    }

    private static void EnumerateFieldTokens<TState>(
        SearchDictionaryRuntime dictionary,
        string? text,
        SearchFieldKind field,
        Action<SearchToken, TState> consumer,
        TState state)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }

        int byteCount = Encoding.UTF8.GetByteCount(text);
        byte[]? rented = null;
        Span<byte> buffer = byteCount <= 1024
            ? stackalloc byte[byteCount]
            : (rented = ArrayPool<byte>.Shared.Rent(byteCount)).AsSpan(0, byteCount);

        try
        {
            Encoding.UTF8.GetBytes(text.AsSpan(), buffer);
            var tokenizer = new SearchTokenizer(dictionary, field, buffer[..byteCount]);
            while (tokenizer.MoveNext(out SearchToken token))
            {
                consumer(token, state);
            }
        }
        finally
        {
            if (rented is not null)
            {
                ArrayPool<byte>.Shared.Return(rented, clearArray: true);
            }
        }
    }

    private static byte[] SerializeShard(SearchShardData shard)
    {
        using var postingWriter = new PooledByteBufferWriter(4096);
        var termMetadata = new TermMetadataRecord[shard.Terms.Length];

        for (int termIndex = 0; termIndex < shard.Terms.Length; termIndex++)
        {
            SearchTermEntry term = shard.Terms[termIndex];
            int postingStart = postingWriter.WrittenCount;
            WriteVInt(postingWriter, checked((uint)term.Postings.Length));
            uint previousArticleId = 0;
            foreach (SearchPostingEntry posting in term.Postings)
            {
                WriteVInt(postingWriter, posting.ArticleId - previousArticleId);
                previousArticleId = posting.ArticleId;
                postingWriter.Write([posting.TitleTf, posting.MetaTf, posting.BodyTf]);
                WriteVInt(postingWriter, checked((uint)posting.Positions.Length));

                uint previousPosition = 0;
                foreach (SearchPositionEntry position in posting.Positions)
                {
                    WriteVInt(postingWriter, position.Position - previousPosition);
                    WriteVInt(postingWriter, position.PositionLength);
                    WriteVInt(postingWriter, (uint)position.Field);
                    previousPosition = position.Position;
                }
            }

            termMetadata[termIndex] = new TermMetadataRecord(term.Hash, term.Idf, (uint)postingStart, (uint)(postingWriter.WrittenCount - postingStart), term.HasPositions);
        }

        byte[] postingBytes = postingWriter.ToArray();

        var stringPool = new PooledByteBufferWriter(4096);
        var categoryMetadata = new DictionaryMetadataRecord[shard.Categories.Length];
        for (int i = 0; i < shard.Categories.Length; i++)
        {
            SearchCategoryDictionaryEntry entry = shard.Categories[i];
            uint offset = (uint)stringPool.WrittenCount;
            int byteCount = Encoding.UTF8.GetByteCount(entry.Name);
            WriteUtf8(stringPool, entry.Name, byteCount);
            categoryMetadata[i] = new DictionaryMetadataRecord(entry.OriginalCategoryId, offset, (ushort)byteCount);
        }

        var tagMetadata = new DictionaryMetadataRecord[shard.Tags.Length];
        for (int i = 0; i < shard.Tags.Length; i++)
        {
            SearchTagDictionaryEntry entry = shard.Tags[i];
            uint offset = (uint)stringPool.WrittenCount;
            int byteCount = Encoding.UTF8.GetByteCount(entry.Name);
            WriteUtf8(stringPool, entry.Name, byteCount);
            tagMetadata[i] = new DictionaryMetadataRecord(entry.OriginalTagId, offset, (ushort)byteCount);
        }

        var tagRefsWriter = new PooledByteBufferWriter(Math.Max(256, shard.Documents.Sum(it => it.TagRefs.Length * sizeof(ushort))));
        var docMetadata = new DocMetadataRecord[shard.Documents.Length];
        for (int i = 0; i < shard.Documents.Length; i++)
        {
            SearchDocEntry doc = shard.Documents[i];
            uint docTagRefOffset = (uint)(tagRefsWriter.WrittenCount / sizeof(ushort));
            foreach (ushort tagRef in doc.TagRefs)
            {
                WriteUInt16(tagRefsWriter, tagRef);
            }

            uint titleOffset = 0;
            ushort titleLength = 0;
            if (!string.IsNullOrEmpty(doc.Title))
            {
                titleOffset = (uint)stringPool.WrittenCount;
                titleLength = checked((ushort)Encoding.UTF8.GetByteCount(doc.Title));
                WriteUtf8(stringPool, doc.Title, titleLength);
            }

            uint summaryOffset = 0;
            ushort summaryLength = 0;
            if (!string.IsNullOrEmpty(doc.Summary))
            {
                summaryOffset = (uint)stringPool.WrittenCount;
                summaryLength = checked((ushort)Encoding.UTF8.GetByteCount(doc.Summary));
                WriteUtf8(stringPool, doc.Summary, summaryLength);
            }

            docMetadata[i] = new DocMetadataRecord(
                (uint)doc.ArticleId,
                doc.CategoryDictionaryIndex,
                (ushort)doc.TagRefs.Length,
                docTagRefOffset,
                (uint)doc.Views,
                (uint)doc.CommentCount,
                (uint)Math.Max(doc.DocLength, 1),
                doc.PublishUnixMs,
                titleOffset,
                titleLength,
                summaryOffset,
                summaryLength);
        }

        byte[] stringBytes = stringPool.ToArray();
        byte[] tagRefsBytes = tagRefsWriter.ToArray();
        int termOffset = Align(HeaderSize, 8);
        int docOffset = Align(termOffset + termMetadata.Length * TermMetadataSize, 8);
        int categoryOffset = Align(docOffset + docMetadata.Length * DocMetadataSize, 8);
        int tagOffset = Align(categoryOffset + categoryMetadata.Length * DictionaryMetadataSize, 8);
        int tagRefOffset = Align(tagOffset + tagMetadata.Length * DictionaryMetadataSize, 8);
        int stringPoolOffset = Align(tagRefOffset + tagRefsBytes.Length, 8);
        int postingOffset = Align(stringPoolOffset + stringBytes.Length, 8);
        int totalLength = postingOffset + postingBytes.Length;

        using var writer = new PooledByteBufferWriter(totalLength + 64);
        WriteUInt32(writer, ShardMagic);
        WriteUInt32(writer, SearchShardVersion);
        WriteUInt32(writer, (uint)shard.Role);
        WriteUInt32(writer, shard.Role == SearchShardRole.Core ? 1u : 0u);
        WriteUInt32(writer, (uint)termMetadata.Length);
        WriteUInt32(writer, (uint)docMetadata.Length);
        WriteUInt32(writer, (uint)categoryMetadata.Length);
        WriteUInt32(writer, (uint)tagMetadata.Length);
        WriteUInt32(writer, (uint)(tagRefsBytes.Length / sizeof(ushort)));
        WriteUInt32(writer, (uint)termOffset);
        WriteUInt32(writer, (uint)docOffset);
        WriteUInt32(writer, (uint)categoryOffset);
        WriteUInt32(writer, (uint)tagOffset);
        WriteUInt32(writer, (uint)tagRefOffset);
        WriteUInt32(writer, (uint)stringPoolOffset);
        WriteUInt32(writer, (uint)postingOffset);
        WriteUInt32(writer, (uint)postingBytes.Length);
        WriteSingle(writer, shard.AverageDocLength);
        AlignWriter(writer, termOffset);

        foreach (TermMetadataRecord term in termMetadata)
        {
            WriteUInt32(writer, term.Hash);
            WriteSingle(writer, term.Idf);
            WriteUInt32(writer, term.PostingOffset);
            WriteUInt32(writer, term.PostingLength);
            WriteUInt32(writer, term.HasPositions ? 1u : 0u);
            WriteUInt32(writer, 0);
        }

        AlignWriter(writer, docOffset);
        foreach (DocMetadataRecord doc in docMetadata)
        {
            WriteUInt32(writer, doc.ArticleId);
            WriteUInt16(writer, doc.CategoryIndex);
            WriteUInt16(writer, doc.TagCount);
            WriteUInt32(writer, doc.TagRefOffset);
            WriteUInt32(writer, doc.Views);
            WriteUInt32(writer, doc.CommentCount);
            WriteUInt32(writer, doc.DocLength);
            WriteInt64(writer, doc.PublishUnixMs);
            WriteUInt32(writer, doc.TitleOffset);
            WriteUInt16(writer, doc.TitleLength);
            WriteUInt16(writer, 0);
            WriteUInt32(writer, doc.SummaryOffset);
            WriteUInt16(writer, doc.SummaryLength);
            WriteUInt16(writer, 0);
            WriteUInt32(writer, 0);
        }

        AlignWriter(writer, categoryOffset);
        foreach (DictionaryMetadataRecord entry in categoryMetadata)
        {
            WriteUInt32(writer, (uint)entry.OriginalId);
            WriteUInt32(writer, entry.StringOffset);
            WriteUInt16(writer, entry.StringLength);
            WriteUInt16(writer, 0);
            WriteUInt32(writer, 0);
        }

        AlignWriter(writer, tagOffset);
        foreach (DictionaryMetadataRecord entry in tagMetadata)
        {
            WriteUInt32(writer, (uint)entry.OriginalId);
            WriteUInt32(writer, entry.StringOffset);
            WriteUInt16(writer, entry.StringLength);
            WriteUInt16(writer, 0);
            WriteUInt32(writer, 0);
        }

        AlignWriter(writer, tagRefOffset);
        writer.Write(tagRefsBytes);
        AlignWriter(writer, stringPoolOffset);
        writer.Write(stringBytes);
        AlignWriter(writer, postingOffset);
        writer.Write(postingBytes);
        return writer.ToArray();
    }

    private static byte[] BuildPackage(ReadOnlySpan<SearchPackageEntry> entries)
    {
        const int packageHeaderSize = 12;
        const int entryHeaderSize = 16;
        int offset = Align(packageHeaderSize + entries.Length * entryHeaderSize, 8);
        int[] offsets = new int[entries.Length];
        for (int i = 0; i < entries.Length; i++)
        {
            offsets[i] = offset;
            offset = Align(offset + entries[i].Bytes.Length, 8);
        }

        using var writer = new PooledByteBufferWriter(offset + 64);
        WriteUInt32(writer, PackageMagic);
        WriteUInt32(writer, SearchPackageVersion);
        WriteUInt32(writer, (uint)entries.Length);
        AlignWriter(writer, packageHeaderSize);

        for (int i = 0; i < entries.Length; i++)
        {
            SearchPackageEntry entry = entries[i];
            WriteUInt32(writer, (uint)entry.Kind);
            WriteUInt32(writer, (uint)entry.Role);
            WriteUInt32(writer, (uint)offsets[i]);
            WriteUInt32(writer, (uint)entry.Bytes.Length);
        }

        for (int i = 0; i < entries.Length; i++)
        {
            AlignWriter(writer, offsets[i]);
            writer.Write(entries[i].Bytes);
        }

        return writer.ToArray();
    }

    private static void AlignWriter(IBufferWriter<byte> writer, int targetOffset)
    {
        if (writer is not PooledByteBufferWriter pooled)
        {
            throw new InvalidOperationException("Only pooled buffer writers are supported for aligned writes.");
        }

        int padding = targetOffset - pooled.WrittenCount;
        if (padding <= 0)
        {
            return;
        }

        pooled.GetSpan(padding).Slice(0, padding).Clear();
        pooled.Advance(padding);
    }

    private static int Align(int value, int alignment)
        => (value + alignment - 1) & ~(alignment - 1);

    private static void WriteUInt32(IBufferWriter<byte> destination, uint value)
    {
        Span<byte> span = destination.GetSpan(sizeof(uint));
        BinaryPrimitives.WriteUInt32LittleEndian(span, value);
        destination.Advance(sizeof(uint));
    }

    private static void WriteUInt16(IBufferWriter<byte> destination, ushort value)
    {
        Span<byte> span = destination.GetSpan(sizeof(ushort));
        BinaryPrimitives.WriteUInt16LittleEndian(span, value);
        destination.Advance(sizeof(ushort));
    }

    private static void WriteInt64(IBufferWriter<byte> destination, long value)
    {
        Span<byte> span = destination.GetSpan(sizeof(long));
        BinaryPrimitives.WriteInt64LittleEndian(span, value);
        destination.Advance(sizeof(long));
    }

    private static void WriteSingle(IBufferWriter<byte> destination, float value)
        => WriteUInt32(destination, BitConverter.SingleToUInt32Bits(value));

    private static void WriteUtf8(IBufferWriter<byte> destination, string value, int byteCount)
    {
        if (byteCount == 0)
        {
            return;
        }

        Span<byte> span = destination.GetSpan(byteCount);
        int written = Encoding.UTF8.GetBytes(value.AsSpan(), span);
        destination.Advance(written);
    }

    private static void WriteVInt(IBufferWriter<byte> writer, uint value)
    {
        while (value >= 0x80)
        {
            Span<byte> span = writer.GetSpan(1);
            span[0] = (byte)(value | 0x80);
            writer.Advance(1);
            value >>= 7;
        }

        Span<byte> final = writer.GetSpan(1);
        final[0] = (byte)value;
        writer.Advance(1);
    }

    private async Task<List<SearchSourceArticle>> LoadArticlesAsync(ISqlSugarClient db)
    {
        List<SearchArticleRow> articleRows = await LoadArticleRowsAsync(db);
        if (articleRows.Count == 0)
        {
            return [];
        }

        int[] articleIds = articleRows.Select(it => it.Id).ToArray();
        Dictionary<int, string> bodyMap = await LoadBodyMapAsync(db, articleIds);
        Dictionary<int, List<SearchTagItem>> tagMap = await LoadTagMapAsync(db, articleIds);
        Dictionary<int, int> commentMap = await LoadCommentCountMapAsync(db, articleIds);

        var list = new List<SearchSourceArticle>(articleRows.Count);
        foreach (SearchArticleRow row in articleRows)
        {
            string body = bodyMap.TryGetValue(row.Id, out string? markdown) ? markdown : string.Empty;
            Dictionary<string, int> titleTokens = CountVisibleTokens(body);
            int docLength = Math.Max(titleTokens.Values.Sum() + 1, 1);
            list.Add(new SearchSourceArticle
            {
                Id = row.Id,
                Title = row.Title ?? string.Empty,
                Summary = NormalizeSummary(row.Summary, body),
                Body = body,
                CategoryId = row.CategoryId,
                CategoryName = string.IsNullOrWhiteSpace(row.CategoryName) ? "默认" : row.CategoryName,
                Tags = tagMap.TryGetValue(row.Id, out List<SearchTagItem>? tags) ? tags : [],
                Views = row.Views,
                CommentCount = commentMap.TryGetValue(row.Id, out int count) ? count : 0,
                CreateTime = DateTime.SpecifyKind(row.CreateTime, DateTimeKind.Utc),
                DocLength = docLength
            });
        }

        return list;
    }

    private static Dictionary<string, int> CountVisibleTokens(string body)
    {
        string plain = MdLinkRegex().Replace(body, m => m.Groups["text"].Value);
        plain = HtmlTagRegex().Replace(plain, string.Empty);
        plain = MdSymbolRegex().Replace(plain, " ");
        plain = WhiteSpaceRegex().Replace(plain, " ").Trim();
        if (plain.Length == 0)
        {
            return [];
        }

        var tokens = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (string part in plain.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            ref int count = ref CollectionsMarshal.GetValueRefOrAddDefault(tokens, part, out _);
            count++;
        }

        return tokens;
    }

    private static async Task<List<SearchArticleRow>> LoadArticleRowsAsync(ISqlSugarClient db)
        => await db.Queryable<Article, Category>((a, c) => a.CategoryId == c.Id)
            .Where((a, c) => !a.IsDeleted)
            .OrderByDescending((a, c) => a.CreateTime)
            .Select((a, c) => new SearchArticleRow
            {
                Id = a.Id,
                Title = a.Title,
                Summary = a.Summary,
                CategoryId = a.CategoryId,
                CategoryName = c.Name,
                Views = a.Views,
                CreateTime = a.CreateTime
            })
            .ToListAsync();

    private static async Task<Dictionary<int, string>> LoadBodyMapAsync(ISqlSugarClient db, int[] articleIds)
    {
        var rows = await db.Queryable<ArticleBody>()
            .Where(it => articleIds.Contains(it.ArticleId))
            .Select(it => new { it.ArticleId, it.MarkdownContent })
            .ToListAsync();

        var bodyMap = new Dictionary<int, string>(rows.Count);
        foreach (var row in rows)
        {
            bodyMap[row.ArticleId] = row.MarkdownContent ?? string.Empty;
        }

        return bodyMap;
    }

    private static async Task<Dictionary<int, List<SearchTagItem>>> LoadTagMapAsync(ISqlSugarClient db, int[] articleIds)
    {
        List<SearchTagRow> tagRows = await db.Queryable<ArticleTag, Tag>((at, t) => at.TagId == t.Id)
            .Where(at => articleIds.Contains(at.ArticleId))
            .Select((at, t) => new SearchTagRow
            {
                ArticleId = at.ArticleId,
                TagId = t.Id,
                TagName = t.Name
            })
            .ToListAsync();

        var tagMap = new Dictionary<int, List<SearchTagItem>>(Math.Min(articleIds.Length, tagRows.Count));
        foreach (SearchTagRow row in tagRows)
        {
            if (!tagMap.TryGetValue(row.ArticleId, out List<SearchTagItem>? tagsForArticle))
            {
                tagsForArticle = [];
                tagMap[row.ArticleId] = tagsForArticle;
            }

            tagsForArticle.Add(new SearchTagItem(row.TagId, row.TagName ?? string.Empty));
        }

        return tagMap;
    }

    private static async Task<Dictionary<int, int>> LoadCommentCountMapAsync(ISqlSugarClient db, int[] articleIds)
    {
        List<SearchCommentCountRow> commentRows = await db.Queryable<Comment>()
            .Where(c => articleIds.Contains(c.ArticleId) && !c.IsDeleted)
            .GroupBy(c => c.ArticleId)
            .Select(c => new SearchCommentCountRow
            {
                ArticleId = c.ArticleId,
                Count = SqlFunc.AggregateCount(c.Id)
            })
            .ToListAsync();

        var commentMap = new Dictionary<int, int>(commentRows.Count);
        foreach (SearchCommentCountRow row in commentRows)
        {
            commentMap[row.ArticleId] = row.Count;
        }

        return commentMap;
    }

    private static string NormalizeSummary(string? summary, string body)
    {
        if (!string.IsNullOrWhiteSpace(summary))
        {
            return summary.Trim();
        }

        if (string.IsNullOrWhiteSpace(body))
        {
            return string.Empty;
        }

        string plain = MdLinkRegex().Replace(body, m => m.Groups["text"].Value);
        plain = HtmlTagRegex().Replace(plain, string.Empty);
        plain = MdSymbolRegex().Replace(plain, " ");
        plain = WhiteSpaceRegex().Replace(plain, " ").Trim();
        if (plain.Length <= MaxSummaryLength)
        {
            return plain;
        }

        return string.Concat(plain.AsSpan(0, MaxSummaryLength), "...");
    }

    private static string BuildServerSearchSnippet(string keyword, string? title, string? summary, string? body)
    {
        string preferred = !string.IsNullOrWhiteSpace(summary) ? summary! : body ?? string.Empty;
        if (string.IsNullOrWhiteSpace(preferred))
        {
            return string.Empty;
        }

        string plain = MdLinkRegex().Replace(preferred, m => m.Groups["text"].Value);
        plain = HtmlTagRegex().Replace(plain, string.Empty);
        plain = MdSymbolRegex().Replace(plain, " ");
        plain = WhiteSpaceRegex().Replace(plain, " ").Trim();
        if (plain.Length == 0)
        {
            return string.Empty;
        }

        int hitIndex = plain.IndexOf(keyword, StringComparison.OrdinalIgnoreCase);
        if (hitIndex < 0)
        {
            return plain.Length <= MaxSummaryLength
                ? plain
                : string.Concat(plain.AsSpan(0, MaxSummaryLength), "...");
        }

        int start = Math.Max(0, hitIndex - 40);
        int length = Math.Min(MaxSummaryLength, plain.Length - start);
        string snippet = plain.Substring(start, length);
        if (start > 0)
        {
            snippet = $"...{snippet}";
        }

        if (start + length < plain.Length)
        {
            snippet = $"{snippet}...";
        }

        return snippet;
    }

    private sealed record SearchIndexManifest(
        int SchemaVersion,
        string CurrentVersion,
        DateTime GeneratedAt,
        IReadOnlyList<SearchShardManifest> Shards,
        IReadOnlyList<string> InitialRoles,
        IReadOnlyList<string> BackgroundRoles,
        IReadOnlyList<string> DeepRoles);

    private sealed record SearchShardManifest(
        SearchShardRole Role,
        string FullUrl,
        string FullSha256,
        string? PatchUrl,
        string? PatchSha256,
        int LoadPhase);

    private sealed record SearchBuildArtifacts(
        string Version,
        DateTime GeneratedAt,
        SearchShardArtifact[] Shards,
        byte[] AliasPackage);

    private sealed record SearchShardArtifact(SearchShardRole Role, SearchShardData Data, byte[] Bytes);

    private sealed record SearchSourceArticle
    {
        public int Id { get; init; }
        public string Title { get; init; } = string.Empty;
        public string Summary { get; init; } = string.Empty;
        public string Body { get; init; } = string.Empty;
        public int CategoryId { get; init; }
        public string CategoryName { get; init; } = string.Empty;
        public List<SearchTagItem> Tags { get; init; } = [];
        public int Views { get; init; }
        public int CommentCount { get; init; }
        public DateTime CreateTime { get; init; }
        public int DocLength { get; init; }
    }

    private sealed record SearchArticleRow
    {
        public int Id { get; init; }
        public string? Title { get; init; }
        public string? Summary { get; init; }
        public int CategoryId { get; init; }
        public string? CategoryName { get; init; }
        public int Views { get; init; }
        public DateTime CreateTime { get; init; }
    }

    private sealed record SearchTagRow
    {
        public int ArticleId { get; init; }
        public int TagId { get; init; }
        public string? TagName { get; init; }
    }

    private sealed record SearchCommentCountRow
    {
        public int ArticleId { get; init; }
        public int Count { get; init; }
    }

    private sealed record SearchArticleResultRow
    {
        public int Id { get; init; }
        public string? Title { get; init; }
        public string? Summary { get; init; }
        public string? MarkdownContent { get; init; }
    }

    private sealed record SearchTagItem(int Id, string Name);

    private sealed record SearchCategoryDictionary(ImmutableArray<SearchCategoryDictionaryEntry> Entries, FrozenDictionary<int, ushort> IndexByCategoryId);
    private sealed record SearchCategoryDictionaryEntry(int OriginalCategoryId, string Name);
    private sealed record SearchTagDictionary(ImmutableArray<SearchTagDictionaryEntry> Entries, FrozenDictionary<int, ushort> IndexByTagId);
    private sealed record SearchTagDictionaryEntry(int OriginalTagId, string Name);

    private sealed record SearchShardData(
        SearchShardRole Role,
        ImmutableArray<SearchDocEntry> Documents,
        ImmutableArray<SearchCategoryDictionaryEntry> Categories,
        ImmutableArray<SearchTagDictionaryEntry> Tags,
        SearchTermEntry[] Terms,
        float AverageDocLength);

    private sealed record SearchDocEntry(
        int ArticleId,
        ushort CategoryDictionaryIndex,
        long PublishUnixMs,
        int Views,
        int CommentCount,
        int DocLength,
        string Title,
        string Summary,
        ushort[] TagRefs)
    {
        public static SearchDocEntry Minimal(int articleId)
            => new(articleId, 0, 0, 0, 0, 1, string.Empty, string.Empty, []);
    }

    private sealed record SearchTermEntry(uint Hash, float Idf, bool HasPositions, SearchPostingEntry[] Postings);
    private sealed record SearchPostingEntry(uint ArticleId, byte TitleTf, byte MetaTf, byte BodyTf, SearchPositionEntry[] Positions);
    private readonly record struct SearchPositionEntry(uint Position, uint PositionLength, SearchFieldKind Field);

    private readonly record struct SearchToken(uint Hash, SearchFieldKind Field, uint Position, uint PositionLength, bool Stopword, bool KeepPositionsCandidate);

    private enum SearchFieldKind : byte
    {
        Title = 1,
        Summary = 2,
        Meta = 3,
        Body = 4
    }

    private enum SearchShardRole : uint
    {
        Core = 0,
        Recent = 1,
        Archive = 2,
        Body = 3
    }

    private enum SearchPackageEntryKind : uint
    {
        Shard = 0,
        Patch = 1
    }

    private readonly record struct SearchPackageEntry(SearchPackageEntryKind Kind, SearchShardRole Role, byte[] Bytes);
    private readonly record struct TermMetadataRecord(uint Hash, float Idf, uint PostingOffset, uint PostingLength, bool HasPositions);
    private readonly record struct DictionaryMetadataRecord(int OriginalId, uint StringOffset, ushort StringLength);
    private readonly record struct DocMetadataRecord(
        uint ArticleId,
        ushort CategoryIndex,
        ushort TagCount,
        uint TagRefOffset,
        uint Views,
        uint CommentCount,
        uint DocLength,
        long PublishUnixMs,
        uint TitleOffset,
        ushort TitleLength,
        uint SummaryOffset,
        ushort SummaryLength);

    private sealed class TermAccumulator
    {
        public int DocumentFrequency { get; set; }
        public bool Stopword { get; set; }
        public bool KeepPositions { get; set; }
        public Dictionary<int, PostingAccumulator> Postings { get; } = [];
    }

    private sealed class PostingAccumulator
    {
        public int ArticleId { get; init; }
        public int TitleTfRaw { get; set; }
        public int MetaTfRaw { get; set; }
        public int BodyTfRaw { get; set; }
        public List<SearchPositionEntry> Positions { get; } = [];

        public SearchPostingEntry Build(bool keepPositions)
            => new(
                (uint)ArticleId,
                QuantizeTf(TitleTfRaw),
                QuantizeTf(MetaTfRaw),
                QuantizeTf(BodyTfRaw),
                keepPositions ? Positions.Distinct().OrderBy(it => it.Position).ToArray() : []);
    }

    private readonly record struct TokenEmissionContext(int ArticleId, Dictionary<uint, TermAccumulator> Terms)
    {
        public void AddToken(SearchToken token)
        {
            ref TermAccumulator? term = ref CollectionsMarshal.GetValueRefOrAddDefault(Terms, token.Hash, out _);
            term ??= new TermAccumulator();
            term.Stopword |= token.Stopword;
            term.KeepPositions |= token.KeepPositionsCandidate;

            ref PostingAccumulator? posting = ref CollectionsMarshal.GetValueRefOrAddDefault(term.Postings, ArticleId, out _);
            posting ??= new PostingAccumulator { ArticleId = ArticleId };
            switch (token.Field)
            {
                case SearchFieldKind.Title:
                    posting.TitleTfRaw++;
                    posting.Positions.Add(new SearchPositionEntry(token.Position, token.PositionLength, SearchFieldKind.Title));
                    break;
                case SearchFieldKind.Body:
                    posting.BodyTfRaw++;
                    posting.Positions.Add(new SearchPositionEntry(token.Position, token.PositionLength, SearchFieldKind.Body));
                    break;
                default:
                    posting.MetaTfRaw++;
                    break;
            }

            term.DocumentFrequency = term.Postings.Count;
        }
    }

    private static byte QuantizeTf(int value)
    {
        if (value <= 0)
        {
            return 0;
        }

        if (value <= QuantizedTfMaxExact)
        {
            return (byte)value;
        }

        return value switch
        {
            <= 12 => 11,
            <= 15 => 12,
            <= 20 => 13,
            <= 30 => 14,
            <= 50 => 15,
            <= 100 => 16,
            _ => 17
        };
    }

    internal static byte QuantizeTfForTests(int value)
        => QuantizeTf(value);

    internal static bool ShouldKeepPositionsForTests(int documentFrequency, int dfCutoff, bool stopword, bool keepPositionsCandidate)
        => ShouldKeepPositions(documentFrequency, dfCutoff, stopword, keepPositionsCandidate);

    internal static bool ShouldEmitPatchForTests(
        int shardDocCount,
        int patchDocCount,
        int tombstoneCount,
        int patchBytesLength,
        int shardBytesLength)
        => ShouldEmitPatch(shardDocCount, patchDocCount, tombstoneCount, patchBytesLength, shardBytesLength);

    internal static SearchTokenDebugView[] TokenizeForTests(string sourceRoot, string text, string fieldName = "Body")
    {
        string lexiconPath = Path.Combine(sourceRoot, SearchLexiconBinaryFileName);
        SearchDictionaryCompiler.CompileIfNeeded(sourceRoot, lexiconPath, NullLogger<SearchIndexService>.Instance);
        using var dictionary = SearchDictionaryRuntime.Open(lexiconPath);
        if (string.IsNullOrEmpty(text))
        {
            return [];
        }

        SearchFieldKind field = Enum.TryParse<SearchFieldKind>(fieldName, ignoreCase: true, out SearchFieldKind parsed)
            ? parsed
            : SearchFieldKind.Body;

        int byteCount = Encoding.UTF8.GetByteCount(text);
        byte[]? rented = null;
        Span<byte> buffer = byteCount <= 1024
            ? stackalloc byte[byteCount]
            : (rented = ArrayPool<byte>.Shared.Rent(byteCount)).AsSpan(0, byteCount);

        try
        {
            Encoding.UTF8.GetBytes(text.AsSpan(), buffer);
            var tokenizer = new SearchTokenizer(dictionary, field, buffer[..byteCount]);
            var tokens = new List<SearchTokenDebugView>();
            while (tokenizer.MoveNext(out SearchToken token))
            {
                tokens.Add(new SearchTokenDebugView(token.Hash, tokenizer.GetDebugText(token), token.Position, token.PositionLength, token.Stopword, token.KeepPositionsCandidate));
            }

            return [.. tokens];
        }
        finally
        {
            if (rented is not null)
            {
                ArrayPool<byte>.Shared.Return(rented, clearArray: true);
            }
        }
    }

    internal readonly record struct SearchTokenDebugView(
        uint Hash,
        string Text,
        uint Position,
        uint PositionLength,
        bool Stopword,
        bool KeepPositionsCandidate);

    private ref struct SearchTokenizer
    {
        private readonly SearchDictionaryRuntime _dictionary;
        private readonly SearchFieldKind _field;
        private ReadOnlySpan<byte> _source;
        private int _index;
        private uint _position;
        private SearchToken[] _queuedTokens;
        private int _queuedIndex;
        private int _queuedCount;

        public SearchTokenizer(SearchDictionaryRuntime dictionary, SearchFieldKind field, ReadOnlySpan<byte> source)
        {
            _dictionary = dictionary;
            _field = field;
            _source = source;
            _index = 0;
            _position = 0;
            _queuedTokens = [];
            _queuedIndex = 0;
            _queuedCount = 0;
        }

        public string GetDebugText(SearchToken token)
            => _dictionary.ResolveUtf8(token.Hash);

        public bool MoveNext(out SearchToken token)
        {
            if (_queuedIndex < _queuedCount)
            {
                token = _queuedTokens[_queuedIndex++];
                return true;
            }

            while (_index < _source.Length)
            {
                byte current = _source[_index];
                if (IsAsciiWord(current))
                {
                    return MoveAscii(out token);
                }

                int runeLength = GetUtf8ScalarLength(current);
                if (runeLength <= 0 || _index + runeLength > _source.Length)
                {
                    _index++;
                    continue;
                }

                uint scalar = DecodeUtf8Scalar(_source, _index, runeLength);
                if (IsIgnorableScalar(scalar))
                {
                    _index += runeLength;
                    continue;
                }

                if (IsCjkScalar(scalar) && QueueCjkSegmentTokens())
                {
                    token = _queuedTokens[_queuedIndex++];
                    return true;
                }

                uint unigramHash = MurmurHash3.HashBytes(_source.Slice(_index, runeLength));
                token = new SearchToken(unigramHash, _field, _position, 1, false, _field is SearchFieldKind.Title or SearchFieldKind.Body);
                _index += runeLength;
                _position++;
                return true;
            }

            token = default;
            return false;
        }

        private bool QueueCjkSegmentTokens()
        {
            int segmentStart = _index;
            int cursor = _index;
            int runeCount = 0;
            while (cursor < _source.Length)
            {
                int runeLength = GetUtf8ScalarLength(_source[cursor]);
                if (runeLength <= 0 || cursor + runeLength > _source.Length)
                {
                    break;
                }

                uint scalar = DecodeUtf8Scalar(_source, cursor, runeLength);
                if (!IsCjkScalar(scalar))
                {
                    break;
                }

                cursor += runeLength;
                runeCount++;
            }

            if (runeCount == 0 || cursor <= segmentStart)
            {
                return false;
            }

            ReadOnlySpan<byte> segment = _source[segmentStart..cursor];
            int[] runeOffsets = new int[runeCount + 1];
            int localOffset = 0;
            for (int i = 0; i < runeCount; i++)
            {
                runeOffsets[i] = localOffset;
                localOffset += GetUtf8ScalarLength(segment[localOffset]);
            }
            runeOffsets[runeCount] = segment.Length;

            double[] bestScores = new double[runeCount + 1];
            int[] bestLengths = new int[runeCount];
            bool[] bestStopwords = new bool[runeCount];
            Span<SearchDictionaryMatch> matches = stackalloc SearchDictionaryMatch[32];

            for (int runeIndex = runeCount - 1; runeIndex >= 0; runeIndex--)
            {
                ReadOnlySpan<byte> suffix = segment[runeOffsets[runeIndex]..];
                int matchCount = _dictionary.CollectMatches(suffix, matches);

                double bestScore = double.NegativeInfinity;
                int bestLength = 1;
                bool bestStopword = false;

                if (matchCount > 0)
                {
                    for (int i = 0; i < matchCount; i++)
                    {
                        SearchDictionaryMatch match = matches[i];
                        if (match.RuneLength <= 0 || runeIndex + match.RuneLength > runeCount)
                        {
                            continue;
                        }

                        double score = match.Frequency + (match.RuneLength * 0.25d) + bestScores[runeIndex + match.RuneLength];
                        if (score > bestScore)
                        {
                            bestScore = score;
                            bestLength = match.RuneLength;
                            bestStopword = match.Stopword;
                        }
                    }
                }

                double unigramScore = 1d + bestScores[runeIndex + 1];
                if (bestScore < unigramScore)
                {
                    bestScore = unigramScore;
                    bestLength = 1;
                    bestStopword = false;
                }

                bestScores[runeIndex] = bestScore;
                bestLengths[runeIndex] = bestLength;
                bestStopwords[runeIndex] = bestStopword;
            }

            int maxTokenCount = runeCount * 2;
            SearchToken[] queued = new SearchToken[maxTokenCount];
            int queuedCount = 0;
            uint basePosition = _position;
            for (int runeIndex = 0; runeIndex < runeCount;)
            {
                int runeLength = Math.Max(1, bestLengths[runeIndex]);
                int tokenByteStart = runeOffsets[runeIndex];
                int tokenByteLength = runeOffsets[runeIndex + runeLength] - tokenByteStart;
                ReadOnlySpan<byte> tokenBytes = segment.Slice(tokenByteStart, tokenByteLength);
                uint tokenPosition = basePosition + (uint)runeIndex;
                bool keepPositions = _field is SearchFieldKind.Title or SearchFieldKind.Body;

                queued[queuedCount++] = new SearchToken(
                    MurmurHash3.HashBytes(tokenBytes),
                    _field,
                    tokenPosition,
                    (uint)runeLength,
                    bestStopwords[runeIndex],
                    keepPositions);

                if (runeLength >= 3)
                {
                    QueueDictionarySubtokens(segment, runeOffsets, runeIndex, runeLength, basePosition, keepPositions, ref queued, ref queuedCount);
                }

                runeIndex += runeLength;
            }

            _queuedTokens = queuedCount == queued.Length ? queued : queued[..queuedCount];
            _queuedIndex = 0;
            _queuedCount = queuedCount;
            _index = cursor;
            _position += (uint)runeCount;
            return queuedCount > 0;
        }

        private bool MoveAscii(out SearchToken token)
        {
            int start = _index;
            while (_index < _source.Length && IsAsciiWord(_source[_index]))
            {
                _index++;
            }

            int length = _index - start;
            Span<byte> lower = length <= 128 ? stackalloc byte[length] : new byte[length];
            _source.Slice(start, length).CopyTo(lower);
            for (int i = 0; i < lower.Length; i++)
            {
                byte value = lower[i];
                if (value is >= (byte)'A' and <= (byte)'Z')
                {
                    lower[i] = (byte)(value + 32);
                }
            }

            token = new SearchToken(MurmurHash3.HashBytes(lower), _field, _position, 1, false, _field is SearchFieldKind.Title or SearchFieldKind.Body);
            _position++;
            return true;
        }

        private void QueueDictionarySubtokens(
            ReadOnlySpan<byte> segment,
            int[] runeOffsets,
            int tokenRuneIndex,
            int tokenRuneLength,
            uint basePosition,
            bool keepPositions,
            ref SearchToken[] queued,
            ref int queuedCount)
        {
            for (int subStart = tokenRuneIndex; subStart < tokenRuneIndex + tokenRuneLength; subStart++)
            {
                int maxSubLength = tokenRuneLength - (subStart - tokenRuneIndex);
                for (int subLength = 2; subLength <= Math.Min(maxSubLength, tokenRuneLength - 1); subLength++)
                {
                    int subByteStart = runeOffsets[subStart];
                    int subByteLength = runeOffsets[subStart + subLength] - subByteStart;
                    ReadOnlySpan<byte> subBytes = segment.Slice(subByteStart, subByteLength);
                    if (!_dictionary.TryFindExactMatch(subBytes, out SearchDictionaryMatch match))
                    {
                        continue;
                    }

                    SearchToken subToken = new(
                        MurmurHash3.HashBytes(subBytes),
                        _field,
                        basePosition + (uint)subStart,
                        (uint)subLength,
                        match.Stopword,
                        keepPositions);

                    bool duplicate = false;
                    for (int i = 0; i < queuedCount; i++)
                    {
                        if (queued[i].Hash == subToken.Hash
                            && queued[i].Position == subToken.Position
                            && queued[i].PositionLength == subToken.PositionLength)
                        {
                            duplicate = true;
                            break;
                        }
                    }

                    if (!duplicate)
                    {
                        if (queuedCount == queued.Length)
                        {
                            Array.Resize(ref queued, queued.Length + 8);
                        }

                        queued[queuedCount++] = subToken;
                    }
                }
            }
        }

        private static bool IsAsciiWord(byte value)
            => value is >= (byte)'a' and <= (byte)'z'
                || value is >= (byte)'A' and <= (byte)'Z'
                || value is >= (byte)'0' and <= (byte)'9';

        internal static int GetUtf8ScalarLength(byte value)
            => value switch
            {
                < 0x80 => 1,
                >= 0xC2 and < 0xE0 => 2,
                >= 0xE0 and < 0xF0 => 3,
                >= 0xF0 and < 0xF8 => 4,
                _ => 1
            };

        private static uint DecodeUtf8Scalar(ReadOnlySpan<byte> source, int offset, int runeLength)
            => runeLength switch
            {
                1 => source[offset],
                2 => (uint)((source[offset] & 0x1F) << 6 | (source[offset + 1] & 0x3F)),
                3 => (uint)((source[offset] & 0x0F) << 12 | (source[offset + 1] & 0x3F) << 6 | (source[offset + 2] & 0x3F)),
                4 => (uint)((source[offset] & 0x07) << 18 | (source[offset + 1] & 0x3F) << 12 | (source[offset + 2] & 0x3F) << 6 | (source[offset + 3] & 0x3F)),
                _ => 0
            };

        private static bool IsCjkScalar(uint scalar)
            => scalar is >= 0x4E00 and <= 0x9FFF
                || scalar is >= 0x3400 and <= 0x4DBF
                || scalar is >= 0x3040 and <= 0x30FF
                || scalar is >= 0xAC00 and <= 0xD7AF;

        private static bool IsIgnorableScalar(uint scalar)
            => scalar <= 0x20
                || char.IsPunctuation((char)scalar)
                || char.IsWhiteSpace((char)scalar);
    }

    private static class SearchDictionaryCompiler
    {
        internal const uint Magic = 0x4C445346; // FSDL
        internal const uint Version = 1;

        public static void CompileIfNeeded(string sourceRoot, string outputPath, ILogger logger)
        {
            string corePath = Path.Combine(sourceRoot, "core.dict.txt");
            string domainPath = Path.Combine(sourceRoot, "domain.dict.txt");
            string stopwordsPath = Path.Combine(sourceRoot, "stopwords.txt");

            DateTime latestSource = new[] { corePath, domainPath, stopwordsPath }
                .Where(File.Exists)
                .Select(File.GetLastWriteTimeUtc)
                .DefaultIfEmpty(DateTime.MinValue)
                .Max();

            if (File.Exists(outputPath) && File.GetLastWriteTimeUtc(outputPath) >= latestSource)
            {
                return;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
            Dictionary<string, LexiconEntryBuilder> entries = [];
            LoadEntries(corePath, entries, stopword: false);
            LoadEntries(domainPath, entries, stopword: false);
            LoadEntries(stopwordsPath, entries, stopword: true);

            LexiconEntryBuilder[] ordered = entries.Values
                .OrderBy(it => it.Bytes[0])
                .ThenBy(it => Convert.ToHexString(it.Bytes), StringComparer.Ordinal)
                .ToArray();

            var prefixRanges = new (uint Start, uint Count)[256];
            for (uint i = 0; i < ordered.Length; i++)
            {
                byte first = ordered[i].Bytes[0];
                ref var range = ref prefixRanges[first];
                if (range.Count == 0)
                {
                    range.Start = i;
                }
                range.Count++;
            }

            using var strings = new PooledByteBufferWriter(Math.Max(ordered.Sum(it => it.Bytes.Length), 256));
            using var writer = new PooledByteBufferWriter(4096);
            WriteUInt32(writer, Magic);
            WriteUInt32(writer, Version);
            WriteUInt32(writer, (uint)ordered.Length);
            WriteUInt32(writer, 16 + 256 * 8u);

            foreach ((uint start, uint count) in prefixRanges)
            {
                WriteUInt32(writer, start);
                WriteUInt32(writer, count);
            }

            int entryTableOffset = writer.WrittenCount;
            AlignWriter(writer, Align(entryTableOffset, 8));

            var offsets = new uint[ordered.Length];
            for (int i = 0; i < ordered.Length; i++)
            {
                offsets[i] = (uint)strings.WrittenCount;
                strings.Write(ordered[i].Bytes);
            }

            for (int i = 0; i < ordered.Length; i++)
            {
                LexiconEntryBuilder entry = ordered[i];
                WriteUInt32(writer, offsets[i]);
                WriteUInt16(writer, checked((ushort)entry.Bytes.Length));
                WriteUInt16(writer, entry.Stopword ? (ushort)1 : (ushort)0);
                WriteUInt32(writer, (uint)entry.Frequency);
                WriteUInt32(writer, 0);
            }

            byte[] stringBytes = strings.ToArray();
            WriteUInt32(writer, (uint)stringBytes.Length);
            writer.Write(stringBytes);
            File.WriteAllBytes(outputPath, writer.ToArray());
            logger.LogInformation("search lexicon compiled to {Path} with {Count} entries", outputPath, ordered.Length);
        }

        private static void LoadEntries(string path, Dictionary<string, LexiconEntryBuilder> target, bool stopword)
        {
            if (!File.Exists(path))
            {
                return;
            }

            foreach (string raw in File.ReadLines(path, Encoding.UTF8))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith('#'))
                {
                    continue;
                }

                string[] parts = line.Split('\t', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                string term = parts[0];
                int frequency = stopword
                    ? 1
                    : parts.Length >= 2 && int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed)
                        ? parsed
                        : 1;

                if (target.TryGetValue(term, out LexiconEntryBuilder? existing))
                {
                    existing.Frequency = Math.Max(existing.Frequency, frequency);
                    existing.Stopword |= stopword;
                    continue;
                }

                target[term] = new LexiconEntryBuilder
                {
                    Bytes = Encoding.UTF8.GetBytes(term),
                    Frequency = frequency,
                    Stopword = stopword
                };
            }
        }

        private sealed class LexiconEntryBuilder
        {
            public byte[] Bytes { get; init; } = [];
            public int Frequency { get; set; }
            public bool Stopword { get; set; }
        }
    }

    private sealed unsafe class SearchDictionaryRuntime : IDisposable
    {
        private readonly MemoryMappedFile _mmf;
        private readonly MemoryMappedViewAccessor _view;
        private readonly SafeMemoryMappedViewHandle _handle;
        private byte* _basePtr;
        private readonly PrefixRange[] _prefixRanges;
        private readonly LexiconEntry[] _entries;
        private readonly int _stringsBaseOffset;

        private SearchDictionaryRuntime(
            MemoryMappedFile mmf,
            MemoryMappedViewAccessor view,
            SafeMemoryMappedViewHandle handle,
            byte* basePtr,
            PrefixRange[] prefixRanges,
            LexiconEntry[] entries,
            int stringsBaseOffset)
        {
            _mmf = mmf;
            _view = view;
            _handle = handle;
            _basePtr = basePtr;
            _prefixRanges = prefixRanges;
            _entries = entries;
            _stringsBaseOffset = stringsBaseOffset;
        }

        public static SearchDictionaryRuntime Open(string path)
        {
            MemoryMappedFile? mmf = null;
            MemoryMappedViewAccessor? view = null;
            SafeMemoryMappedViewHandle? handle = null;
            byte* basePtr = null;
            bool pointerAcquired = false;

            try
            {
                mmf = MemoryMappedFile.CreateFromFile(path, FileMode.Open, null, 0, MemoryMappedFileAccess.Read);
                view = mmf.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
                handle = view.SafeMemoryMappedViewHandle;
                handle.AcquirePointer(ref basePtr);
                pointerAcquired = true;
                if (basePtr is null)
                {
                    throw new InvalidOperationException("Failed to acquire search dictionary pointer.");
                }

                byte* cursor = basePtr;
                uint magic = Unsafe.ReadUnaligned<uint>(cursor);
                cursor += sizeof(uint);
                uint version = Unsafe.ReadUnaligned<uint>(cursor);
                cursor += sizeof(uint);
                if (magic != SearchDictionaryCompiler.Magic || version != SearchDictionaryCompiler.Version)
                {
                    throw new InvalidDataException("search dictionary header invalid");
                }

                uint entryCount = Unsafe.ReadUnaligned<uint>(cursor);
                cursor += sizeof(uint);
                _ = Unsafe.ReadUnaligned<uint>(cursor);
                cursor += sizeof(uint);

                var prefixRanges = new PrefixRange[256];
                for (int i = 0; i < prefixRanges.Length; i++)
                {
                    prefixRanges[i] = new PrefixRange(Unsafe.ReadUnaligned<uint>(cursor), Unsafe.ReadUnaligned<uint>(cursor + 4));
                    cursor += 8;
                }

                cursor = basePtr + Align((int)(cursor - basePtr), 8);
                var entries = new LexiconEntry[entryCount];
                for (int i = 0; i < entryCount; i++)
                {
                    uint offset = Unsafe.ReadUnaligned<uint>(cursor);
                    ushort length = Unsafe.ReadUnaligned<ushort>(cursor + 4);
                    ushort flags = Unsafe.ReadUnaligned<ushort>(cursor + 6);
                    uint frequency = Unsafe.ReadUnaligned<uint>(cursor + 8);
                    entries[i] = new LexiconEntry(offset, length, frequency, (flags & 1) != 0);
                    cursor += 16;
                }

                _ = (int)Unsafe.ReadUnaligned<uint>(cursor);
                cursor += sizeof(uint);
                int stringsBaseOffset = (int)(cursor - basePtr);
                return new SearchDictionaryRuntime(mmf, view, handle, basePtr, prefixRanges, entries, stringsBaseOffset);
            }
            catch
            {
                if (pointerAcquired && handle is not null)
                {
                    handle.ReleasePointer();
                }

                view?.Dispose();
                mmf?.Dispose();
                throw;
            }
        }

        public int CollectMatches(ReadOnlySpan<byte> source, Span<SearchDictionaryMatch> matches)
        {
            if (source.IsEmpty)
            {
                return 0;
            }

            PrefixRange range = _prefixRanges[source[0]];
            if (range.Count == 0)
            {
                return 0;
            }

            int count = 0;
            for (uint i = range.Start; i < range.Start + range.Count; i++)
            {
                LexiconEntry entry = _entries[i];
                if (entry.ByteLength > source.Length)
                {
                    continue;
                }

                ReadOnlySpan<byte> candidate = new(_basePtr + _stringsBaseOffset + entry.StringOffset, entry.ByteLength);
                if (!source[..entry.ByteLength].SequenceEqual(candidate))
                {
                    continue;
                }

                if (count >= matches.Length)
                {
                    break;
                }

                matches[count++] = new SearchDictionaryMatch(entry.ByteLength, CountRunes(candidate), entry.Frequency, entry.Stopword);
            }

            if (count > 1)
            {
                matches[..count].Sort(static (left, right) =>
                {
                    int byRunes = right.RuneLength.CompareTo(left.RuneLength);
                    return byRunes != 0 ? byRunes : right.Frequency.CompareTo(left.Frequency);
                });
            }

            return count;
        }

        public bool TryFindExactMatch(ReadOnlySpan<byte> source, out SearchDictionaryMatch match)
        {
            Span<SearchDictionaryMatch> matches = stackalloc SearchDictionaryMatch[16];
            int count = CollectMatches(source, matches);
            for (int i = 0; i < count; i++)
            {
                if (matches[i].ByteLength == source.Length)
                {
                    match = matches[i];
                    return true;
                }
            }

            match = default;
            return false;
        }

        public string ResolveUtf8(uint hash)
        {
            foreach (LexiconEntry entry in _entries)
            {
                ReadOnlySpan<byte> candidate = new(_basePtr + _stringsBaseOffset + entry.StringOffset, entry.ByteLength);
                if (MurmurHash3.HashBytes(candidate) == hash)
                {
                    return Encoding.UTF8.GetString(candidate);
                }
            }

            return hash.ToString(CultureInfo.InvariantCulture);
        }

        public void Dispose()
        {
            if (_basePtr is not null)
            {
                _handle.ReleasePointer();
                _basePtr = null;
            }

            _view.Dispose();
            _mmf.Dispose();
        }

        private static int CountRunes(ReadOnlySpan<byte> bytes)
        {
            int count = 0;
            for (int i = 0; i < bytes.Length;)
            {
                i += SearchTokenizer.GetUtf8ScalarLength(bytes[i]);
                count++;
            }

            return count;
        }

        private readonly record struct PrefixRange(uint Start, uint Count);
        private readonly record struct LexiconEntry(uint StringOffset, ushort ByteLength, uint Frequency, bool Stopword)
        { }
    }

    private readonly record struct SearchDictionaryMatch(int ByteLength, int RuneLength, uint Frequency, bool Stopword);

    private static class MurmurHash3
    {
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static uint HashBytes(ReadOnlySpan<byte> bytes)
        {
            const uint c1 = 0xcc9e2d51;
            const uint c2 = 0x1b873593;
            uint h1 = 0;
            int length = bytes.Length;
            int roundedEnd = length & ~0x3;

            for (int i = 0; i < roundedEnd; i += 4)
            {
                uint k1 = (uint)(bytes[i]
                    | bytes[i + 1] << 8
                    | bytes[i + 2] << 16
                    | bytes[i + 3] << 24);

                k1 *= c1;
                k1 = BitOperations.RotateLeft(k1, 15);
                k1 *= c2;

                h1 ^= k1;
                h1 = BitOperations.RotateLeft(h1, 13);
                h1 = h1 * 5 + 0xe6546b64;
            }

            uint tail = 0;
            switch (length & 3)
            {
                case 3:
                    tail ^= (uint)bytes[roundedEnd + 2] << 16;
                    goto case 2;
                case 2:
                    tail ^= (uint)bytes[roundedEnd + 1] << 8;
                    goto case 1;
                case 1:
                    tail ^= bytes[roundedEnd];
                    tail *= c1;
                    tail = BitOperations.RotateLeft(tail, 15);
                    tail *= c2;
                    h1 ^= tail;
                    break;
            }

            h1 ^= (uint)length;
            h1 ^= h1 >> 16;
            h1 *= 0x85ebca6b;
            h1 ^= h1 >> 13;
            h1 *= 0xc2b2ae35;
            h1 ^= h1 >> 16;
            return h1;
        }
    }
}

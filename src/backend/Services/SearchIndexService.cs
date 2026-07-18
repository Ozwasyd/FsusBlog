using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Frozen;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Globalization;
using System.IO.MemoryMappedFiles;
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;

using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Win32.SafeHandles;

using SqlSugar;

namespace FsusBlog.Server.Services;

/// <summary>
/// 搜索离线索引编译服务。
/// 直接生成多分片 search index 与 append+tombstone patch。
/// </summary>
public sealed partial class SearchIndexService(
    IServiceScopeFactory scopeFactory,
    IWebHostEnvironment environment,
    IConfiguration configuration,
    INotificationStreamPublisher notificationStreamPublisher,
    IUnifiedCache cache,
    ILogger<SearchIndexService> logger) : ISearchIndexService
{
    private const uint ShardMagic = 0x32534846; // FHS2
    private const uint PackageMagic = 0x4B505346; // FSPK
    private const uint SearchShardVersion = 3;
    private const uint SearchPackageVersion = 3;
    private const int MaxSummaryLength = 180;
    private const int QuantizedTfMaxExact = 10;
    private const int HotFrequencyPercentile = 95;
    private const int RecentYearsWindow = 2;
    private const int MaxSearchKeywordChars = 128;
    private const int MaxIndexedBodyChars = 256 * 1024;
    private const int MaxCjkSegmentRunes = 4096;
    private const int SearchManifestSchemaVersion = 3;
    private const int PatchRebuildDocThresholdPercent = 20;
    private const int PatchRebuildByteThresholdPercent = 25;
    private const int PatchRebuildTombstoneThresholdPercent = 15;
    private const string SearchIndexDirectory = "search";
    private const string SearchPatchDirectory = "patches";
    private const string SearchDictionaryDirectory = "dictionaries";
    private const string SearchManifestFileName = "index.manifest.aeds";
    private const string SearchAliasFileName = "index.bin";
    private const string SearchLexiconSourceDirectory = "Dictionaries/Search";
    private const string SearchLexiconBinaryFileName = "lexicon.bin";
    private const uint SearchManifestMagic = 0x4D495346; // FSIM
    private const uint SearchManifestBinaryVersion = 1;
    private const int HeaderSize = 72;
    private const int TermMetadataSize = 24;
    private const int DocMetadataSize = 52;
    private const int DictionaryMetadataSize = 16;
    private static readonly SemaphoreSlim SearchIndexWriteGate = new(1, 1);
    private volatile SearchRuntimeSnapshot? _runtimeSnapshot;
    private static readonly FrozenDictionary<SearchShardRole, int> DefaultLoadPhase = new Dictionary<SearchShardRole, int>
    {
        [SearchShardRole.Core] = 0,
        [SearchShardRole.Recent] = 0,
        [SearchShardRole.Archive] = 1
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
                long startedAt = Stopwatch.GetTimestamp();
                string result = "ok";
                using Activity? activity = FsusObservability.StartActivity("search.query", "search");
                FsusObservability.SetTag(activity, "fsus.search.mode", "query");
                try
                {
                    if (string.IsNullOrWhiteSpace(keyword))
                    {
                        result = "empty_keyword";
                        return [];
                    }

                    string normalizedKeyword = keyword.Trim();
                    if (normalizedKeyword.Length > MaxSearchKeywordChars)
                    {
                        result = "keyword_too_long";
                        return [];
                    }

                    SearchRuntimeSnapshot? runtimeSnapshot = _runtimeSnapshot;
                    if (runtimeSnapshot is not null)
                    {
                        return runtimeSnapshot.Search(normalizedKeyword);
                    }

                    string fallbackKeyword = NormalizeKeywordForFallback(normalizedKeyword);
                    await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
                    ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
                    DateTime now = DateTime.UtcNow;
                    var rows = await db.Queryable<Article>()
                        .Where(article =>
                            !article.IsDeleted
                            && article.Status == ArticleStatus.Published
                            && (article.PublishedAt == null || article.PublishedAt <= now)
                            && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= now)
                            && (article.Title.ToLower().Contains(fallbackKeyword)
                                || (article.Summary != null && article.Summary.ToLower().Contains(fallbackKeyword))))
                        .OrderByDescending(article => article.Views)
                        .OrderByDescending(article => article.CreateTime)
                        .Take(200)
                        .Select(article => new SearchArticleResultRow
                        {
                            Id = article.Id,
                            Title = article.Title,
                            Summary = article.Summary
                        })
                        .ToListAsync();

                    var results = new List<Article>(rows.Count);
                    foreach (SearchArticleResultRow row in rows)
                    {
                        results.Add(new Article
                        {
                            Id = row.Id,
                            Title = row.Title ?? string.Empty,
                            Content = BuildServerSearchSnippet(normalizedKeyword, row.Title, row.Summary, body: null)
                        });
                    }

                    return results;
                }
                catch
                {
                    _runtimeSnapshot = null;
                    result = "failed";
                    throw;
                }
                finally
                {
                    FsusObservability.SetTag(activity, "fsus.result", result);
                    FsusObservability.RecordSearchOperation("query", result, FsusObservability.GetElapsed(startedAt));
                }
            },
            _ => [],
            logger,
            "search-index-search",
            LogLevel.Error);

    public Task AddOrUpdateIndexAsync(Article article)
        => ApplyIncrementalSearchIndexAsync([article.Id], []);

    public Task DeleteIndexAsync(int id)
        => ApplyIncrementalSearchIndexAsync([], [id]);

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

    private static string NormalizeKeywordForFallback(string keyword)
        => NormalizeTokenForTests(keyword) ?? TextHelpers.LowerTrimmed(keyword) ?? string.Empty;

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

    public static ulong TokenFingerprintForTests(string input)
        => HashTokenForTests(input);

    internal static void ValidateDictionaryHeaderForTests(string path)
    {
        using var runtime = SearchDictionaryRuntime.Open(path);
    }

    private Task RebuildSearchIndexAsync(IReadOnlyCollection<int> upsertArticleIds, IReadOnlyCollection<int> deletedArticleIds)
        => BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                long startedAt = Stopwatch.GetTimestamp();
                string result = "ok";
                using Activity? activity = FsusObservability.StartActivity("search.rebuild", "search");
                FsusObservability.SetTag(activity, "fsus.search.mode", "rebuild");
                try
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
                    SearchRuntimeSnapshot runtimeSnapshot = SearchRuntimeSnapshot.Build(articles, dictionary);
                    _runtimeSnapshot = runtimeSnapshot;
                    FsusObservability.RecordSearchRuntimeSnapshotMemory(runtimeSnapshot.EstimatedMemoryBytes, "full");
                    await PublishArtifactsAsync(root, artifacts, upsertArticleIds, deletedArticleIds);
                }
                catch
                {
                    result = "failed";
                    throw;
                }
                finally
                {
                    FsusObservability.SetTag(activity, "fsus.result", result);
                    FsusObservability.RecordSearchOperation("rebuild", result, FsusObservability.GetElapsed(startedAt));
                }
            },
            logger,
            "search-index-rebuild",
            LogLevel.Error);

    private Task ApplyIncrementalSearchIndexAsync(IReadOnlyCollection<int> upsertArticleIds, IReadOnlyCollection<int> deletedArticleIds)
        => BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                long startedAt = Stopwatch.GetTimestamp();
                string result = "ok";
                using Activity? activity = FsusObservability.StartActivity("search.incremental", "search");
                FsusObservability.SetTag(activity, "fsus.search.mode", "incremental");
                try
                {
                    string root = ResolveSearchRoot();
                    string manifestPath = Path.Combine(root, SearchManifestFileName);
                    SearchIndexManifest? previousManifest = ReadManifest(manifestPath);
                    if (previousManifest is null)
                    {
                        await RebuildSearchIndexAsync(upsertArticleIds, deletedArticleIds).ConfigureAwait(false);
                        result = "full_compact";
                        return;
                    }

                    await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
                    ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
                    List<SearchSourceArticle> articles = await LoadArticlesAsync(db).ConfigureAwait(false);
                    string dictionariesDirectory = Path.Combine(root, SearchDictionaryDirectory);
                    Directory.CreateDirectory(dictionariesDirectory);
                    string lexiconPath = Path.Combine(dictionariesDirectory, SearchLexiconBinaryFileName);
                    SearchDictionaryCompiler.CompileIfNeeded(
                        Path.Combine(environment.ContentRootPath, SearchLexiconSourceDirectory),
                        lexiconPath,
                        logger);
                    using var dictionary = SearchDictionaryRuntime.Open(lexiconPath);

                    SearchBuildArtifacts artifacts = BuildArtifacts(articles, dictionary);
                    await PublishArtifactsAsync(root, artifacts, upsertArticleIds, deletedArticleIds).ConfigureAwait(false);
                    _runtimeSnapshot = null;
                    FsusObservability.RecordSearchRuntimeSnapshotMemory(0, "incremental-invalidated");
                }
                catch
                {
                    result = "failed";
                    throw;
                }
                finally
                {
                    FsusObservability.SetTag(activity, "fsus.result", result);
                    FsusObservability.RecordSearchOperation("incremental", result, FsusObservability.GetElapsed(startedAt));
                }
            },
            logger,
            "search-index-incremental",
            LogLevel.Error);

    private string ResolveSearchRoot()
    {
        string? derivedRoot = configuration["ReleaseStorage:DerivedRoot"]
            ?? configuration["FSUSBLOG_RELEASE_DERIVED_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_DERIVED_ROOT");
        if (!string.IsNullOrWhiteSpace(derivedRoot))
        {
            return ResolveReleaseScopedSearchRoot(derivedRoot, ResolveReleaseId());
        }

        string root = environment.WebRootPath;
        if (string.IsNullOrWhiteSpace(root))
        {
            root = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        }

        return Path.Combine(root, SearchIndexDirectory);
    }

    private string ResolveSearchPublicBase()
    {
        string? derivedRoot = configuration["ReleaseStorage:DerivedRoot"]
            ?? configuration["FSUSBLOG_RELEASE_DERIVED_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_DERIVED_ROOT");
        return string.IsNullOrWhiteSpace(derivedRoot)
            ? "/search"
            : ResolveReleaseScopedSearchPublicBase(ResolveReleaseId());
    }

    private string ResolveReleaseId()
    {
        string releaseId = configuration["FSUSBLOG_RELEASE_ID"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ID")
            ?? string.Empty;
        return NormalizeSearchReleaseId(releaseId);
    }

    internal static string ResolveReleaseScopedSearchRoot(string derivedRoot, string releaseId)
        => ReleaseStorageLayout.BuildReleaseDerivedPath(
            derivedRoot,
            NormalizeSearchReleaseId(releaseId),
            SearchIndexDirectory);

    internal static string ResolveReleaseScopedSearchPublicBase(string releaseId)
        => $"/release-derived/{NormalizeSearchReleaseId(releaseId)}/search";

    private static string NormalizeSearchReleaseId(string releaseId)
    {
        if (releaseId.Length is < 6 or > 128
            || !char.IsAsciiLetterOrDigit(releaseId[0])
            || releaseId.Any(static character => !char.IsAsciiLetterOrDigit(character)
                && character is not '.' and not '_' and not '-')
            || releaseId.Equals("latest", StringComparison.OrdinalIgnoreCase)
            || releaseId.Equals("current", StringComparison.OrdinalIgnoreCase)
            || releaseId.Equals("final-current", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Release-scoped search storage requires a safe immutable FSUSBLOG_RELEASE_ID.");
        }

        return releaseId;
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

        byte[] coreBytes = SerializeShard(coreShard);
        byte[] recentBytes = SerializeShard(recentShard);
        byte[] archiveBytes = SerializeShard(archiveShard);

        string version = ComputeVersion(coreBytes, recentBytes, archiveBytes);
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
                new SearchShardArtifact(SearchShardRole.Archive, archiveShard, archiveBytes)
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
        string publicBase = ResolveSearchPublicBase();
        string patchRoot = Path.Combine(root, SearchPatchDirectory);
        Directory.CreateDirectory(patchRoot);

        string manifestPath = Path.Combine(root, SearchManifestFileName);
        SearchIndexManifest? previousManifest = null;
        await SearchIndexWriteGate.WaitAsync().ConfigureAwait(false);
        try
        {
            previousManifest = ReadManifest(manifestPath);
            IReadOnlyList<SearchShardManifest> previousShards = previousManifest?.Shards ?? [];
            var shardManifests = new List<SearchShardManifest>(artifacts.Shards.Length);
            var generationFiles = new Dictionary<string, ReadOnlyMemory<byte>>(StringComparer.Ordinal);
            HashSet<int> changedDocumentIds = [.. upsertArticleIds];
            changedDocumentIds.UnionWith(deletedArticleIds);

            foreach (SearchShardArtifact shard in artifacts.Shards)
            {
                string shardVersionedFile = $"index.{shard.Role.ToString().ToLowerInvariant()}.{artifacts.Version}.bin";
                string shardUrl = $"{publicBase}/{shardVersionedFile}";
                generationFiles[shardVersionedFile] = shard.Bytes;

                SearchShardManifest? previousShard = previousShards.FirstOrDefault(it => it.Role == shard.Role);
                string? patchUrl = null;
                string? patchSha = null;
                if (previousShard is not null
                    && changedDocumentIds.Count > 0
                    && File.Exists(ResolvePublishedArtifactPath(root, previousShard.FullUrl)))
                {
                    SearchShardData patchShard = BuildPatchShard(shard.Data, changedDocumentIds);
                    byte[] patchShardBytes = patchShard.Documents.Length == 0 && patchShard.Terms.Length == 0
                        ? []
                        : SerializeShard(patchShard);
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
                        patchUrl = $"{publicBase}/{SearchPatchDirectory}/{patchFileName}";
                        patchSha = ToLowerHex(SHA256.HashData(patchBytes));
                        generationFiles[Path.Combine(SearchPatchDirectory, patchFileName)] = patchBytes;
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
                []);

            generationFiles[SearchAliasFileName] = artifacts.AliasPackage;
            generationFiles[SearchManifestFileName] = EncodeManifest(manifest);
            string lexiconPath = Path.Combine(root, SearchDictionaryDirectory, SearchLexiconBinaryFileName);
            if (File.Exists(lexiconPath))
            {
                generationFiles[Path.Combine(SearchDictionaryDirectory, SearchLexiconBinaryFileName)] =
                    await File.ReadAllBytesAsync(lexiconPath).ConfigureAwait(false);
            }

            ReleaseDerivedArtifactPublisher? publisher = ResolveReleaseDerivedPublisher();
            if (publisher is not null)
            {
                await PublishReleaseDerivedArtifactsAsync(publisher, generationFiles).ConfigureAwait(false);
            }
            else
            {
                foreach ((string relativePath, ReadOnlyMemory<byte> payload) in generationFiles
                             .Where(static pair => !string.Equals(pair.Key, SearchManifestFileName, StringComparison.Ordinal))
                             .OrderBy(static pair => pair.Key, StringComparer.Ordinal))
                {
                    WriteFileAtomically(Path.Combine(root, relativePath), payload.ToArray());
                }

                WriteFileAtomically(manifestPath, generationFiles[SearchManifestFileName].ToArray());
            }
        }
        finally
        {
            SearchIndexWriteGate.Release();
        }

        if (!string.Equals(previousManifest?.CurrentVersion, artifacts.Version, StringComparison.Ordinal))
        {
            await cache.IncrementAsync(CachePolicyId.ArticleSearchVersion, "main").ConfigureAwait(false);
            await notificationStreamPublisher.PublishAsync(
                NotificationStreamEventType.SearchIndexUpdated,
                new SearchIndexUpdatePayload(artifacts.Version, $"{publicBase}/index.manifest.aeds", artifacts.GeneratedAt),
                new NotificationStreamGroupTarget(NotificationStreamTargetCollections.ContentFeed));
        }
    }

    private ReleaseDerivedArtifactPublisher? ResolveReleaseDerivedPublisher()
    {
        string? derivedRoot = configuration["ReleaseStorage:DerivedRoot"]
            ?? configuration["FSUSBLOG_RELEASE_DERIVED_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_DERIVED_ROOT");
        if (string.IsNullOrWhiteSpace(derivedRoot))
        {
            return null;
        }

        return new ReleaseDerivedArtifactPublisher(derivedRoot, ResolveReleaseId());
    }

    internal static Task<ReleaseDerivedArtifactGeneration> PublishReleaseDerivedArtifactsAsync(
        ReleaseDerivedArtifactPublisher publisher,
        IReadOnlyDictionary<string, ReadOnlyMemory<byte>> files,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(publisher);
        if (!files.ContainsKey(SearchManifestFileName))
        {
            throw new ArgumentException("Search release-derived publication requires index.manifest.aeds.", nameof(files));
        }

        string generation = BuildSearchPublicationGeneration(files);
        return publisher.PublishGenerationAndProjectAsync(
            SearchIndexDirectory,
            generation,
            files,
            [SearchManifestFileName],
            cancellationToken);
    }

    internal static string BuildSearchPublicationGeneration(
        IReadOnlyDictionary<string, ReadOnlyMemory<byte>> files)
    {
        using IncrementalHash digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach ((string path, ReadOnlyMemory<byte> payload) in files.OrderBy(static pair => pair.Key, StringComparer.Ordinal))
        {
            byte[] pathBytes = Encoding.UTF8.GetBytes(path.Replace(Path.DirectorySeparatorChar, '/'));
            digest.AppendData(pathBytes);
            digest.AppendData(new byte[] { 0 });
            digest.AppendData(payload.Span);
            digest.AppendData(new byte[] { 0 });
        }

        return $"search-{Convert.ToHexStringLower(digest.GetHashAndReset())}";
    }

    private static string ResolvePublishedArtifactPath(string root, string publicUrl)
    {
        int searchSegment = publicUrl.IndexOf("/search/", StringComparison.Ordinal);
        if (searchSegment < 0)
        {
            throw new InvalidOperationException("Search artifact URL is outside the release search scope.");
        }

        string relativePath = publicUrl[(searchSegment + "/search/".Length)..]
            .Replace('/', Path.DirectorySeparatorChar);
        string candidate = Path.GetFullPath(Path.Combine(root, relativePath));
        string rootPrefix = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)) + Path.DirectorySeparatorChar;
        StringComparison comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        if (!candidate.StartsWith(rootPrefix, comparison))
        {
            throw new InvalidOperationException("Search artifact URL escaped the release search scope.");
        }

        return candidate;
    }

    private static SearchShardData BuildPatchShard(SearchShardData shard, IReadOnlySet<int> changedDocumentIds)
    {
        SearchDocEntry[] docs = shard.Documents
            .Where(doc => changedDocumentIds.Contains(doc.ArticleId))
            .ToArray();

        SearchTermEntry[] terms = BuildPatchTermsFromForwardIndex(shard, changedDocumentIds);

        if (!docs.Any(HasDocumentMetadata))
        {
            return new SearchShardData(
                shard.Role,
                docs.ToImmutableArray(),
                [],
                [],
                terms,
                BuildForwardIndex(terms),
                shard.AverageDocLength);
        }

        return BuildMetadataPatchShard(shard, docs, terms);
    }

    private static SearchTermEntry[] BuildPatchTermsFromForwardIndex(SearchShardData shard, IReadOnlySet<int> changedDocumentIds)
    {
        var postingsByTerm = new SortedDictionary<uint, List<SearchPostingEntry>>();
        foreach (int articleId in changedDocumentIds)
        {
            if (!shard.ForwardIndex.TryGetValue(articleId, out SearchForwardTermEntry[]? forwardTerms))
            {
                continue;
            }

            foreach (SearchForwardTermEntry forward in forwardTerms)
            {
                if (!postingsByTerm.TryGetValue(forward.TermHash, out List<SearchPostingEntry>? postings))
                {
                    postings = [];
                    postingsByTerm[forward.TermHash] = postings;
                }

                postings.Add(forward.Posting);
            }
        }

        if (postingsByTerm.Count == 0)
        {
            return [];
        }

        var termMetadata = shard.Terms.ToDictionary(static term => term.Hash);
        var terms = new SearchTermEntry[postingsByTerm.Count];
        int index = 0;
        foreach ((uint hash, List<SearchPostingEntry> postings) in postingsByTerm)
        {
            SearchTermEntry source = termMetadata[hash];
            postings.Sort(static (left, right) => left.ArticleId.CompareTo(right.ArticleId));
            terms[index++] = new SearchTermEntry(hash, source.Idf, source.HasPositions, postings.ToArray());
        }

        return terms;
    }

    private static bool HasDocumentMetadata(SearchDocEntry doc)
        => doc.PublishUnixMs != 0
            || doc.Views != 0
            || doc.CommentCount != 0
            || !string.IsNullOrEmpty(doc.Title)
            || !string.IsNullOrEmpty(doc.Summary)
            || doc.TagRefs.Length > 0;

    private static SearchShardData BuildMetadataPatchShard(SearchShardData shard, SearchDocEntry[] docs, SearchTermEntry[] terms)
    {
        var categoryIndexMap = new Dictionary<ushort, ushort>();
        var categoryEntries = ImmutableArray.CreateBuilder<SearchCategoryDictionaryEntry>();
        var tagIndexMap = new Dictionary<ushort, ushort>();
        var tagEntries = ImmutableArray.CreateBuilder<SearchTagDictionaryEntry>();
        var remappedDocs = ImmutableArray.CreateBuilder<SearchDocEntry>(docs.Length);

        foreach (SearchDocEntry doc in docs)
        {
            ushort categoryIndex = RemapCategoryIndex(shard.Categories, categoryIndexMap, categoryEntries, doc.CategoryDictionaryIndex);
            ushort[] tagRefs = new ushort[doc.TagRefs.Length];
            for (int i = 0; i < doc.TagRefs.Length; i++)
            {
                tagRefs[i] = RemapTagIndex(shard.Tags, tagIndexMap, tagEntries, doc.TagRefs[i]);
            }

            remappedDocs.Add(doc with
            {
                CategoryDictionaryIndex = categoryIndex,
                TagRefs = tagRefs
            });
        }

        return new SearchShardData(
            shard.Role,
            remappedDocs.MoveToImmutable(),
            categoryEntries.ToImmutable(),
            tagEntries.ToImmutable(),
            terms,
            BuildForwardIndex(terms),
            shard.AverageDocLength);
    }

    private static ushort RemapCategoryIndex(
        ImmutableArray<SearchCategoryDictionaryEntry> source,
        Dictionary<ushort, ushort> map,
        ImmutableArray<SearchCategoryDictionaryEntry>.Builder entries,
        ushort oldIndex)
    {
        if (oldIndex >= source.Length)
        {
            return 0;
        }

        if (map.TryGetValue(oldIndex, out ushort mapped))
        {
            return mapped;
        }

        mapped = checked((ushort)entries.Count);
        map[oldIndex] = mapped;
        entries.Add(source[oldIndex]);
        return mapped;
    }

    private static ushort RemapTagIndex(
        ImmutableArray<SearchTagDictionaryEntry> source,
        Dictionary<ushort, ushort> map,
        ImmutableArray<SearchTagDictionaryEntry>.Builder entries,
        ushort oldIndex)
    {
        if (oldIndex >= source.Length)
        {
            return 0;
        }

        if (map.TryGetValue(oldIndex, out ushort mapped))
        {
            return mapped;
        }

        mapped = checked((ushort)entries.Count);
        map[oldIndex] = mapped;
        entries.Add(source[oldIndex]);
        return mapped;
    }

}

using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;
using SqlSugar;
using StackExchange.Redis;
using System.Data;
using System.Data.Common;
using System.Runtime.CompilerServices;

namespace FsusBlog.Server.Services;

/// <summary>
/// 文章核心业务服务
/// 修复日期: 2026-02-23 (应用 DataReader 物理级映射，引入 MemoryCache 实现 Double-Check 缓存锁，彻底解决后台作用域销毁炸弹)
///[架构重构 2026-03-01]
/// 1. 废弃 Read-Time 摘要计算，改为 Write-Time 计算，消灭 LOH 内存暴涨与网络带宽冗余。
/// 2. 补充 RegisterPostEvictionCallback 解决 SemaphoreSlim 游离造成的内核句柄泄露。
/// 3. 废弃高危的 Task.Run 游离线程，阻塞等待搜索索引落盘，杜绝生产环境滚动发版导致的索引永久损坏。
/// 4. 引入 IN(...) 容量阀门与 Parallel.ForEachAsync 控制外部 I/O 并发风暴。
/// </summary>
public class ArticleService(
    ISqlSugarClient _db,
    ISearchIndexService _searchIndex,
    IConnectionMultiplexer _redisConnection,
    IUnifiedCache _cache,
    ICacheMissCoordinator _cacheMissCoordinator,
    IDbConcurrencyGate _dbConcurrencyGate,
    IHttpContextAccessor _httpContextAccessor,
    ILogger<ArticleService> _logger,
    IServiceScopeFactory _scopeFactory,
    IPublicAotInvalidationService _publicAotInvalidationService,
    ICacheInvalidationDispatcher _cacheInvalidationDispatcher) : IArticleService
{
    private const int MaxPageSize = 100;
    private const int MaxSearchKeywordLength = 128;
    private const int MaxHotArticlesCount = 100;
    private const int MaxTitleLength = 256;
    private const int MaxSummaryLength = 512;
    private const int MaxContentLength = 200_000;
    private const int MaxTagIds = 32;
    private const int LongReadThreshold = 5_000;
    private const int ReadingCharsPerMinute = 300;

    private readonly IDatabase _redis = _redisConnection.GetDatabase();
    private bool? _legacyArticleContentColumnExists;

    private CancellationToken Ct => _httpContextAccessor.HttpContext?.RequestAborted ?? CancellationToken.None;

    public async ValueTask IncreaseViewCountAsync(int id)
    {
        await _db.Updateable<Article>()
            .SetColumns(it => it.Views == it.Views + 1)
            .Where(it => it.Id == id)
            .ExecuteCommandAsync();

        await _redis.SortedSetIncrementAsync("blog:top_articles", id, 1);

        // 逻辑自洽：增加阅读量不触发全局列表版本号变更
        await _cache.RemoveAsync(CachePolicyId.ArticleDetail, id.ToString());
    }

    public async Task<ArticleListPageReadModel> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted)
    {
        page = page < 1 ? 1 : page;
        size = size switch
        {
            < 1 => 10,
            > MaxPageSize => MaxPageSize,
            _ => size
        };

        long version = await GetListCacheVersionAsync();
        string cacheIdentity = BuildArticleListIdentity(version, page, size, categoryId, tagId, isDeleted);

        return await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.ArticleList,
                cacheIdentity,
                ct => _cache.TryGetJsonAsync<ArticleListPageReadModel>(CachePolicyId.ArticleList, cacheIdentity, ct),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "article-list",
                    async gateCt =>
                    {
                        ArticleListPageReadModel result = await LoadArticleListPageFromDbAsync(page, size, categoryId, tagId, isDeleted, gateCt);
                        await _cache.SetJsonAsync(CachePolicyId.ArticleList, cacheIdentity, result, gateCt);
                        return result;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<ArticleListPageReadModel> retry = await _cache.TryGetJsonAsync<ArticleListPageReadModel>(CachePolicyId.ArticleList, cacheIdentity, gateCt);
                        if (retry.Hit)
                        {
                            return retry.Value ?? new ArticleListPageReadModel { Items = [], Total = 0 };
                        }

                        throw new TimeoutException($"db-gate-timeout:article-list:{cacheIdentity}");
                    },
                    ct),
                "article-list",
                Ct)
            .ConfigureAwait(false)
            ?? new ArticleListPageReadModel { Items = [], Total = 0 };
    }

    public async Task<ArticleDetailReadModel?> GetByIdAsync(int id)
    {
        string cacheIdentity = id.ToString();
        var detailCache = await _cache.TryGetJsonAsync<ArticleDetailReadModel>(CachePolicyId.ArticleDetail, cacheIdentity, Ct);
        if (detailCache.Hit)
        {
            ArticleDetailReadModel? cached = detailCache.Value;
            if (cached is null)
            {
                return null;
            }

            if (!string.IsNullOrWhiteSpace(cached.Content))
            {
                return cached;
            }

            string healedContent = await LoadArticleContentAsync(id);
            if (string.IsNullOrWhiteSpace(healedContent))
            {
                healedContent = cached.Summary ?? string.Empty;
            }

            if (string.IsNullOrWhiteSpace(healedContent))
            {
                return cached;
            }

            int healedWordCount = CalculateReadableLength(healedContent);
            var healed = cached with
            {
                Content = healedContent,
                WordCount = healedWordCount,
                EstimatedReadingMinutes = Math.Max(1, (healedWordCount + ReadingCharsPerMinute - 1) / ReadingCharsPerMinute),
                ShowReadingNotice = healedWordCount > LongReadThreshold
            };
            await _cache.SetJsonAsync(CachePolicyId.ArticleDetail, cacheIdentity, healed, Ct);
            return healed;
        }

        var query = _db.Queryable<Article>().LeftJoin<Category>((a, c) => a.CategoryId == c.Id).Where(a => a.Id == id && a.IsDeleted == false)
            .Select((a, c) => new { a.Id, a.Title, a.Summary, a.CategoryId, a.Views, a.CreateTime, a.IsDeleted, CategoryName = c.Name });

        var sqlObj = query.ToSql();
        ArticleDetailReadModel? article = null;
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            if (await reader.ReadAsync(Ct))
            {
                int fId = reader.GetOrdinal("Id"), fTitle = reader.GetOrdinal("Title"),
                    fSum = reader.GetOrdinal("Summary"), fCatId = reader.GetOrdinal("CategoryId"), fViews = reader.GetOrdinal("Views"),
                    fTime = reader.GetOrdinal("CreateTime"), fIsDel = reader.GetOrdinal("IsDeleted"), fCatName = reader.GetOrdinal("CategoryName");

                article = new ArticleDetailReadModel
                {
                    Id = reader.GetInt32(fId),
                    Title = reader.GetString(fTitle),
                    Summary = reader.IsDBNull(fSum) ? string.Empty : reader.GetString(fSum),
                    CategoryId = reader.GetInt32(fCatId),
                    Views = reader.GetInt32(fViews),
                    CreateTime = reader.GetDateTime(fTime),
                    IsDeleted = reader.GetBoolean(fIsDel),
                    CategoryName = reader.IsDBNull(fCatName) ? "默认分类" : reader.GetString(fCatName),
                    Tags = []
                };
            }
        }

        if (article != null)
        {
            string content = await LoadArticleContentAsync(id);
            if (string.IsNullOrWhiteSpace(content) && !string.IsNullOrWhiteSpace(article.Summary))
            {
                content = article.Summary;
            }
            int wordCount = CalculateReadableLength(content);
            int estimatedReadingMinutes = Math.Max(1, (wordCount + ReadingCharsPerMinute - 1) / ReadingCharsPerMinute);
            bool showReadingNotice = wordCount > LongReadThreshold;

            var tags = await LoadArticleTagsAsync(id);
            article = article with
            {
                Content = content,
                WordCount = wordCount,
                EstimatedReadingMinutes = estimatedReadingMinutes,
                ShowReadingNotice = showReadingNotice,
                Tags = tags
            };
            await _cache.SetJsonAsync(CachePolicyId.ArticleDetail, cacheIdentity, article, Ct);
        }
        else
        {
            await _cache.SetRawAsync(CachePolicyId.ArticleDetail, cacheIdentity, Array.Empty<byte>(), TimeSpan.FromMinutes(5), Ct);
        }

        return article;
    }

    private async Task<string> LoadArticleContentAsync(int articleId)
    {
        string content = await _db.Queryable<ArticleBody>()
            .Where(it => it.ArticleId == articleId)
            .Select(it => it.MarkdownContent)
            .FirstAsync() ?? string.Empty;

        if (!string.IsNullOrWhiteSpace(content))
        {
            return content;
        }

        if (!await LegacyArticleContentColumnExistsAsync())
        {
            return content;
        }

        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            "SELECT COALESCE(content, '') AS content FROM article WHERE id = @id LIMIT 1;",
            new[] { new SugarParameter("@id", articleId) });
        if (await reader.ReadAsync(Ct) && !reader.IsDBNull(0))
        {
            return reader.GetString(0);
        }

        return string.Empty;
    }

    private async Task<bool> LegacyArticleContentColumnExistsAsync()
    {
        if (_legacyArticleContentColumnExists.HasValue)
        {
            return _legacyArticleContentColumnExists.Value;
        }

        int exists = await _db.Ado.GetIntAsync("""
            SELECT COUNT(1)
            FROM information_schema.columns
            WHERE table_name = 'article'
              AND column_name = 'content';
            """);
        _legacyArticleContentColumnExists = exists > 0;
        return _legacyArticleContentColumnExists.Value;
    }

    public async Task<int> CreateAsync(CreateArticleRequest dto)
    {
        var title = NormalizeText(dto.Title, MaxTitleLength);
        var content = NormalizeText(dto.Content, MaxContentLength);
        var summary = NormalizeText(dto.Summary, MaxSummaryLength);
        var tagIds = NormalizeTagIds(dto.TagIds);
        var safeSummary = string.IsNullOrWhiteSpace(summary) ? GenerateSafeSummary(content) : summary;
        var article = new Article { Title = title, Summary = safeSummary, CategoryId = dto.CategoryId, CreateTime = DateTime.UtcNow, IsDeleted = false, Content = content };

        var result = await _db.Ado.UseTranAsync(async () => {
            int id = await _db.Insertable(article).ExecuteReturnIdentityAsync();
            await _db.Insertable(new ArticleBody { ArticleId = id, MarkdownContent = content, UpdatedAt = DateTime.UtcNow }).ExecuteCommandAsync();
            if (tagIds.Count > 0)
            {
                await _db.Insertable(BuildArticleTags(id, tagIds)).ExecuteCommandAsync();
            }
            return id;
        });

        if (result.IsSuccess)
        {
            await InvalidateCache();
            await InvalidatePublicAotAsync(null, [dto.CategoryId], tagIds, "create");
            ArticleListItemResponse? realtimePreview = await LoadRealtimePreviewAsync(result.Data);

            //[修改日期 2026-03-01]
            // 物理真相：阻断 Fire-and-Forget。采用同步 Await 保障强一致性与停机期间的物理防损。
            // 后台管理员操作频率极低，20ms 的索引落盘与推送耗时在主干管道中微乎其微。
            await BoundaryExecutor.ExecuteAsync(
                async () =>
                {
                    await using var scope = _scopeFactory.CreateAsyncScope();
                    var searchIndex = scope.ServiceProvider.GetRequiredService<ISearchIndexService>();
                    var messageSvc = scope.ServiceProvider.GetRequiredService<IMessageRealtimePublisher>();
                    await Task.WhenAll(
                        searchIndex.AddOrUpdateIndexAsync(article),
                        messageSvc.PushArticleChangedAsync(new ArticleNoticeDto(result.Data, "Created", article.CreateTime, realtimePreview))
                    );
                },
                _logger,
                "article-create-sync",
                LogLevel.Error);

            return result.Data;
        }
        _logger.LogError("创建文章失败 | DbError: {Error}", result.ErrorMessage);
        return 0;
    }

    private static int CalculateReadableLength(string? content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return 0;
        }

        int count = 0;
        foreach (char ch in content)
        {
            if (!char.IsWhiteSpace(ch))
            {
                count++;
            }
        }

        return count;
    }

    public async Task<bool> UpdateAsync(int id, UpdateArticleRequest dto)
    {
        var originalCategoryId = await _db.Queryable<Article>()
            .ClearFilter()
            .Where(it => it.Id == id)
            .Select(it => it.CategoryId)
            .FirstAsync();
        var originalTagIds = await LoadArticleTagIdsAsync(id);
        var title = NormalizeText(dto.Title, MaxTitleLength);
        var content = NormalizeText(dto.Content, MaxContentLength);
        var summary = NormalizeText(dto.Summary, MaxSummaryLength);
        var tagIds = NormalizeTagIds(dto.TagIds);
        var safeSummary = string.IsNullOrWhiteSpace(summary) ? GenerateSafeSummary(content) : summary;

        var result = await _db.Ado.UseTranAsync(async () =>
        {
            await _db.Updateable<Article>()
                .SetColumns(it => it.Title == title)
                .SetColumns(it => it.Summary == safeSummary)
                .SetColumns(it => it.CategoryId == dto.CategoryId)
                .Where(it => it.Id == id).ExecuteCommandAsync();
            await _db.Storageable(new ArticleBody { ArticleId = id, MarkdownContent = content, UpdatedAt = DateTime.UtcNow }).ExecuteCommandAsync();
            await _db.Deleteable<ArticleTag>().Where(it => it.ArticleId == id).ExecuteCommandAsync();
            if (tagIds.Count > 0)
            {
                await _db.Insertable(BuildArticleTags(id, tagIds)).ExecuteCommandAsync();
            }
        });

        if (result.IsSuccess)
        {
            await InvalidateCache(id);
            await InvalidatePublicAotAsync(
                id,
                MergeIds([originalCategoryId], [dto.CategoryId]),
                MergeIds(originalTagIds, tagIds),
                "update");
            ArticleListItemResponse? realtimePreview = await LoadRealtimePreviewAsync(id);
            await BoundaryExecutor.ExecuteAsync(
                async () =>
                {
                    await using var scope = _scopeFactory.CreateAsyncScope();
                    var db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
                    var messageSvc = scope.ServiceProvider.GetRequiredService<IMessageRealtimePublisher>();
                    var searchIndex = scope.ServiceProvider.GetRequiredService<ISearchIndexService>();
                    var art = await db.Queryable<Article>().InSingleAsync(id);
                    if (art != null)
                    {
                        art.Content = await db.Queryable<ArticleBody>().Where(it => it.ArticleId == id).Select(it => it.MarkdownContent).FirstAsync() ?? string.Empty;
                        await Task.WhenAll(
                            searchIndex.AddOrUpdateIndexAsync(art),
                            messageSvc.PushArticleChangedAsync(new ArticleNoticeDto(id, "Updated", DateTime.UtcNow, realtimePreview)));
                    }
                },
                _logger,
                "article-update-sync",
                LogLevel.Error);
            return true;
        }
        return false;
    }

    public async Task<bool> DeleteAsync(int id)
    {
        var state = await LoadArticleAotStateAsync(id);
        var success = await _db.Updateable<Article>().SetColumns(it => it.IsDeleted == true).Where(it => it.Id == id).ExecuteCommandAsync() > 0;
        if (success)
        {
            await InvalidateCache(id);
            await InvalidatePublicAotAsync(id, state.CategoryIds, state.TagIds, "delete");
            await BoundaryExecutor.ExecuteAsync(
                async () =>
                {
                    await using var scope = _scopeFactory.CreateAsyncScope();
                    var messageSvc = scope.ServiceProvider.GetRequiredService<IMessageRealtimePublisher>();
                    var searchIndex = scope.ServiceProvider.GetRequiredService<ISearchIndexService>();
                    var redisDb = scope.ServiceProvider.GetRequiredService<IConnectionMultiplexer>().GetDatabase();
                    await Task.WhenAll(
                        searchIndex.DeleteIndexAsync(id),
                        redisDb.SortedSetRemoveAsync("blog:top_articles", id),
                        messageSvc.PushArticleChangedAsync(new ArticleNoticeDto(id, "Deleted", DateTime.UtcNow))
                    );
                },
                _logger,
                "article-delete-sync",
                LogLevel.Error);
        }
        return success;
    }

    public async Task<bool> RestoreAsync(int id)
    {
        var state = await LoadArticleAotStateAsync(id);
        var success = await _db.Updateable<Article>().SetColumns(it => it.IsDeleted == false).Where(it => it.Id == id).ExecuteCommandAsync() > 0;
        if (success)
        {
            await InvalidateCache(id);
            await InvalidatePublicAotAsync(id, state.CategoryIds, state.TagIds, "restore");
            ArticleListItemResponse? realtimePreview = await LoadRealtimePreviewAsync(id);
            await BoundaryExecutor.ExecuteAsync(
                async () =>
                {
                    await using var scope = _scopeFactory.CreateAsyncScope();
                    var db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
                    var messageSvc = scope.ServiceProvider.GetRequiredService<IMessageRealtimePublisher>();
                    var searchIndex = scope.ServiceProvider.GetRequiredService<ISearchIndexService>();
                    var redisDb = scope.ServiceProvider.GetRequiredService<IConnectionMultiplexer>().GetDatabase();
                    var article = await db.Queryable<Article>().InSingleAsync(id);
                    if (article != null)
                    {
                        article.Content = await db.Queryable<ArticleBody>().Where(it => it.ArticleId == id).Select(it => it.MarkdownContent).FirstAsync() ?? string.Empty;
                        await Task.WhenAll(
                            searchIndex.AddOrUpdateIndexAsync(article),
                            redisDb.SortedSetAddAsync("blog:top_articles", id, article.Views),
                            messageSvc.PushArticleChangedAsync(new ArticleNoticeDto(id, "Restored", DateTime.UtcNow, realtimePreview))
                        );
                    }
                },
                _logger,
                "article-restore-sync",
                LogLevel.Error);
        }
        return success;
    }

    public async Task<bool> PermanentlyDeleteArticleAsync(int id)
    {
        var article = await _db.Queryable<Article>().ClearFilter().InSingleAsync(id);
        if (article == null) return false;
        article.Content = await _db.Queryable<ArticleBody>().Where(it => it.ArticleId == id).Select(it => it.MarkdownContent).FirstAsync() ?? string.Empty;
        var tagIds = await LoadArticleTagIdsAsync(id);
        var imageUrls = ImageHelper.ExtractIllustrationUrls(article.Content);

        var result = await _db.Ado.UseTranAsync(async () => {
            await _db.Deleteable<Comment>().Where(c => c.ArticleId == id).ExecuteCommandAsync();
            await _db.Deleteable<ArticleTag>().Where(at => at.ArticleId == id).ExecuteCommandAsync();
            await _db.Deleteable<ArticleBody>().Where(it => it.ArticleId == id).ExecuteCommandAsync();
            return await _db.Deleteable<Article>().In(id).ExecuteCommandAsync();
        });

        if (result.IsSuccess)
        {
            await InvalidateCache(id);
            await InvalidatePublicAotAsync(id, [article.CategoryId], tagIds, "permanent-delete");
            await BoundaryExecutor.ExecuteAsync(
                async () =>
                {
                    await using var scope = _scopeFactory.CreateAsyncScope();
                    var messageSvc = scope.ServiceProvider.GetRequiredService<IMessageRealtimePublisher>();
                    var fileSvc = scope.ServiceProvider.GetRequiredService<IFileService>();
                    var searchIndex = scope.ServiceProvider.GetRequiredService<ISearchIndexService>();
                    var redisDb = scope.ServiceProvider.GetRequiredService<IConnectionMultiplexer>().GetDatabase();

                    await Task.WhenAll(
                        searchIndex.DeleteIndexAsync(id),
                        redisDb.SortedSetRemoveAsync("blog:top_articles", id),
                        messageSvc.PushArticleChangedAsync(new ArticleNoticeDto(id, "Deleted", DateTime.UtcNow))
                    );

                    if (imageUrls.Count > 0)
                    {
                        await Parallel.ForEachAsync(imageUrls, new ParallelOptions { MaxDegreeOfParallelism = 5 }, async (url, token) =>
                        {
                            await fileSvc.DeleteImageAsync(url);
                        });
                    }
                },
                _logger,
                "article-permanent-delete-sync",
                LogLevel.Error);
            return true;
        }
        return false;
    }

    public async Task<int> ClearTrashAsync()
    {
        var trashArticles = await _db.Queryable<Article>()
            .ClearFilter()
            .Where(a => a.IsDeleted)
            .Select(a => new { a.Id, a.CategoryId })
            .ToListAsync(Ct);
        if (trashArticles.Count == 0) return 0;

        var articleIds = trashArticles.Select(a => a.Id).ToList();
        var categoryIds = trashArticles.Select(a => a.CategoryId).Distinct().ToList();
        var tagIds = articleIds.Count == 0 ? [] : await LoadArticleTagIdsAsync(articleIds);

        Dictionary<int, string> trashedBodyMap = articleIds.Count == 0
            ? new Dictionary<int, string>()
            : (await _db.Queryable<ArticleBody>()
                .Where(it => articleIds.Contains(it.ArticleId))
                .Select(it => new { it.ArticleId, it.MarkdownContent })
                .ToListAsync(Ct))
                .ToDictionary(it => it.ArticleId, it => it.MarkdownContent);

        var result = await _db.Ado.UseTranAsync(async () => {
            //[修改日期 2026-03-01]
            // 物理防线：将上千个 ID 拆分为每批 500 个的块 (Chunking) 进行删除事务。
            // 防止构建超出数据库解析上限的超大 IN (...) 语法树。
            foreach (var chunk in articleIds.Chunk(500))
            {
                await _db.Deleteable<Comment>().Where(c => chunk.Contains(c.ArticleId)).ExecuteCommandAsync();
                await _db.Deleteable<ArticleTag>().Where(at => chunk.Contains(at.ArticleId)).ExecuteCommandAsync();
                await _db.Deleteable<ArticleBody>().Where(it => chunk.Contains(it.ArticleId)).ExecuteCommandAsync();
                await _db.Deleteable<Article>().In(chunk).ExecuteCommandAsync();
            }
            return articleIds.Count;
        });

        if (result.IsSuccess)
        {
            await InvalidateCache();
            await InvalidatePublicAotBatchAsync(articleIds, categoryIds, tagIds, "clear-trash");
            await BoundaryExecutor.ExecuteAsync(
                async () =>
                {
                    await using var scope = _scopeFactory.CreateAsyncScope();
                    var fileSvc = scope.ServiceProvider.GetRequiredService<IFileService>();
                    var redisDb = scope.ServiceProvider.GetRequiredService<IConnectionMultiplexer>().GetDatabase();

                    var tasks = new List<Task>(articleIds.Count * 3);
                    for (int i = 0; i < articleIds.Count; i++)
                    {
                        int id = articleIds[i];
                        tasks.Add(redisDb.SortedSetRemoveAsync("blog:top_articles", id));
                        tasks.Add(_cache.RemoveAsync(CachePolicyId.ArticleDetail, id.ToString(), Ct));
                        tasks.Add(_searchIndex.DeleteIndexAsync(id));
                    }
                    await Task.WhenAll(tasks);

                    var imgUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var art in trashArticles)
                    {
                        if (!trashedBodyMap.TryGetValue(art.Id, out string? body))
                        {
                            continue;
                        }

                        foreach (var url in ImageHelper.ExtractIllustrationUrls(body))
                        {
                            imgUrls.Add(url);
                        }
                    }

                    if (imgUrls.Count > 0)
                    {
                        await Parallel.ForEachAsync(imgUrls, new ParallelOptions { MaxDegreeOfParallelism = 5 }, async (url, token) =>
                        {
                            await fileSvc.DeleteImageAsync(url);
                        });
                    }
                },
                _logger,
                "article-clear-trash-sync",
                LogLevel.Error);
            return result.Data;
        }
        _logger.LogError("清空回收站失败 | DbError: {Error}", result.ErrorMessage);
        return -1;
    }

    public async Task<List<ArticleListItemReadModel>> SearchArticlesAsync(string keyword)
    {
        if (string.IsNullOrWhiteSpace(keyword))
        {
            return [];
        }

        keyword = keyword.Trim();
        if (keyword.Length > MaxSearchKeywordLength)
        {
            keyword = keyword[..MaxSearchKeywordLength];
        }

        string cacheIdentity = $"keyword:{keyword}";

        return await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.ArticleSearch,
                cacheIdentity,
                ct => _cache.TryGetJsonAsync<List<ArticleListItemReadModel>>(CachePolicyId.ArticleSearch, cacheIdentity, ct),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "article-search",
                    async gateCt =>
                    {
                        List<ArticleListItemReadModel> result = await LoadSearchArticlesFromSourceAsync(keyword, gateCt);
                        await _cache.SetJsonAsync(CachePolicyId.ArticleSearch, cacheIdentity, result, gateCt);
                        return result;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<List<ArticleListItemReadModel>> retry = await _cache.TryGetJsonAsync<List<ArticleListItemReadModel>>(CachePolicyId.ArticleSearch, cacheIdentity, gateCt);
                        if (retry.Hit)
                        {
                            return retry.Value ?? [];
                        }

                        throw new TimeoutException($"db-gate-timeout:article-search:{keyword}");
                    },
                    ct),
                "article-search",
                Ct)
            .ConfigureAwait(false)
            ?? [];
    }

    public async Task<List<PopularArticleSummaryDto>> GetHotArticlesAsync(int count = 10)
    {
        count = count switch
        {
            < 1 => 10,
            > MaxHotArticlesCount => MaxHotArticlesCount,
            _ => count
        };

        string redisKey = "blog:top_articles";
        List<int> ids = await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.TopArticles,
                $"seed:{count}",
                ct => TryReadHotArticleSeedAsync(redisKey, count, ct),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "article-hot-seed",
                    gateCt => SeedHotArticlesAsync(redisKey, count, gateCt),
                    async gateCt =>
                    {
                        CacheReadResult<List<int>> retry = await TryReadHotArticleSeedAsync(redisKey, count, gateCt);
                        if (retry.Hit && retry.Value is not null)
                        {
                            return retry.Value;
                        }

                        throw new TimeoutException($"db-gate-timeout:article-hot-seed:{count}");
                    },
                    ct),
                "article-hot-seed",
                Ct)
            .ConfigureAwait(false)
            ?? [];

        if (ids.Count == 0)
        {
            return [];
        }

        var sqlObj = _db.Queryable<Article>().In(ids).Where(a => !a.IsDeleted).Select(a => new { a.Id, a.Title, a.Views }).ToSql();
        var articles = new List<PopularArticleSummaryDto>(ids.Count);
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id"), fTitle = reader.GetOrdinal("Title"), fViews = reader.GetOrdinal("Views");
            while (await reader.ReadAsync(Ct))
            {
                articles.Add(new PopularArticleSummaryDto(reader.GetInt32(fId), reader.GetString(fTitle), reader.GetInt32(fViews)));
            }
        }
        return OrderHotArticles(ids, articles);
    }

    private async Task<ArticleListPageReadModel> LoadArticleListPageFromDbAsync(
        int page,
        int size,
        int? categoryId,
        int? tagId,
        bool isDeleted,
        CancellationToken cancellationToken)
    {
        var baseQuery = _db.Queryable<Article>()
            .ClearFilter()
            .Where(a => a.IsDeleted == isDeleted)
            .WhereIF(categoryId.HasValue, a => a.CategoryId == categoryId)
            .WhereIF(tagId.HasValue, a => SqlFunc.Subqueryable<ArticleTag>().Where(at => at.ArticleId == a.Id && at.TagId == tagId).Any());

        int totalCount = await baseQuery.CountAsync();
        if (totalCount == 0)
        {
            return new ArticleListPageReadModel { Items = [], Total = 0 };
        }

        var sqlObj = baseQuery.LeftJoin<Category>((a, c) => a.CategoryId == c.Id)
            .OrderByDescending(a => a.CreateTime)
            .Select((a, c) => new
            {
                a.Id,
                a.Title,
                a.Summary,
                a.Views,
                a.CreateTime,
                a.CategoryId,
                CategoryName = c.Name,
                a.IsDeleted
            })
            .Skip((page - 1) * size)
            .Take(size)
            .ToSql();

        var list = new List<ArticleListItemReadModel>(size);
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id");
            int fTitle = reader.GetOrdinal("Title");
            int fSum = reader.GetOrdinal("Summary");
            int fViews = reader.GetOrdinal("Views");
            int fTime = reader.GetOrdinal("CreateTime");
            int fCatId = reader.GetOrdinal("CategoryId");
            int fCatName = reader.GetOrdinal("CategoryName");
            int fDel = reader.GetOrdinal("IsDeleted");

            while (await reader.ReadAsync(cancellationToken))
            {
                list.Add(new ArticleListItemReadModel
                {
                    Id = reader.GetInt32(fId),
                    Title = reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle),
                    Summary = reader.IsDBNull(fSum) ? string.Empty : reader.GetString(fSum),
                    Views = reader.GetInt32(fViews),
                    CreateTime = reader.GetDateTime(fTime),
                    CategoryId = reader.GetInt32(fCatId),
                    CategoryName = reader.IsDBNull(fCatName) ? "默认" : reader.GetString(fCatName),
                    IsDeleted = reader.GetBoolean(fDel),
                    Tags = []
                });
            }
        }

        if (list.Count > 0)
        {
            var ids = new List<int>(list.Count);
            for (int i = 0; i < list.Count; i++)
            {
                ids.Add(list[i].Id);
            }

            var tagDict = await LoadArticleTagMapAsync(ids);
            AttachTags(list, tagDict);
        }

        return new ArticleListPageReadModel { Items = list, Total = totalCount };
    }

    private async Task<List<ArticleListItemReadModel>> LoadSearchArticlesFromSourceAsync(string keyword, CancellationToken cancellationToken)
    {
        var searchResults = await _searchIndex.SearchAsync(keyword);
        if (searchResults.Count == 0)
        {
            return [];
        }

        int boundedCount = Math.Min(searchResults.Count, 200);
        var ids = new List<int>(boundedCount);
        for (int i = 0; i < boundedCount; i++)
        {
            ids.Add(searchResults[i].Id);
        }

        var sqlObj = _db.Queryable<Article>()
            .LeftJoin<Category>((a, c) => a.CategoryId == c.Id)
            .Where(a => ids.Contains(a.Id) && !a.IsDeleted)
            .Select((a, c) => new
            {
                a.Id,
                a.Summary,
                a.Views,
                a.CreateTime,
                a.CategoryId,
                CategoryName = c.Name,
                a.IsDeleted
            })
            .ToSql();

        var metadataFromDb = new Dictionary<int, (string Summary, int Views, DateTime Time, int CatId, string CatName, bool IsDel)>(ids.Count);
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id");
            int fSum = reader.GetOrdinal("Summary");
            int fViews = reader.GetOrdinal("Views");
            int fTime = reader.GetOrdinal("CreateTime");
            int fCatId = reader.GetOrdinal("CategoryId");
            int fCatName = reader.GetOrdinal("CategoryName");
            int fDel = reader.GetOrdinal("IsDeleted");

            while (await reader.ReadAsync(cancellationToken))
            {
                metadataFromDb[reader.GetInt32(fId)] = (
                    reader.IsDBNull(fSum) ? string.Empty : reader.GetString(fSum),
                    reader.GetInt32(fViews),
                    reader.GetDateTime(fTime),
                    reader.GetInt32(fCatId),
                    reader.IsDBNull(fCatName) ? "默认" : reader.GetString(fCatName),
                    reader.GetBoolean(fDel));
            }
        }

        var tagDict = await LoadArticleTagMapAsync(ids);
        var resultList = new List<ArticleListItemReadModel>(ids.Count);
        for (int i = 0; i < boundedCount; i++)
        {
            Article searchIndexArticle = searchResults[i];
            int id = searchIndexArticle.Id;
            if (!metadataFromDb.TryGetValue(id, out var metadata))
            {
                continue;
            }

            resultList.Add(new ArticleListItemReadModel
            {
                Id = searchIndexArticle.Id,
                Title = searchIndexArticle.Title,
                Snippet = searchIndexArticle.Content,
                Summary = metadata.Summary,
                Views = metadata.Views,
                CreateTime = metadata.Time,
                CategoryId = metadata.CatId,
                CategoryName = metadata.CatName,
                IsDeleted = metadata.IsDel,
                Tags = tagDict.TryGetValue(id, out var tags) ? tags : []
            });
        }

        return resultList;
    }

    private async Task<CacheReadResult<List<int>>> TryReadHotArticleSeedAsync(string redisKey, int count, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RedisValue[] topIds = await _redis.SortedSetRangeByRankAsync(redisKey, 0, count - 1, Order.Descending);
        List<int> ids = ExtractOrderedArticleIds(topIds);
        return ids.Count == 0
            ? new CacheReadResult<List<int>>(false, default)
            : new CacheReadResult<List<int>>(true, ids);
    }

    private async Task<List<int>> SeedHotArticlesAsync(string redisKey, int count, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var topFromDb = await _db.Queryable<Article>()
            .Where(a => !a.IsDeleted)
            .OrderByDescending(a => a.Views)
            .Take(count)
            .Select(a => new { a.Id, a.Views })
            .ToListAsync(cancellationToken);

        if (topFromDb.Count == 0)
        {
            return [];
        }

        var entries = new SortedSetEntry[topFromDb.Count];
        var ids = new List<int>(topFromDb.Count);
        for (int i = 0; i < topFromDb.Count; i++)
        {
            entries[i] = new SortedSetEntry(topFromDb[i].Id, topFromDb[i].Views);
            ids.Add(topFromDb[i].Id);
        }

        await _redis.SortedSetAddAsync(redisKey, entries);
        return ids;
    }

    private async Task InvalidateCache(int? articleId = null)
    {
        await _cacheInvalidationDispatcher.InvalidateArticleMutationAsync(articleId, Ct);
    }

    private async Task InvalidatePublicAotAsync(int? articleId, IEnumerable<int>? categoryIds, IEnumerable<int>? tagIds, string operation)
    {
        await BoundaryExecutor.ExecuteAsync(
            () => _publicAotInvalidationService.InvalidateArticleMutationAsync(articleId, categoryIds, tagIds, Ct),
            _logger,
            $"invalidate-article-aot:{operation}");
    }

    private async Task InvalidatePublicAotBatchAsync(IEnumerable<int> articleIds, IEnumerable<int>? categoryIds, IEnumerable<int>? tagIds, string operation)
    {
        await BoundaryExecutor.ExecuteAsync(
            () => _publicAotInvalidationService.InvalidateArticleMutationBatchAsync(articleIds, categoryIds, tagIds, Ct),
            _logger,
            $"invalidate-article-aot-batch:{operation}");
    }

    private async Task<List<int>> LoadArticleTagIdsAsync(int articleId)
    {
        return await _db.Queryable<ArticleTag>()
            .Where(it => it.ArticleId == articleId)
            .Select(it => it.TagId)
            .ToListAsync(Ct);
    }

    private async Task<List<int>> LoadArticleTagIdsAsync(List<int> articleIds)
    {
        return await _db.Queryable<ArticleTag>()
            .Where(it => articleIds.Contains(it.ArticleId))
            .Select(it => it.TagId)
            .Distinct()
            .ToListAsync(Ct);
    }

    private async Task<(List<int> CategoryIds, List<int> TagIds)> LoadArticleAotStateAsync(int articleId)
    {
        var categoryId = await _db.Queryable<Article>()
            .ClearFilter()
            .Where(it => it.Id == articleId)
            .Select(it => it.CategoryId)
            .FirstAsync();

        return ([categoryId], await LoadArticleTagIdsAsync(articleId));
    }

    private async Task<ArticleListItemResponse?> LoadRealtimePreviewAsync(int id)
    {
        var sqlObj = _db.Queryable<Article>()
            .ClearFilter()
            .LeftJoin<Category>((a, c) => a.CategoryId == c.Id)
            .Where(a => a.Id == id && a.IsDeleted == false)
            .Select((a, c) => new
            {
                a.Id,
                a.Title,
                a.Summary,
                a.Views,
                a.CreateTime,
                a.CategoryId,
                CategoryName = c.Name,
                a.IsDeleted
            })
            .ToSql();

        ArticleListItemReadModel? preview = null;
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            if (await reader.ReadAsync(Ct))
            {
                int fId = reader.GetOrdinal("Id");
                int fTitle = reader.GetOrdinal("Title");
                int fSummary = reader.GetOrdinal("Summary");
                int fViews = reader.GetOrdinal("Views");
                int fCreateTime = reader.GetOrdinal("CreateTime");
                int fCategoryId = reader.GetOrdinal("CategoryId");
                int fCategoryName = reader.GetOrdinal("CategoryName");
                int fIsDeleted = reader.GetOrdinal("IsDeleted");

                preview = new ArticleListItemReadModel
                {
                    Id = reader.GetInt32(fId),
                    Title = reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle),
                    Summary = reader.IsDBNull(fSummary) ? string.Empty : reader.GetString(fSummary),
                    Views = reader.GetInt32(fViews),
                    CreateTime = reader.GetDateTime(fCreateTime),
                    CategoryId = reader.GetInt32(fCategoryId),
                    CategoryName = reader.IsDBNull(fCategoryName) ? "默认" : reader.GetString(fCategoryName),
                    Tags = [],
                    IsDeleted = reader.GetBoolean(fIsDeleted)
                };
            }
        }

        if (preview is null)
        {
            return null;
        }

        ArticleListItemReadModel articlePreview = preview;
        List<TagReadModel> tags = await LoadArticleTagsAsync(id);
        return ArticleProjection.ToResponse(articlePreview with { Tags = tags });
    }

    private static List<int> MergeIds(IEnumerable<int> left, IEnumerable<int> right)
    {
        var merged = new HashSet<int>();
        foreach (int value in left)
        {
            if (value > 0)
            {
                merged.Add(value);
            }
        }

        foreach (int value in right)
        {
            if (value > 0)
            {
                merged.Add(value);
            }
        }

        return [.. merged];
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string NormalizeText(string? value, int maxLen)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var trimmed = value.Trim();
        return trimmed.Length > maxLen ? trimmed[..maxLen] : trimmed;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static List<int> NormalizeTagIds(List<int>? tagIds)
    {
        if (tagIds == null || tagIds.Count == 0)
        {
            return [];
        }

        var result = new List<int>(Math.Min(tagIds.Count, MaxTagIds));
        var set = new HashSet<int>();
        for (int i = 0; i < tagIds.Count && result.Count < MaxTagIds; i++)
        {
            var id = tagIds[i];
            if (set.Add(id))
            {
                result.Add(id);
            }
        }

        return result;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static List<ArticleTag> BuildArticleTags(int articleId, List<int> tagIds)
    {
        var items = new List<ArticleTag>(tagIds.Count);
        for (int i = 0; i < tagIds.Count; i++)
        {
            items.Add(new ArticleTag { ArticleId = articleId, TagId = tagIds[i] });
        }

        return items;
    }

    private async Task<List<TagReadModel>> LoadArticleTagsAsync(int articleId)
    {
        if (articleId <= 0)
        {
            return new List<TagReadModel>();
        }

        var tagMap = await LoadArticleTagMapAsync([articleId]);
        return tagMap.TryGetValue(articleId, out var tags) ? tags : new List<TagReadModel>();
    }

    private async Task<Dictionary<int, List<TagReadModel>>> LoadArticleTagMapAsync(IReadOnlyCollection<int> articleIds)
    {
        if (articleIds.Count == 0)
        {
            return new Dictionary<int, List<TagReadModel>>();
        }

        var ids = articleIds
            .Where(id => id > 0)
            .Distinct()
            .ToList();
        if (ids.Count == 0)
        {
            return new Dictionary<int, List<TagReadModel>>();
        }

        var tagRows = await _db.Queryable<ArticleTag>()
            .InnerJoin<Tag>((at, t) => at.TagId == t.Id)
            .Where(at => ids.Contains(at.ArticleId))
            .Select((at, t) => new { at.ArticleId, t.Id, t.Name })
            .ToListAsync(Ct);

        var tagMap = new Dictionary<int, List<TagReadModel>>(ids.Count);
        foreach (var row in tagRows)
        {
            if (!tagMap.TryGetValue(row.ArticleId, out var tags))
            {
                tags = [];
                tagMap[row.ArticleId] = tags;
            }

            tags.Add(new TagReadModel { Id = row.Id, Name = row.Name });
        }

        return tagMap;
    }

    private static void AttachTags(List<ArticleListItemReadModel> items, IReadOnlyDictionary<int, List<TagReadModel>> tagMap)
    {
        for (int i = 0; i < items.Count; i++)
        {
            var item = items[i];
            items[i] = item with { Tags = tagMap.TryGetValue(item.Id, out var tags) ? tags : [] };
        }
    }

    private static List<int> ExtractOrderedArticleIds(RedisValue[] values)
    {
        var ids = new List<int>(values.Length);
        for (int i = 0; i < values.Length; i++)
        {
            RedisValue value = values[i];
            if (value.HasValue)
            {
                ids.Add((int)value);
            }
        }

        return ids;
    }

    private static List<PopularArticleSummaryDto> OrderHotArticles(IReadOnlyList<int> ids, IReadOnlyList<PopularArticleSummaryDto> articles)
    {
        var articleMap = new Dictionary<int, PopularArticleSummaryDto>(articles.Count);
        for (int i = 0; i < articles.Count; i++)
        {
            PopularArticleSummaryDto article = articles[i];
            articleMap[article.Id] = article;
        }

        var ordered = new List<PopularArticleSummaryDto>(ids.Count);
        for (int i = 0; i < ids.Count; i++)
        {
            int id = ids[i];
            if (articleMap.TryGetValue(id, out PopularArticleSummaryDto article))
            {
                ordered.Add(article);
            }
        }

        return ordered;
    }

    internal static List<PopularArticleSummaryDto> OrderHotArticlesForTests(IReadOnlyList<int> ids, IReadOnlyList<PopularArticleSummaryDto> articles)
        => OrderHotArticles(ids, articles);

    internal static void AttachTagsForTests(List<ArticleListItemReadModel> items, IReadOnlyDictionary<int, List<TagReadModel>> tagMap)
        => AttachTags(items, tagMap);

    // [修改日期 2026-03-01]
    // 写入时绝对安全的摘要生成：防御 C# 字符串切片由于 UTF-16 代理对断裂引发的 Emoji 碎裂乱码。[MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string GenerateSafeSummary(string? content)
    {
        if (string.IsNullOrWhiteSpace(content)) return string.Empty;
        if (content.Length <= 200) return content;

        int len = 200;
        // 如果截断点切在了一个 4 字节 Emoji (HighSurrogate) 的头上，主动退让 1 字符，保持语义闭环
        if (char.IsHighSurrogate(content[len - 1])) len--;

        return content[..len];
    }

    private async ValueTask<long> GetListCacheVersionAsync()
    {
        string? ver = await _cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Ct);
        return long.TryParse(ver, out long parsed) ? parsed : 0;
    }

    private static string BuildArticleListIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted)
    {
        return string.Concat(
            version.ToString(), ":",
            page.ToString(), ":",
            size.ToString(), ":",
            (categoryId ?? 0).ToString(), ":",
            (tagId ?? 0).ToString(), ":",
            isDeleted ? "1" : "0");
    }
}

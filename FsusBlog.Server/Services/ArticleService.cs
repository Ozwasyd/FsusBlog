using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using SqlSugar;
using StackExchange.Redis;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Runtime.CompilerServices;
using System.Data;
using System.Data.Common;
using System.Collections.Concurrent;
using Microsoft.AspNetCore.OutputCaching;
using Microsoft.Extensions.Caching.Memory;

namespace FsusBlog.Server.Services;

/// <summary>
/// 文章核心业务服务
/// 修复日期: 2026-02-23 (应用 DataReader 物理级映射，引入 MemoryCache 实现 Double-Check 缓存锁，彻底解决后台作用域销毁炸弹)
/// </summary>
public class ArticleService(
    ISqlSugarClient _db,
    ILuceneService _lucene,
    IConnectionMultiplexer _redisConnection,
    IHttpContextAccessor _httpContextAccessor,
    ILogger<ArticleService> _logger,
    IServiceScopeFactory _scopeFactory,
    IOutputCacheStore _cacheStore,
    IMemoryCache _memoryCache) : IArticleService
{
    private readonly IDatabase _redis = _redisConnection.GetDatabase();

    private const string CACHE_PREFIX = "blog:article:";
    private const string LIST_CACHE_VERSION_KEY = "blog:article:list_version";
    private const string LIST_CACHE_PREFIX = "blog:article:list:v";

    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        ReferenceHandler = ReferenceHandler.IgnoreCycles,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private CancellationToken Ct => _httpContextAccessor.HttpContext?.RequestAborted ?? CancellationToken.None;

    public async ValueTask IncreaseViewCountAsync(int id)
    {
        await _db.Updateable<Article>()
            .SetColumns(it => it.Views == it.Views + 1)
            .Where(it => it.Id == id)
            .ExecuteCommandAsync();

        await _redis.SortedSetIncrementAsync("blog:top_articles", id, 1);

        // 逻辑自洽：增加阅读量不触发全局列表版本号变更
        await _redis.KeyDeleteAsync(GenerateDetailKey(id));
    }

    public async Task<PageResultDto<ArticleListDto>> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted)
    {
        long version = await GetListCacheVersionAsync();
        string cacheKey = GenerateListCacheKey(version, page, size, categoryId, tagId, isDeleted);

        // 1. 无锁快读
        try
        {
            using var lease = await _redis.StringGetLeaseAsync(cacheKey);
            if (lease != null && lease.Length > 0)
            {
                var cachedResult = JsonSerializer.Deserialize<PageResultDto<ArticleListDto>>(lease.Span, _jsonOptions);
                if (cachedResult != null) return cachedResult;
            }
        }
        catch (Exception ex) { _logger.LogWarning(ex, "读取列表缓存异常"); }

        // 2. 缓存击穿防护 (细粒度本地锁)
        var cacheLock = _memoryCache.GetOrCreate(string.Concat("lock:", cacheKey), entry =>
        {
            entry.SlidingExpiration = TimeSpan.FromMinutes(2);
            return new SemaphoreSlim(1, 1);
        })!;

        await cacheLock.WaitAsync(Ct);
        try
        {
            // 3. Double-Check
            using var lease2 = await _redis.StringGetLeaseAsync(cacheKey);
            if (lease2 != null && lease2.Length > 0)
            {
                return JsonSerializer.Deserialize<PageResultDto<ArticleListDto>>(lease2.Span, _jsonOptions)!;
            }

            RefAsync<int> total = 0;
            var baseQuery = _db.Queryable<Article>()
                .ClearFilter()
                .Where(a => a.IsDeleted == isDeleted)
                .WhereIF(categoryId.HasValue, a => a.CategoryId == categoryId)
                .WhereIF(tagId.HasValue, a => SqlFunc.Subqueryable<ArticleTag>().Where(at => at.ArticleId == a.Id && at.TagId == tagId).Any());

            int totalCount = await baseQuery.CountAsync();
            if (totalCount == 0) return new PageResultDto<ArticleListDto> { Items = [], Total = 0 };

            var sqlObj = baseQuery.LeftJoin<Category>((a, c) => a.CategoryId == c.Id)
                .OrderByDescending(a => a.CreateTime)
                .Select((a, c) => new
                {
                    a.Id,
                    a.Title,
                    Summary = SqlFunc.Substring(a.Content, 1, 200), // Postgres 1-based
                    a.Views,
                    a.CreateTime,
                    a.CategoryId,
                    CategoryName = c.Name,
                    a.IsDeleted
                })
                .Skip((page - 1) * size).Take(size).ToSql();

            var list = new List<ArticleListDto>(size);
            using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
            {
                // 物理预热寻址
                int fId = reader.GetOrdinal("Id"), fTitle = reader.GetOrdinal("Title"), fSum = reader.GetOrdinal("Summary"),
                    fViews = reader.GetOrdinal("Views"), fTime = reader.GetOrdinal("CreateTime"), fCatId = reader.GetOrdinal("CategoryId"),
                    fCatName = reader.GetOrdinal("CategoryName"), fDel = reader.GetOrdinal("IsDeleted");

                while (await reader.ReadAsync(Ct))
                {
                    list.Add(new ArticleListDto
                    {
                        Id = reader.GetInt32(fId),
                        Title = reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle),
                        Summary = reader.IsDBNull(fSum) ? null : reader.GetString(fSum),
                        Views = reader.GetInt32(fViews),
                        CreateTime = reader.GetDateTime(fTime),
                        Category = new ArticleCategoryView(reader.GetInt32(fCatId), reader.IsDBNull(fCatName) ? "默认" : reader.GetString(fCatName)),
                        IsDeleted = reader.GetBoolean(fDel),
                        Tags = []
                    });
                }
            }

            if (list.Count > 0)
            {
                var ids = list.Select(x => x.Id).ToList();
                var tagsData = await _db.Queryable<ArticleTag>()
                    .InnerJoin<Tag>((at, t) => at.TagId == t.Id)
                    .Where(at => ids.Contains(at.ArticleId))
                    .Select((at, t) => new { at.ArticleId, t.Id, t.Name })
                    .ToListAsync();

                var tagDict = new Dictionary<int, List<TagDto>>(ids.Count);
                foreach (var t in tagsData)
                {
                    if (!tagDict.TryGetValue(t.ArticleId, out var tagList)) { tagList = []; tagDict[t.ArticleId] = tagList; }
                    tagList.Add(new TagDto(t.Id, t.Name));
                }

                for (int i = 0; i < list.Count; i++)
                {
                    var item = list[i];
                    item.Tags = tagDict.TryGetValue(item.Id, out var tags) ? tags : [];
                    list[i] = item;
                }
            }

            var result = new PageResultDto<ArticleListDto> { Items = list, Total = totalCount };
            _ = _redis.StringSetAsync(cacheKey, JsonSerializer.SerializeToUtf8Bytes(result, _jsonOptions), TimeSpan.FromMinutes(10));
            return result;
        }
        finally { cacheLock.Release(); }
    }

    public async Task<Article?> GetByIdAsync(int id)
    {
        string cacheKey = GenerateDetailKey(id);
        try
        {
            using var lease = await _redis.StringGetLeaseAsync(cacheKey);
            if (lease != null && lease.Length > 0)
            {
                if (lease.Length == 0) return null;
                return JsonSerializer.Deserialize<Article>(lease.Span, _jsonOptions);
            }
        }
        catch (Exception ex) { _logger.LogWarning("Redis Read Failed: {Msg}", ex.Message); }

        var query = _db.Queryable<Article>().LeftJoin<Category>((a, c) => a.CategoryId == c.Id).Where(a => a.Id == id)
            .Select((a, c) => new { a.Id, a.Title, a.Content, a.Summary, a.CategoryId, a.Views, a.CreateTime, a.IsDeleted, CategoryName = c.Name });

        var sqlObj = query.ToSql();
        Article? article = null;
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            if (await reader.ReadAsync(Ct))
            {
                int fId = reader.GetOrdinal("Id"), fTitle = reader.GetOrdinal("Title"), fContent = reader.GetOrdinal("Content"),
                    fSum = reader.GetOrdinal("Summary"), fCatId = reader.GetOrdinal("CategoryId"), fViews = reader.GetOrdinal("Views"),
                    fTime = reader.GetOrdinal("CreateTime"), fIsDel = reader.GetOrdinal("IsDeleted"), fCatName = reader.GetOrdinal("CategoryName");

                article = new Article
                {
                    Id = reader.GetInt32(fId),
                    Title = reader.GetString(fTitle),
                    Content = reader.IsDBNull(fContent) ? string.Empty : reader.GetString(fContent),
                    Summary = reader.IsDBNull(fSum) ? string.Empty : reader.GetString(fSum),
                    CategoryId = reader.GetInt32(fCatId),
                    Views = reader.GetInt32(fViews),
                    CreateTime = reader.GetDateTime(fTime),
                    IsDeleted = reader.GetBoolean(fIsDel),
                    Category = new Category { Id = reader.GetInt32(fCatId), Name = reader.IsDBNull(fCatName) ? "默认分类" : reader.GetString(fCatName) },
                    Tags = []
                };
            }
        }

        if (article != null)
        {
            var tagsSql = _db.Queryable<ArticleTag>().InnerJoin<Tag>((at, t) => at.TagId == t.Id).Where(at => at.ArticleId == id).Select((at, t) => new { t.Id, t.Name }).ToSql();
            using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(tagsSql.Key, tagsSql.Value))
            {
                int tId = reader.GetOrdinal("Id"), tName = reader.GetOrdinal("Name");
                while (await reader.ReadAsync(Ct)) article.Tags.Add(new Tag { Id = reader.GetInt32(tId), Name = reader.GetString(tName) });
            }
            _ = _redis.StringSetAsync(cacheKey, JsonSerializer.SerializeToUtf8Bytes(article, _jsonOptions), TimeSpan.FromHours(1));
        }
        else _ = _redis.StringSetAsync(cacheKey, Array.Empty<byte>(), TimeSpan.FromMinutes(5));

        return article;
    }

    public async Task<int> CreateAsync(ArticleDto dto)
    {
        var article = new Article { Title = dto.Title, Content = dto.Content, Summary = dto.Summary, CategoryId = dto.CategoryId, CreateTime = DateTime.UtcNow, IsDeleted = false };
        var result = await _db.Ado.UseTranAsync(async () => {
            int id = await _db.Insertable(article).ExecuteReturnIdentityAsync();
            if (dto.TagIds?.Count > 0) await _db.Insertable(dto.TagIds.Select(tid => new ArticleTag { ArticleId = id, TagId = tid }).ToArray()).ExecuteCommandAsync();
            return id;
        });

        if (result.IsSuccess)
        {
            await InvalidateCache();
            _ = Task.Run(async () => {
                try
                {
                    using var scope = _scopeFactory.CreateScope();
                    var lucene = scope.ServiceProvider.GetRequiredService<ILuceneService>();
                    var messageSvc = scope.ServiceProvider.GetRequiredService<IMessageService>();
                    await Task.WhenAll(lucene.AddOrUpdateIndexAsync(article), messageSvc.PushArticleChangedAsync(new ArticleNoticeDto(result.Data, "Created", article.CreateTime)));
                }
                catch (Exception ex) { _logger.LogError(ex, "后台异步任务执行失败"); }
            });
            return result.Data;
        }
        throw new Exception(result.ErrorMessage);
    }

    public async Task<bool> UpdateAsync(int id, ArticleDto dto)
    {
        var result = await _db.Ado.UseTranAsync(async () =>
        {
            await _db.Updateable<Article>()
                .SetColumns(it => it.Title == dto.Title)
                .SetColumns(it => it.Content == dto.Content)
                .SetColumns(it => it.Summary == dto.Summary)
                .SetColumns(it => it.CategoryId == dto.CategoryId)
                .Where(it => it.Id == id).ExecuteCommandAsync();
            await _db.Deleteable<ArticleTag>().Where(it => it.ArticleId == id).ExecuteCommandAsync();
            if (dto.TagIds?.Count > 0) await _db.Insertable(dto.TagIds.Select(tid => new ArticleTag { ArticleId = id, TagId = tid }).ToArray()).ExecuteCommandAsync();
        });

        if (result.IsSuccess)
        {
            await InvalidateCache(id);
            _ = Task.Run(async () => {
                try
                {
                    using var scope = _scopeFactory.CreateScope();
                    var db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
                    var messageSvc = scope.ServiceProvider.GetRequiredService<IMessageService>();
                    var lucene = scope.ServiceProvider.GetRequiredService<ILuceneService>();
                    var art = await db.Queryable<Article>().InSingleAsync(id);
                    if (art != null) await Task.WhenAll(lucene.AddOrUpdateIndexAsync(art), messageSvc.PushArticleChangedAsync(new ArticleNoticeDto(id, "Updated", DateTime.UtcNow)));
                }
                catch (Exception ex) { _logger.LogError(ex, "后台任务失败"); }
            });
            return true;
        }
        return false;
    }

    public async Task<bool> DeleteAsync(int id)
    {
        var success = await _db.Updateable<Article>().SetColumns(it => it.IsDeleted == true).Where(it => it.Id == id).ExecuteCommandAsync() > 0;
        if (success)
        {
            await InvalidateCache(id);
            _ = Task.Run(async () => {
                try
                {
                    using var scope = _scopeFactory.CreateScope();
                    var messageSvc = scope.ServiceProvider.GetRequiredService<IMessageService>();
                    var lucene = scope.ServiceProvider.GetRequiredService<ILuceneService>();
                    var redisDb = scope.ServiceProvider.GetRequiredService<IConnectionMultiplexer>().GetDatabase();
                    await Task.WhenAll(lucene.DeleteIndexAsync(id), redisDb.SortedSetRemoveAsync("blog:top_articles", id), messageSvc.PushArticleChangedAsync(new ArticleNoticeDto(id, "Deleted", DateTime.UtcNow)));
                }
                catch (Exception ex) { _logger.LogError(ex, "后台任务失败"); }
            });
        }
        return success;
    }

    public async Task<bool> RestoreAsync(int id)
    {
        var success = await _db.Updateable<Article>().SetColumns(it => it.IsDeleted == false).Where(it => it.Id == id).ExecuteCommandAsync() > 0;
        if (success)
        {
            await InvalidateCache(id);
            _ = Task.Run(async () => {
                try
                {
                    using var scope = _scopeFactory.CreateScope();
                    var db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
                    var messageSvc = scope.ServiceProvider.GetRequiredService<IMessageService>();
                    var lucene = scope.ServiceProvider.GetRequiredService<ILuceneService>();
                    var redisDb = scope.ServiceProvider.GetRequiredService<IConnectionMultiplexer>().GetDatabase();
                    var article = await db.Queryable<Article>().InSingleAsync(id);
                    if (article != null) await Task.WhenAll(lucene.AddOrUpdateIndexAsync(article), redisDb.SortedSetAddAsync("blog:top_articles", id, article.Views), messageSvc.PushArticleChangedAsync(new ArticleNoticeDto(id, "Restored", DateTime.UtcNow)));
                }
                catch (Exception ex) { _logger.LogError(ex, "后台任务失败"); }
            });
        }
        return success;
    }

    public async Task<bool> PermanentlyDeleteArticleAsync(int id)
    {
        var article = await _db.Queryable<Article>().ClearFilter().InSingleAsync(id);
        if (article == null) return false;
        var imageUrls = ImageHelper.ExtractIllustrationUrls(article.Content);
        var result = await _db.Ado.UseTranAsync(async () => {
            await _db.Deleteable<Comment>().Where(c => c.ArticleId == id).ExecuteCommandAsync();
            await _db.Deleteable<ArticleTag>().Where(at => at.ArticleId == id).ExecuteCommandAsync();
            return await _db.Deleteable<Article>().In(id).ExecuteCommandAsync();
        });
        if (result.IsSuccess)
        {
            await InvalidateCache(id);
            _ = Task.Run(async () => {
                try
                {
                    using var scope = _scopeFactory.CreateScope();
                    var messageSvc = scope.ServiceProvider.GetRequiredService<IMessageService>();
                    var fileSvc = scope.ServiceProvider.GetRequiredService<IFileService>();
                    var lucene = scope.ServiceProvider.GetRequiredService<ILuceneService>();
                    var redisDb = scope.ServiceProvider.GetRequiredService<IConnectionMultiplexer>().GetDatabase();
                    var tasks = new List<Task> { lucene.DeleteIndexAsync(id), redisDb.SortedSetRemoveAsync("blog:top_articles", id), messageSvc.PushArticleChangedAsync(new ArticleNoticeDto(id, "Deleted", DateTime.UtcNow)) };
                    if (imageUrls.Count > 0) tasks.AddRange(imageUrls.Select(fileSvc.DeleteImageAsync));
                    await Task.WhenAll(tasks);
                }
                catch (Exception ex) { _logger.LogError(ex, "物理清理失败"); }
            });
            return true;
        }
        return false;
    }

    public async Task<int> ClearTrashAsync()
    {
        var trashArticles = await _db.Queryable<Article>().ClearFilter().Where(a => a.IsDeleted).Select(a => new { a.Id, a.Content }).ToListAsync(Ct);
        if (trashArticles.Count == 0) return 0;
        var articleIds = trashArticles.Select(a => a.Id).ToList();
        var result = await _db.Ado.UseTranAsync(async () => {
            await _db.Deleteable<Comment>().Where(c => articleIds.Contains(c.ArticleId)).ExecuteCommandAsync();
            await _db.Deleteable<ArticleTag>().Where(at => articleIds.Contains(at.ArticleId)).ExecuteCommandAsync();
            return await _db.Deleteable<Article>().In(articleIds).ExecuteCommandAsync();
        });

        if (result.IsSuccess)
        {
            await InvalidateCache();
            _ = Task.Run(async () => {
                try
                {
                    using var scope = _scopeFactory.CreateScope();
                    var fileSvc = scope.ServiceProvider.GetRequiredService<IFileService>();
                    var redisDb = scope.ServiceProvider.GetRequiredService<IConnectionMultiplexer>().GetDatabase();
                    var tasks = articleIds.SelectMany(id => new Task[] { redisDb.SortedSetRemoveAsync("blog:top_articles", id), redisDb.KeyDeleteAsync(GenerateDetailKey(id)), _lucene.DeleteIndexAsync(id) }).ToList();
                    var imgUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var art in trashArticles) { foreach (var url in ImageHelper.ExtractIllustrationUrls(art.Content)) imgUrls.Add(url); }
                    tasks.AddRange(imgUrls.Select(fileSvc.DeleteImageAsync));
                    await Task.WhenAll(tasks);
                }
                catch (Exception ex) { _logger.LogError(ex, "清理回收站异常"); }
            });
            return result.Data;
        }
        throw new Exception(result.ErrorMessage);
    }

    public async Task<List<ArticleListDto>> SearchArticlesAsync(string keyword)
    {
        var searchResults = await _lucene.SearchAsync(keyword);
        if (searchResults.Count == 0) return [];
        var ids = searchResults.Select(x => x.Id).ToList();

        var sqlObj = _db.Queryable<Article>().LeftJoin<Category>((a, c) => a.CategoryId == c.Id)
            .Where(a => ids.Contains(a.Id) && !a.IsDeleted)
            .Select((a, c) => new { a.Id, a.Views, a.CreateTime, a.CategoryId, CategoryName = c.Name, a.IsDeleted }).ToSql();

        var metadataFromDb = new Dictionary<int, (int Views, DateTime Time, int CatId, string CatName, bool IsDel)>();
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id"), fViews = reader.GetOrdinal("Views"), fTime = reader.GetOrdinal("CreateTime"),
                fCatId = reader.GetOrdinal("CategoryId"), fCatName = reader.GetOrdinal("CategoryName"), fDel = reader.GetOrdinal("IsDeleted");
            while (await reader.ReadAsync(Ct)) metadataFromDb[reader.GetInt32(fId)] = (reader.GetInt32(fViews), reader.GetDateTime(fTime), reader.GetInt32(fCatId), reader.IsDBNull(fCatName) ? "默认" : reader.GetString(fCatName), reader.GetBoolean(fDel));
        }
        var tags = await _db.Queryable<ArticleTag>().InnerJoin<Tag>((at, t) => at.TagId == t.Id).Where(at => ids.Contains(at.ArticleId)).Select((at, t) => new { at.ArticleId, t.Id, t.Name }).ToListAsync();
        var tagDict = new Dictionary<int, List<TagDto>>();
        foreach (var t in tags)
        {
            if (!tagDict.TryGetValue(t.ArticleId, out var tagList)) { tagList = []; tagDict[t.ArticleId] = tagList; }
            tagList.Add(new TagDto(t.Id, t.Name));
        }
        var resultList = new List<ArticleListDto>(searchResults.Count);
        foreach (var luceneArt in searchResults)
        {
            if (metadataFromDb.TryGetValue(luceneArt.Id, out var m)) resultList.Add(new ArticleListDto
            {
                Id = luceneArt.Id,
                Title = luceneArt.Title,
                Snippet = luceneArt.Content,
                Views = m.Views,
                CreateTime = m.Time,
                Category = new ArticleCategoryView(m.CatId, m.CatName),
                IsDeleted = m.IsDel,
                Tags = tagDict.TryGetValue(luceneArt.Id, out var tList) ? tList : []
            });
        }
        return resultList;
    }

    public async Task<List<PopularArticleDto>> GetHotArticlesAsync(int count = 10)
    {
        string redisKey = "blog:top_articles";
        var topIds = await _redis.SortedSetRangeByRankAsync(redisKey, 0, count - 1, Order.Descending);
        List<int> ids = [];
        foreach (var val in topIds) if (val.HasValue) ids.Add((int)val);

        if (ids.Count == 0)
        {
            var cacheLock = _memoryCache.GetOrCreate(redisKey, entry => { entry.SlidingExpiration = TimeSpan.FromMinutes(2); return new SemaphoreSlim(1, 1); })!;
            await cacheLock.WaitAsync(Ct);
            try
            {
                var topIds2 = await _redis.SortedSetRangeByRankAsync(redisKey, 0, count - 1, Order.Descending);
                if (topIds2.Length > 0) foreach (var val in topIds2) if (val.HasValue) ids.Add((int)val);
                else
                {
                    var topFromDb = await _db.Queryable<Article>().Where(a => !a.IsDeleted).OrderByDescending(a => a.Views).Take(count).Select(a => new { a.Id, a.Views }).ToListAsync(Ct);
                    if (topFromDb.Count == 0) return [];
                    await _redis.SortedSetAddAsync(redisKey, [.. topFromDb.Select(x => new SortedSetEntry(x.Id, x.Views))]);
                    ids = [.. topFromDb.Select(x => x.Id)];
                }
            }
            finally { cacheLock.Release(); }
        }

        var sqlObj = _db.Queryable<Article>().In(ids).Where(a => !a.IsDeleted).Select(a => new { a.Id, a.Title, a.Views }).ToSql();
        var articles = new List<PopularArticleDto>(ids.Count);
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id"), fTitle = reader.GetOrdinal("Title"), fViews = reader.GetOrdinal("Views");
            while (await reader.ReadAsync(Ct)) articles.Add(new PopularArticleDto { Id = reader.GetInt32(fId), Title = reader.GetString(fTitle), Views = reader.GetInt32(fViews) });
        }
        var artDic = articles.ToDictionary(a => a.Id);
        var result = new List<PopularArticleDto>(ids.Count);
        foreach (var id in ids) if (artDic.TryGetValue(id, out var a)) result.Add(a);
        return result;
    }

    private async Task InvalidateCache(int? articleId = null)
    {
        var tasks = new List<Task>(6);
        if (articleId.HasValue) tasks.Add(_redis.KeyDeleteAsync(GenerateDetailKey(articleId.Value)));
        tasks.Add(_redis.StringIncrementAsync(LIST_CACHE_VERSION_KEY));
        tasks.Add(_redis.KeyDeleteAsync("cache:rss:xml_content"));
        tasks.Add(_cacheStore.EvictByTagAsync("Category", default).AsTask());
        tasks.Add(_cacheStore.EvictByTagAsync("ArticleList", default).AsTask());
        tasks.Add(_cacheStore.EvictByTagAsync("HotArticles", default).AsTask());
        await Task.WhenAll(tasks);
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string GenerateDetailKey(int id) => string.Create(CACHE_PREFIX.Length + DigitCount.GetDigitCount(id), id, (span, val) =>
    {
        CACHE_PREFIX.AsSpan().CopyTo(span); val.TryFormat(span[CACHE_PREFIX.Length..], out _);
    });

    private async ValueTask<long> GetListCacheVersionAsync()
    {
        var ver = await _redis.StringGetAsync(LIST_CACHE_VERSION_KEY);
        return ver.HasValue ? (long)ver : 0;
    }

    private static string GenerateListCacheKey(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted)
    {
        int vLen = DigitCount.GetDigitCount(version), pLen = DigitCount.GetDigitCount(page), sLen = DigitCount.GetDigitCount(size),
            cLen = DigitCount.GetDigitCount(categoryId ?? 0), tLen = DigitCount.GetDigitCount(tagId ?? 0);
        int totalLen = LIST_CACHE_PREFIX.Length + vLen + 1 + pLen + 1 + sLen + 1 + cLen + 1 + tLen + 2;

        return string.Create(totalLen, (version, page, size, categoryId, tagId, isDeleted), (span, state) =>
        {
            LIST_CACHE_PREFIX.AsSpan().CopyTo(span); int cur = LIST_CACHE_PREFIX.Length;
            state.version.TryFormat(span[cur..], out int w); cur += w; span[cur++] = ':';
            state.page.TryFormat(span[cur..], out w); cur += w; span[cur++] = '_';
            state.size.TryFormat(span[cur..], out w); cur += w; span[cur++] = '_';
            (state.categoryId ?? 0).TryFormat(span[cur..], out w); cur += w; span[cur++] = '_';
            (state.tagId ?? 0).TryFormat(span[cur..], out w); cur += w; span[cur++] = '_';
            span[cur] = state.isDeleted ? '1' : '0';
        });
    }
}
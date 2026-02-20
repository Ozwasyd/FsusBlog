using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using SqlSugar;
using StackExchange.Redis;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Services;

public class ArticleService(
    ISqlSugarClient _db,
    ILuceneService _lucene,
    IFileService _fileService,
    IConnectionMultiplexer _redisConnection,
    IHttpContextAccessor _httpContextAccessor,
    IMessageService _messageService,
    ILogger<ArticleService> _logger) : IArticleService
{
    private readonly IDatabase _redis = _redisConnection.GetDatabase();

    private const string CACHE_PREFIX = "blog:article:";
    private const string LIST_CACHE_PREFIX = "blog:article:list:";

    // 高性能 Json 配置
    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        ReferenceHandler = ReferenceHandler.IgnoreCycles,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    /// <summary>
    /// 获取当前请求的取消令牌，如果无 HttpContext 则使用 None
    /// </summary>
    private CancellationToken Ct => _httpContextAccessor.HttpContext?.RequestAborted ?? CancellationToken.None;

    /// <summary>
    /// 高性能增加阅读量：同步更新 DB、热榜 Score 并失效详情缓存
    /// </summary>
    public async ValueTask IncreaseViewCountAsync(int id)
    {
        // 1. 更新数据库计数
        await _db.Updateable<Article>()
            .SetColumns(it => it.Views == it.Views + 1)
            .Where(it => it.Id == id)
            .ExecuteCommandAsync();

        // 2. 实时更新 Redis 热榜权重 (Sorted Set)
        // 使用 _redis (IDatabase) 确保与查询端一致
        await _redis.SortedSetIncrementAsync("blog:top_articles", id, 1);

        // 3. 【关键修复】失效掉旧的详情缓存，确保下一次 GetByIdAsync 拿到真值
        // 解决详情页数字不跳动的问题
        await _redis.KeyDeleteAsync($"{CACHE_PREFIX}{id}");

        // 4. 发送实时热度更新通知 (SignalR - 逻辑自洽：治理组实时热度同步)
        // 这里可以选择性调用，如果前端热榜需要实时跳动
        // _ = _messageService.PushArticleChangedAsync(new ArticleNoticeDto { ... });
    }

    public async Task<PageResultDto<ArticleListDto>> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted)
    {
        string cacheKey = $"{LIST_CACHE_PREFIX}{page}_{size}_{categoryId ?? 0}_{tagId ?? 0}_{isDeleted}";

        try
        {
            // 尝试读取缓存，带上超时控制（应用层模拟取消）
            var cacheTask = _redis.StringGetAsync(cacheKey);
            var completedTask = await Task.WhenAny(cacheTask, Task.Delay(-1, Ct));

            if (completedTask == cacheTask)
            {
                var cachedData = await cacheTask;
                if (cachedData.HasValue)
                {
                    return JsonSerializer.Deserialize<PageResultDto<ArticleListDto>>(cachedData.ToString()!)!;
                }
            }
        }
        catch (OperationCanceledException) { throw; } // 正常取消
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "读取文章列表缓存失败或超时，Key: {CacheKey}", cacheKey);
        }

        RefAsync<int> total = 0;

        var list = await _db.Queryable<Article>()
            .ClearFilter()
            .Where(x => x.IsDeleted == isDeleted)
            .WhereIF(categoryId.HasValue, x => x.CategoryId == categoryId)
            .WhereIF(tagId.HasValue, x => x.Tags.Any(t => t.Id == tagId))
            .OrderByDescending(x => x.CreateTime)
            .Select(x => new ArticleListDto
            {
                Id = x.Id,
                Title = x.Title,
                Summary = x.Summary,
                Views = x.Views,
                CreateTime = x.CreateTime,
                CategoryName = x.Category.Name,
                IsDeleted = x.IsDeleted
            })
            .Mapper((dto, cache) =>
            {
                // 注意：Mapper 内部是同步委托或伪异步，较难直接传递 CT，但外层查询已受控
                var allTagsInThisPage = cache.Get(currentList =>
                {
                    var articleIds = currentList.Select(a => a.Id).ToList();
                    return _db.Queryable<ArticleTag>()
                        .InnerJoin<Tag>((at, t) => at.TagId == t.Id)
                        .Where(at => articleIds.Contains(at.ArticleId))
                        .Select((at, t) => new { at.ArticleId, t.Id, t.Name })
                        .ToList();
                });

                dto.Tags = [.. allTagsInThisPage
                    .Where(t => t.ArticleId == dto.Id)
                    .Select(t => new TagDto { Id = t.Id, Name = t.Name })];
            })
            .ToPageListAsync(page, size, total); // SqlSugar 内部暂未完全透传 CT 到 Mapper，但主查询会响应

        var result = new PageResultDto<ArticleListDto> { Items = list, Total = total.Value };

        // 写入缓存（Fire-and-forget，不等待，因为即使客户端断开，缓存写入也应该完成以造福后续请求）
        _ = _redis.StringSetAsync(cacheKey, JsonSerializer.Serialize(result, _jsonOptions), TimeSpan.FromMinutes(10));

        return result;
    }

    public async Task<Article?> GetByIdAsync(int id)
    {
        string cacheKey = $"{CACHE_PREFIX}{id}";

        try
        {
            // 快速读取缓存
            var cachedData = await _redis.StringGetAsync(cacheKey);
            if (cachedData.HasValue)
            {
                var jsonStr = cachedData.ToString();
                if (jsonStr == "null_data") return null;
                return JsonSerializer.Deserialize<Article>(jsonStr, _jsonOptions);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Redis Read Failed: {Message}", ex.Message);
        }

        // 数据库查询带上 CT
        var article = await _db.Queryable<Article>()
            .Includes(x => x.Category)
            .Includes(x => x.Tags)
            .InSingleAsync(id); // 虽然 InSingleAsync 源码可能未透传 CT，但在连接层会响应关闭

        // 缓存写入逻辑保持不变（后台执行）
        if (article != null)
        {
            _ = _redis.StringSetAsync(cacheKey, JsonSerializer.Serialize(article, _jsonOptions), TimeSpan.FromHours(1));
        }
        else
        {
            // 防穿透
            _ = _redis.StringSetAsync(cacheKey, "null_data", TimeSpan.FromMinutes(5));
        }

        return article;
    }

    public async Task<int> CreateAsync(ArticleDto dto)
    {
        var article = new Article
        {
            Title = dto.Title,
            Content = dto.Content,
            Summary = dto.Summary,
            CategoryId = dto.CategoryId,
            CreateTime = DateTime.UtcNow,
            IsDeleted = false
        };

        int newId = 0;
        var result = await _db.Ado.UseTranAsync(async () =>
        {
            newId = await _db.Insertable(article).ExecuteReturnIdentityAsync();
            article.Id = newId;
            if (dto.TagIds?.Count > 0)
            {
                var tags = dto.TagIds.Select(tid => new ArticleTag { ArticleId = newId, TagId = tid }).ToList();
                await _db.Insertable(tags).ExecuteCommandAsync();
            }
        });

        if (result.IsSuccess)
        {
            _logger.LogInformation("文章发布成功 | ID: {ArticleId}", newId);
            await InvalidateCache(newId);

            // 异步执行索引和信令推送
            _ = Task.Run(async () =>
            {
                try
                {
                    var indexTask = _lucene.AddOrUpdateIndexAsync(article);
                    var notifyTask = _messageService.PushArticleChangedAsync(new ArticleNoticeDto
                    {
                        ArticleId = newId,
                        Action = "Created",
                        EventTime = article.CreateTime
                    });

                    await Task.WhenAll(indexTask, notifyTask);
                    await _redis.KeyDeleteAsync("cache:rss:xml_content");
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "文章创建后的异步任务执行失败 | ID: {ArticleId}", newId);
                }
            });

            return newId;
        }
        throw new Exception($"发布失败: {result.ErrorMessage}");
    }

    public async Task<bool> UpdateAsync(int id, ArticleDto dto)
    {
        var result = await _db.Ado.UseTranAsync(async () =>
        {
            await _db.Updateable<Article>()
                .SetColumns(it => new Article
                {
                    Title = dto.Title,
                    Content = dto.Content,
                    Summary = dto.Summary,
                    CategoryId = dto.CategoryId
                })
                .Where(it => it.Id == id).ExecuteCommandAsync();

            await _db.Deleteable<ArticleTag>().Where(it => it.ArticleId == id).ExecuteCommandAsync();
            if (dto.TagIds?.Count > 0)
            {
                var tags = dto.TagIds.Select(tid => new ArticleTag { ArticleId = id, TagId = tid }).ToList();
                await _db.Insertable(tags).ExecuteCommandAsync();
            }
        });

        if (result.IsSuccess)
        {
            await InvalidateCache(id);

            _ = Task.Run(async () =>
            {
                try
                {
                    // 获取最新对象用于更新索引
                    var art = await _db.Queryable<Article>().InSingleAsync(id);
                    if (art != null)
                    {
                        var indexTask = _lucene.AddOrUpdateIndexAsync(art);
                        // 仅发送信令，不携带内容
                        var notifyTask = _messageService.PushArticleChangedAsync(new ArticleNoticeDto
                        {
                            ArticleId = id,
                            Action = "Updated",
                            EventTime = DateTime.UtcNow
                        });

                        await Task.WhenAll(indexTask, notifyTask);
                        await _redis.KeyDeleteAsync("cache:rss:xml_content");
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "文章更新后的异步任务执行失败 | ID: {ArticleId}", id);
                }
            });
            return true;
        }
        return false;
    }

    public async Task<bool> DeleteAsync(int id)
    {
        var success = await _db.Updateable<Article>()
            .SetColumns(it => it.IsDeleted == true)
            .Where(it => it.Id == id).ExecuteCommandAsync() > 0;

        if (success)
        {
            await InvalidateCache(id);

            _ = Task.Run(async () =>
            {
                try
                {
                    var indexTask = _lucene.DeleteIndexAsync(id);
                    var redisTask = _redis.SortedSetRemoveAsync("blog:top_articles", id);
                    var notifyTask = _messageService.PushArticleChangedAsync(new ArticleNoticeDto
                    {
                        ArticleId = id,
                        Action = "Deleted",
                        EventTime = DateTime.UtcNow
                    });

                    await Task.WhenAll(indexTask, redisTask, notifyTask);
                    await _redis.KeyDeleteAsync("cache:rss:xml_content");
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "文章逻辑删除后的异步任务执行失败 | ID: {ArticleId}", id);
                }
            });
        }
        return success;
    }

    public async Task<bool> RestoreAsync(int id)
    {
        var success = await _db.Updateable<Article>()
            .SetColumns(it => it.IsDeleted == false)
            .Where(it => it.Id == id).ExecuteCommandAsync() > 0;

        if (success)
        {
            await InvalidateCache(id);

            _ = Task.Run(async () =>
            {
                try
                {
                    var article = await _db.Queryable<Article>().InSingleAsync(id);
                    if (article != null)
                    {
                        var indexTask = _lucene.AddOrUpdateIndexAsync(article);
                        var redisTask = _redis.SortedSetAddAsync("blog:top_articles", id, article.Views);
                        var notifyTask = _messageService.PushArticleChangedAsync(new ArticleNoticeDto
                        {
                            ArticleId = id,
                            Action = "Restored",
                            EventTime = DateTime.UtcNow
                        });

                        await Task.WhenAll(indexTask, redisTask, notifyTask);
                        await _redis.KeyDeleteAsync("cache:rss:xml_content");
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "文章还原后的异步任务执行失败 | ID: {ArticleId}", id);
                }
            });
        }
        return success;
    }

    public async Task<bool> PermanentlyDeleteArticleAsync(int id)
    {
        var article = await _db.Queryable<Article>().ClearFilter().InSingleAsync(id);
        if (article == null) return false;

        var imageUrls = ImageHelper.ExtractIllustrationUrls(article.Content);

        var result = await _db.Ado.UseTranAsync(async () =>
        {
            await _db.Deleteable<Comment>().Where(c => c.ArticleId == id).ExecuteCommandAsync();
            await _db.Deleteable<ArticleTag>().Where(at => at.ArticleId == id).ExecuteCommandAsync();
            await _db.Deleteable<Article>().In(id).ExecuteCommandAsync();
        });

        if (result.IsSuccess)
        {
            _logger.LogWarning("执行物理删除 | ID: {ArticleId}", id);
            await InvalidateCache(id);

            _ = Task.Run(async () =>
            {
                try
                {
                    var cleanupTasks = new List<Task>
                {
                    _lucene.DeleteIndexAsync(id),
                    _redis.SortedSetRemoveAsync("blog:top_articles", id),
                    _messageService.PushArticleChangedAsync(new ArticleNoticeDto
                    {
                        ArticleId = id,
                        Action = "Deleted",
                        EventTime = DateTime.UtcNow
                    })
                };

                    if (imageUrls != null && imageUrls.Count > 0)
                    {
                        _logger.LogInformation("启动插图物理清理 | 数量: {Count}", imageUrls.Count);
                        cleanupTasks.AddRange(imageUrls.Select(url => _fileService.DeleteImageAsync(url)));
                    }

                    await Task.WhenAll(cleanupTasks);
                    await _redis.KeyDeleteAsync("cache:rss:xml_content");
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "物理删除后的后台清理任务执行失败 | ID: {ArticleId}", id);
                }
            });
            return true;
        }
        return false;
    }

    public async Task<int> ClearTrashAsync()
    {
        // 列表查询带上 CT
        var trashArticles = await _db.Queryable<Article>()
            .ClearFilter()
            .Where(a => a.IsDeleted == true)
            .Select(a => new { a.Id, a.Content })
            .ToListAsync(Ct);

        if (trashArticles.Count == 0) return 0;

        var articleIds = trashArticles.Select(a => a.Id).ToList();
        var deletedCount = 0;

        // 批量删除事务（耗时操作，不建议强加 CT，因为可能导致部分删除的数据不一致，让它跑完比较安全）
        var result = await _db.Ado.UseTranAsync(async () =>
        {
            await _db.Deleteable<Comment>().Where(c => articleIds.Contains(c.ArticleId)).ExecuteCommandAsync();
            await _db.Deleteable<ArticleTag>().Where(at => articleIds.Contains(at.ArticleId)).ExecuteCommandAsync();
            deletedCount = await _db.Deleteable<Article>().In(articleIds).ExecuteCommandAsync();
        });

        if (result.IsSuccess)
        {
            _logger.LogCritical("执行大规模物理删除 | Count: {Count}", deletedCount);

            // 清理缓存（Fire-and-forget）
            _ = Task.Run(async () =>
            {
                var server = _redisConnection.GetServer(_redisConnection.GetEndPoints()[0]);
                var keys = server.Keys(pattern: $"{LIST_CACHE_PREFIX}*").ToArray();
                if (keys.Length > 0) await _redis.KeyDeleteAsync(keys);

                foreach (var id in articleIds)
                {
                    await _redis.SortedSetRemoveAsync("blog:top_articles", id);
                    await _redis.KeyDeleteAsync($"{CACHE_PREFIX}{id}");
                    await _lucene.DeleteIndexAsync(id);
                }

                foreach (var art in trashArticles)
                {
                    var urls = ImageHelper.ExtractIllustrationUrls(art.Content);
                    foreach (var url in urls) await _fileService.DeleteImageAsync(url);
                }
            });

            return deletedCount;
        }

        throw new Exception($"清空回收站系统失败: {result.ErrorMessage}");
    }

    public async Task<List<ArticleListDto>> SearchArticlesAsync(string keyword)
    {
        // Lucene 搜索通常极快，暂不加 CT，但数据库回捞需要
        var searchResults = await _lucene.SearchAsync(keyword);
        if (searchResults.Count == 0) return [];

        var ids = searchResults.Select(x => x.Id).ToList();

        // 数据库回捞带上 CT
        var articlesFromDb = await _db.Queryable<Article>()
            .Includes(x => x.Category).Includes(x => x.Tags)
            .Where(x => ids.Contains(x.Id) && !x.IsDeleted)
            .ToListAsync(Ct);

        var artDic = articlesFromDb.ToDictionary(x => x.Id);
        var luceneDic = searchResults.ToDictionary(x => x.Id);

        return [.. ids.Where(artDic.ContainsKey).Select(id => {
            var art = artDic[id];
            return new ArticleListDto {
                Id = art.Id,
                Title = art.Title,
                Summary = art.Summary,
                Snippet = luceneDic[id].Content,
                CreateTime = art.CreateTime,
                CategoryName = art.Category?.Name ?? "默认",
                Tags = [.. art.Tags.Select(t => new TagDto { Id = t.Id, Name = t.Name })]
            };
        })];
    }

    public async Task<List<PopularArticleDto>> GetHotArticlesAsync(int count = 10)
    {
        string redisKey = "blog:top_articles";

        // 尝试从 Redis 获取
        var topIds = await _redis.SortedSetRangeByRankAsync(redisKey, 0, count - 1, Order.Descending);
        List<int> ids = [.. topIds.Select(x => int.Parse(x!))];

        // 如果 Redis 彻底为空（如缓存崩溃或初始化），从 DB 强制同步
        if (ids.Count == 0)
        {
            var topFromDb = await _db.Queryable<Article>()
                .Where(a => !a.IsDeleted)
                .OrderByDescending(a => a.Views)
                .Take(count)
                .Select(a => new { a.Id, a.Views })
                .ToListAsync(Ct);

            if (topFromDb.Count == 0) return [];

            // 批量同步分值，确保起点一致
            var entries = topFromDb.Select(x => new SortedSetEntry(x.Id, x.Views)).ToArray();
            await _redis.SortedSetAddAsync(redisKey, entries);
            ids = [.. topFromDb.Select(x => x.Id)];
        }

        // 数值始终回捞数据库，保证“显示的阅读数”与“详情页”绝对一致
        var articles = await _db.Queryable<Article>()
            .In(ids)
            .Where(a => !a.IsDeleted)
            .Select(a => new PopularArticleDto
            {
                Id = a.Id,
                Title = a.Title,
                Views = a.Views // 这里的 Views 来自数据库真值
            })
            .ToListAsync(Ct);

        // 保持 Redis 排序顺序返回
        return [.. ids
            .Select(id => articles.FirstOrDefault(a => a.Id == id))
            .Where(a => a != null)
            .Select(a => a!)];
    }

    private async Task InvalidateCache(int id)
    {
        await _redis.KeyDeleteAsync($"{CACHE_PREFIX}{id}");

        var server = _redisConnection.GetServer(_redisConnection.GetEndPoints()[0]);
        var keys = server.Keys(pattern: $"{LIST_CACHE_PREFIX}*").ToArray();
        if (keys.Length > 0) await _redis.KeyDeleteAsync(keys);
    }
}
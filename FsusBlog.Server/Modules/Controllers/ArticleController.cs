using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using SqlSugar;
using System.Data.Common;
using System.Text;
using System.Runtime.InteropServices;
using System.IO;
using FsusBlog.Server.Infrastructure.Filters;

namespace FsusBlog.Server.Modules.Controllers;

/// <summary>
/// 文章管理控制器 (Write Side)
/// 修复日期: 2026-02-23 (修正 string.Concat 编译错误，全量应用 DTO 结构体响应，加固 DataReader 物理映射)
/// </summary>
[ApiController]
[Route("api/[controller]")]
[Authorize(Roles = "admin")]
public partial class ArticleController(
    IArticleService _articleService,
    IPublicAotShellService _publicAotShellService,
    IUnifiedCache _cache,
    ISqlSugarClient _db,
    ILogger<ArticleController> _logger) : ControllerBase
{
    private const string RssCacheIdentity = "main";

    [HttpPost]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse<ArticleMutationResponseDto>>> Create([FromBody] CreateArticleRequest dto)
    {
        int id = await _articleService.CreateAsync(dto);
        if (id <= 0)
        {
            return ControllerResults.Status<ArticleMutationResponseDto>(500, "发布失败：数据库操作异常", HttpContext.TraceIdentifier);
        }

        await TryStorePublicAotShellAsync(dto.AotBundle, id, "create");

        // 直接返回在 Models.Dtos 中定义的公开结构体
        return ApiResponse<ArticleMutationResponseDto>.Success(new ArticleMutationResponseDto(id), "博文发布成功");
    }

    [HttpPut("{id}")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse<ArticleMutationResponseDto>>> Update(int id, [FromBody] UpdateArticleRequest dto)
    {
        var success = await _articleService.UpdateAsync(id, dto);
        if (success)
        {
            await TryStorePublicAotShellAsync(dto.AotBundle, id, "update");
            return ApiResponse<ArticleMutationResponseDto>.Success(new ArticleMutationResponseDto(id), "博文更新成功");
        }

        return ControllerResults.Status<ArticleMutationResponseDto>(500, "更新失败：数据库操作异常", HttpContext.TraceIdentifier);
    }

    [HttpPost("{id}/aot-bundle")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> StoreAotBundle(int id, [FromBody] PublicAotShellBundleContract bundle)
    {
        await TryStorePublicAotShellAsync(bundle, id, "store-bundle");
        return ApiResponse.Success("公开页缓存已同步");
    }

    [HttpDelete("{id}")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> Delete(int id)
    {
        if (await _articleService.DeleteAsync(id))
        {
            return ApiResponse.Success("文章已移至回收站");
        }

        return ControllerResults.NotFound("未找到对应文章", HttpContext.TraceIdentifier);
    }

    [HttpDelete("permanent/{id}")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> PermanentDelete(int id)
    {
        if (await _articleService.PermanentlyDeleteArticleAsync(id))
        {
            return ApiResponse.Success("文章及关联资源已彻底抹除");
        }

        return ControllerResults.NotFound("操作失败：资源不存在", HttpContext.TraceIdentifier);
    }

    [HttpDelete("trash")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse<TrashClearResponseDto>>> ClearTrash()
    {
        int count = await _articleService.ClearTrashAsync();
        if (count < 0)
        {
            return ControllerResults.Status<TrashClearResponseDto>(500, "清空回收站失败：数据库操作异常", HttpContext.TraceIdentifier);
        }

        using var _ = AuditLogScope.Push(
            AuditSourceCatalog.Article,
            AuditTypeCatalog.Audit,
            new KeyValuePair<string, object?>("AuditAction", "trash.clear"),
            new KeyValuePair<string, object?>("DestroyedCount", count));
        LogClearTrash(count);
        return ApiResponse<TrashClearResponseDto>.Success(new TrashClearResponseDto(count), "回收站已清空");
    }

    [HttpPut("restore/{id}")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> Restore(int id)
    {
        if (await _articleService.RestoreAsync(id))
        {
            return ApiResponse.Success("文章已恢复发布");
        }

        return ControllerResults.NotFound("恢复失败：资源不存在", HttpContext.TraceIdentifier);
    }

    /// <summary>
    /// RSS 文章订阅源 (物理级零分配版)
    /// </summary>
    [EnableRateLimiting("fixed_ip")]
    [AllowAnonymous]
    [HttpGet("rss")]
    [Produces("application/xml")]
    public async Task<IActionResult> GetRssFeed()
    {
        var rssCache = await _cache.TryGetAsync<byte[]>(
            CachePolicyId.ArticleRss,
            RssCacheIdentity,
            static bytes =>
            {
                if (MemoryMarshal.TryGetArray(bytes, out ArraySegment<byte> segment)
                    && segment.Offset == 0
                    && segment.Count == segment.Array?.Length)
                {
                    return (true, segment.Array);
                }

                return (true, bytes.ToArray());
            });
        if (rssCache.Hit && rssCache.Value is { Length: > 0 } cachedBytes)
        {
            return File(cachedBytes, "application/xml");
        }

        // 2. 获取 SEO 配置
        var configList = await _db.Queryable<SystemConfig>()
            .Where(c => c.Key == "Seo_Title" || c.Key == "Seo_Description" || c.Key == "Site_BaseUrl")
            .Select(c => new { c.Key, c.Value })
            .ToListAsync();

        string siteTitle = "FsusBlog", siteDesc = "技术博客", baseUrl = $"{Request.Scheme}://{Request.Host}";
        foreach (var cfg in configList)
        {
            if (cfg.Key == "Seo_Title") siteTitle = cfg.Value;
            else if (cfg.Key == "Seo_Description") siteDesc = cfg.Value;
            else if (cfg.Key == "Site_BaseUrl") baseUrl = cfg.Value.TrimEnd('/');
        }

        // 3. 物理读取前 20 篇文章
        var sqlObj = _db.Queryable<Article>()
            .LeftJoin<Category>((a, c) => a.CategoryId == c.Id)
            .LeftJoin<ArticleBody>((a, c, b) => a.Id == b.ArticleId)
            .Where(a => !a.IsDeleted)
            .OrderByDescending(a => a.CreateTime)
            .Take(20)
            .Select((a, c, b) => new { a.Id, a.Title, a.Summary, a.CreateTime, CategoryName = c.Name, Content = b.MarkdownContent })
            .ToSql();

        var items = new List<ArticleListItemResponse>(20);
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id"), fTitle = reader.GetOrdinal("Title"), fSum = reader.GetOrdinal("Summary"),
                fTime = reader.GetOrdinal("CreateTime"), fCat = reader.GetOrdinal("CategoryName"), fContent = reader.GetOrdinal("Content");

            while (await reader.ReadAsync())
            {
                var contentStr = reader.IsDBNull(fContent) ? string.Empty : reader.GetString(fContent);
                items.Add(new ArticleListItemResponse
                {
                    Id = reader.GetInt32(fId),
                    Title = reader.GetString(fTitle),
                    Summary = reader.IsDBNull(fSum)
                        ? ImageHelper.StripMarkdown(contentStr, 200)
                        : reader.GetString(fSum),
                    CreateTime = reader.GetDateTime(fTime),
                    Category = new ArticleCategoryView(0, reader.IsDBNull(fCat) ? "默认" : reader.GetString(fCat))
                });
            }
        }

        // 4. MemoryStream 流式构造 XML
        var ms = new MemoryStream(8192);
        await using (var writer = new StreamWriter(ms, new UTF8Encoding(false), leaveOpen: true))
        {
            writer.Write("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<rss version=\"2.0\">\n  <channel>\n");
            writer.Write("    <title><![CDATA["); writer.Write(siteTitle); writer.Write("]]></title>\n");
            writer.Write("    <link>"); writer.Write(baseUrl); writer.Write("</link>\n");
            writer.Write("    <lastBuildDate>"); writer.Write(TimeUtils.ToRfc822(DateTime.UtcNow)); writer.Write("</lastBuildDate>\n");

            foreach (var art in items)
            {
                string sum = art.Summary ?? string.Empty;

                writer.Write("    <item>\n");
                writer.Write("      <title><![CDATA["); writer.Write(art.Title); writer.Write("]]></title>\n");
                writer.Write("      <link>"); writer.Write(baseUrl); writer.Write("/article/"); writer.Write(art.Id); writer.Write("</link>\n");
                writer.Write("      <description><![CDATA["); writer.Write(sum); writer.Write("]]></description>\n");
                writer.Write("      <pubDate>"); writer.Write(TimeUtils.ToRfc822(art.CreateTime)); writer.Write("</pubDate>\n");
                writer.Write("    </item>\n");
            }
            writer.Write("  </channel>\n</rss>");
        }

        ms.Position = 0;
        byte[] finalBytes = ms.ToArray();
        await _cache.SetRawAsync(CachePolicyId.ArticleRss, RssCacheIdentity, finalBytes);
        return File(finalBytes, "application/xml");
    }

    [LoggerMessage(EventId = 1, Level = LogLevel.Critical, Message = "执行清空回收站操作 | 被销毁文章数: {Count}")]
    private partial void LogClearTrash(int count);

    private async Task TryStorePublicAotShellAsync(PublicAotShellBundleContract? bundle, int articleId, string operation)
    {
        if (bundle is null || bundle.Entries is null || bundle.Entries.Count == 0)
        {
            return;
        }

        var normalized = bundle with
        {
            Entries = [
                .. bundle.Entries.Select(entry =>
                    entry.PageId == PublicPageId.ArticleDetail
                        ? entry with { ArticleId = articleId }
                        : entry)
            ],
            GeneratedAtUtc = DateTimeOffset.UtcNow
        };

        var result = await _publicAotShellService.StoreAsync(normalized);
        if (!result.IsSuccess)
        {
            _logger.LogWarning(
                "AOT 缓存写入失败 | Operation={Operation} | ArticleId={ArticleId} | Code={Code} | Message={Message}",
                operation,
                articleId,
                result.Error.Code,
                result.Error.Message);
        }
    }

}

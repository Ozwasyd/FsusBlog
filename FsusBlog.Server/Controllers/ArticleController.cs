using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using SqlSugar;
using StackExchange.Redis;
using System.Text;

namespace FsusBlog.Server.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ArticleController(
    IArticleService _articleService,
    IConnectionMultiplexer _redisConnection,
    IPowService _powService,
    ISqlSugarClient _db,
    AdaptivePowGovernor _governor,
    ILogger<ArticleController> _logger) : ControllerBase
{
    private readonly IDatabase _redis = _redisConnection.GetDatabase();
    private const string RssCacheKey = "cache:rss:xml_content";

    /// <summary>
    /// 获取文章列表（带权限过滤）
    /// </summary>
    [HttpGet]
    public async Task<ActionResult<ApiResponse<object>>> GetList(int page = 1, int size = 10, int? categoryId = null, int? tagId = null, bool isDeleted = false)
    {
        if (isDeleted)
        {
            if (User.Identity?.IsAuthenticated != true || !User.IsInRole("admin"))
            {
                return StatusCode(403, ApiResponse.Fail("权限不足：只有管理员可访问回收站内容", 403));
            }
        }

        var pageResult = await _articleService.GetPageListAsync(page, size, categoryId, tagId, isDeleted);
        return Ok(ApiResponse.Success(pageResult));
    }

    /// <summary>
    /// 获取文章详情（带阅读量防刷）
    /// </summary>
    [HttpGet("{id}")]
    public async Task<ActionResult<ApiResponse<Article>>> Get(int id)
    {
        // 1. 获取基础数据 (Service 内部处理缓存逻辑)
        var article = await _articleService.GetByIdAsync(id);

        if (article == null)
        {
            return NotFound(ApiResponse.Fail("文章不存在", 404));
        }

        // 2. 访问锁逻辑：1小时内同一 IP 仅增加一次阅读量
        var clientIp = HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var lockKey = $"view_lock:{id}:{clientIp}";

        // 逻辑自洽：尝试原子性写入锁
        if (await _redis.StringSetAsync(lockKey, "1", TimeSpan.FromHours(1), When.NotExists))
        {
            // 3. 执行原子自增与详情缓存失效逻辑
            await _articleService.IncreaseViewCountAsync(id);

            // 4. 手动补偿内存对象，实现本次返回结果的实时性
            article.Views += 1;
        }

        return Ok(ApiResponse.Success(article));
    }

    [Authorize(Roles = "admin")]
    [HttpPost]
    public async Task<ActionResult<ApiResponse<object>>> Create([FromBody] ArticleDto dto)
    {
        int id = await _articleService.CreateAsync(dto);
        return Ok(ApiResponse.Success(new { id }, "博文发布成功"));
    }

    [Authorize(Roles = "admin")]
    [HttpPut("{id}")]
    public async Task<ActionResult<ApiResponse<object>>> Update(int id, [FromBody] ArticleDto dto)
    {
        var success = await _articleService.UpdateAsync(id, dto);
        if (success) return Ok(ApiResponse.Success(new { id }, "博文更新成功"));

        return StatusCode(500, ApiResponse.Fail("更新失败：数据库操作异常", 500));
    }

    [Authorize(Roles = "admin")]
    [HttpDelete("{id}")]
    public async Task<ActionResult<ApiResponse>> Delete(int id)
    {
        if (await _articleService.DeleteAsync(id))
            return Ok(ApiResponse.Success("文章已移至回收站"));

        return NotFound(ApiResponse.Fail("未找到对应文章", 404));
    }

    [Authorize(Roles = "admin")]
    [HttpDelete("permanent/{id}")]
    public async Task<ActionResult<ApiResponse>> PermanentDelete(int id)
    {
        if (await _articleService.PermanentlyDeleteArticleAsync(id))
            return Ok(ApiResponse.Success("文章及关联资源已彻底抹除"));

        return NotFound(ApiResponse.Fail("操作失败：资源不存在", 404));
    }

    [Authorize(Roles = "admin")]
    [HttpDelete("trash")]
    public async Task<ActionResult<ApiResponse<object>>> ClearTrash()
    {
        int count = await _articleService.ClearTrashAsync();
        _logger.LogCritical("执行清空回收站操作 | 被销毁文章数: {Count}", count);
        return Ok(ApiResponse.Success(new { count }, "回收站已清空"));
    }

    [EnableRateLimiting("fixed_ip")]
    [AllowAnonymous]
    [HttpGet("search")]
    public async Task<ActionResult<ApiResponse<object>>> Search([FromQuery] SearchDto dto)
    {
        // 1. 基础业务参数校验
        if (dto == null || string.IsNullOrWhiteSpace(dto.Keyword))
            return BadRequest(ApiResponse.Fail("搜索关键词不能为空"));

        string clientIp = HttpContext.GetClientIp();

        // 2. 实时环境裁决 (熔断器逻辑)
        // 职责：判断当前系统负载是否允许该难度的请求通过
        // 性能最大化：此处通常命中本地 L1 缓存，速度极快
        int currentRequired = await _governor.GetDifficultyForIpAsync(clientIp);

        if (dto.Difficulty < currentRequired)
        {
            // 逻辑自洽：如果系统负载瞬间升高，即便是之前下发的合法挑战包也要失效，强制前端重新获取高难度挑战
            return StatusCode(403, ApiResponse.Fail("访问受限：系统负载波动，请刷新页面重新获取挑战", 403));
        }

        // 3. 凭据完整性与合法性校验
        // 职责：验证签名是否被篡改、Nonce 是否重放、时间戳是否过期
        // 安全性保障：VerifyAsync 内部会根据 dto.PowSignature 验证其包含的 Difficulty 是否被客户端手动篡改
        if (!await _powService.VerifyAsync(dto, clientIp))
        {
            return StatusCode(401, ApiResponse.Fail("安全校验已失效，请重试", 401));
        }

        // 4. 业务执行
        // 走到这里说明：
        // a. 该请求符合当前的系统负载要求 (Difficulty >= currentRequired)
        // b. 该请求是服务器下发的，且没有被中途篡改过 (Signature Valid)
        var results = await _articleService.SearchArticlesAsync(dto.Keyword);

        return Ok(ApiResponse.Success(results));
    }

    [HttpGet("hot")]
    public async Task<ActionResult<ApiResponse<object>>> GetHotArticles([FromQuery] int size = 10)
    {
        size = Math.Clamp(size, 1, 50);
        var hotArticles = await _articleService.GetHotArticlesAsync(size);
        return Ok(ApiResponse.Success(hotArticles));
    }

    [HttpPut("restore/{id}")]
    [Authorize(Roles = "admin")]
    public async Task<ActionResult<ApiResponse>> Restore(int id)
    {
        if (await _articleService.RestoreAsync(id))
            return Ok(ApiResponse.Success("文章已恢复发布"));

        return NotFound(ApiResponse.Fail("恢复失败：资源不存在", 404));
    }

    /// <summary>
    /// RSS 文章订阅源 
    /// 性能最大化：利用 Redis 缓存完整的 XML 响应
    /// 安全性保障：不强制 PoW，由固定 IP 限流器保护
    /// </summary>
    [EnableRateLimiting("fixed_ip")]
    [HttpGet("rss")]
    [Produces("application/xml")]
    public async Task<IActionResult> GetRssFeed()
    {
        // 1. 优先检查 Redis 缓存
        var cachedRss = await _redis.StringGetAsync(RssCacheKey);
        if (cachedRss.HasValue)
        {
            return Content(cachedRss.ToString()!, "application/xml", Encoding.UTF8);
        }

        // 2. 聚合系统配置 (增加 Site_BaseUrl 查询)
        var configList = await _db.Queryable<SystemConfig>()
            .Where(c => c.Key == "Seo_Title" ||
                        c.Key == "Seo_Description" ||
                        c.Key == "Site_BaseUrl")
            .ToListAsync();

        var configDict = configList.ToDictionary(c => c.Key, c => c.Value);

        // 获取配置并提供健壮的默认值
        configDict.TryGetValue("Seo_Title", out string? siteTitle);
        configDict.TryGetValue("Seo_Description", out string? siteDesc);
        configDict.TryGetValue("Site_BaseUrl", out string? baseUrl);

        siteTitle ??= "FsusBlog";
        siteDesc ??= "一个硬核的技术博客";
        // 逻辑自洽：如果数据库没配，则尝试从 Request 中获取当前域名作为后备方案
        baseUrl = (baseUrl ?? $"{Request.Scheme}://{Request.Host}").TrimEnd('/');

        // 3. 获取数据
        var pageData = await _articleService.GetPageListAsync(1, 20, null, null);
        var items = pageData.Items;

        // 4. 构建 XML
        var sb = new StringBuilder();
        sb.AppendLine("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
        sb.AppendLine("<rss version=\"2.0\" xmlns:atom=\"http://www.w3.org/2005/Atom\">");
        sb.AppendLine("  <channel>");
        sb.AppendLine($"    <title><![CDATA[{siteTitle}]]></title>");
        sb.AppendLine($"    <link>{baseUrl}</link>");
        sb.AppendLine($"    <description><![CDATA[{siteDesc}]]></description>");
        sb.AppendLine($"    <language>zh-cn</language>");
        sb.AppendLine($"    <lastBuildDate>{TimeUtils.ToRfc822(DateTime.UtcNow)}</lastBuildDate>");
        // 必须使用绝对路径，RSS 阅读器才能正确识别 self 引用
        sb.AppendLine($"    <atom:link href=\"{baseUrl}/api/Article/rss\" rel=\"self\" type=\"application/rss+xml\" />");

        foreach (var article in items)
        {
            // 拼接完整的文章跳转链接
            string fullLink = $"{baseUrl}/article/{article.Id}";

            string summary = string.IsNullOrWhiteSpace(article.Summary)
                ? ImageHelper.StripMarkdown(article.Snippet ?? string.Empty, 200)
                : article.Summary;

            sb.AppendLine("    <item>");
            sb.AppendLine($"      <title><![CDATA[{article.Title}]]></title>");
            sb.AppendLine($"      <link>{fullLink}</link>");
            sb.AppendLine($"      <description><![CDATA[{summary}... (阅读全文请访问站点并完成安全验证)]]></description>");
            sb.AppendLine($"      <pubDate>{TimeUtils.ToRfc822(article.CreateTime)}</pubDate>");
            sb.AppendLine($"      <guid isPermaLink=\"false\">{article.Id}</guid>");
            sb.AppendLine($"      <category>{article.CategoryName}</category>");
            sb.AppendLine("    </item>");
        }

        sb.AppendLine("  </channel>");
        sb.AppendLine("</rss>");

        string finalXml = sb.ToString();

        // 5. 写入 Redis 缓存 (30 分钟)
        await _redis.StringSetAsync(RssCacheKey, finalXml, TimeSpan.FromMinutes(30));

        return Content(finalXml, "application/xml", Encoding.UTF8);
    }

}
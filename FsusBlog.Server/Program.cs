using FsusBlog.Server.Infrastructure;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Sse;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Services.Sse;
using FsusBlog.Server.Services.VistitLog;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.ObjectPool;
using Serilog;
using SqlSugar;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

// =================================================================================
// 性能最大化配置 (修复日期: 2026-02-22)
// 动态倍增线程池下限，解决 StackExchange.Redis 瞬间高并发下的饥饿超时问题
// =================================================================================
int workerThreads, iocpThreads;
ThreadPool.GetMinThreads(out workerThreads, out iocpThreads);

int minThreadsBasedOnCpu = Environment.ProcessorCount * 50;
int targetMinThreads = Math.Max(minThreadsBasedOnCpu, workerThreads);
ThreadPool.SetMinThreads(targetMinThreads, targetMinThreads);

// 1. 日志
builder.Host.UseSerilog((context, services, configuration) => configuration
    .ReadFrom.Configuration(context.Configuration)
    .ReadFrom.Services(services)
    .Enrich.FromLogContext());

// 2. 基础网络 (针对多层代理进行安全加固)
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});

// 解析并统一存储 CORS 列表 (清除原有的重复代码)
var originsString = builder.Configuration["CORS_ALLOWED_HOSTS"];
var origins = originsString?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries) ?? [];

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.WithOrigins(origins)
          .AllowAnyHeader()
          .AllowAnyMethod()
          .AllowCredentials();
    });
});

// 3. 核心服务注册
builder.Services.AddControllers()
    .AddJsonOptions(options => options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
builder.Services.AddOutputCache();
builder.Services.AddHttpContextAccessor();
builder.Services.AddEndpointsApiExplorer();

builder.Services.AddRedis(builder.Configuration);
builder.Services.AddSqlSugar();
builder.Services.AddJwtAuthentication(builder.Configuration);

// [物理级替换] 移除 SignalR，挂载 SSE 底层支持
builder.Services.AddSingleton<SseConnectionManager>();
builder.Services.AddHostedService<SseHeartbeatService>();

builder.Services.AddPowServices();

builder.Services.AddMemoryCache();
builder.Services.AddHttpClient();
builder.Services.AddSingleton<CrawlerDetectorService>();
builder.Services.AddHostedService<CrawlerUpdateWorker>();

builder.Services.AddScoped<IFileService, FileService>();
builder.Services.AddScoped<ISystemService, SystemService>();
builder.Services.AddScoped<IArticleService, ArticleService>();
builder.Services.AddScoped<ICommentService, CommentService>();
builder.Services.AddScoped<IStatsService, StatsService>();
builder.Services.AddScoped<IUserService, UserService>();
builder.Services.AddScoped<MessageCacheService>();
builder.Services.AddScoped<IMessageService, SseMessageService>();
builder.Services.AddSingleton<IBlacklistService, BlacklistService>();
builder.Services.AddSingleton<IUserIdProvider, SnowflakeUserIdProvider>();

builder.Services.AddSingleton<VisitLogChannel>();
builder.Services.AddHostedService<VisitLogProcessorService>();
builder.Services.AddHostedService<LogCleanupService>();
builder.Services.AddSingleton<IContentFilterService, ContentFilterService>();

// Lucene 配置
var lucenePath = Path.Combine(AppContext.BaseDirectory, "LuceneIndex");
builder.Services.AddSingleton<ILuceneContext>(new LuceneContext(lucenePath));
builder.Services.AddSingleton<ILuceneService, LuceneService>();
builder.Services.TryAddSingleton<ObjectPoolProvider, DefaultObjectPoolProvider>();

builder.Services.AddSingleton(sp =>
{
    var env = sp.GetRequiredService<IWebHostEnvironment>();
    var logger = sp.GetRequiredService<ILogger<IP2LocationPooledObjectPolicy>>();

    string baseDir = AppContext.BaseDirectory;
    string[] potentialPaths = [
        Path.Combine(baseDir, "wwwroot", "resources", "IP2LOCATION.BIN"),
        Path.Combine(baseDir, "resources", "IP2LOCATION.BIN"),
        Path.Combine(baseDir, "wwwroot", "resource", "IP2LOCATION.BIN")
    ];

    string? binPath = potentialPaths.FirstOrDefault(File.Exists);

    if (string.IsNullOrEmpty(binPath))
    {
        var allFiles = Directory.GetFiles(baseDir, "IP2LOCATION.BIN", SearchOption.AllDirectories);
        throw new FileNotFoundException($"[严重] 找不到数据库文件。已尝试路径: {string.Join(", ", potentialPaths)}。 实际发现于: {string.Join(", ", allFiles)}");
    }

    var policy = new IP2LocationPooledObjectPolicy(binPath, logger);
    return sp.GetRequiredService<ObjectPoolProvider>().Create(policy);
});

// 4. 分区限流
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.AddPolicy("fixed_ip", httpContext =>
    {
        string clientIp = httpContext.GetClientIp();

        if (httpContext.User.IsInRole("admin") || clientIp == "127.0.0.1" || clientIp == "::1")
        {
            return RateLimitPartition.GetNoLimiter("admin");
        }

        return RateLimitPartition.GetFixedWindowLimiter(clientIp, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 100,
            Window = TimeSpan.FromMinutes(1),
            AutoReplenishment = true,
            QueueLimit = 2,
            QueueProcessingOrder = QueueProcessingOrder.OldestFirst
        });
    });
});

builder.Services.AddScoped<CacheInitializer>();

// 核心修复：统一 Minimal API 的序列化策略，确保与 Controller 行为一致
builder.Services.ConfigureHttpJsonOptions(options => {
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
});

var app = builder.Build();

// ==============================================================================
// 5. 中间件管道 (Order is CRITICAL)
// ==============================================================================

app.UseForwardedHeaders();

// 核心：这里只加载了 ShieldMiddleware，因此 CrawlerAuthMiddleware 属于死代码
app.UseMiddleware<ShieldMiddleware>();

app.UseMiddleware<GlobalExceptionMiddleware>();

//[修改日期 2026-03-01]
// 修改理由：物理接管前端静态资源，实现零 I/O 损耗单容器托管。
// 安全性保障：显式注册 application/wasm MIME 类型，防止 Kestrel 拦截 PoW 引擎下载。
app.UseDefaultFiles(); // 必须在 UseStaticFiles 之前，用于默认指向 index.html

var provider = new FileExtensionContentTypeProvider();
provider.Mappings[".wasm"] = "application/wasm";

app.UseStaticFiles(new StaticFileOptions
{
    ContentTypeProvider = provider,
    OnPrepareResponse = ctx =>
    {
        // 性能最大化：为前端的 js/css/wasm 静态资产设置长达 1 年的强缓存
        if (ctx.File.Name.EndsWith(".js") || ctx.File.Name.EndsWith(".css") || ctx.File.Name.EndsWith(".wasm"))
        {
            ctx.Context.Response.Headers.Append("Cache-Control", "public,max-age=31536000,immutable");
        }
    }
});

app.UseRouting();
app.UseOutputCache();

if (origins.Length > 0)
{
    app.UseCors(); // 利用前面统一注册好的 Default Policy
}

app.UseRateLimiter();
app.UseAuthentication();
app.UseMiddleware<BannedUserFilter>();
app.UseAuthorization();
app.UseMiddleware<VisitLogMiddleware>();

app.MapControllers();

// 6. 最小API挂载注册
app.MapMessageEndpoints();
app.MapArticleEndpoints();
app.MapAuthEndpoints();
app.MapCategoryEndpoints();
app.MapCommentEndpoints();
app.MapSystemEndpoints(); 
app.MapTagEndpoints();

// [极限物理重构] 接驳 Minimal API SSE 流式传输，自动承载 Token 与 PoW
app.MapGet("/api/notifications/stream", StreamNotificationsAsync);

async Task StreamNotificationsAsync(
    HttpContext ctx,
    SseConnectionManager manager,
    CancellationToken ct)
{
    ctx.Response.Headers.Append("Content-Type", "text/event-stream");
    ctx.Response.Headers.Append("Cache-Control", "no-cache");
    ctx.Response.Headers.Append("Connection", "keep-alive");

    // [物理破冰 1] 彻底打穿 Nginx / Caddy 的反向代理缓冲
    ctx.Response.Headers.Append("X-Accel-Buffering", "no");

    // [物理破冰 2] 强行瘫痪 ASP.NET Core 的 Gzip/Brotli 响应压缩与内部缓冲
    var feature = ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>();
    feature?.DisableBuffering();

    //[物理破冰 3] 强制立即下发 HTTP Headers，瞬间解开前端 Fetch Promise 等待
    await ctx.Response.StartAsync(ct);

    var userId = ctx.User.Identity?.IsAuthenticated == true
        ? ctx.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
        : null;

    string connId = Guid.NewGuid().ToString();
    var channel = System.Threading.Channels.Channel.CreateUnbounded<string>();

    var groups = new List<string> { "ContentGovernanceGroup" };
    if (!string.IsNullOrEmpty(userId)) groups.Add("AuthenticatedUsersGroup");

    var client = new SseClient(connId, userId, channel.Writer, groups);
    manager.AddClient(client);

    using var registration = ct.Register(() => channel.Writer.TryComplete());

    try
    {
        // 推送初始握手心跳，验证全链路贯通
        await ctx.Response.WriteAsync("event: connected\ndata: {}\n\n", ct);
        await ctx.Response.Body.FlushAsync(ct);

        await foreach (var message in channel.Reader.ReadAllAsync(ct))
        {
            // 每次产生数据，直接零拷贝写入网卡并强制 Flush
            await ctx.Response.WriteAsync(message, ct);
            await ctx.Response.Body.FlushAsync(ct);
        }
    }
    catch (OperationCanceledException)
    {
        // 客户端断开连接，优雅吞咽异常
    }
    finally
    {
        manager.RemoveClient(connId);
    }
}

// [修改日期 2026-03-01]
// 修改理由：SPA 路由防丢。如果请求没有命中上面的任何 API 或文件，统统回退到前端入口，交由 Vue Router 处理 404 和页面路由。
app.MapFallbackToFile("index.html");

// 7. 数据库与系统初始化
try
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
    db.DbMaintenance.CreateDatabase();

    var types = Assembly.GetExecutingAssembly().GetTypes()
        .Where(t => t.GetCustomAttribute<SugarTable>() != null).ToArray();
    db.CodeFirst.InitTables(types);

    var initializer = scope.ServiceProvider.GetRequiredService<CacheInitializer>();
    await initializer.InitializeAsync();

    Console.WriteLine("Hello,world.System Ready (API Engine Mode).");
}
catch (Exception ex)
{
    Log.Fatal(ex, "System Halt.");
    if (!app.Environment.IsDevelopment()) throw;
}

app.Run();
using FsusBlog.Server.Infrastructure;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.SignalR;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules;
using FsusBlog.Server.Services;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.ObjectPool;
using Serilog;
using SqlSugar;
using System.Reflection;
using System.Text.Json;
using System.Threading.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

// 1. 日志 (保持不变)
builder.Host.UseSerilog((context, services, configuration) => configuration
    .ReadFrom.Configuration(context.Configuration)
    .ReadFrom.Services(services)
    .Enrich.FromLogContext());

// 2. 基础网络 (针对多层代理进行安全加固)
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    // 逻辑自洽：识别由 OpenResty 和 Nginx 传递的 X-Forwarded-For 和 X-Forwarded-Proto
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;

    // 安全性保障：在 Docker 内部桥接网络中，清除已知代理和网络限制以信任网关分发的 Header
    // 确保 ShieldMiddleware 和 PoW 逻辑能拿到真实的访客公网 IP
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});

// 1. 读取逗号分隔的字符串
var originsString = builder.Configuration["CORS_ALLOWED_HOSTS"];

// 2. 将字符串转换为数组，并过滤掉空值
var origins = originsString?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
              ?? [];

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        // 逻辑自洽：自动应用来自环境变量或 JSON 的域名列表
        policy.WithOrigins(origins)
          .AllowAnyHeader()
          .AllowAnyMethod()
          .AllowCredentials();
    });
});

// 3. 核心服务注册
builder.Services.AddControllers()
    .AddJsonOptions(options => options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
builder.Services.AddHttpContextAccessor();
builder.Services.AddEndpointsApiExplorer();

// 扩展件
builder.Services.AddRedis(builder.Configuration);
builder.Services.AddSqlSugar();
builder.Services.AddJwtAuthentication(builder.Configuration);

// SignalR 加固配置
builder.Services.AddSignalR(builder.Configuration);

// 注册自适应 PoW 治理器
builder.Services.AddSingleton<AdaptivePowGovernor>();

// 注册 PoW 服务
builder.Services.AddSingleton<IPowService, RedisPowService>();

// 业务服务 (保持不变)
builder.Services.AddScoped<IFileService, FileService>();
builder.Services.AddScoped<ISystemService, SystemService>();
builder.Services.AddScoped<IArticleService, ArticleService>();
builder.Services.AddScoped<ICommentService, CommentService>();
builder.Services.AddScoped<IStatsService, StatsService>();
builder.Services.AddScoped<IUserService, UserService>();
builder.Services.AddScoped<MessageCacheService>();
builder.Services.AddScoped<IMessageService, SignalRMessageService>();
builder.Services.AddSingleton<IBlacklistService, BlacklistService>();
builder.Services.AddSingleton<IUserIdProvider, SnowflakeUserIdProvider>();

// Lucene (针对 Linux 容器路径进行适配)
var lucenePath = Path.Combine(AppContext.BaseDirectory, "LuceneIndex");
builder.Services.AddSingleton<ILuceneContext>(new LuceneContext(lucenePath));
builder.Services.AddSingleton<ILuceneService, LuceneService>();
builder.Services.TryAddSingleton<ObjectPoolProvider, DefaultObjectPoolProvider>();
builder.Services.AddSingleton(sp =>
{
    var env = sp.GetRequiredService<IWebHostEnvironment>();
    var logger = sp.GetRequiredService<ILogger<IP2LocationPooledObjectPolicy>>();

    // 根据调试反馈，文件实际存在于 resources (复数) 文件夹中
    // 性能最大化：优先匹配系统已确认存在的物理路径
    string baseDir = AppContext.BaseDirectory;
    string[] potentialPaths = {
        Path.Combine(baseDir, "wwwroot", "resources", "IP2LOCATION.BIN"),
        Path.Combine(baseDir, "resources", "IP2LOCATION.BIN"),
        Path.Combine(baseDir, "wwwroot", "resource", "IP2LOCATION.BIN")
    };

    string? binPath = potentialPaths.FirstOrDefault(File.Exists);

    if (string.IsNullOrEmpty(binPath))
    {
        // 安全性保障：若所有路径均失效，输出详细的扫描结果以供二次审计
        var allFiles = Directory.GetFiles(baseDir, "IP2LOCATION.BIN", SearchOption.AllDirectories);
        throw new FileNotFoundException($"[严重] 找不到数据库文件。已尝试路径: {string.Join(", ", potentialPaths)}。 实际发现于: {string.Join(", ", allFiles)}");
    }

    var policy = new IP2LocationPooledObjectPolicy(binPath, logger);
    return sp.GetRequiredService<ObjectPoolProvider>().Create(policy);
});

// 4. 分区限流 (基于真实 IP 进行防御)
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.AddPolicy("fixed_ip", httpContext =>
    {
        // 性能最大化：此处获取的 IP 已由 ForwardedHeaders 完成修正
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

var app = builder.Build();

// ==============================================================================
// 5. 中间件管道 (Order is CRITICAL)
// ==============================================================================

// 1. IP 修正 (必须置于首位以确保后续安全中间件获取正确客户端 IP)
app.UseForwardedHeaders();

// 2. 零容忍防御盾 (最前置过滤黑名单)
app.UseMiddleware<ShieldMiddleware>();

// 3. 异常兜底
app.UseMiddleware<GlobalExceptionMiddleware>();

// 静态剥离逻辑：方案二下静态资源由 Nginx 处理，此处仅作资源目录支持
app.UseStaticFiles();

app.UseRouting();

// 4. CORS (跨域配置)
// 直接从环境变量或配置中获取逗号分隔的字符串
var allowedOriginsString = builder.Configuration["CORS_ALLOWED_HOSTS"] ?? "";

// 将字符串拆分为数组，并过滤掉空项
var allowedOrigins = allowedOriginsString
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

if (allowedOrigins.Length > 0)
{
    app.UseCors(policy => policy
        .WithOrigins(allowedOrigins)
        .AllowAnyHeader()
        .AllowAnyMethod()
        .AllowCredentials());
}

// 5. 安全过滤与授权
app.UseRateLimiter();
app.UseAuthentication();
app.UseMiddleware<BannedUserFilter>();
app.UseAuthorization();

// 6. 访问审计
app.UseMiddleware<VisitLogMiddleware>();

app.MapControllers();

// 7. 路径一致性：映射路径必须与 Nginx 代理配置中的 /hub/ 保持严格一致
app.MapHub<NotificationHub>("/hub/notifications");
app.MapMessageEndpoints();

// 逻辑自洽：前后端分离模式下 404 回退由前端网关 try_files 处理，API 层不再映射 index.html
// app.MapFallbackToFile("/index.html"); 

// 6. 数据库与系统初始化
try
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
    db.DbMaintenance.CreateDatabase();

    // 自动同步实体结构
    var types = Assembly.GetExecutingAssembly().GetTypes()
        .Where(t => t.GetCustomAttribute<SugarTable>() != null).ToArray();
    db.CodeFirst.InitTables(types);

    // 初始化系统配置与热数据缓存
    var initializer = scope.ServiceProvider.GetRequiredService<CacheInitializer>();
    await initializer.InitializeAsync();

    Console.WriteLine("System Ready (API Engine Mode).");
}
catch (Exception ex)
{
    Log.Fatal(ex, "System Halt.");
    if (!app.Environment.IsDevelopment()) throw;
}

app.Run();
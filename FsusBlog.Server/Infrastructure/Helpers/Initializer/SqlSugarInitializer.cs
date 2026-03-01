using FsusBlog.Server.Infrastructure.Cache;
using SqlSugar;
using StackExchange.Redis;
using DbType = SqlSugar.DbType;

namespace FsusBlog.Server.Infrastructure.Helpers.Initializer;

/// <summary>
/// SqlSugar 初始化器
/// 修复日期: 2026-02-23 (修复 SqlSugarCacheService 依赖注入链，衔接零分配 Redis 架构，增强 AOP 性能防线)
/// </summary>
public static class SqlSugarInitializer
{
    /// <summary>
    /// SqlSugar 核心服务注册
    /// </summary>
    public static void AddSqlSugar(this IServiceCollection services)
    {
        // 使用工厂模式注册单例，延迟解析依赖，避免 BuildServiceProvider 反模式
        services.AddSingleton<ISqlSugarClient>(sp =>
        {
            // 1. 从 DI 容器中获取必要依赖 (此时容器已构建完成)
            var config = sp.GetRequiredService<IConfiguration>();
            var logger = sp.GetRequiredService<ILogger<SqlSugarScope>>();

            var connectionString = config.GetConnectionString("DefaultConnection");
            if (string.IsNullOrEmpty(connectionString))
            {
                throw new InvalidOperationException("致命错误：未配置数据库连接字符串 DefaultConnection。");
            }

            // 核心修复：配合之前 SqlSugarCacheService 的物理级零分配重构，
            // 这里必须注入 IConnectionMultiplexer 而不是 IDistributedCache
            var redisMultiplexer = sp.GetRequiredService<IConnectionMultiplexer>();

            // 获取缓存服务专用的 Logger，允许为 null
            var cacheLogger = sp.GetService<ILogger<SqlSugarCacheService>>();

            // 2. 构建连接配置
            var connectionConfig = new ConnectionConfig
            {
                ConnectionString = connectionString,
                DbType = DbType.PostgreSQL,
                IsAutoCloseConnection = true,
                InitKeyType = InitKeyType.Attribute,

                ConfigureExternalServices = new ConfigureExternalServices
                {
                    // 注入重构后的极致性能缓存服务
                    DataInfoCacheService = new SqlSugarCacheService(redisMultiplexer, cacheLogger!)
                },

                // PostgreSQL 特有配置：强制转小写
                MoreSettings = new ConnMoreSettings
                {
                    PgSqlIsAutoToLower = true,
                    PgSqlIsAutoToLowerCodeFirst = true
                }
            };

            // 3. 初始化 SqlSugarScope (线程安全的单例)
            var db = new SqlSugarScope(connectionConfig, dbClient =>
            {
                // 4. 配置 AOP (面向切面编程)

                // 调试日志：性能防线
                dbClient.Aop.OnLogExecuting = (sql, pars) =>
                {
                    // 必须保持此判断！这使得生产环境下的 SQL 拦截开销趋近于 0，
                    // 避免 UtilMethods.GetSqlString 产生海量的字符串装箱与拼接垃圾。
                    if (logger.IsEnabled(LogLevel.Debug))
                    {
                        logger.LogDebug("SQL Executing: {Sql}", UtilMethods.GetSqlString(DbType.PostgreSQL, sql, pars));
                    }
                };

                // 慢 SQL 监控
                dbClient.Aop.OnLogExecuted = (sql, pars) =>
                {
                    var executionTime = dbClient.Ado.SqlExecutionTime.TotalSeconds;
                    // 执行超过 1 秒的语句记录为 Warning
                    if (executionTime > 1)
                    {
                        var fullSql = UtilMethods.GetSqlString(DbType.PostgreSQL, sql, pars);
                        logger.LogWarning("慢 SQL 警报 ({Time:F2}s): {Sql}", executionTime, fullSql);
                    }
                };

                // 错误日志
                dbClient.Aop.OnError = (exp) =>
                {
                    // 记录完整的堆栈信息与直接引发异常的 SQL
                    logger.LogError(exp, "SQL 执行异常 | SQL: {Sql}", exp.Sql);
                };
            });

            return db;
        });
    }
}

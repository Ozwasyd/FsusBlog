using FsusBlog.Server.Infrastructure.Cache;
using Microsoft.Extensions.Caching.Distributed;
using SqlSugar;
using DbType = SqlSugar.DbType;

namespace FsusBlog.Server.Infrastructure.Helpers.Initializer;

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
            var distributedCache = sp.GetRequiredService<IDistributedCache>();

            // 获取缓存服务专用的 Logger (如果有)
            var cacheLogger = sp.GetService<ILogger<SqlSugarCacheService>>();

            // 2. 构建连接配置
            var connectionConfig = new ConnectionConfig
            {
                ConnectionString = config.GetConnectionString("DefaultConnection"),
                DbType = DbType.PostgreSQL,
                IsAutoCloseConnection = true,
                InitKeyType = InitKeyType.Attribute,

                ConfigureExternalServices = new ConfigureExternalServices
                {
                    DataInfoCacheService = new SqlSugarCacheService(distributedCache, cacheLogger)
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

                // 调试日志：仅在 Debug 级别开启时记录 SQL
                dbClient.Aop.OnLogExecuting = (sql, pars) =>
                {
                    if (logger.IsEnabled(LogLevel.Debug))
                    {
                        logger.LogDebug("SQL Executing: {Sql}", UtilMethods.GetSqlString(DbType.PostgreSQL, sql, pars));
                    }
                };

                // 慢 SQL 监控：执行超过 1 秒的语句记录为 Warning
                dbClient.Aop.OnLogExecuted = (sql, pars) =>
                {
                    // 必须先判断 Ado 是否为空 (虽然极少发生)
                    if (dbClient.Ado.SqlExecutionTime.TotalSeconds > 1)
                    {
                        var time = dbClient.Ado.SqlExecutionTime.TotalSeconds;
                        var fullSql = UtilMethods.GetSqlString(DbType.PostgreSQL, sql, pars);
                        logger.LogWarning("⚠️ 慢 SQL 警报 ({Time:F2}s): {Sql}", time, fullSql);
                    }
                };

                // 错误日志：SQL 执行报错时记录
                dbClient.Aop.OnError = (exp) =>
                {
                    // 记录完整的堆栈信息
                    logger.LogError(exp, "SQL 执行异常 | SQL: {Sql}", exp.Sql);
                };
            });

            return db;
        });
    }
}

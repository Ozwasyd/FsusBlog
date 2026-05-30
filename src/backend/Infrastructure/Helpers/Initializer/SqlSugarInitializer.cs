using System.Data.Common;
using FsusBlog.Server.Infrastructure.Testing;
using Npgsql;
using SqlSugar;
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
        services.AddSingleton<SqlSugarClientFactory>();
        services.AddScoped<ISqlSugarClient>(sp =>
        {
            var testSession = sp.GetService<ITestSessionContext>();
            return sp.GetRequiredService<SqlSugarClientFactory>().CreateClient(testSession);
        });
    }

    internal static string NormalizeConnectionString(string connectionString)
    {
        var rawBuilder = new DbConnectionStringBuilder
        {
            ConnectionString = connectionString
        };
        var builder = new NpgsqlConnectionStringBuilder(connectionString);

        if (!ContainsAny(rawBuilder, "Maximum Pool Size", "MaxPoolSize"))
        {
            builder.MaxPoolSize = 60;
        }

        if (!ContainsAny(rawBuilder, "Minimum Pool Size", "MinPoolSize"))
        {
            builder.MinPoolSize = 5;
        }

        if (!ContainsAny(rawBuilder, "Timeout", "Connection Timeout"))
        {
            builder.Timeout = 15;
        }

        if (!ContainsAny(rawBuilder, "Command Timeout", "CommandTimeout"))
        {
            builder.CommandTimeout = 30;
        }

        return builder.ConnectionString;
    }

    private static string ApplySearchPath(string connectionString, string schemaName)
    {
        var builder = new NpgsqlConnectionStringBuilder(connectionString)
        {
            SearchPath = $"{schemaName},public"
        };

        return builder.ConnectionString;
    }

    private static bool ContainsAny(DbConnectionStringBuilder builder, params string[] keys)
    {
        for (int i = 0; i < keys.Length; i++)
        {
            if (builder.ContainsKey(keys[i]))
            {
                return true;
            }
        }

        return false;
    }

    private static ConnectionConfig CreateConnectionConfig(string connectionString)
        => new()
        {
            ConnectionString = connectionString,
            DbType = DbType.PostgreSQL,
            IsAutoCloseConnection = true,
            InitKeyType = InitKeyType.Attribute,

            // PostgreSQL 特有配置：强制转小写
            MoreSettings = new ConnMoreSettings
            {
                PgSqlIsAutoToLower = true,
                PgSqlIsAutoToLowerCodeFirst = true
            }
        };

    private sealed class SqlSugarClientFactory
    {
        private readonly string _connectionString;
        private readonly ILogger<SqlSugarClient> _logger;

        public SqlSugarClientFactory(IConfiguration config, ILogger<SqlSugarClient> logger)
        {
            _logger = logger;
            string? configuredConnectionString = config.GetConnectionString("DefaultConnection");
            if (string.IsNullOrEmpty(configuredConnectionString))
            {
                throw new InvalidOperationException("致命错误：未配置数据库连接字符串 DefaultConnection。");
            }

            _connectionString = NormalizeConnectionString(configuredConnectionString);
        }

        public ISqlSugarClient CreateClient(ITestSessionContext? testSession)
        {
            if (testSession?.SchemaName is not { Length: > 0 } schemaName)
            {
                return new SqlSugarClient(CreateConnectionConfig(_connectionString), ConfigureAop);
            }

            string isolatedConnectionString = ApplySearchPath(_connectionString, schemaName);
            return new SqlSugarClient(CreateConnectionConfig(isolatedConnectionString), ConfigureAop);
        }

        private void ConfigureAop(SqlSugarClient dbClient)
        {
            // 调试日志：性能防线
            dbClient.Aop.OnLogExecuting = (sql, pars) =>
            {
                // 必须保持此判断！这使得生产环境下的 SQL 拦截开销趋近于 0，
                // 避免 UtilMethods.GetSqlString 产生海量的字符串装箱与拼接垃圾。
                if (_logger.IsEnabled(LogLevel.Debug))
                {
                    _logger.LogDebug("SQL Executing: {Sql}", UtilMethods.GetSqlString(DbType.PostgreSQL, sql, pars));
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
                    _logger.LogWarning("慢 SQL 警报 ({Time:F2}s): {Sql}", executionTime, fullSql);
                }
            };

            // 错误日志
            dbClient.Aop.OnError = exp =>
            {
                // 记录完整的堆栈信息与直接引发异常的 SQL
                _logger.LogError(exp, "SQL 执行异常 | SQL: {Sql}", exp.Sql);
            };
        }
    }
}

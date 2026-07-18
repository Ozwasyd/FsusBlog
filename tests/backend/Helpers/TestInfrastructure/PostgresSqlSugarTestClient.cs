using SqlSugar;
using DbType = SqlSugar.DbType;

using FsusBlog.Server.Infrastructure.Helpers.Initializer;
namespace FsusBlog.Server.Tests.TestInfrastructure;

public abstract class PostgresClassDatabaseFixture
{
    private readonly SemaphoreSlim _resetGate = new(1, 1);
    private string? _connectionString;

    public string ConnectionString => _connectionString
        ?? throw new InvalidOperationException("The class database has not been initialized for this test case.");

    public async Task<string> ResetAsync(PostgresSchemaMigrationFixture containerFixture)
    {
        await _resetGate.WaitAsync().ConfigureAwait(false);
        try
        {
            _connectionString ??= await PostgresSqlSugarTestClient
                .CreateConnectionStringAsync(containerFixture)
                .ConfigureAwait(false);
            await containerFixture.ExecuteAsync(
                    _connectionString,
                    """
                    DROP SCHEMA IF EXISTS public CASCADE;
                    CREATE SCHEMA public;
                    """)
                .ConfigureAwait(false);
            return _connectionString;
        }
        finally
        {
            _resetGate.Release();
        }
    }

    public SqlSugarClient CreateClient() => PostgresSqlSugarTestClient.Create(ConnectionString);
}

public sealed class AnonymousCommentSubmitDatabaseFixture : PostgresClassDatabaseFixture
{
}

public sealed class ArticleRightsWritePathDatabaseFixture : PostgresClassDatabaseFixture
{
}

public sealed class ArticleDestructiveMutationDatabaseFixture : PostgresClassDatabaseFixture
{
}

public sealed class ArticleRevisionConcurrencyDatabaseFixture : PostgresClassDatabaseFixture
{
}

internal static class PostgresSqlSugarTestClient
{
    public static async Task<SqlSugarClient> CreateAsync(PostgresSchemaMigrationFixture fixture)
        => Create(await CreateConnectionStringAsync(fixture).ConfigureAwait(false));

    public static async Task<string> CreateConnectionStringAsync(PostgresSchemaMigrationFixture fixture)
    {
        string databaseName = await fixture.CreateDatabaseAsync().ConfigureAwait(false);
        return fixture.BuildDatabaseConnectionString(databaseName);
    }

    public static SqlSugarClient Create(string connectionString)
        => new(new ConnectionConfig
        {
            DbType = DbType.PostgreSQL,
            ConnectionString = SqlSugarInitializer.NormalizeConnectionString(connectionString),
            InitKeyType = InitKeyType.Attribute,
            IsAutoCloseConnection = true,
            MoreSettings = new ConnMoreSettings
            {
                PgSqlIsAutoToLower = true,
                PgSqlIsAutoToLowerCodeFirst = true
            }
        });

    public static void InitTables(SqlSugarClient db, params Type[] entityTypes)
        => db.CodeFirst.InitTables(entityTypes);
}

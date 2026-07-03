using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using SqlSugar;
using DbType = SqlSugar.DbType;

namespace FsusBlog.Server.Tests.TestInfrastructure;

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

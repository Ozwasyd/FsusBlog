using FsusBlog.Server.Infrastructure.Helpers.Initializer;

using Npgsql;

using SqlSugar;

using DbType = SqlSugar.DbType;
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

public sealed class SecurityFixtureDatabaseFixture : PostgresClassDatabaseFixture
{
}

internal static class PostgresSqlSugarTestClient
{
    public static async Task<SqlSugarClient> CreateAsync(PostgresSchemaMigrationFixture fixture)
        => Create(await CreateConnectionStringAsync(fixture).ConfigureAwait(false));

    public static async Task<string> CreateConnectionStringAsync(PostgresSchemaMigrationFixture fixture)
    {
        string databaseName = await fixture.CreateDatabaseAsync().ConfigureAwait(false);
        TestTemporalContext temporal = TestTemporalContext.FromEnvironment();
        return BindTemporalSessionOptions(
            fixture.BuildDatabaseConnectionString(databaseName),
            temporal);
    }

    public static SqlSugarClient Create(string connectionString)
    {
        TestTemporalContext temporal = TestTemporalContext.FromEnvironment();
        var client = new SqlSugarClient(new ConnectionConfig
        {
            DbType = DbType.PostgreSQL,
            ConnectionString = SqlSugarInitializer.NormalizeConnectionString(
                BindTemporalSessionOptions(connectionString, temporal)),
            InitKeyType = InitKeyType.Attribute,
            IsAutoCloseConnection = true,
            MoreSettings = new ConnMoreSettings
            {
                PgSqlIsAutoToLower = true,
                PgSqlIsAutoToLowerCodeFirst = true
            }
        });
        temporal.AssertRuntimeContext();
        client.Ado.Open();
        try
        {
            System.Data.DataTable observation = client.Ado.GetDataTable(
                """
                SELECT
                    current_setting('TimeZone') AS timezone,
                    current_setting('fsusblog.test_business_epoch_utc', true) AS business_epoch
                """);
            string timezone = Convert.ToString(
                observation.Rows[0]["timezone"],
                System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty;
            string epochRaw = Convert.ToString(
                observation.Rows[0]["business_epoch"],
                System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty;
            VerifyTemporalObservation(temporal, timezone, epochRaw);
        }
        finally
        {
            client.Ado.Close();
        }
        return client;
    }

    private static string BindTemporalSessionOptions(
        string connectionString,
        TestTemporalContext temporal)
    {
        var connection = new NpgsqlConnectionStringBuilder(connectionString);
        string options = connection.Options?.Trim() ?? string.Empty;
        if (options.Contains(temporal.PostgresSessionOptions, StringComparison.Ordinal))
        {
            return connection.ConnectionString;
        }
        bool declaresTemporalContext =
            options.Contains("timezone=", StringComparison.OrdinalIgnoreCase)
            || options.Contains(
                "fsusblog.test_business_epoch_utc=",
                StringComparison.OrdinalIgnoreCase);
        if (!declaresTemporalContext)
        {
            connection.Options = options.Length == 0
                ? temporal.PostgresSessionOptions
                : $"{options} {temporal.PostgresSessionOptions}";
        }
        return connection.ConnectionString;
    }

    internal static void VerifyTemporalObservation(
        TestTemporalContext temporal,
        string timezone,
        string epochRaw)
    {
        if (!string.Equals(timezone, temporal.PostgresTimezone, StringComparison.Ordinal)
            || !DateTimeOffset.TryParse(
                epochRaw,
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.RoundtripKind,
                out DateTimeOffset epoch)
            || epoch != temporal.BusinessEpochUtc)
        {
            throw new InvalidOperationException(
                "PostgreSQL session temporal context does not exact-match the backend plan.");
        }
    }

    public static void InitTables(SqlSugarClient db, params Type[] entityTypes)
    {
        db.CodeFirst.InitTables(entityTypes);
        bool taxonomy = entityTypes.Contains(typeof(FsusBlog.Server.Entities.Category))
            || entityTypes.Contains(typeof(FsusBlog.Server.Entities.Tag));
        bool locale = entityTypes.Contains(typeof(FsusBlog.Server.Entities.UserLocalePreference));
        if (taxonomy)
            db.CodeFirst.InitTables(typeof(FsusBlog.Server.Entities.Article), typeof(FsusBlog.Server.Entities.ArticleTag));
        if (taxonomy || locale || entityTypes.Contains(typeof(FsusBlog.Server.Entities.ArticleMutationOutboxEvent)))
        {
            db.CodeFirst.InitTables(
                typeof(FsusBlog.Server.Entities.ArticleSourceGeneration),
                typeof(FsusBlog.Server.Entities.ArticleSourceSequence),
                typeof(FsusBlog.Server.Entities.ArticleSourceMutation),
                typeof(FsusBlog.Server.Entities.ArticleSourceObservation));
        }
        if (taxonomy || locale)
        {
            var descriptors = new List<FsusBlog.Migration.ISchemaMigrationDescriptor>();
            if (taxonomy)
                descriptors.Add(FsusBlog.Migration.Definitions.TaxonomyMutationReceiptMigrationDefinitions.BuildMigration());
            if (locale)
                descriptors.Add(FsusBlog.Migration.Definitions.UserLocaleMutationReceiptMigrationDefinitions.BuildMigration());
            descriptors.Add(FsusBlog.Migration.Definitions.ArticleSourceReceiptOriginsMigrationDefinitions.BuildMigration());
            foreach (var descriptor in descriptors)
                foreach (var step in descriptor.Steps)
                    step.ExecuteAsync(db, CancellationToken.None).GetAwaiter().GetResult();
        }
    }
}

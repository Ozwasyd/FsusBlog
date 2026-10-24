using System.Data;

using Npgsql;

using Xunit;

using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Algorithms.Schema;

namespace FsusBlog.Migration.Tests;

public sealed class PgCurrentSchemaCatalogNotNullTests
{
    [Fact]
    public async Task PostgreSql18ControlNotNullFacts_PreserveTheOriginalCompleteProjection()
    {
        await using var fixture = await NativeFixture.CreateAsync();
        await using var connection = new NpgsqlConnection(fixture.ConnectionString);
        await connection.OpenAsync(fixture.Token);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, fixture.Token);
        await using var count = new NpgsqlCommand($"SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.{CurrentSchemaControlShape.ApplyJournalTableName}'::regclass AND contype = 'n';", connection, transaction);
        Assert.Equal(7L, Convert.ToInt64(await count.ExecuteScalarAsync(fixture.Token)));

        var observed = await PgCurrentSchemaCatalogObserver.ReadTableAsync(
            connection, transaction, CurrentSchemaControlShape.ApplyJournalTableName, fixture.Token);
        var effects = await PgCurrentSchemaEffectObserver.ReadAsync(connection, transaction, fixture.Token);
        Assert.Equal(7, observed.Tables[CurrentSchemaControlShape.ApplyJournalTableName].Columns.Count);
        Assert.Equal(4, observed.Tables[CurrentSchemaControlShape.ApplyJournalTableName].Constraints.Count);
        Assert.Equal(3, observed.Tables[CurrentSchemaControlShape.ApplyJournalTableName].IndexDefinitions.Count);
        Assert.Empty(PgCurrentSchemaControlShape.CompareApplyJournal(observed, effects));
    }

    [Theory]
    [InlineData("unvalidated")]
    [InlineData("deferrable")]
    [InlineData("initially-deferred")]
    [InlineData("unenforced")]
    [InlineData("no-inherit")]
    [InlineData("not-local")]
    [InlineData("inherited")]
    [InlineData("missing")]
    [InlineData("unknown")]
    public async Task PostgreSql18ControlNotNullDrift_IsRefusedByTheOriginalNativeObserver(string mutation)
    {
        await using var fixture = await NativeFixture.CreateAsync();
        await using var connection = new NpgsqlConnection(fixture.ConnectionString);
        await connection.OpenAsync(fixture.Token);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, fixture.Token);
        string statement = mutation switch
        {
            "unvalidated" => "UPDATE pg_constraint SET convalidated = FALSE",
            "deferrable" => "UPDATE pg_constraint SET condeferrable = TRUE",
            "initially-deferred" => "UPDATE pg_constraint SET condeferred = TRUE",
            "unenforced" => "UPDATE pg_constraint SET conenforced = FALSE",
            "no-inherit" => "UPDATE pg_constraint SET connoinherit = TRUE",
            "not-local" => "UPDATE pg_constraint SET conislocal = FALSE",
            "inherited" => "UPDATE pg_constraint SET coninhcount = 1",
            "missing" => "DELETE FROM pg_constraint",
            "unknown" => "UPDATE pg_constraint SET contype = 'z'",
            _ => throw new InvalidOperationException("Unknown native NOT NULL mutation.")
        };
        await using var tamper = new NpgsqlCommand($"{statement} WHERE conrelid = 'public.{CurrentSchemaControlShape.ApplyJournalTableName}'::regclass AND contype = 'n' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.{CurrentSchemaControlShape.ApplyJournalTableName}'::regclass AND attname = 'entry_payload')]::smallint[];", connection, transaction);
        Assert.Equal(1, await tamper.ExecuteNonQueryAsync(fixture.Token));

        InvalidOperationException refusal = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            PgCurrentSchemaCatalogObserver.ReadTableAsync(
                connection, transaction, CurrentSchemaControlShape.ApplyJournalTableName, fixture.Token));
        Assert.Equal(mutation == "unknown"
            ? "Unsupported PostgreSQL current schema constraint type: z."
            : "current_schema_control_not_null_constraint_unavailable", refusal.Message);
    }

    private sealed class NativeFixture : IAsyncDisposable
    {
        private const string Admin = "Host=127.0.0.1;Port=5432;Username=fsusblog;Password=fsusblog_dev;Database=postgres;Pooling=false;SSL Mode=Disable";
        private readonly CancellationTokenSource _deadline = new(TimeSpan.FromSeconds(40));
        private readonly string _database = "native_not_null_contract_" + Guid.NewGuid().ToString("N");

        internal string ConnectionString => new NpgsqlConnectionStringBuilder(Admin) { Database = _database }.ConnectionString;
        internal CancellationToken Token => _deadline.Token;

        internal static async Task<NativeFixture> CreateAsync()
        {
            var fixture = new NativeFixture();
            try
            {
                await using var admin = new NpgsqlConnection(Admin);
                await admin.OpenAsync(fixture.Token);
                await using var create = new NpgsqlCommand($"CREATE DATABASE \"{fixture._database}\";", admin);
                await create.ExecuteNonQueryAsync(fixture.Token);
                await using var connection = new NpgsqlConnection(fixture.ConnectionString);
                await connection.OpenAsync(fixture.Token);
                Assert.True(connection.PostgreSqlVersion.Major >= 18, "This native control requires original PostgreSQL 18 NOT NULL catalog facts.");
                await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, fixture.Token);
                await PgCurrentSchemaControlShape.EnsureApplyJournalAsync(connection, transaction, fixture.Token);
                await transaction.CommitAsync(fixture.Token);
                return fixture;
            }
            catch
            {
                await fixture.DisposeAsync();
                throw;
            }
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                await using var admin = new NpgsqlConnection(Admin);
                await admin.OpenAsync(cleanup.Token);
                await using var drop = new NpgsqlCommand($"DROP DATABASE IF EXISTS \"{_database}\" WITH (FORCE);", admin);
                await drop.ExecuteNonQueryAsync(cleanup.Token);
            }
            finally
            {
                _deadline.Dispose();
            }
        }
    }
}

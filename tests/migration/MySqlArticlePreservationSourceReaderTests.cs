using System.Data;
using System.Data.Common;

using FsusBlog.Contracts.Migration;

using MySqlConnector;

using Xunit;

namespace FsusBlog.Migration.Tests;

// Shape/refusal controls only. Fake DB objects never pass MySQL native admission;
// these tests do not claim successful server observation or provider qualification.
public sealed class MySqlArticlePreservationSourceReaderTests
{
    private static readonly CurrentSchemaArtifactReference s_origin = new("fixture://original-source", new string('a', 64));
    private static readonly Uri s_documentBase = new("https://source.example/article/1");
    private static readonly ArticlePreservationLimits s_limits = new(10, 20, 1_000_000);

    [Theory]
    [InlineData(IsolationLevel.Snapshot)]
    [InlineData(IsolationLevel.RepeatableRead)]
    [InlineData(IsolationLevel.Serializable)]
    [InlineData(IsolationLevel.ReadCommitted)]
    public async Task A_provider_or_isolation_label_cannot_replace_the_original_mysql_native_session(IsolationLevel isolation)
    {
        using var connection = new LabelConnection();
        using var transaction = new LabelTransaction(connection, isolation);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
            () => MySqlArticlePreservationSourceReader.ReadBorrowedAsync(connection, transaction,
                s_origin, s_documentBase, s_limits, TimeSpan.FromSeconds(1), default));
        Assert.Equal("article_preservation_consistent_source_session_required", failure.Message);
        Assert.Equal(0, connection.CommandsCreated);
        Assert.Equal(0, transaction.Mutations);
        Assert.Same(connection, transaction.Connection);
        Assert.Equal(isolation, transaction.IsolationLevel);
    }

    [Fact]
    public void A_real_closed_driver_without_its_original_transaction_cannot_grant_a_read()
    {
        using var connection = new MySqlConnection();
        using var transaction = new LabelTransaction(connection, IsolationLevel.Snapshot);
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationSourceReader.RequireReadSession(
            CurrentSchemaProviderKind.MySql, connection, transaction));
        Assert.Equal(ConnectionState.Closed, connection.State);
        Assert.Equal(0, transaction.Mutations);
    }

    [Theory]
    [InlineData(CurrentSchemaProviderKind.PostgreSql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public void Snapshot_exception_does_not_expand_the_original_other_provider_shape_gate(CurrentSchemaProviderKind provider)
    {
        using var connection = new LabelConnection();
        using var snapshot = new LabelTransaction(connection, IsolationLevel.Snapshot);
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationSourceReader.RequireReadSession(provider, connection, snapshot));
        using var repeatable = new LabelTransaction(connection, IsolationLevel.RepeatableRead);
        using var serializable = new LabelTransaction(connection, IsolationLevel.Serializable);
        // Existing generic shape checks are unchanged. Only the original observer
        // can subsequently admit an actual native source; these objects cannot.
        ArticlePreservationSourceReader.RequireReadSession(provider, connection, repeatable);
        ArticlePreservationSourceReader.RequireReadSession(provider, connection, serializable);
        Assert.Equal(0, connection.CommandsCreated);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Closed_or_changed_borrowed_connections_are_refused_without_modifying_the_caller(bool changed)
    {
        using var connection = new LabelConnection(changed ? ConnectionState.Open : ConnectionState.Closed);
        using var other = new LabelConnection();
        using var transaction = new LabelTransaction(changed ? other : connection, IsolationLevel.Snapshot);
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationSourceReader.RequireReadSession(
            CurrentSchemaProviderKind.MySql, connection, transaction));
        Assert.Equal(0, connection.CommandsCreated);
        Assert.Equal(0, other.CommandsCreated);
        Assert.Equal(0, transaction.Mutations);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(long.MaxValue)]
    public async Task Missing_or_unbounded_budget_refuses_before_the_original_native_open(long ticks)
    {
        ArgumentOutOfRangeException failure = await Assert.ThrowsAsync<ArgumentOutOfRangeException>(
            () => MySqlArticlePreservationSourceReader.ReadAsync("not-a-driver-connection-string", s_origin,
                s_documentBase, s_limits, TimeSpan.FromTicks(ticks), default));
        Assert.Equal("readBudget", failure.ParamName);
    }

    [Theory]
    [InlineData("origin")]
    [InlineData("digest")]
    [InlineData("base")]
    public async Task Missing_original_source_inputs_do_not_open_a_native_session_or_fabricate_defaults(string missing)
    {
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
            () => MySqlArticlePreservationSourceReader.ReadAsync("not-a-driver-connection-string",
                missing == "origin" ? null! : missing == "digest" ? s_origin with { Sha256 = "missing" } : s_origin,
                missing == "base" ? new Uri("/article/1", UriKind.Relative) : s_documentBase,
                s_limits, TimeSpan.FromSeconds(1), default));
        Assert.Equal("article_preservation_source_origin_required", failure.Message);
    }

    [Fact]
    public async Task Original_cancellation_is_preserved_before_driver_parsing_or_any_capture()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => MySqlArticlePreservationSourceReader.ReadAsync(
            "not-a-driver-connection-string", s_origin, s_documentBase, s_limits,
            TimeSpan.FromSeconds(1), cancellation.Token));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" ")]
    public async Task Missing_original_secret_input_is_refused_by_the_existing_resource_owner(string? connectionString)
    {
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
            () => MySqlArticlePreservationSourceReader.ReadAsync(connectionString!, s_origin, s_documentBase,
                s_limits, TimeSpan.FromSeconds(1), default));
        Assert.Equal("offline_source_native_operation_context_required", failure.Message);
    }

    [Fact]
    public async Task Invalid_driver_settings_cannot_escape_as_credential_or_driver_error_payload()
    {
        const string secret = "source-reader-private-fixture";
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
            () => MySqlArticlePreservationSourceReader.ReadAsync(
                "Password=" + secret + ";UnsupportedNativeSessionFixtureOption=1", s_origin,
                s_documentBase, s_limits, TimeSpan.FromSeconds(1), default));
        Assert.Equal("offline_source_mysql_native_operation_failed", failure.Message);
        Assert.DoesNotContain(secret, failure.Message);
        Assert.Null(failure.InnerException);
    }

    private sealed class LabelConnection(ConnectionState state = ConnectionState.Open) : DbConnection
    {
        internal int CommandsCreated { get; private set; }
        [System.Diagnostics.CodeAnalysis.AllowNull]
        public override string ConnectionString { get; set; } = string.Empty;
        public override string Database => "caller-label-not-authority";
        public override string DataSource => "caller-label-not-authority";
        public override string ServerVersion => "unit";
        public override ConnectionState State => state;
        public override void ChangeDatabase(string databaseName) => throw new NotSupportedException();
        public override void Close() { }
        public override void Open() => throw new NotSupportedException();
        protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel) => throw new NotSupportedException();
        protected override DbCommand CreateDbCommand()
        {
            CommandsCreated++;
            throw new NotSupportedException("A label fixture cannot create native observation commands.");
        }
    }

    private sealed class LabelTransaction(DbConnection connection, IsolationLevel isolation) : DbTransaction
    {
        internal int Mutations { get; private set; }
        public override IsolationLevel IsolationLevel => isolation;
        protected override DbConnection DbConnection => connection;
        public override void Commit() { Mutations++; throw new NotSupportedException(); }
        public override void Rollback() { Mutations++; throw new NotSupportedException(); }
    }
}

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
    public async Task AProviderOrIsolationLabelCannotReplaceTheOriginalMysqlNativeSession(IsolationLevel isolation)
    {
        using var connection = new LabelConnection();
        using var transaction = new LabelTransaction(connection, isolation);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ArticlePreservationSourceReader.ReadAsync(CurrentSchemaProviderKind.MySql, connection, transaction,
                new OfflineMigrationSourceObserver(),
                s_origin, s_documentBase, s_limits, TimeSpan.FromSeconds(1), default));
        Assert.Equal("article_preservation_consistent_source_session_required", failure.Message);
        Assert.Equal(0, connection.CommandsCreated);
        Assert.Equal(0, transaction.Mutations);
        Assert.Same(connection, transaction.Connection);
        Assert.Equal(isolation, transaction.IsolationLevel);
    }

    [Fact]
    public void ARealClosedDriverWithoutItsOriginalTransactionCannotGrantARead()
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
    public void SnapshotExceptionDoesNotExpandTheOriginalOtherProviderShapeGate(CurrentSchemaProviderKind provider)
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
    public void ClosedOrChangedBorrowedConnectionsAreRefusedWithoutModifyingTheCaller(bool changed)
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
    public async Task MissingOrUnboundedBudgetRefusesBeforeTheOriginalNativeOpen(long ticks)
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
    public async Task MissingOriginalSourceInputsDoNotOpenANativeSessionOrFabricateDefaults(string missing)
    {
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
            () => MySqlArticlePreservationSourceReader.ReadAsync("not-a-driver-connection-string",
                missing == "origin" ? null! : missing == "digest" ? s_origin with
                {
                    Sha256 = "missing"
                } : s_origin,
                missing == "base" ? new Uri("/article/1", UriKind.Relative) : s_documentBase,
                s_limits, TimeSpan.FromSeconds(1), default));
        Assert.Equal("article_preservation_source_origin_required", failure.Message);
    }

    [Fact]
    public async Task OriginalCancellationIsPreservedBeforeDriverParsingOrAnyCapture()
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
    public async Task MissingOriginalSecretInputIsRefusedByTheExistingResourceOwner(string? connectionString)
    {
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
            () => MySqlArticlePreservationSourceReader.ReadAsync(connectionString!, s_origin, s_documentBase,
                s_limits, TimeSpan.FromSeconds(1), default));
        Assert.Equal("offline_source_native_operation_context_required", failure.Message);
    }

    [Fact]
    public async Task InvalidDriverSettingsCannotEscapeAsCredentialOrDriverErrorPayload()
    {
        const string Secret = "source-reader-private-fixture";
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
            () => MySqlArticlePreservationSourceReader.ReadAsync(
                "Password=" + Secret + ";UnsupportedNativeSessionFixtureOption=1", s_origin,
                s_documentBase, s_limits, TimeSpan.FromSeconds(1), default));
        Assert.Equal("offline_source_mysql_native_operation_failed", failure.Message);
        Assert.DoesNotContain(Secret, failure.Message);
        Assert.Null(failure.InnerException);
    }

    [Fact]
    public async Task MissingOriginalRunOwnedContextCannotGrantABorrowedRead()
    {
        ArgumentNullException failure = await Assert.ThrowsAsync<ArgumentNullException>(
            () => MySqlArticlePreservationSourceReader.ReadBorrowedAsync(null!, s_origin,
                s_documentBase, s_limits, TimeSpan.FromSeconds(1), default));
        Assert.Equal("originalRead", failure.ParamName);
    }

    [Fact]
    public async Task MissingLimitsRefuseBeforeTheOriginalNativeOpen()
    {
        ArgumentNullException failure = await Assert.ThrowsAsync<ArgumentNullException>(
            () => MySqlArticlePreservationSourceReader.ReadAsync("not-a-driver-connection-string", s_origin,
                s_documentBase, null!, TimeSpan.FromSeconds(1), default));
        Assert.Equal("limits", failure.ParamName);
    }

    [Theory]
    [InlineData(0, 20, 1_000_000)]
    [InlineData(-1, 20, 1_000_000)]
    [InlineData(10, 0, 1_000_000)]
    [InlineData(10, -1, 1_000_000)]
    [InlineData(10, 20, 0)]
    [InlineData(10, 20, -1)]
    public async Task InvalidFiniteLimitsRefuseBeforeDriverParsing(int articles, int taxonomy, long metadata)
    {
        ArgumentOutOfRangeException failure = await Assert.ThrowsAsync<ArgumentOutOfRangeException>(
            () => MySqlArticlePreservationSourceReader.ReadAsync("not-a-driver-connection-string", s_origin,
                s_documentBase, new ArticlePreservationLimits(articles, taxonomy, metadata), TimeSpan.FromSeconds(1), default));
        Assert.Equal("readBudget", failure.ParamName);
    }

    [Fact]
    public void CallerOwnedKeyCannotMintTheNativeReadContext()
    {
        using var cancellation = new CancellationTokenSource();
        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(
            () => new OfflineMigrationMySqlNativeSession.OwnedReadContext(new object(), null!, null!, null!, cancellation.Token));
        Assert.Equal("offline_source_mysql_original_owned_context_required", failure.Message);
    }

    private sealed class LabelConnection(ConnectionState state = ConnectionState.Open) : DbConnection
    {
        internal int CommandsCreated
        {
            get; private set;
        }
        [System.Diagnostics.CodeAnalysis.AllowNull]
        public override string ConnectionString { get; set; } = string.Empty;
        public override string Database => "caller-label-not-authority";
        public override string DataSource => "caller-label-not-authority";
        public override string ServerVersion => "unit";
        public override ConnectionState State => state;
        public override void ChangeDatabase(string databaseName) => throw new NotSupportedException();
        public override void Close()
        {
        }
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
        internal int Mutations
        {
            get; private set;
        }
        public override IsolationLevel IsolationLevel => isolation;
        protected override DbConnection DbConnection => connection;
        public override void Commit()
        {
            Mutations++;
            throw new NotSupportedException();
        }
        public override void Rollback()
        {
            Mutations++;
            throw new NotSupportedException();
        }
    }
}

using System.Data;
using System.Data.Common;

using FsusBlog.Contracts.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

// Admission-only controls: these do not substitute for actual native source-reader integration.
public sealed class ArticlePreservationSourceReaderTests
{
    private static readonly CurrentSchemaArtifactReference s_origin = new("fixture://source-origin", new string('a', 64));
    private static readonly Uri s_documentBase = new("https://source.example/article/1");
    private static readonly ArticlePreservationLimits s_limits = new(10, 20, 1_000_000);

    [Theory]
    [InlineData(IsolationLevel.ReadCommitted)]
    [InlineData(IsolationLevel.ReadUncommitted)]
    [InlineData(IsolationLevel.Snapshot)]
    public async Task SourceReader_RejectsAnInconsistentTransactionBeforeReadingWithoutChangingCallerState(IsolationLevel isolation)
    {
        using var connection = new AdmissionConnection();
        using var transaction = new AdmissionTransaction(connection, isolation);
        await Assert.ThrowsAsync<InvalidOperationException>(() => Read(connection, transaction));
        Assert.Equal(0, connection.CommandsCreated);
        Assert.Equal(isolation, transaction.IsolationLevel);
        Assert.Equal(0, transaction.Mutations);
        Assert.Same(connection, transaction.Connection);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SourceReader_RejectsClosedOrDifferentConnectionsBeforeReading(bool differentConnection)
    {
        using var connection = new AdmissionConnection(differentConnection ? ConnectionState.Open : ConnectionState.Closed);
        using var other = new AdmissionConnection();
        using var transaction = new AdmissionTransaction(differentConnection ? other : connection, IsolationLevel.RepeatableRead);
        await Assert.ThrowsAsync<InvalidOperationException>(() => Read(connection, transaction));
        Assert.Equal(0, connection.CommandsCreated);
        Assert.Equal(0, other.CommandsCreated);
        Assert.Equal(0, transaction.Mutations);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(long.MaxValue)]
    public async Task SourceReader_RejectsMissingNegativeOrNonFiniteBudgetsBeforeReading(long ticks)
    {
        using var connection = new AdmissionConnection();
        using var transaction = new AdmissionTransaction(connection, IsolationLevel.Serializable);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => ArticlePreservationSourceReader.ReadAsync(
            CurrentSchemaProviderKind.PostgreSql, connection, transaction, new(), s_origin, s_documentBase,
            s_limits, TimeSpan.FromTicks(ticks), default));
        Assert.Equal(0, connection.CommandsCreated);
        Assert.Equal(0, transaction.Mutations);
    }

    [Fact]
    public async Task SourceReader_CancelledRequestCannotStartObservation()
    {
        using var connection = new AdmissionConnection();
        using var transaction = new AdmissionTransaction(connection, IsolationLevel.RepeatableRead);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ArticlePreservationSourceReader.ReadAsync(
            CurrentSchemaProviderKind.PostgreSql, connection, transaction, new(), s_origin, s_documentBase,
            s_limits, TimeSpan.FromSeconds(1), cancellation.Token));
        Assert.Equal(0, connection.CommandsCreated);
        Assert.Equal(0, transaction.Mutations);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SourceReader_RejectsMissingOriginFactsInsteadOfFabricatingAProductionBaseUrl(bool relativeBase)
    {
        using var connection = new AdmissionConnection();
        using var transaction = new AdmissionTransaction(connection, IsolationLevel.RepeatableRead);
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationSourceReader.ReadAsync(
            CurrentSchemaProviderKind.PostgreSql, connection, transaction, new(),
            relativeBase ? s_origin : s_origin with
            {
                Sha256 = "missing"
            },
            relativeBase ? new Uri("/article/1", UriKind.Relative) : s_documentBase,
            s_limits, TimeSpan.FromSeconds(1), default));
        Assert.Equal(0, connection.CommandsCreated);
    }

    [Fact]
    public async Task SourceReader_ValidSessionShapeDoesNotSubstituteForTheOriginalNativeObserver()
    {
        using var connection = new AdmissionConnection();
        using var transaction = new AdmissionTransaction(connection, IsolationLevel.Serializable);
        InvalidOperationException refusal = await Assert.ThrowsAsync<InvalidOperationException>(() => Read(connection, transaction));
        Assert.Equal("offline_source_native_streaming_driver_required", refusal.Message);
        Assert.Equal(0, connection.CommandsCreated);
        Assert.Equal(0, transaction.Mutations);
    }

    private static Task<ArticlePreservationSourceReadResult> Read(DbConnection connection, DbTransaction transaction)
        => ArticlePreservationSourceReader.ReadAsync(CurrentSchemaProviderKind.PostgreSql, connection,
            transaction, new(), s_origin, s_documentBase, s_limits, TimeSpan.FromSeconds(1), default);

    private sealed class AdmissionConnection(ConnectionState state = ConnectionState.Open) : DbConnection
    {
        internal int CommandsCreated
        {
            get; private set;
        }
        [System.Diagnostics.CodeAnalysis.AllowNull]
        public override string ConnectionString { get; set; } = string.Empty;
        public override string Database => "unit";
        public override string DataSource => "unit";
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
            throw new NotSupportedException("Admission controls must stop before a database command.");
        }
    }

    private sealed class AdmissionTransaction(DbConnection connection, IsolationLevel isolation) : DbTransaction
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

using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Tests.Unit;
using FsusBlog.Shared.Contracts.ArticleVault;

using Npgsql;

using NSubstitute;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleVaultOperationCheckpointPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task CompetingProcesses_ReplaySameCheckpointAndReadOnlyExactNamedHistory()
    {
        await using NpgsqlDataSource dataSource = await CreateStoreDatabaseAsync();
        IArticleVaultExecutionStore executorStore = Substitute.For<IArticleVaultExecutionStore>();
        var first = new PostgresArticleVaultOperationCheckpointStore(dataSource, executorStore, new FixtureTimeProvider());
        var second = new PostgresArticleVaultOperationCheckpointStore(dataSource, executorStore, new FixtureTimeProvider());
        ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
        await Task.WhenAll(first.RegisterAsync(identity, plan), second.RegisterAsync(identity, plan));
        ArticleVaultOperationCheckpoint planned = ArticleVaultOperationFixture.Checkpoint(identity, plan);
        await Task.WhenAll(first.AppendAsync(identity, plan, planned), second.AppendAsync(identity, plan, planned));
        ArticleVaultOperationCheckpoint validating = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, planned, VaultOperationState.Validating);
        await second.AppendAsync(identity, plan, validating);

        var restarted = new PostgresArticleVaultOperationCheckpointStore(dataSource, executorStore, new FixtureTimeProvider());
        Assert.Single(await restarted.ReadThroughAsync(identity, plan, 0, planned.ContentSha256));
        Assert.Equal(2, (await restarted.ReadThroughAsync(identity, plan, 1, validating.ContentSha256)).Count);
        await Assert.ThrowsAsync<InvalidDataException>(() => restarted.ReadThroughAsync(identity, plan, 1, planned.ContentSha256));
        await Assert.ThrowsAsync<InvalidDataException>(() => restarted.AppendAsync(identity, plan,
            ArticleVaultOperationFixture.Seal(validating with { RecordedAtUnixMs = validating.RecordedAtUnixMs + 1 })));

        ArticleVaultOperationIdentity changedDeadline = ArticleVaultOperationVerifier.Bind(
            plan, identity.AgentIdentity, identity.RequestSha256, identity.IdempotencySha256, identity.DeadlineUnixMs - 1);
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => restarted.RegisterAsync(changedDeadline, plan));
        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync();
        await using var count = new NpgsqlCommand("SELECT count(*) FROM article_vault_operation_checkpoint", connection);
        Assert.Equal(2L, await count.ExecuteScalarAsync());
        Assert.Empty(executorStore.ReceivedCalls());
    }

    [Fact]
    public async Task ImmutableTriggers_RejectUpdateAndDeleteOfIdentityAndCheckpoints()
    {
        await using NpgsqlDataSource dataSource = await CreateStoreDatabaseAsync();
        var store = new PostgresArticleVaultOperationCheckpointStore(dataSource, Substitute.For<IArticleVaultExecutionStore>(), new FixtureTimeProvider());
        ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
        await store.RegisterAsync(identity, plan);
        ArticleVaultOperationCheckpoint planned = ArticleVaultOperationFixture.Checkpoint(identity, plan);
        await store.AppendAsync(identity, plan, planned);
        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync();
        foreach (string table in new[] { "article_vault_operation_identity", "article_vault_operation_checkpoint" })
        {
            foreach (string sql in new[] { $"DELETE FROM {table}", $"UPDATE {table} SET operation_identity = operation_identity" })
            {
                await using var command = new NpgsqlCommand(sql, connection);
                PostgresException exception = await Assert.ThrowsAsync<PostgresException>(() => command.ExecuteNonQueryAsync());
                Assert.Equal("P0001", exception.SqlState);
            }
        }

        Assert.Single(await store.ReadThroughAsync(identity, plan, 0, planned.ContentSha256));
    }

    [Fact]
    public async Task CurrentClockExpiry_CannotBeBypassedByBackdatingCheckpoint()
    {
        await using NpgsqlDataSource dataSource = await CreateStoreDatabaseAsync();
        var clock = new FixtureTimeProvider();
        var store = new PostgresArticleVaultOperationCheckpointStore(dataSource, Substitute.For<IArticleVaultExecutionStore>(), clock);
        ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
        await store.RegisterAsync(identity, plan);
        ArticleVaultOperationCheckpoint planned = ArticleVaultOperationFixture.Checkpoint(identity, plan);
        await store.AppendAsync(identity, plan, planned);
        ArticleVaultOperationCheckpoint validating = ArticleVaultOperationFixture.Checkpoint(identity, plan, planned, VaultOperationState.Validating);
        await store.AppendAsync(identity, plan, validating);
        clock.NowUnixMs = identity.DeadlineUnixMs + 1;
        await store.RegisterAsync(identity, plan);
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => store.AppendAsync(identity, plan,
            ArticleVaultOperationFixture.Checkpoint(identity, plan, validating, VaultOperationState.ExecutingServer,
                VaultServerCommitDisposition.Unknown)));
        ArticleVaultOperationCheckpoint cancelled = ArticleVaultOperationFixture.Checkpoint(identity, plan, validating,
            VaultOperationState.Cancelled, reason: "operation_expired", time: clock.NowUnixMs);
        await store.AppendAsync(identity, plan, cancelled);
        Assert.Equal(3, (await store.ReadThroughAsync(identity, plan, cancelled.Sequence, cancelled.ContentSha256)).Count);
    }

    [Fact]
    public async Task AcceptedCheckpoint_ConsumesCanonicalExactResultAndRejectsTamperedReference()
    {
        await using NpgsqlDataSource dataSource = await CreateStoreDatabaseAsync();
        ArticleVaultSealedExecutionBundle bundle = ArticleVaultOperationFixture.Bundle("body\r\n"u8.ToArray());
        ArticleVaultExecutionResult result = ArticleVaultOperationFixture.NoOpResult(bundle);
        IArticleVaultExecutionStore executorStore = Substitute.For<IArticleVaultExecutionStore>();
        executorStore.LoadSealedAsync(bundle.PlanReference, bundle.PlanSha256, Arg.Any<CancellationToken>()).Returns(bundle);
        executorStore.LoadResultAsync(result.ResultReference, Arg.Any<CancellationToken>()).Returns(result);
        var store = new PostgresArticleVaultOperationCheckpointStore(dataSource, executorStore, new FixtureTimeProvider());
        ArticleVaultSyncPlan plan = bundle.Plan;
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
        await store.RegisterAsync(identity, plan);
        ArticleVaultOperationCheckpoint planned = ArticleVaultOperationFixture.Checkpoint(identity, plan);
        ArticleVaultOperationCheckpoint validating = ArticleVaultOperationFixture.Checkpoint(identity, plan, planned, VaultOperationState.Validating);
        ArticleVaultOperationCheckpoint executing = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, validating, VaultOperationState.ExecutingServer, VaultServerCommitDisposition.Unknown);
        await store.AppendAsync(identity, plan, planned);
        await store.AppendAsync(identity, plan, validating);
        await store.AppendAsync(identity, plan, executing);
        ArticleVaultOperationCheckpoint materializing = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, executing, VaultOperationState.MaterializingLocal, VaultServerCommitDisposition.Accepted,
            new VaultOperationStageReference(result.ResultReference, result.ContentSha256));
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => store.AppendAsync(identity, plan,
            ArticleVaultOperationFixture.Seal(materializing with
            {
                ServerResult = materializing.ServerResult! with { ContentSha256 = ArticleVaultOperationFixture.DigestA }
            })));
        await store.AppendAsync(identity, plan, materializing);
        Assert.Equal(4, (await store.ReadThroughAsync(identity, plan, materializing.Sequence, materializing.ContentSha256)).Count);
        await Assert.ThrowsAsync<InvalidDataException>(() => store.AppendAsync(identity, plan,
            ArticleVaultOperationFixture.Checkpoint(identity, plan, materializing, VaultOperationState.Synced,
                VaultServerCommitDisposition.Accepted, materializing.ServerResult)));
    }

    private async Task<NpgsqlDataSource> CreateStoreDatabaseAsync()
    {
        string database = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(database);
        ISchemaMigrationDescriptor descriptor = ArticleVaultOperationMigrationDefinitions.BuildMigration();
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
        foreach (RawSqlStep step in descriptor.Steps.Cast<RawSqlStep>())
        {
            await using var command = new NpgsqlCommand(step.Sql, connection, transaction);
            await command.ExecuteNonQueryAsync();
        }

        await transaction.CommitAsync();
        return NpgsqlDataSource.Create(connectionString);
    }

    private sealed class FixtureTimeProvider : TimeProvider
    {
        internal long NowUnixMs { get; set; } = 1_800_000_000_100;

        public override DateTimeOffset GetUtcNow() => DateTimeOffset.FromUnixTimeMilliseconds(NowUnixMs);
    }
}

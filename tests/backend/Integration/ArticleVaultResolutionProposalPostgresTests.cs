using System.Text;

using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleVault;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleVaultResolutionProposalPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task ConcurrentDuplicateSeal_ReopenAndNewDecisionRetainExactHistory()
    {
        await using Database database = await CreateAsync();
        ArticleVaultResolutionPlan proposal = Build(database.Input);
        await Task.WhenAll(Enumerable.Range(0, 8).Select(async _ =>
        {
            using SqlSugarClient db = PostgresSqlSugarTestClient.Create(database.ConnectionString);
            var store = new PostgresArticleVaultResolutionProposalStore(database.Source,
                new PostgresArticleVaultExecutionStore(db, database.Clock), database.Clock);
            await store.SealAsync(proposal, database.Input);
        }));
        ArticleVaultResolutionPlanInput cancelled = database.Input with
        {
            Decisions = [new(VaultConflictType.MetadataDisjoint, VaultConflictAction.CancelOperation, VaultConflictDisposition.Automatic, null)]
        };
        ArticleVaultResolutionPlan second = Build(cancelled);
        await database.Store.SealAsync(second, cancelled);
        await using NpgsqlDataSource reopened = NpgsqlDataSource.Create(database.ConnectionString);
        var reopenedStore = new PostgresArticleVaultResolutionProposalStore(reopened, database.ExecutionStore, database.Clock);
        Assert.Equal(proposal.ContentSha256, (await reopenedStore.ReadExactAsync(proposal.ResolutionOperationIdentity, proposal.ContentSha256))!.ContentSha256);
        Assert.Equal(second.ContentSha256, (await reopenedStore.ReadExactAsync(second.ResolutionOperationIdentity, second.ContentSha256))!.ContentSha256);
        Assert.Equal(2, await CountAsync(database));
        Assert.Equal(VaultSyncPlanStatus.Blocked, database.Input.Metadata.Plan.Status);
        Assert.Equal("article_vault_resolution_canonical_execution_admission_missing",
            ArticleVaultResolutionPlanner.RequireExecutionAdmission(proposal, database.Input).ReasonCode);
        Assert.Equal(0, await CountResultsAsync(database));
    }

    [Fact]
    public async Task ActualSchema_RejectsUpdateDeleteAndTruncateAndRetainsOriginalBytes()
    {
        await using Database database = await CreateAsync();
        ArticleVaultResolutionPlan proposal = Build(database.Input);
        await database.Store.SealAsync(proposal, database.Input);
        foreach (string sql in new[]
        {
            "UPDATE article_vault_resolution_proposal SET proposal_bytes = proposal_bytes",
            "DELETE FROM article_vault_resolution_proposal",
            "TRUNCATE article_vault_resolution_proposal"
        })
        {
            await using NpgsqlConnection connection = await database.Source.OpenConnectionAsync();
            await using var command = new NpgsqlCommand(sql, connection);
            PostgresException error = await Assert.ThrowsAsync<PostgresException>(() => command.ExecuteNonQueryAsync());
            Assert.Equal(PostgresErrorCodes.RaiseException, error.SqlState);
            Assert.Equal("article_vault_resolution_proposal_immutable", error.MessageText);
        }
        Assert.Equal(proposal.ContentSha256, (await database.Store.ReadExactAsync(proposal.ResolutionOperationIdentity, proposal.ContentSha256))!.ContentSha256);
        Assert.Equal(1, await CountAsync(database));
    }

    [Fact]
    public async Task StaleCurrentInputAndExpiredClock_RefuseWithoutLosingHistoricalProposal()
    {
        await using Database database = await CreateAsync();
        ArticleVaultResolutionPlan proposal = Build(database.Input);
        ArticleVaultResolutionPlanInput altered = database.Input with
        {
            Confirmation = database.Input.Confirmation with
            {
                ActorIdentity = "another-actor"
            }
        };
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => database.Store.SealAsync(proposal, altered));
        Assert.Equal(0, await CountAsync(database));
        await database.Store.SealAsync(proposal, database.Input);
        database.Clock.Now = DateTimeOffset.FromUnixTimeMilliseconds(proposal.ExpiresAtUnixMs + 1);
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => database.Store.SealAsync(proposal, database.Input));
        Assert.Equal(proposal.ContentSha256, (await database.Store.ReadExactAsync(proposal.ResolutionOperationIdentity, proposal.ContentSha256))!.ContentSha256);
        Assert.Equal(1, await CountAsync(database));
    }

    [Fact]
    public async Task ConflictingStoredIdentity_IsNeverOverwrittenByReplay()
    {
        await using Database database = await CreateAsync();
        ArticleVaultResolutionPlan proposal = Build(database.Input);
        string conflictingDigest = new('b', 64);
        await InsertAsync(database, proposal, conflictingDigest, ArticleVaultResolutionPlanner.Serialize(proposal));
        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(
            () => database.Store.SealAsync(proposal, database.Input));
        Assert.Equal("article_vault_resolution_proposal_append_conflict", error.Message);
        Assert.Null(await database.Store.ReadExactAsync(proposal.ResolutionOperationIdentity, proposal.ContentSha256));
        Assert.Equal(1, await CountAsync(database));
    }

    [Fact]
    public async Task MalformedBytesAndUnknownPayload_AreRefusedOnExactRead()
    {
        foreach (bool unknownField in new[] { false, true })
        {
            await using Database database = await CreateAsync();
            ArticleVaultResolutionPlan proposal = Build(database.Input);
            string json = Encoding.UTF8.GetString(ArticleVaultResolutionPlanner.Serialize(proposal));
            byte[] bytes = unknownField ? Encoding.UTF8.GetBytes(json[..^1] + ",\"writer\":\"arbitrary\"}") : "malformed"u8.ToArray();
            await InsertAsync(database, proposal, proposal.ContentSha256, bytes);
            await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => database.Store.ReadExactAsync(proposal.ResolutionOperationIdentity, proposal.ContentSha256));
        }
    }

    [Fact]
    public async Task MissingOriginalPlanAndNonExactReference_RefuseBeforeProposalWrite()
    {
        await using Database database = await CreateAsync(sealOriginal: false);
        ArticleVaultResolutionPlan proposal = Build(database.Input);
        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(
            () => database.Store.SealAsync(proposal, database.Input));
        Assert.Equal("article_vault_resolution_proposal_original_plan_missing", error.Message);
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => database.Store.ReadExactAsync("latest", proposal.ContentSha256));
        Assert.Equal(0, await CountAsync(database));
    }

    private async Task<Database> CreateAsync(bool sealOriginal = true)
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        string[] ddl = ArticleVaultExecutionMigrationDefinitions.BuildMigration().Steps
            .Concat(ArticleVaultResolutionProposalMigrationDefinitions.BuildMigration().Steps)
            .OfType<RawSqlStep>().Select(static step => step.Sql).ToArray();
        await fixture.ExecuteAsync(connectionString, string.Join('\n', ddl));
        SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        var clock = new ProposalClock();
        var execution = new PostgresArticleVaultExecutionStore(db, clock);
        ArticleVaultResolutionPlanInput input = ArticleVaultResolutionProposalFixture.Create();
        ArticleVaultExecutionPayload payload = new(ArticleVaultExecutionSchemas.Payload, 1, [], string.Empty);
        payload = payload with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealPayload(payload)
        };
        ArticleVaultSealedExecutionBundle bundle = new(ArticleVaultExecutionSchemas.Bundle, 1, input.Metadata.Plan.PlanCandidateIdentity,
            input.Metadata.Plan.ContentSha256, 7, input.Metadata.Plan, input.Metadata.Root, input.Metadata.Articles,
            input.Metadata.Observations, payload, string.Empty);
        bundle = bundle with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(bundle)
        };
        if (sealOriginal)
        {
            await execution.SealAsync(bundle);
        }
        var builder = new NpgsqlConnectionStringBuilder(connectionString) { MaxPoolSize = 1 };
        NpgsqlDataSource source = NpgsqlDataSource.Create(builder.ConnectionString);
        var store = new PostgresArticleVaultResolutionProposalStore(source, execution, clock);
        return new(connectionString, db, source, execution, store, input, clock);
    }

    private static ArticleVaultResolutionPlan Build(ArticleVaultResolutionPlanInput input)
        => Assert.IsType<ArticleVaultResolutionPlan>(ArticleVaultResolutionPlanner.Build(input).Plan);

    private static async Task<long> CountAsync(Database database)
    {
        await using NpgsqlConnection connection = await database.Source.OpenConnectionAsync();
        await using var command = new NpgsqlCommand("SELECT count(*) FROM article_vault_resolution_proposal", connection);
        return (long)(await command.ExecuteScalarAsync())!;
    }

    private static async Task<long> CountResultsAsync(Database database)
    {
        await using NpgsqlConnection connection = await database.Source.OpenConnectionAsync();
        await using var command = new NpgsqlCommand("SELECT count(*) FROM article_vault_execution_result", connection);
        return (long)(await command.ExecuteScalarAsync())!;
    }

    // Inserts controlled corruption into the isolated test database; it is not a production store.
    private static async Task InsertAsync(Database database, ArticleVaultResolutionPlan proposal, string digest, byte[] bytes)
    {
        await using NpgsqlConnection connection = await database.Source.OpenConnectionAsync();
        await using var command = new NpgsqlCommand("""
            INSERT INTO article_vault_resolution_proposal VALUES (@operation, @digest, @plan, @plan_digest, @site, @vault, @bytes, @stored)
            """, connection);
        command.Parameters.AddWithValue("operation", proposal.ResolutionOperationIdentity);
        command.Parameters.AddWithValue("digest", digest);
        command.Parameters.AddWithValue("plan", proposal.Binding.PlanCandidateIdentity);
        command.Parameters.AddWithValue("plan_digest", proposal.Binding.PlanSha256);
        command.Parameters.AddWithValue("site", proposal.Binding.SiteIdentity);
        command.Parameters.AddWithValue("vault", proposal.Binding.VaultIdentity);
        command.Parameters.AddWithValue("bytes", bytes);
        command.Parameters.AddWithValue("stored", database.Clock.GetUtcNow().UtcDateTime);
        await command.ExecuteNonQueryAsync();
    }

    private sealed class ProposalClock : TimeProvider
    {
        internal DateTimeOffset Now { get; set; } = DateTimeOffset.FromUnixTimeMilliseconds(ArticleVaultResolutionProposalFixture.Now);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed record Database(
        string ConnectionString,
        SqlSugarClient Db,
        NpgsqlDataSource Source,
        PostgresArticleVaultExecutionStore ExecutionStore,
        PostgresArticleVaultResolutionProposalStore Store,
        ArticleVaultResolutionPlanInput Input,
        ProposalClock Clock) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Source.DisposeAsync();
            Db.Dispose();
        }
    }
}

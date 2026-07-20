using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.WebUtilities;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class CommentManagementCapabilityServiceTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTimeOffset s_baseline = new(2026, 7, 20, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public void IssueCapability_ProducesOpaqueCommitmentThatOnlyMatchingSecretVerifies()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create("Host=unused;Database=unused;Username=unused;Password=unused");
        var service = new CommentManagementCapabilityService(db, new MutableTimeProvider(s_baseline));

        CommentManagementCapability first = service.IssueCapability();
        CommentManagementCapability second = service.IssueCapability();

        Assert.Equal(32, WebEncoders.Base64UrlDecode(first.Secret).Length);
        Assert.Equal(64, first.Commitment.Length);
        Assert.DoesNotContain(first.Secret, first.Commitment, StringComparison.Ordinal);
        Assert.True(service.VerifyCapability(first.Secret, first.Commitment));
        Assert.False(service.VerifyCapability(second.Secret, first.Commitment));
        Assert.NotEqual(first.Commitment, second.Commitment);
        Assert.False(service.VerifyCapability(first.Secret, "not-a-valid-commitment"));
        Assert.False(service.VerifyCapability(string.Empty, first.Commitment));
    }

    [Fact]
    public void VerifyCapability_UsesFixedTimeDigestComparison()
    {
        string implementation = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentManagementCapabilityService),
            nameof(CommentManagementCapabilityService.VerifyCapability));

        Assert.Contains("CryptographicOperations.FixedTimeEquals", implementation, StringComparison.Ordinal);
        Assert.Contains("SHA256.HashData", implementation, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Challenge_IsSingleUseAndBoundToCommentAndPurpose()
    {
        await using TestDatabase database = await CreateDatabaseAsync();
        CommentManagementCapabilityService service = database.Service;
        CommentManagementCapability capability = service.IssueCapability();
        await database.InsertCommentAsync(101, capability.Commitment);
        await database.InsertCommentAsync(102, capability.Commitment);

        CommentManagementChallengeResult issued = await service.IssueChallengeAsync(
            101,
            capability.Secret,
            CommentManagementPurposes.Edit,
            CancellationToken.None);

        Assert.True(issued.Issued);
        Assert.NotNull(issued.Challenge);
        Assert.Equal(s_baseline.AddMinutes(5).UtcDateTime, issued.ExpiresAtUtc);
        Assert.False(await service.ConsumeChallengeAsync(
            102,
            issued.Challenge!,
            CommentManagementPurposes.Edit,
            CancellationToken.None));
        Assert.False(await service.ConsumeChallengeAsync(
            101,
            issued.Challenge!,
            CommentManagementPurposes.Delete,
            CancellationToken.None));
        Assert.True(await service.ConsumeChallengeAsync(
            101,
            issued.Challenge!,
            CommentManagementPurposes.Edit,
            CancellationToken.None));
        Assert.False(await service.ConsumeChallengeAsync(
            101,
            issued.Challenge!,
            CommentManagementPurposes.Edit,
            CancellationToken.None));
    }

    [Fact]
    public async Task Challenge_ExpiresAndCapabilityCommitmentRemainsUnchanged()
    {
        await using TestDatabase database = await CreateDatabaseAsync();
        CommentManagementCapabilityService service = database.Service;
        CommentManagementCapability capability = service.IssueCapability();
        await database.InsertCommentAsync(201, capability.Commitment);

        CommentManagementChallengeResult issued = await service.IssueChallengeAsync(
            201,
            capability.Secret,
            CommentManagementPurposes.Status,
            CancellationToken.None);
        database.Clock.Advance(TimeSpan.FromMinutes(5).Add(TimeSpan.FromMilliseconds(1)));

        Assert.False(await service.ConsumeChallengeAsync(
            201,
            issued.Challenge!,
            CommentManagementPurposes.Status,
            CancellationToken.None));
        Comment stored = await database.Db.Queryable<Comment>().InSingleAsync(201);
        Assert.Equal(capability.Commitment, stored.ManagementCapabilityHash);
        Assert.True(service.VerifyCapability(capability.Secret, stored.ManagementCapabilityHash!));
    }

    [Fact]
    public async Task IssueChallenge_RejectsWrongSecretWithoutPersistingChallenge()
    {
        await using TestDatabase database = await CreateDatabaseAsync();
        CommentManagementCapability capability = database.Service.IssueCapability();
        await database.InsertCommentAsync(301, capability.Commitment);

        CommentManagementChallengeResult result = await database.Service.IssueChallengeAsync(
            301,
            "wrong-secret",
            CommentManagementPurposes.Edit,
            CancellationToken.None);

        Assert.False(result.Issued);
        Assert.Equal("comment_management_capability_invalid", result.FailureCode);
        Assert.Equal(0, await database.Db.Queryable<CommentManagementChallenge>().CountAsync());
    }

    private async Task<TestDatabase> CreateDatabaseAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        var db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Comment), typeof(CommentManagementChallenge));
        return new TestDatabase(db, new MutableTimeProvider(s_baseline));
    }

    private sealed class TestDatabase(SqlSugarClient db, MutableTimeProvider clock) : IAsyncDisposable
    {
        public SqlSugarClient Db { get; } = db;

        public MutableTimeProvider Clock { get; } = clock;

        public CommentManagementCapabilityService Service { get; } = new(db, clock);

        public Task<int> InsertCommentAsync(long id, string commitment)
            => Db.Insertable(new Comment
            {
                Id = id,
                ArticleId = 42,
                Content = "original",
                CreateTime = s_baseline.UtcDateTime,
                CurrentVersion = 1,
                UserId = null,
                AuthorMode = "zk-anonymous",
                ManagementCapabilityHash = commitment
            }).ExecuteCommandAsync();

        public ValueTask DisposeAsync()
        {
            Db.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;

        public void Advance(TimeSpan duration) => utcNow = utcNow.Add(duration);
    }
}

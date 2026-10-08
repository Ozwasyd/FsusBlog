using System.Reflection;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;
namespace FsusBlog.Server.Tests;

[Collection(nameof(SchemaMigrationPostgresCollectionA))]
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
public sealed class SecurityFixtureCompositionRootIntegrationTests(
    PostgresSchemaMigrationFixture postgres,
    SecurityFixtureDatabaseFixture database,
    PublicHotDeliveryRedisFixture redis) :
    IClassFixture<SecurityFixtureDatabaseFixture>,
    IClassFixture<PublicHotDeliveryRedisFixture>
{
    private static readonly DateTimeOffset s_epoch = new(2026, 8, 26, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task ThreeFamilies_UseProductionServicesAndIndependentPostgresRedisObservation()
    {
        await using Harness harness = await CreateHarnessAsync();
        SecurityFixtureRequestBinding binding = new("security-run", "security-ns", "security-state-matrix");
        JsonElement[] fragments =
        [
            Fragment(binding, harness.Accounts, "risk-pow-rate-limit",
                "security.pow.elevated",
                "security.rate-limit.near-limit",
                "security.risk.low"),
            Fragment(binding, harness.Accounts, "ban",
                "security.subject.banned",
                "security.subject.unbanned"),
            Fragment(binding, harness.Accounts, "credential",
                "security.audit.active-window",
                "security.credential.active",
                "security.credential.revoked",
                "security.issuance.replay-observed",
                "security.nullifier.blocked")
        ];

        foreach (JsonElement fragment in fragments)
        {
            JsonElement applied = JsonSerializer.SerializeToElement(
                await harness.Root.ApplyAsync(fragment, binding, CancellationToken.None));
            Assert.Equal("applied", applied.GetProperty("status").GetString());
            Assert.False(applied.GetProperty("partial").GetBoolean());

            JsonElement first = JsonSerializer.SerializeToElement(
                await harness.Root.ObserveAsync(fragment, binding, CancellationToken.None));
            JsonElement independent = JsonSerializer.SerializeToElement(
                await harness.Root.ObserveAsync(fragment, binding, CancellationToken.None));
            Assert.Equal(
                first.GetProperty("contentDigest").GetString(),
                independent.GetProperty("contentDigest").GetString());
            foreach (JsonElement fact in independent.GetProperty("facts").EnumerateArray())
            {
                Assert.True(fact.GetProperty("database").GetProperty("present").GetBoolean());
                Assert.True(fact.GetProperty("redis").GetProperty("present").GetBoolean());
                Assert.True(fact.GetProperty("service").GetProperty("observed").GetBoolean());
            }
        }

        Assert.Equal("elevated", await DecisionAsync(harness.Root, fragments[0], binding, "security.pow.elevated"));
        Assert.Equal("near-limit", await DecisionAsync(harness.Root, fragments[0], binding, "security.rate-limit.near-limit"));
        Assert.Equal("rejected", await DecisionAsync(harness.Root, fragments[1], binding, "security.subject.banned"));
        Assert.Equal("accepted", await DecisionAsync(harness.Root, fragments[2], binding, "security.credential.active"));
        Assert.Equal("rejected", await DecisionAsync(harness.Root, fragments[2], binding, "security.credential.revoked"));
        Assert.Equal("replay-rejected", await DecisionAsync(harness.Root, fragments[2], binding, "security.issuance.replay-observed"));

        foreach (JsonElement fragment in fragments.Reverse())
        {
            JsonElement cleanup = CleanupPlan(fragment, binding);
            _ = await harness.Root.CleanupAsync(cleanup, binding, CancellationToken.None);
            JsonElement observed = JsonSerializer.SerializeToElement(
                await harness.Root.ObserveCleanupAsync(cleanup, binding, CancellationToken.None));
            Assert.Empty(observed.GetProperty("residualOwnedOperationIds").EnumerateArray());
            Assert.Equal(0, observed.GetProperty("nonOwnedMutationCount").GetInt32());
        }
        User[] preservedAccounts = harness.Db.Queryable<User>().OrderBy(item => item.Id).ToArray();
        Assert.Equal(3, preservedAccounts.Length);
        Assert.All(preservedAccounts, account => Assert.Equal(0, account.Status));
    }

    [Fact]
    public async Task PartialProductionFailure_RecoversOnlyExactOwnedPostgresAndRedisState()
    {
        await using Harness harness = await CreateHarnessAsync(failCredentialIssue: true);
        SecurityFixtureRequestBinding binding = new("failure-run", "failure-ns", "security-state-matrix");
        JsonElement fragment = Fragment(binding, harness.Accounts, "credential", "security.credential.active");

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            harness.Root.ApplyAsync(fragment, binding, CancellationToken.None));

        JsonElement cleanup = CleanupPlan(fragment, binding);
        JsonElement observed = JsonSerializer.SerializeToElement(
            await harness.Root.ObserveCleanupAsync(cleanup, binding, CancellationToken.None));
        Assert.Empty(observed.GetProperty("residualOwnedOperationIds").EnumerateArray());
        Assert.Equal(3, harness.Db.Queryable<User>().Count());
        Assert.Equal(0, harness.Db.Queryable<AnonymousCredential>().Count());
    }

    private async Task<Harness> CreateHarnessAsync(bool failCredentialIssue = false)
    {
        string connectionString = await database.ResetAsync(postgres);
        SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(AnonymousCredential),
            typeof(CommentAnonymousNullifier),
            typeof(AnonymousCredentialIssuanceAudit));
        AllocatedAccounts accounts = await SeedAllocatedAccountsAsync(db);

        ConnectionMultiplexer connection = await redis.ConnectAsync();
        var memory = new MemoryCache(new MemoryCacheOptions());
        var registry = new CachePolicyRegistry();
        string redisPrefix = $"security-fixture:{Guid.NewGuid():N}:";
        var scope = new PrefixRuntimeKeyScope(redisPrefix);
        var cache = new UnifiedCache(
            connection,
            registry,
            scope,
            NullLogger<UnifiedCache>.Instance);
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["fsus:allowLocalSecurityFixture"] = "true",
                ["Security:AntiCrawler:MaxRiskScore"] = "200"
            })
            .Build();
        var policy = new SecurityAdminPolicyService(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(configuration));
        var risk = new CrawlerRiskService(
            cache,
            cache,
            cache,
            cache,
            policy,
            NullLogger<CrawlerRiskService>.Instance);
        IAnonymousCredentialService credentialService = new AnonymousCredentialService(db);
        if (failCredentialIssue)
        {
            credentialService = new FailingCredentialService(credentialService);
        }
        IWebHostEnvironment environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns("Test");
        TestTemporalRuntimeContext temporal = CreateTemporalContext();
        (BanStateProjection banProjection, IBanStateProjectionObligationCoordinator banObligations) =
            TestBanStateProjectionRuntime.Create(db);
        var root = new SecurityFixtureCompositionRoot(
            db,
            risk,
            risk,
            new BlacklistService(
                db,
                Substitute.For<IAccountStateProjectionMutationPublisher>(),
                banProjection,
                banObligations),
            credentialService,
            new CommentAnonymousNullifierService(db, configuration),
            new AnonymousCredentialIssuanceAuditStore(db),
            cache,
            cache,
            cache,
            cache,
            temporal,
            environment,
            configuration);
        return new Harness(root, db, cache, memory, connection, redis, redisPrefix, accounts);
    }

    private static async Task<string> DecisionAsync(
        ISecurityFixtureCompositionRoot root,
        JsonElement fragment,
        SecurityFixtureRequestBinding binding,
        string capabilityId)
    {
        JsonElement observed = JsonSerializer.SerializeToElement(
            await root.ObserveAsync(fragment, binding, CancellationToken.None));
        return observed.GetProperty("facts").EnumerateArray()
            .Single(item => item.GetProperty("capabilityId").GetString() == capabilityId)
            .GetProperty("service")
            .GetProperty("decision")
            .GetString()!;
    }

    private static JsonElement Fragment(
        SecurityFixtureRequestBinding binding,
        AllocatedAccounts accounts,
        string family,
        params string[] capabilities)
    {
        object[] operations = capabilities.Order(StringComparer.Ordinal).Select(capability =>
        {
            string token = capability.Replace('.', '-');
            string role = capability switch
            {
                "security.subject.banned" => "subject.banned",
                "security.subject.unbanned" => "subject.unbanned",
                _ => "primary"
            };
            int accountId = role switch
            {
                "subject.banned" => accounts.Banned,
                "subject.unbanned" => accounts.Unbanned,
                _ => accounts.Primary
            };
            return new
            {
                capabilityId = capability,
                family,
                operationId = Digest($"operation:{binding.RunId}:{token}"),
                subject = new
                {
                    digest = Digest($"subject:{token}")
                },
                ipPseudonym = new
                {
                    digest = Digest($"ip:{token}")
                },
                credential = new
                {
                    digest = Digest($"credential:{token}")
                },
                nullifier = new
                {
                    digest = Digest($"nullifier:{token}")
                },
                issuance = new
                {
                    digest = Digest($"issuance:{token}")
                },
                temporal = new
                {
                    businessEpochUtc = "2026-08-26T12:00:00.000Z",
                    businessClockMode = "fixed"
                },
                authIdentityRef = new
                {
                    schema = "fsusblog.fixture-identity-prepare-reference.v1",
                    verified = false,
                    ownerProducerId = "auth-session",
                    consumerProducerId = "security-state",
                    runId = binding.RunId,
                    @namespace = binding.Namespace,
                    profileId = binding.ProfileId,
                    role,
                    publicId = accountId.ToString(System.Globalization.CultureInfo.InvariantCulture)
                }
            };
        }).ToArray();
        return JsonSerializer.SerializeToElement(new
        {
            schema = "fsusblog.security-fixture-operation-fragment.v1",
            planDigest = Digest($"plan:{binding.RunId}"),
            runId = binding.RunId,
            @namespace = binding.Namespace,
            producerId = "security-state",
            family,
            capabilities = capabilities.Order(StringComparer.Ordinal).ToArray(),
            operations,
            contentDigest = Digest($"fragment:{family}:{binding.RunId}")
        });
    }

    private static JsonElement CleanupPlan(JsonElement fragment, SecurityFixtureRequestBinding binding)
        => JsonSerializer.SerializeToElement(new
        {
            schema = "fsusblog.security-fixture-cleanup-plan.v1",
            planDigest = fragment.GetProperty("planDigest").GetString(),
            runId = binding.RunId,
            @namespace = binding.Namespace,
            family = fragment.GetProperty("family").GetString(),
            ownedOperationIds = fragment.GetProperty("operations").EnumerateArray()
                .Select(item => item.GetProperty("operationId").GetString())
                .Order(StringComparer.Ordinal)
                .ToArray()
        });

    private static TestTemporalRuntimeContext CreateTemporalContext()
    {
        ConstructorInfo constructor = typeof(TestTemporalRuntimeContext)
            .GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic)
            .Single();
        return (TestTemporalRuntimeContext)constructor.Invoke(
        [
            "{}",
            s_epoch,
            "UTC",
            "en-US",
            "en-US",
            "Invariant",
            "UTC",
            "UTC",
            "gregory",
            "monday"
        ]);
    }

    private static async Task<AllocatedAccounts> SeedAllocatedAccountsAsync(SqlSugarClient db)
    {
        async Task<int> SeedAsync(string role)
        {
            string handle = $"fixture-auth-{role}";
            return await db.Insertable(new User
            {
                PublicHandle = handle,
                IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
                AccountSubjectHash = AccountSubjectHasher.Create(AnonymousIdentityRuntime.AnonymousAccountKind, handle),
                RegistrationState = AccountRegistrationStates.Active,
                Status = 0,
                CreateTime = s_epoch.UtcDateTime
            }).ExecuteReturnIdentityAsync();
        }

        return new AllocatedAccounts(
            await SeedAsync("primary"),
            await SeedAsync("banned"),
            await SeedAsync("unbanned"));
    }

    private static string Digest(string value)
        => $"sha256:{Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value)))}";

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key) => string.Concat(prefix, key);
    }

    private sealed class FailingCredentialService(IAnonymousCredentialService inner) : IAnonymousCredentialService
    {
        public Task<AnonymousCredential> IssueAccountBoundAsync(
            int accountId,
            string accountBindingHash,
            string credentialLevel = AnonymousCredentialLevels.Basic,
            string metadataJson = "{}",
            CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("injected credential persistence failure");

        public Task<AnonymousCredential?> GetActiveAccountCredentialAsync(
            int accountId,
            string? accountBindingHash = null,
            CancellationToken cancellationToken = default)
            => inner.GetActiveAccountCredentialAsync(accountId, accountBindingHash, cancellationToken);

        public Task<string?> GetAccountCredentialLevelAsync(
            int accountId,
            string? accountBindingHash = null,
            CancellationToken cancellationToken = default)
            => inner.GetAccountCredentialLevelAsync(accountId, accountBindingHash, cancellationToken);

        public Task<bool> RevokeAsync(long credentialId, CancellationToken cancellationToken = default)
            => inner.RevokeAsync(credentialId, cancellationToken);
    }

    private sealed class Harness(
        ISecurityFixtureCompositionRoot root,
        SqlSugarClient db,
        UnifiedCache cache,
        MemoryCache memory,
        ConnectionMultiplexer connection,
        PublicHotDeliveryRedisFixture redis,
        string redisPrefix,
        AllocatedAccounts accounts) : IAsyncDisposable
    {
        public ISecurityFixtureCompositionRoot Root { get; } = root;
        public SqlSugarClient Db { get; } = db;
        public AllocatedAccounts Accounts { get; } = accounts;

        public async ValueTask DisposeAsync()
        {
            await redis.DeleteNamespaceAsync(redisPrefix);
            cache.Dispose();
            memory.Dispose();
            await connection.DisposeAsync();
            Db.Dispose();
        }
    }

    private sealed record AllocatedAccounts(int Primary, int Banned, int Unbanned);
}

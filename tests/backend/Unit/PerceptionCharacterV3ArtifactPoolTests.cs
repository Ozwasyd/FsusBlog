using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Shared.Contracts.Security;

using Microsoft.Extensions.Configuration;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class PerceptionCharacterV3Tests
{
    [Fact]
    public async Task ProviderZeroesPoolAnswerImmediatelyAfterRequestBoundHmac()
    {
        var pool = new CapturingPool();
        var provider = new PerceptionCharacterV3Provider(
            new Keys(RandomNumberGenerator.GetBytes(32), RandomNumberGenerator.GetBytes(32)),
            pool,
            new MemoryStore(),
            new AllowGate(),
            new TestDeviceAuthority(),
            new PerceptionCharacterV3RandomNonceSource(),
            new AuditSink(),
            TimeProvider.System);

        SecurityChallengeProviderIssueResult result = await provider.IssueAsync(ProviderIssueRequest());

        Assert.True(result.Succeeded);
        Assert.NotNull(pool.LastLease);
        Assert.True(pool.LastLease.AnswerBytes.IsEmpty);
    }

    [Fact]
    public void ArtifactPoolRejectsReuseOfCurrentTokenOrAnswerKey()
    {
        byte[] poolKey = RandomNumberGenerator.GetBytes(32);
        var options = new PerceptionCharacterV3ArtifactPoolOptions
        {
            RootPath = "unused",
            ActiveGeneration = "unused-generation",
            KeyCurrent = "pool-k1",
            Keys = new(StringComparer.Ordinal) { ["pool-k1"] = Convert.ToHexStringLower(poolKey) }
        };
        var redis = NSubstitute.Substitute.For<IConnectionMultiplexer>();
        var keyScope = new TestRuntimeKeyScope("test:pool-key:");
        Assert.Throws<InvalidOperationException>(() => new RedisPerceptionCharacterV3ArtifactPool(
            redis, keyScope, options, s_root, null, new Keys(poolKey, RandomNumberGenerator.GetBytes(32))));
        Assert.Throws<InvalidOperationException>(() => new RedisPerceptionCharacterV3ArtifactPool(
            redis, keyScope, options, s_root, null, new Keys(RandomNumberGenerator.GetBytes(32), poolKey)));
        CryptographicOperations.ZeroMemory(poolKey);
    }

    [Fact]
    public void ArtifactPoolConfigurationRejectsCrossDomainKeyReuse()
    {
        string shared = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Security:PerceptionCharacterV3:Pool:RootPath"] = "var/security/perception-v3-pools",
            ["Security:PerceptionCharacterV3:Pool:ActiveGeneration"] = "generation-1",
            ["Security:PerceptionCharacterV3:Pool:KeyCurrent"] = "pool-k1",
            ["Security:PerceptionCharacterV3:Pool:Keys:pool-k1"] = shared,
            ["Security:Pow:SigningKey"] = shared
        }).Build();

        Assert.Throws<InvalidOperationException>(() =>
            PerceptionCharacterV3ArtifactPoolOptions.FromConfiguration(configuration, new FakeEnvironment()));
    }

    [Fact]
    [Trait("Fixture", "LocalRedis")]
    public async Task ArtifactPoolBurnSurvivesCancellationProcessInterruptionAndAmbiguousReply()
    {
        string connectionString = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_REDIS")
            ?? throw new InvalidOperationException("FSUSBLOG_TEST_REDIS environment variable is not set.");
        Assert.False(string.IsNullOrWhiteSpace(connectionString), "FSUSBLOG_TEST_REDIS must not be empty.");
        string redisPrefixRoot = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_REDIS_PREFIX")
            ?? throw new InvalidOperationException("FSUSBLOG_TEST_REDIS_PREFIX environment variable is not set.");
        Assert.False(string.IsNullOrWhiteSpace(redisPrefixRoot), "FSUSBLOG_TEST_REDIS_PREFIX must not be empty.");
        string poolRoot = Path.Combine(Path.GetTempPath(), "fsusblog-v3-pool-" + Guid.CreateVersion7().ToString("N"));
        string generation = "runtime-test-generation";
        byte[] key = RandomNumberGenerator.GetBytes(32);
        try
        {
            await GeneratePoolAsync(poolRoot, generation, key);
            await using ConnectionMultiplexer redis = await ConnectionMultiplexer.ConnectAsync(connectionString);
            string redisPrefix = redisPrefixRoot + "artifact-burn:";
            var keyScope = new TestRuntimeKeyScope(redisPrefix);
            await using var redisCleanup = new RedisPrefixCleanup(redis, redisPrefix);
            var options = new PerceptionCharacterV3ArtifactPoolOptions
            {
                RootPath = poolRoot,
                ActiveGeneration = generation,
                KeyCurrent = "pool-k1",
                Keys = new(StringComparer.Ordinal) { ["pool-k1"] = Convert.ToHexStringLower(key) }
            };
            var pool = new RedisPerceptionCharacterV3ArtifactPool(redis, keyScope, options, s_root);
            await pool.InitializeAsync(CancellationToken.None);
            int discardReply = 1;
            var ambiguousPool = new RedisPerceptionCharacterV3ArtifactPool(
                redis, keyScope, options, s_root, () => Interlocked.Exchange(ref discardReply, 0) == 1);
            await ambiguousPool.InitializeAsync(CancellationToken.None);
            await Assert.ThrowsAsync<PerceptionCharacterV3StoreUnavailableException>(() => ambiguousPool.LeaseAsync(
                PerceptionCharacterV3Representation.Visual, CancellationToken.None));

            using var responseCancellation = new CancellationTokenSource();
            await using (PerceptionCharacterV3ArtifactLease cancelledResponse = Assert.IsType<PerceptionCharacterV3ArtifactLease>(
                await pool.LeaseAsync(PerceptionCharacterV3Representation.Visual, CancellationToken.None)))
            {
                responseCancellation.Cancel();
                Assert.True(responseCancellation.IsCancellationRequested);
            }
            await using (PerceptionCharacterV3ArtifactLease interruptedProcess = Assert.IsType<PerceptionCharacterV3ArtifactLease>(
                await pool.LeaseAsync(PerceptionCharacterV3Representation.Visual, CancellationToken.None)))
            {
                Assert.NotEmpty(interruptedProcess.AnswerBytes.ToArray());
            }

            string?[] winners = await Task.WhenAll(Enumerable.Range(0, 32).Select(async _ =>
            {
                PerceptionCharacterV3ArtifactLease? lease = await pool.LeaseAsync(
                    PerceptionCharacterV3Representation.Visual, CancellationToken.None);
                if (lease is null)
                    return null;
                await using (lease)
                    return lease.EntryId;
            }));
            string[] leasedIds = winners.OfType<string>().ToArray();
            Assert.Equal(6, leasedIds.Length);
            Assert.Equal(6, leasedIds.Distinct(StringComparer.Ordinal).Count());

            await using PerceptionCharacterV3ArtifactLease audio = Assert.IsType<PerceptionCharacterV3ArtifactLease>(
                await pool.LeaseAsync(PerceptionCharacterV3Representation.Audio, CancellationToken.None));
            Assert.Null(await pool.LeaseAsync(PerceptionCharacterV3Representation.Audio, CancellationToken.None));

            RedisKey[] keys = redis.GetServer(redis.GetEndPoints()[0]).Keys(pattern: redisPrefix + "*").ToArray();
            Assert.Equal(10, keys.Count(keyName => keyName.ToString().Contains(":entry:", StringComparison.Ordinal)));
            foreach (RedisKey redisKey in keys.Where(keyName => keyName.ToString().Contains(":entry:", StringComparison.Ordinal)))
                Assert.Equal("burned", (await redis.GetDatabase().StringGetAsync(redisKey)).ToString());

            await redis.GetDatabase().StringSetAsync(
                keyScope.PrefixKey($"security:perception-v3-pool:{generation}:revoked"), "revoked");
            await Assert.ThrowsAsync<InvalidOperationException>(() => pool.LeaseAsync(
                PerceptionCharacterV3Representation.Visual, CancellationToken.None));
            var restartedPool = new RedisPerceptionCharacterV3ArtifactPool(redis, keyScope, options, s_root);
            await Assert.ThrowsAsync<InvalidOperationException>(() => restartedPool.InitializeAsync(CancellationToken.None));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            if (Directory.Exists(poolRoot))
                Directory.Delete(poolRoot, recursive: true);
        }
    }

    [Fact]
    [Trait("Fixture", "LocalRedis")]
    public async Task BudgetedLeaseAtomicallyAccountsExactBytesQuotasAndRetryIdentity()
    {
        string connectionString = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_REDIS")
            ?? throw new InvalidOperationException("FSUSBLOG_TEST_REDIS environment variable is not set.");
        Assert.False(string.IsNullOrWhiteSpace(connectionString));
        string runId = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_LOCAL_REDIS_RUN_ID")
            ?? throw new InvalidOperationException("LocalRedis run identity is required.");
        Assert.False(string.IsNullOrWhiteSpace(runId));
        Assert.DoesNotContain(":", runId);
        string redisPrefixRoot = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_REDIS_PREFIX")
            ?? throw new InvalidOperationException("LocalRedis prefix is required.");
        Assert.Equal($"test:perception-v3-local-redis:{runId}:", redisPrefixRoot);
        string evidencePath = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_REDIS_BUDGET_EVIDENCE")
            ?? throw new InvalidOperationException("LocalRedis budget evidence path is required.");
        Assert.False(string.IsNullOrWhiteSpace(evidencePath));
        string poolRoot = Path.Combine(Path.GetTempPath(), "fsusblog-v3-budget-pool-" + Guid.CreateVersion7().ToString("N"));
        string generation = "runtime-budget-generation";
        byte[] key = RandomNumberGenerator.GetBytes(32);
        try
        {
            await GeneratePoolAsync(poolRoot, generation, key);
            await using ConnectionMultiplexer redis = await ConnectionMultiplexer.ConnectAsync(connectionString);
            string redisPrefix = redisPrefixRoot + "budgeted-lease:";
            Assert.Empty(redis.GetServer(redis.GetEndPoints()[0]).Keys(pattern: redisPrefix + "*"));
            var keyScope = new TestRuntimeKeyScope(redisPrefix);
            await using var redisCleanup = new RedisPrefixCleanup(redis, redisPrefix);
            var options = new PerceptionCharacterV3ArtifactPoolOptions
            {
                RootPath = poolRoot,
                ActiveGeneration = generation,
                KeyCurrent = "pool-k1",
                Keys = new(StringComparer.Ordinal) { ["pool-k1"] = Convert.ToHexStringLower(key) }
            };
            var pool = new RedisPerceptionCharacterV3ArtifactPool(redis, keyScope, options, s_root);
            await pool.InitializeAsync(CancellationToken.None);
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var observations = new List<object>();
            using JsonDocument manifest = JsonDocument.Parse(await File.ReadAllTextAsync(
                Path.Combine(poolRoot, generation, "manifest.json")));
            Dictionary<string, long> artifactSizes = manifest.RootElement.GetProperty("entries")
                .EnumerateArray().ToDictionary(
                    entry => entry.GetProperty("entryId").GetString()!,
                    entry => entry.GetProperty("artifactBytes").GetInt64());
            PerceptionCharacterV3LeaseBudget firstBudget = Budget("operation-1", now);

            PerceptionCharacterV3PoolLeaseResult first = await pool.LeaseBudgetedAsync(
                PerceptionCharacterV3Representation.Visual,
                firstBudget,
                CancellationToken.None);
            await using PerceptionCharacterV3ArtifactLease firstLease = Assert.IsType<PerceptionCharacterV3ArtifactLease>(first.Lease);
            long exactBytes = firstLease.Artifact.LongLength;
            Assert.Equal(artifactSizes[firstLease.EntryId], exactBytes);
            RedisKey minuteBytesKey = keyScope.PrefixKey(
                $"security:perception-v3-pool:{generation}:budget:bytes:minute:{now / 60_000}");
            Assert.Equal(exactBytes, (long)await redis.GetDatabase().StringGetAsync(minuteBytesKey));
            await AssertBudgetStateAsync("first-lease", 1, exactBytes);

            PerceptionCharacterV3PoolLeaseResult retry = await pool.LeaseBudgetedAsync(
                PerceptionCharacterV3Representation.Visual,
                firstBudget,
                CancellationToken.None);
            Assert.Equal(PerceptionCharacterV3PoolLeaseOutcome.AlreadyAccounted, retry.Outcome);
            Assert.Null(retry.Lease);
            Assert.Equal(exactBytes, (long)await redis.GetDatabase().StringGetAsync(minuteBytesKey));
            Assert.Equal(8, (await pool.GetInventoryAsync(CancellationToken.None)).VisualReady);
            await AssertBudgetStateAsync("operation-retry", 1, exactBytes);

            PerceptionCharacterV3PoolLeaseResult subjectLimited = await pool.LeaseBudgetedAsync(
                PerceptionCharacterV3Representation.Visual,
                Budget("operation-2", now) with
                {
                    SubjectPerMinute = 1
                },
                CancellationToken.None);
            Assert.Equal(PerceptionCharacterV3PoolLeaseOutcome.SubjectQuotaExhausted, subjectLimited.Outcome);
            Assert.Null(subjectLimited.Lease);
            Assert.Equal(8, (await pool.GetInventoryAsync(CancellationToken.None)).VisualReady);
            await AssertBudgetStateAsync("subject-rejected", 1, exactBytes);

            PerceptionCharacterV3PoolLeaseResult byteLimited = await pool.LeaseBudgetedAsync(
                PerceptionCharacterV3Representation.Visual,
                Budget("operation-3", now) with
                {
                    EgressBytesPerMinute = exactBytes
                },
                CancellationToken.None);
            Assert.Equal(PerceptionCharacterV3PoolLeaseOutcome.EgressBudgetExhausted, byteLimited.Outcome);
            Assert.Null(byteLimited.Lease);
            Assert.Equal(exactBytes, (long)await redis.GetDatabase().StringGetAsync(minuteBytesKey));
            await AssertBudgetStateAsync("egress-rejected", 1, exactBytes);

            int discardReply = 1;
            var ambiguousPool = new RedisPerceptionCharacterV3ArtifactPool(
                redis, keyScope, options, s_root, () =>
                    (long)redis.GetDatabase().HashGet(
                        keyScope.PrefixKey($"security:perception-v3-pool:{generation}:inventory"),
                        "visual-ready") == 7 && Interlocked.Exchange(ref discardReply, 0) == 1);
            await ambiguousPool.InitializeAsync(CancellationToken.None);
            PerceptionCharacterV3LeaseBudget ambiguousBudget = Budget("operation-ambiguous", now) with
            {
                SubjectHash = "subject-ambiguous"
            };
            await Assert.ThrowsAsync<PerceptionCharacterV3StoreUnavailableException>(() =>
                ambiguousPool.LeaseBudgetedAsync(
                    PerceptionCharacterV3Representation.Visual,
                    ambiguousBudget,
                    CancellationToken.None));
            long bytesAfterAmbiguous = (long)await redis.GetDatabase().StringGetAsync(minuteBytesKey);
            Assert.Equal(7, (await pool.GetInventoryAsync(CancellationToken.None)).VisualReady);
            Assert.Equal(bytesAfterAmbiguous, await AssertBudgetStateAsync("ambiguous-reply", 2, bytesAfterAmbiguous));

            PerceptionCharacterV3PoolLeaseResult ambiguousRetry = await pool.LeaseBudgetedAsync(
                PerceptionCharacterV3Representation.Visual,
                ambiguousBudget,
                CancellationToken.None);
            Assert.Equal(PerceptionCharacterV3PoolLeaseOutcome.AlreadyAccounted, ambiguousRetry.Outcome);
            Assert.Null(ambiguousRetry.Lease);
            Assert.Equal(bytesAfterAmbiguous, (long)await redis.GetDatabase().StringGetAsync(minuteBytesKey));
            Assert.Equal(7, (await pool.GetInventoryAsync(CancellationToken.None)).VisualReady);
            await AssertBudgetStateAsync("ambiguous-retry", 2, bytesAfterAmbiguous);
            await File.WriteAllTextAsync(evidencePath, JsonSerializer.Serialize(new
            {
                schema = "fsusblog.perception-character-v3-budget-cases.v1",
                testId = "FsusBlog.Server.Tests.Unit.PerceptionCharacterV3Tests.BudgetedLeaseAtomicallyAccountsExactBytesQuotasAndRetryIdentity",
                runId,
                prefixNamespace = redisPrefix,
                endpoint = redis.GetEndPoints()[0] is System.Net.DnsEndPoint dns
                    ? $"{dns.Host}:{dns.Port}"
                    : redis.GetEndPoints()[0].ToString(),
                cases = observations
            }));

            async Task<long> AssertBudgetStateAsync(string id, int leases, long bytes)
            {
                IDatabase database = redis.GetDatabase();
                string generationPrefix = redisPrefix + $"security:perception-v3-pool:{generation}:";
                RedisKey[] burned = redis.GetServer(redis.GetEndPoints()[0])
                    .Keys(pattern: generationPrefix + "entry:*").ToArray();
                Assert.Equal(leases, burned.Length);
                long burnedBytes = 0;
                foreach (RedisKey entryKey in burned)
                {
                    Assert.Equal("burned", (string?)await database.StringGetAsync(entryKey));
                    burnedBytes += artifactSizes[entryKey.ToString()[(generationPrefix.Length + "entry:".Length)..]];
                }
                Assert.Equal(bytes, burnedBytes);
                Assert.Equal(bytes, (long)await database.StringGetAsync(minuteBytesKey));
                Assert.Equal(leases, (long)await database.StringGetAsync(
                    generationPrefix + $"budget:lease:minute:{now / 60_000}"));
                Assert.Equal(leases, await database.SortedSetLengthAsync(generationPrefix + "budget:rolling-hour"));
                Assert.Equal(leases, redis.GetServer(redis.GetEndPoints()[0])
                    .Keys(pattern: generationPrefix + "budget:operation:*").Count());
                Assert.Equal(1, (long)await database.StringGetAsync(
                    generationPrefix + $"quota:subject:subject:minute:{now / 60_000}"));
                var inventory = await pool.GetInventoryAsync(CancellationToken.None);
                Assert.Equal(9 - leases, inventory.VisualReady);
                Assert.Equal(1, inventory.AudioReady);
                Assert.Equal(9 - leases, (long)await database.HashGetAsync(generationPrefix + "inventory", "visual-ready"));
                Assert.Equal(leases, (long)await database.HashGetAsync(generationPrefix + "inventory", "visual-leased"));
                Assert.Equal(10 - leases, (long)await database.HashGetAsync(generationPrefix + "inventory", "total-ready"));
                observations.Add(new
                {
                    id,
                    outcome = "passed",
                    leases,
                    bytes,
                    burnedBytes
                });
                return burnedBytes;
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            if (Directory.Exists(poolRoot))
                Directory.Delete(poolRoot, recursive: true);
        }
    }

    private static PerceptionCharacterV3LeaseBudget Budget(string operationId, long nowUnixMs)
        => new(
            operationId,
            "comment",
            "ip-prefix",
            "device",
            "subject",
            nowUnixMs,
            100,
            1_000,
            1_000_000,
            10_000_000,
            100,
            100,
            100,
            100);

    private static async Task GeneratePoolAsync(string poolRoot, string generation, byte[] key)
    {
        var start = new ProcessStartInfo("node")
        {
            WorkingDirectory = s_root,
            RedirectStandardError = true,
            RedirectStandardOutput = true
        };
        start.ArgumentList.Add(Path.Combine(s_root, "tools/security/perception-character-v3-pool.mjs"));
        foreach (string argument in new[]
        {
            "generate", "--root", poolRoot, "--generation", generation,
            "--key-env", "FSUSBLOG_TEST_POOL_KEY", "--key-version", "pool-k1",
            "--visual", "9", "--audio", "1"
        })
            start.ArgumentList.Add(argument);
        start.Environment["FSUSBLOG_TEST_POOL_KEY"] = Convert.ToHexStringLower(key);
        using Process process = Process.Start(start)!;
        string output = await process.StandardOutput.ReadToEndAsync();
        string error = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.True(process.ExitCode == 0, output + error);
    }

    private sealed class CapturingPool : IPerceptionCharacterV3ArtifactPool
    {
        public string ActiveGenerationId => "test-generation";
        public PerceptionCharacterV3ArtifactLease? LastLease
        {
            get; private set;
        }

        public Task InitializeAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task<PerceptionCharacterV3ArtifactLease?> LeaseAsync(
            PerceptionCharacterV3Representation representation,
            CancellationToken cancellationToken)
        {
            LastLease = Lease(representation);
            return Task.FromResult<PerceptionCharacterV3ArtifactLease?>(LastLease);
        }
    }
}

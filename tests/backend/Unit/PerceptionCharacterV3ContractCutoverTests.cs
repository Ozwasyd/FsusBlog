using System.Linq.Expressions;
using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PerceptionCharacterV3ContractCutoverTests
{
    [Fact]
    public async Task Execute_BindsExactTargetClosesMutatesActivatesAndDoesNotLeasePool()
    {
        var events = new List<string>();
        var store = new RecordingStore(events);
        var gate = new RecordingGate(events);
        IPerceptionCharacterV3ArtifactPool pool = SecurityChallengeProtocolActivationGuardTests.HealthyPool();
        var service = CreateService(pool, store, gate, AlwaysVerifiedFence());

        PerceptionCharacterV3CutoverReceipt receipt = await service.ExecuteAsync(Request());

        Assert.True(receipt.Accepted);
        Assert.Equal("activated", receipt.Status);
        Assert.Equal(SecurityChallengeProtocolActivationGuardTests.PoolGeneration, receipt.PoolGeneration);
        Assert.Equal(SecurityChallengeProtocolActivationGuardTests.PoolManifestDigest, receipt.PoolManifestDigest);
        Assert.Equal(PerceptionCharacterV3ReleaseTarget.ContractDigest, receipt.ContractDigest);
        Assert.Equal(PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint, receipt.FrontendAedsSchemaFingerprint);
        Assert.Equal(SecurityChallengeProtocolActivationGuardTests.PolicyVersion, receipt.PolicySnapshotVersion);
        Assert.Matches("^[0-9a-f]{64}$", receipt.ReceiptFingerprint);
        Assert.Equal(["preflight", "close", "apply", "save", "open", "smoke"], events);
        Assert.Equal(1, store.ApplyCount);
        await pool.DidNotReceive().LeaseAsync(
            Arg.Any<FsusBlog.Shared.Contracts.Security.PerceptionCharacterV3Representation>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Execute_RetryIsIdempotentAndNeverReappliesOrConsumesPool()
    {
        var events = new List<string>();
        var store = new RecordingStore(events);
        var gate = new RecordingGate(events);
        IPerceptionCharacterV3ArtifactPool pool = SecurityChallengeProtocolActivationGuardTests.HealthyPool();
        var service = CreateService(pool, store, gate, AlwaysVerifiedFence());
        PerceptionCharacterV3CutoverRequest request = Request();

        PerceptionCharacterV3CutoverReceipt first = await service.ExecuteAsync(request);
        PerceptionCharacterV3CutoverReceipt second = await service.ExecuteAsync(request);

        Assert.True(second.Idempotent);
        Assert.Equal(first.ReceiptFingerprint, second.ReceiptFingerprint);
        Assert.Equal(1, store.ApplyCount);
        Assert.Equal(2, gate.OpenCount);
        await pool.DidNotReceive().LeaseAsync(
            Arg.Any<FsusBlog.Shared.Contracts.Security.PerceptionCharacterV3Representation>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Execute_RejectsMixedFrontendFingerprintBeforeClosingOrMutating()
    {
        var events = new List<string>();
        var store = new RecordingStore(events);
        var gate = new RecordingGate(events);
        var service = CreateService(
            SecurityChallengeProtocolActivationGuardTests.HealthyPool(),
            store,
            gate,
            AlwaysVerifiedFence());
        PerceptionCharacterV3CutoverRequest request = Request();
        request = request with
        {
            Target = request.Target with
            {
                FrontendAedsSchemaFingerprint = new string('f', 64)
            }
        };

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.ExecuteAsync(request));

        Assert.Empty(events);
        Assert.Equal(0, store.ApplyCount);
    }

    [Fact]
    public async Task Execute_DryRunDoesNotCloseOrOpenIssuance()
    {
        var events = new List<string>();
        var store = new RecordingStore(events);
        var gate = new RecordingGate(events);
        var service = CreateService(
            SecurityChallengeProtocolActivationGuardTests.HealthyPool(),
            store,
            gate,
            AlwaysVerifiedFence());

        PerceptionCharacterV3CutoverReceipt receipt = await service.ExecuteAsync(Request() with
        {
            DryRun = true
        });

        Assert.True(receipt.Accepted);
        Assert.Equal("would-activate", receipt.Status);
        Assert.Equal(["preflight", "apply", "save"], events);
        Assert.Equal(0, gate.CloseCount);
        Assert.Equal(0, gate.OpenCount);
    }

    [Fact]
    public async Task Execute_UnexpectedOpenIssuanceIsClosedAndRejectedBeforeMutation()
    {
        var events = new List<string>();
        var store = new RecordingStore(events);
        var gate = new RecordingGate(events)
        {
            InitiallyOpen = true
        };
        var service = CreateService(
            SecurityChallengeProtocolActivationGuardTests.HealthyPool(),
            store,
            gate,
            AlwaysVerifiedFence());

        PerceptionCharacterV3CutoverReceipt receipt = await service.ExecuteAsync(Request());

        Assert.False(receipt.Accepted);
        Assert.Equal("perception_character_v3_issuance_not_closed_at_cutover_start", receipt.ErrorCode);
        Assert.Equal(["smoke", "close"], events);
        Assert.Equal(0, store.ApplyCount);
    }

    [Fact]
    public async Task Execute_FenceLossAfterMutationStaysClosedAndRetryDoesNotReapply()
    {
        var events = new List<string>();
        var store = new RecordingStore(events);
        var gate = new RecordingGate(events);
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(
                SecurityChallengeProtocolActivationGuardTests.Verified(),
                SecurityChallengeProtocolActivationGuardTests.Verified(),
                SecurityChallengeProtocolActivationGuardTests.RejectedFence(),
                SecurityChallengeProtocolActivationGuardTests.Verified(),
                SecurityChallengeProtocolActivationGuardTests.Verified(),
                SecurityChallengeProtocolActivationGuardTests.Verified());
        var service = CreateService(
            SecurityChallengeProtocolActivationGuardTests.HealthyPool(),
            store,
            gate,
            fence);

        PerceptionCharacterV3CutoverReceipt rejected = await service.ExecuteAsync(Request());
        PerceptionCharacterV3CutoverReceipt accepted = await service.ExecuteAsync(Request());

        Assert.False(rejected.Accepted);
        Assert.Equal("closed", rejected.Status);
        Assert.True(accepted.Accepted);
        Assert.Equal(1, store.ApplyCount);
        Assert.Equal(2, gate.CloseCount);
        Assert.Equal(1, gate.OpenCount);
    }

    [Fact]
    public async Task Execute_SameOperationIdCannotBindAnotherRelease()
    {
        var store = new RecordingStore([]);
        var service = CreateService(
            SecurityChallengeProtocolActivationGuardTests.HealthyPool(),
            store,
            new RecordingGate([]),
            AlwaysVerifiedFence());
        await service.ExecuteAsync(Request());

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.ExecuteAsync(Request() with
        {
            ReleaseId = "release-b"
        }));
        Assert.Equal(1, store.ApplyCount);
    }

    [Fact]
    [Trait("Fixture", "LocalRedis")]
    public async Task RedisStore_RetiresAllV3NamespacesAndEnvelopeIdempotently()
    {
        string connectionString = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_REDIS")
            ?? throw new InvalidOperationException("FSUSBLOG_TEST_REDIS environment variable is not set.");
        Assert.False(string.IsNullOrWhiteSpace(connectionString), "FSUSBLOG_TEST_REDIS must not be empty.");
        string runId = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_LOCAL_REDIS_RUN_ID")
            ?? throw new InvalidOperationException("LocalRedis run identity is required.");
        Assert.False(string.IsNullOrWhiteSpace(runId), "LocalRedis run identity must not be empty.");
        Assert.DoesNotContain(":", runId);
        string redisPrefixRoot = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_REDIS_PREFIX")
            ?? throw new InvalidOperationException("LocalRedis prefix is required.");
        Assert.Equal($"test:perception-v3-local-redis:{runId}:", redisPrefixRoot);
        string evidencePath = Environment.GetEnvironmentVariable("FSUSBLOG_V3_CUTOVER_EVIDENCE_OUT")
            ?? throw new InvalidOperationException("LocalRedis cutover evidence path is required.");
        Assert.False(string.IsNullOrWhiteSpace(evidencePath), "LocalRedis cutover evidence path must not be empty.");
        string sourceCommit = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_SOURCE_COMMIT")
            ?? throw new InvalidOperationException("LocalRedis source commit is required.");
        string sourceFingerprint = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_SOURCE_FINGERPRINT")
            ?? throw new InvalidOperationException("LocalRedis source fingerprint is required.");
        Assert.False(string.IsNullOrWhiteSpace(sourceCommit), "LocalRedis source commit must not be empty.");
        Assert.False(string.IsNullOrWhiteSpace(sourceFingerprint), "LocalRedis source fingerprint must not be empty.");
        string fullEvidencePath = Path.GetFullPath(evidencePath);
        Assert.False(File.Exists(fullEvidencePath), "LocalRedis cutover evidence must be fresh for this run.");

        await using ConnectionMultiplexer redis = await ConnectionMultiplexer.ConnectAsync(connectionString);
        EndPoint endpoint = redis.GetEndPoints()[0];
        string endpointIdentity = endpoint is DnsEndPoint dns
            ? $"{dns.Host}:{dns.Port}"
            : endpoint.ToString() ?? throw new InvalidOperationException("Redis endpoint identity is unavailable.");
        string prefix = redisPrefixRoot + "cutover:";
        var scope = new PrefixRuntimeKeyScope(prefix);
        IDatabase database = redis.GetDatabase();
        IServer server = redis.GetServer(endpoint);
        Assert.Empty(server.Keys(database.Database, $"{prefix}*"));
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IUpdateable<SecurityChallenge> update = Substitute.For<IUpdateable<SecurityChallenge>>();
        db.Updateable<SecurityChallenge>().Returns(update);
        update.SetColumns(Arg.Any<Expression<Func<SecurityChallenge, SecurityChallenge>>>()).Returns(update);
        update.Where(Arg.Any<Expression<Func<SecurityChallenge, bool>>>()).Returns(update);
        update.ExecuteCommandAsync().Returns(Task.FromResult(2));
        var services = new ServiceCollection();
        services.AddScoped<ISqlSugarClient>(_ => db);
        await using ServiceProvider provider = services.BuildServiceProvider();
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?>
            {
                ["RedisOptions:InstanceName"] = string.Empty
            }).Build();
        var store = new RedisPerceptionCharacterV3CutoverStore(
            RedisOperationExecutor.ForTestConnection(redis),
            scope,
            configuration,
            provider.GetRequiredService<IServiceScopeFactory>());
        string challengeId = Guid.CreateVersion7().ToString("D");
        RedisKey stateKey = scope.PrefixKey($"security:perception-v3:{challengeId}");
        RedisKey activeKey = scope.PrefixKey("security:perception-v3-active:identity-a");
        RedisKey deviceKey = scope.PrefixKey("security:perception-v3-device:device-a");
        RedisKey ipKey = scope.PrefixKey("security:perception-v3-device-ip:ip-a");
        RedisKey oldPoolKey = scope.PrefixKey("security:perception-v3-pool:pool-old:entry:a");
        RedisKey envelopeKey = scope.PrefixKey("fsus:sec:challenge-envelope:envelope:test");
        SecurityChallengeEnvelopeState envelope = Envelope();
        string manifestSource = "canonical-test-fixture";
        string poolGeneration = SecurityChallengeProtocolActivationGuardTests.PoolGeneration;
        string poolManifestDigest = SecurityChallengeProtocolActivationGuardTests.PoolManifestDigest;
        string? manifestPath = Environment.GetEnvironmentVariable("FSUSBLOG_V3_GATE_POOL_MANIFEST");
        if (!string.IsNullOrWhiteSpace(manifestPath))
        {
            byte[] manifestBytes = await File.ReadAllBytesAsync(manifestPath);
            using JsonDocument manifest = JsonDocument.Parse(manifestBytes);
            Assert.Equal(
                "fsusblog.security.perception-character-v3.pool-manifest.v1",
                manifest.RootElement.GetProperty("schema").GetString());
            poolGeneration = manifest.RootElement.GetProperty("generationId").GetString()
                ?? throw new InvalidOperationException("The release-gate pool generation is missing.");
            Assert.False(string.IsNullOrWhiteSpace(poolGeneration));
            Assert.Equal(
                PerceptionCharacterV3ReleaseTarget.ContractDigest,
                manifest.RootElement.GetProperty("contractDigest").GetString());
            Assert.True(
                manifest.RootElement.TryGetProperty("entries", out JsonElement entries)
                && entries.ValueKind == JsonValueKind.Array
                && entries.GetArrayLength() > 0,
                "The release-gate pool manifest must contain entries.");
            poolManifestDigest = Convert.ToHexStringLower(SHA256.HashData(manifestBytes));
            manifestSource = "release-gate-manifest";
        }
        RedisKey activePoolKey = scope.PrefixKey(
            $"security:perception-v3-pool:{poolGeneration}:entry:b");
        try
        {
            await database.StringSetAsync(stateKey, "state");
            await database.StringSetAsync(activeKey, "active");
            await database.StringSetAsync(deviceKey, "device");
            await database.StringSetAsync(ipKey, "ip");
            await database.StringSetAsync(oldPoolKey, "old");
            await database.HashSetAsync(
                envelopeKey,
                "data",
                SecurityChallengeKindCutoverEnvelopeCodec.Encode(envelope));
            await database.StringSetAsync(activePoolKey, "active-pool");
            PerceptionCharacterV3CutoverTarget target = SecurityChallengeProtocolActivationGuardTests.Target() with
            {
                PoolGeneration = poolGeneration,
                PoolManifestDigest = poolManifestDigest,
                TargetFingerprint = string.Empty
            };
            target = target with
            {
                TargetFingerprint = PerceptionCharacterV3ContractCutover.ComputeTargetFingerprint(target)
            };
            IPerceptionCharacterV3ArtifactPool pool = Substitute.For<IPerceptionCharacterV3ArtifactPool>();
            pool.GetIdentityAsync(Arg.Any<CancellationToken>()).Returns(new PerceptionCharacterV3PoolIdentity(
                poolGeneration,
                poolManifestDigest,
                PerceptionCharacterV3ReleaseTarget.ContractDigest,
                new string('3', 64)));
            pool.GetInventoryAsync(Arg.Any<CancellationToken>())
                .Returns(PerceptionCharacterV3PoolInventory.UnknownHealthy(poolGeneration));
            var gate = new RecordingGate([]);
            PerceptionCharacterV3ContractCutover cutover = CreateService(
                pool,
                store,
                gate,
                AlwaysVerifiedFence());
            var request = new PerceptionCharacterV3CutoverRequest(
                "operation-release-gate",
                "release-gate",
                "green",
                42,
                target);
            PerceptionCharacterV3CutoverReceipt first = await cutover.ExecuteAsync(request);
            PerceptionCharacterV3CutoverReceipt repeated = await cutover.ExecuteAsync(request);

            Assert.True(first.Accepted);
            Assert.False(first.Idempotent);
            Assert.True(repeated.Accepted);
            Assert.True(repeated.Idempotent);
            Assert.Equal(first.ReceiptFingerprint, repeated.ReceiptFingerprint);
            Assert.Equal(first.Mutation, repeated.Mutation);
            Assert.Equal(2, first.Mutation.ChallengeRowsRevoked);
            Assert.Equal(1, first.Mutation.StateKeysRetired);
            Assert.Equal(1, first.Mutation.ActiveIdentityKeysRetired);
            Assert.Equal(2, first.Mutation.DeviceKeysRetired);
            Assert.Equal(1, first.Mutation.OldPoolGenerationsRevoked);
            Assert.Equal(1, first.Mutation.EnvelopesRevoked);
            Assert.False(await database.KeyExistsAsync(stateKey));
            Assert.False(await database.KeyExistsAsync(activeKey));
            Assert.False(await database.KeyExistsAsync(deviceKey));
            Assert.False(await database.KeyExistsAsync(ipKey));
            Assert.False(await database.KeyExistsAsync(oldPoolKey));
            Assert.True(await database.KeyExistsAsync(activePoolKey));
            RedisValue encoded = await database.HashGetAsync(envelopeKey, "data");
            bool envelopeRevoked = SecurityChallengeKindCutoverEnvelopeCodec.TryDecode(
                (string)encoded!, out SecurityChallengeEnvelopeState? revoked);
            Assert.True(envelopeRevoked);
            Assert.Equal(SecurityChallengeEnvelopeStatuses.Revoked, revoked!.Status);
            await update.Received(1).ExecuteCommandAsync();
            await pool.DidNotReceive().LeaseAsync(
                Arg.Any<PerceptionCharacterV3Representation>(),
                Arg.Any<CancellationToken>());

            var evidence = new
            {
                schema = "fsusblog.security.perception-character-v3-cutover-fixture.v1",
                testId = "FsusBlog.Server.Tests.Unit.PerceptionCharacterV3ContractCutoverTests.RedisStore_RetiresAllV3NamespacesAndEnvelopeIdempotently",
                status = "passed",
                runId,
                prefixNamespace = prefix,
                endpoint = endpointIdentity,
                sourceCommit,
                sourceFingerprint,
                releaseTargetFingerprint = PerceptionCharacterV3ReleaseTarget.TargetFingerprint,
                poolGeneration,
                poolManifestDigest,
                manifestSource,
                namespaceRetirement = new
                {
                    stateKeysRetired = !await database.KeyExistsAsync(stateKey),
                    activeIdentityKeysRetired = !await database.KeyExistsAsync(activeKey),
                    deviceKeysRetired = !await database.KeyExistsAsync(deviceKey)
                        && !await database.KeyExistsAsync(ipKey),
                    oldPoolGenerationsRevoked = !await database.KeyExistsAsync(oldPoolKey),
                    activeGenerationRetained = await database.KeyExistsAsync(activePoolKey),
                    envelopeRevoked
                },
                databaseRevoke = new
                {
                    commandCount = 1,
                    rowsRevoked = first.Mutation.ChallengeRowsRevoked
                },
                idempotency = new
                {
                    repeatedAccepted = repeated.Accepted,
                    repeatedIdempotent = repeated.Idempotent,
                    receiptFingerprintStable = first.ReceiptFingerprint == repeated.ReceiptFingerprint,
                    mutationStable = first.Mutation == repeated.Mutation,
                    poolLeaseCount = 0
                },
                first = new
                {
                    accepted = first.Accepted,
                    idempotent = first.Idempotent,
                    poolLeaseCount = 0,
                    receiptFingerprint = first.ReceiptFingerprint,
                    targetFingerprint = first.TargetFingerprint,
                    mutation = new
                    {
                        challengeRowsRevoked = first.Mutation.ChallengeRowsRevoked,
                        stateKeysRetired = first.Mutation.StateKeysRetired,
                        activeIdentityKeysRetired = first.Mutation.ActiveIdentityKeysRetired,
                        deviceKeysRetired = first.Mutation.DeviceKeysRetired,
                        oldPoolGenerationsRevoked = first.Mutation.OldPoolGenerationsRevoked,
                        envelopesExamined = first.Mutation.EnvelopesExamined,
                        envelopesRevoked = first.Mutation.EnvelopesRevoked,
                        retiredStateDigest = first.Mutation.RetiredStateDigest
                    }
                },
                second = new
                {
                    accepted = repeated.Accepted,
                    idempotent = repeated.Idempotent,
                    poolLeaseCount = 0,
                    receiptFingerprint = repeated.ReceiptFingerprint,
                    targetFingerprint = repeated.TargetFingerprint,
                    mutation = new
                    {
                        challengeRowsRevoked = repeated.Mutation.ChallengeRowsRevoked,
                        stateKeysRetired = repeated.Mutation.StateKeysRetired,
                        activeIdentityKeysRetired = repeated.Mutation.ActiveIdentityKeysRetired,
                        deviceKeysRetired = repeated.Mutation.DeviceKeysRetired,
                        oldPoolGenerationsRevoked = repeated.Mutation.OldPoolGenerationsRevoked,
                        envelopesExamined = repeated.Mutation.EnvelopesExamined,
                        envelopesRevoked = repeated.Mutation.EnvelopesRevoked,
                        retiredStateDigest = repeated.Mutation.RetiredStateDigest
                    }
                },
                oldStateConsumable = false,
                rollbackRestoresRetiredContract = false
            };
            Directory.CreateDirectory(Path.GetDirectoryName(fullEvidencePath)!);
            string temporaryEvidencePath = fullEvidencePath + "." + Guid.CreateVersion7().ToString("N") + ".tmp";
            await File.WriteAllTextAsync(
                temporaryEvidencePath,
                JsonSerializer.Serialize(evidence, new JsonSerializerOptions
                {
                    WriteIndented = true
                }) + Environment.NewLine);
            File.Move(temporaryEvidencePath, fullEvidencePath);
        }
        finally
        {
            RedisKey[] keys = server.Keys(database.Database, $"{prefix}*").ToArray();
            if (keys.Length > 0)
            {
                await database.KeyDeleteAsync(keys);
            }
        }
    }

    [Fact]
    public async Task ProtectedEndpoint_AcceptsOnlyTrustedSystemConfigFlowAndReturnsActivatedReceipt()
    {
        var store = new RecordingStore([]);
        var gate = new RecordingGate([]);
        PerceptionCharacterV3ContractCutover cutover = CreateService(
            SecurityChallengeProtocolActivationGuardTests.HealthyPool(),
            store,
            gate,
            AlwaysVerifiedFence());
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Configuration["AllowedHosts"] = "*";
        builder.Services.AddAuthorization();
        builder.Services.AddRateLimiter(options => options.AddFixedWindowLimiter("fixed_ip", limiter =>
        {
            limiter.PermitLimit = 10;
            limiter.Window = TimeSpan.FromMinutes(1);
        }));
        builder.Services.AddSingleton(cutover);
        await using WebApplication app = builder.Build();
        app.UseRouting();
        app.Use(async (context, next) =>
        {
            context.Connection.RemoteIpAddress = IPAddress.Loopback;
            context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", "39"),
                new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.SystemConfig)
            ], "test"));
            await next(context);
        });
        app.UseAuthorization();
        app.UseRateLimiter();
        app.MapActiveReleaseFenceEndpoints();
        await app.StartAsync();

        HttpClient client = app.GetTestClient();
        client.BaseAddress = new Uri("http://localhost");
        HttpResponseMessage response = await client.PostAsJsonAsync(
            ActiveReleaseFenceEndpoints.PerceptionCharacterV3CutoverPath,
            Request());
        PerceptionCharacterV3CutoverReceipt? receipt =
            await response.Content.ReadFromJsonAsync<PerceptionCharacterV3CutoverReceipt>();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(receipt);
        Assert.True(receipt.Accepted);
        Assert.Equal("activated", receipt.Status);
        Assert.Equal(1, store.ApplyCount);
    }

    private static PerceptionCharacterV3ContractCutover CreateService(
        IPerceptionCharacterV3ArtifactPool pool,
        IPerceptionCharacterV3CutoverStore store,
        IPerceptionCharacterV3ActivationGate gate,
        IActiveReleaseFence fence)
        => new(
            fence,
            pool,
            SecurityChallengeProtocolActivationGuardTests.PolicyProvider(),
            store,
            gate,
            TimeProvider.System);

    private static IActiveReleaseFence AlwaysVerifiedFence()
    {
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(SecurityChallengeProtocolActivationGuardTests.Verified());
        return fence;
    }

    private static PerceptionCharacterV3CutoverRequest Request()
        => new(
            "operation-a",
            "release-a",
            "green",
            42,
            SecurityChallengeProtocolActivationGuardTests.Target());

    private static SecurityChallengeEnvelopeState Envelope()
        => new(
            Guid.CreateVersion7().ToString("D"),
            "comment.create",
            "/api/comment",
            "subject",
            "ip",
            "device",
            "policy",
            [Guid.CreateVersion7().ToString("D")],
            [PerceptionCharacterV3ReleaseTarget.WireName],
            [SecurityChallengeEnvelopeMemberStatuses.Issued],
            0,
            1,
            SecurityChallengeEnvelopeStatuses.Active,
            1,
            ProofToken: "proof",
            ProofNonce: "nonce",
            ProofIssuedAtUnixMs: 1,
            ProofExpiresAtUnixMs: 2);

    private sealed class RecordingStore(List<string> events) : IPerceptionCharacterV3CutoverStore
    {
        private PerceptionCharacterV3CutoverReceipt? _receipt;
        private PerceptionCharacterV3CutoverMutationResult? _mutation;
        private string? _requestFingerprint;

        public int ApplyCount
        {
            get;
            private set;
        }

        public Task<PerceptionCharacterV3CutoverReceipt?> ReadReceiptAsync(
            string operationId,
            CancellationToken cancellationToken = default)
            => Task.FromResult(_receipt);

        public Task<PerceptionCharacterV3CutoverMutationResult> ApplyAsync(
            PerceptionCharacterV3CutoverRequest request,
            string requestFingerprint,
            CancellationToken cancellationToken = default)
        {
            if (_mutation is not null)
            {
                Assert.Equal(_requestFingerprint, requestFingerprint);
                return Task.FromResult(_mutation);
            }
            ApplyCount++;
            events.Add("apply");
            _requestFingerprint = requestFingerprint;
            _mutation = new PerceptionCharacterV3CutoverMutationResult(
                1,
                2,
                3,
                4,
                5,
                6,
                7,
                new string('3', 64));
            return Task.FromResult(_mutation);
        }

        public Task<PerceptionCharacterV3CutoverReceipt> SaveReceiptAsync(
            PerceptionCharacterV3CutoverReceipt receipt,
            CancellationToken cancellationToken = default)
        {
            events.Add("save");
            _receipt = receipt;
            return Task.FromResult(receipt);
        }
    }

    private sealed class RecordingGate(List<string> events) : IPerceptionCharacterV3ActivationGate
    {
        private bool _open;

        public bool InitiallyOpen
        {
            init => _open = value;
        }

        public int CloseCount
        {
            get;
            private set;
        }

        public int OpenCount
        {
            get;
            private set;
        }

        public Task<bool> IsOpenAsync(CancellationToken cancellationToken = default)
        {
            events.Add(_open ? "smoke" : "preflight");
            return Task.FromResult(_open);
        }

        public Task CloseAsync(CancellationToken cancellationToken = default)
        {
            CloseCount++;
            _open = false;
            events.Add("close");
            return Task.CompletedTask;
        }

        public Task OpenAsync(
            PerceptionCharacterV3CutoverReceipt receipt,
            CancellationToken cancellationToken = default)
        {
            OpenCount++;
            _open = true;
            events.Add("open");
            return Task.CompletedTask;
        }
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string PrefixKey(string key) => prefix + key;
    }
}

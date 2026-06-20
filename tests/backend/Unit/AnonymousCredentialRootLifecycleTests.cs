using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Services.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCredentialRootLifecycleTests
{
    private static readonly DateTimeOffset BaselineNow = DateTimeOffset.Parse("2026-06-19T00:00:00Z");
    private static readonly string IssuerPublicKeyHash = new('f', 64);

    [Fact]
    public void Migration_CreatesRootLifecycleEpochRevocationTablesAndIndexes()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260619-post-anonymous-credential-root-lifecycle");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("CREATE TABLE IF NOT EXISTS anonymous_credential_epoch", fingerprint, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS anonymous_credential_revocation", fingerprint, StringComparison.Ordinal);
        Assert.Contains("issuer_public_key_hash", fingerprint, StringComparison.Ordinal);
        Assert.Contains("unique_idx_anonymous_credential_epoch_epoch", fingerprint, StringComparison.Ordinal);
        Assert.Contains("unique_idx_anonymous_credential_root_hash", fingerprint, StringComparison.Ordinal);
        Assert.Contains("unique_idx_anonymous_credential_root_single_active", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_anonymous_credential_root_status_epoch", fingerprint, StringComparison.Ordinal);
        Assert.Contains("unique_idx_anonymous_credential_revocation_epoch_handle", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void RuntimeServices_RegisterRootLifecycleReaderWriterRevocationAndRefreshWorker()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(new ConfigurationBuilder().Build());

        Assert.Contains(services, static item => item.ServiceType == typeof(IAnonymousCredentialRootReader));
        Assert.Contains(services, static item => item.ServiceType == typeof(IAnonymousCredentialRootWriter));
        Assert.Contains(services, static item => item.ServiceType == typeof(IAnonymousCredentialRevocationService));
        Assert.Contains(services, static item =>
            item.ServiceType == typeof(IHostedService) &&
            item.ImplementationType == typeof(AnonymousCredentialRootRefreshHostedService));
    }

    [Fact]
    public async Task RootLifecycle_RotatesActiveIntoGraceAndExcludesLegacyAccumulatorFromProductionSnapshot()
    {
        string dbPath = BuildDbPath("root-lifecycle-rotate");
        try
        {
            using SqlSugarClient setup = CreateDb(dbPath);
            CreateLifecycleTables(setup);

            var clock = new MutableTimeProvider(BaselineNow);
            await using ServiceProvider provider = BuildProvider(dbPath, clock, Substitute.For<IAnonymousCredentialRootService>());
            var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
            var reader = provider.GetRequiredService<IAnonymousCredentialRootReader>();

            Result<AnonymousCredentialRootRecord> first = await writer.RotateAsync(CreateRotation(epoch: 100, rootHash: "aa01", graceMinutes: 70), CancellationToken.None);
            Result<AnonymousCredentialRootRecord> second = await writer.RotateAsync(CreateRotation(epoch: 101, rootHash: "bb02", graceMinutes: 120), CancellationToken.None);
            await reader.RefreshAsync(CancellationToken.None);

            Assert.True(first.IsSuccess, first.Error.Message);
            Assert.True(second.IsSuccess, second.Error.Message);
            Assert.False(reader.IsRootAccepted("aa01", 100));
            Assert.False(reader.IsRootAccepted("aa01", RevocationRoot(100), IssuerPublicKeyHash, 100));
            Assert.False(reader.IsRootAccepted("aa01", RevocationRoot(101), IssuerPublicKeyHash, 100));
            Assert.False(reader.IsRootAccepted("aa01", RevocationRoot(100), new string('e', 64), 100));
            Assert.False(reader.IsRootAccepted("bb02", RevocationRoot(101), IssuerPublicKeyHash, 101));
            Assert.Empty(reader.CurrentSnapshot.AcceptedRoots);

            using SqlSugarClient verifyDb = CreateDb(dbPath);
            Assert.Equal(1, await verifyDb.Queryable<AnonymousCredentialRoot>()
                .Where(static item => item.Status == AnonymousCredentialRootStatuses.Active)
                .CountAsync());
            AnonymousCredentialRoot grace = await verifyDb.Queryable<AnonymousCredentialRoot>()
                .Where(static item => item.Epoch == 100)
                .FirstAsync();
            Assert.Equal(AnonymousCredentialRootStatuses.Grace, grace.Status);

            clock.Advance(TimeSpan.FromMinutes(71));
            await reader.RefreshAsync(CancellationToken.None);

            Assert.False(reader.IsRootAccepted("aa01", 100));
            Assert.False(reader.IsRootAccepted("bb02", RevocationRoot(101), IssuerPublicKeyHash, 101));
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    [Fact]
    public async Task RootLifecycle_RefreshExcludesSeededLegacyRootFromProductionSnapshot()
    {
        string dbPath = BuildDbPath("root-lifecycle-startup");
        try
        {
            using SqlSugarClient setup = CreateDb(dbPath);
            CreateLifecycleTables(setup);
            SeedRoot(setup, epoch: 150, rootHash: "ee05", status: AnonymousCredentialRootStatuses.Active, graceMinutes: 120);

            await using ServiceProvider provider = BuildProvider(dbPath, new MutableTimeProvider(BaselineNow), Substitute.For<IAnonymousCredentialRootService>());
            var reader = provider.GetRequiredService<IAnonymousCredentialRootReader>();

            await reader.RefreshAsync(CancellationToken.None);

            Assert.False(reader.IsRootAccepted("ee05", RevocationRoot(150), IssuerPublicKeyHash, 150));
            Assert.Empty(reader.CurrentSnapshot.AcceptedRoots);
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    [Fact]
    public async Task RootLifecycle_LegacySha256AccumulatorDoesNotEnterProductionZkSnapshot()
    {
        string dbPath = BuildDbPath("root-lifecycle-legacy-accumulator");
        try
        {
            using SqlSugarClient setup = CreateDb(dbPath);
            CreateLifecycleTables(setup);
            SeedRoot(
                setup,
                epoch: 160,
                rootHash: "ee07",
                status: AnonymousCredentialRootStatuses.Active,
                graceMinutes: 120,
                circuitMetadata: LegacyRevocationAccumulatorMetadata);

            await using ServiceProvider provider = BuildProvider(dbPath, new MutableTimeProvider(BaselineNow), Substitute.For<IAnonymousCredentialRootService>());
            var reader = provider.GetRequiredService<IAnonymousCredentialRootReader>();

            await reader.RefreshAsync(CancellationToken.None);

            Assert.Empty(reader.CurrentSnapshot.AcceptedRoots);
            Assert.False(reader.IsRootAccepted("ee07", 160));
            Assert.False(reader.IsRootAccepted("ee07", RevocationRoot(160), IssuerPublicKeyHash, 160));
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    [Fact]
    public async Task RootLifecycle_RejectsRotationThatMarksLegacyAccumulatorProductionReady()
    {
        string dbPath = BuildDbPath("root-lifecycle-legacy-prod-ready");
        try
        {
            using SqlSugarClient setup = CreateDb(dbPath);
            CreateLifecycleTables(setup);

            await using ServiceProvider provider = BuildProvider(dbPath, new MutableTimeProvider(BaselineNow), Substitute.For<IAnonymousCredentialRootService>());
            var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();

            Result<AnonymousCredentialRootRecord> rotated = await writer.RotateAsync(CreateRotation(
                epoch: 161,
                rootHash: "ee08",
                circuitMetadata: LegacyRevocationAccumulatorMarkedProductionReadyMetadata), CancellationToken.None);

            Assert.True(rotated.IsFailure);
            Assert.Equal("anonymous_credential_revocation_accumulator_not_production_ready", rotated.Error.Message);
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    [Fact]
    public void CircuitFriendlyAccumulator_CreatesVerifiableSparseMerkleNonMembershipWitness()
    {
        string revokedHandle = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(IssuerPublicKeyHash, "credential:170:revoked");
        string activeHandle = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(IssuerPublicKeyHash, "credential:170:active");

        Result<string> root = AnonymousCredentialRevocationAccumulator.TryComputeCircuitFriendlyRoot(
            170,
            IssuerPublicKeyHash,
            [revokedHandle]);
        Result<AnonymousCredentialNonMembershipWitness> activeWitness =
            AnonymousCredentialRevocationAccumulator.CreateCircuitFriendlyNonMembershipWitness(
                170,
                root.Value!,
                IssuerPublicKeyHash,
                activeHandle,
                [revokedHandle]);
        Result<AnonymousCredentialNonMembershipWitness> revokedWitness =
            AnonymousCredentialRevocationAccumulator.CreateCircuitFriendlyNonMembershipWitness(
                170,
                root.Value!,
                IssuerPublicKeyHash,
                revokedHandle,
                [revokedHandle]);

        Assert.True(root.IsSuccess, root.Error.Message);
        Assert.True(activeWitness.IsSuccess, activeWitness.Error.Message);
        Assert.False(revokedWitness.IsSuccess);
        Assert.Equal("anonymous_credential_revoked", revokedWitness.Error.Message);
        AnonymousCredentialNonMembershipWitness witness = activeWitness.Value!;
        Assert.Equal(
            AnonymousCredentialRevocationAccumulator.CircuitFriendlyNonMembershipAlgorithmId,
            witness.AlgorithmId);
        Assert.Equal(128, witness.PathDepth);
        Assert.Equal(128, witness.SiblingHashes!.Count);
        Assert.True(AnonymousCredentialRevocationAccumulator.VerifyCircuitFriendlyNonMembershipWitness(
            witness,
            [revokedHandle]));
    }

    [Fact]
    public async Task RootLifecycle_CircuitFriendlyAccumulatorEntersProductionSnapshotAndRevokesWithCircuitRoot()
    {
        string dbPath = BuildDbPath("root-lifecycle-circuit-friendly-accumulator");
        try
        {
            using SqlSugarClient setup = CreateDb(dbPath);
            CreateLifecycleTables(setup);

            var rootCache = Substitute.For<IAnonymousCredentialRootService>();
            await using ServiceProvider provider = BuildProvider(dbPath, new MutableTimeProvider(BaselineNow), rootCache);
            var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
            var reader = provider.GetRequiredService<IAnonymousCredentialRootReader>();
            var revocations = provider.GetRequiredService<IAnonymousCredentialRevocationService>();
            string emptyRoot = CircuitFriendlyRevocationRoot(171);
            string handleHash = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(IssuerPublicKeyHash, "credential:171:unit");
            string revokedRoot = CircuitFriendlyRevocationRoot(171, handleHash);

            Result<AnonymousCredentialRootRecord> rotated = await writer.RotateAsync(CreateRotation(
                epoch: 171,
                rootHash: "ff01",
                revocationRootHash: emptyRoot,
                circuitMetadata: CircuitFriendlyRevocationAccumulatorMetadata), CancellationToken.None);

            Assert.True(rotated.IsSuccess, rotated.Error.Message);
            AnonymousCredentialAcceptedRoot accepted = Assert.Single(reader.CurrentSnapshot.AcceptedRoots);
            Assert.Equal(171, accepted.Epoch);
            Assert.Equal("ff01", accepted.RootHash);
            Assert.Equal(emptyRoot, accepted.RevocationRootHash);
            Assert.Equal(IssuerPublicKeyHash, accepted.IssuerPublicKeyHash);
            Assert.Equal(AnonymousCredentialRootStatuses.Active, accepted.Status);
            Assert.True(accepted.GraceExpiresAtUtc > BaselineNow);
            Assert.True(reader.IsRootAccepted("ff01", emptyRoot, IssuerPublicKeyHash, 171));

            Result revoked = await revocations.RevokeAsync(new AnonymousCredentialRevocationRequest(
                Epoch: 171,
                RevocationHandleHash: handleHash,
                RevocationRootHash: revokedRoot,
                Reason: "abuse",
                ActorId: "admin:7"), CancellationToken.None);

            Assert.True(revoked.IsSuccess, revoked.Error.Message);
            Assert.True(reader.IsRootAccepted("ff01", revokedRoot, IssuerPublicKeyHash, 171));
            rootCache.Received(2).Invalidate();

            using SqlSugarClient verifyDb = CreateDb(dbPath);
            AnonymousCredentialRoot root = await verifyDb.Queryable<AnonymousCredentialRoot>()
                .Where(static item => item.Epoch == 171)
                .FirstAsync();
            Assert.Equal(revokedRoot, root.RevocationRootHash);
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    [Fact]
    public async Task Revocation_UpdatesAccumulatorAndInvalidatesRootSnapshotCache()
    {
        string dbPath = BuildDbPath("root-lifecycle-revocation");
        try
        {
            using SqlSugarClient setup = CreateDb(dbPath);
            CreateLifecycleTables(setup);

            var rootCache = Substitute.For<IAnonymousCredentialRootService>();
            await using ServiceProvider provider = BuildProvider(dbPath, new MutableTimeProvider(BaselineNow), rootCache);
            var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
            var revocations = provider.GetRequiredService<IAnonymousCredentialRevocationService>();
            var audit = provider.GetRequiredService<CapturingAuditEventService>();

            string handleHash = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(IssuerPublicKeyHash, "credential:200:unit");
            string nextRoot = RevocationRoot(200, handleHash);
            Result<AnonymousCredentialRootRecord> rotated = await writer.RotateAsync(CreateRotation(epoch: 200, rootHash: "cc03"), CancellationToken.None);
            Result revoked = await revocations.RevokeAsync(new AnonymousCredentialRevocationRequest(
                Epoch: 200,
                RevocationHandleHash: handleHash,
                RevocationRootHash: nextRoot,
                Reason: "abuse",
                ActorId: "admin:7"), CancellationToken.None);

            Assert.True(rotated.IsSuccess, rotated.Error.Message);
            Assert.True(revoked.IsSuccess, revoked.Error.Message);
            rootCache.Received(2).Invalidate();

            using SqlSugarClient verifyDb = CreateDb(dbPath);
            AnonymousCredentialRoot root = await verifyDb.Queryable<AnonymousCredentialRoot>()
                .Where(static item => item.Epoch == 200)
                .FirstAsync();
            AnonymousCredentialRevocation row = Assert.Single(await verifyDb.Queryable<AnonymousCredentialRevocation>().ToListAsync());
            Assert.Equal(nextRoot, root.RevocationRootHash);
            Assert.Equal(handleHash, row.RevocationHandleHash);
            Assert.Equal(2, audit.Events.Count);
            Assert.All(audit.Events, static item => Assert.True(item.IsHighValue));
            string auditText = string.Join('|', audit.Events.SelectMany(static item =>
                item.Context?.Select(static pair => $"{pair.Key}:{pair.Value}") ?? []));
            Assert.DoesNotContain(handleHash, auditText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("userId", auditText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("42", auditText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("secret", auditText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("witness", auditText, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    [Fact]
    public async Task Revocation_MismatchedAccumulatorRootAndRawUserHandleFailClosed()
    {
        string dbPath = BuildDbPath("root-lifecycle-revocation-failclosed");
        try
        {
            using SqlSugarClient setup = CreateDb(dbPath);
            CreateLifecycleTables(setup);

            await using ServiceProvider provider = BuildProvider(dbPath, new MutableTimeProvider(BaselineNow), Substitute.For<IAnonymousCredentialRootService>());
            var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
            var revocations = provider.GetRequiredService<IAnonymousCredentialRevocationService>();

            Result<AnonymousCredentialRootRecord> rotated = await writer.RotateAsync(CreateRotation(epoch: 201, rootHash: "dd05"), CancellationToken.None);
            string handleHash = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(IssuerPublicKeyHash, "credential:201:unit");
            Result mismatchedRoot = await revocations.RevokeAsync(new AnonymousCredentialRevocationRequest(
                Epoch: 201,
                RevocationHandleHash: handleHash,
                RevocationRootHash: new string('0', 64)), CancellationToken.None);
            Result rawUserHandle = await revocations.RevokeAsync(new AnonymousCredentialRevocationRequest(
                Epoch: 201,
                RevocationHandleHash: "42",
                RevocationRootHash: new string('1', 64)), CancellationToken.None);

            Assert.True(rotated.IsSuccess, rotated.Error.Message);
            Assert.True(mismatchedRoot.IsFailure);
            Assert.Equal("anonymous_credential_revocation_root_mismatch", mismatchedRoot.Error.Message);
            Assert.True(rawUserHandle.IsFailure);
            Assert.Equal("anonymous_credential_revocation_invalid", rawUserHandle.Error.Message);

            using SqlSugarClient verifyDb = CreateDb(dbPath);
            Assert.Empty(await verifyDb.Queryable<AnonymousCredentialRevocation>().ToListAsync());
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    [Fact]
    public async Task Revocation_GraceExpiredRootFailsClosed()
    {
        string dbPath = BuildDbPath("root-lifecycle-revocation-grace");
        try
        {
            using SqlSugarClient setup = CreateDb(dbPath);
            CreateLifecycleTables(setup);
            var clock = new MutableTimeProvider(BaselineNow);

            await using ServiceProvider provider = BuildProvider(dbPath, clock, Substitute.For<IAnonymousCredentialRootService>());
            var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
            var revocations = provider.GetRequiredService<IAnonymousCredentialRevocationService>();

            Result<AnonymousCredentialRootRecord> rotated = await writer.RotateAsync(CreateRotation(epoch: 202, rootHash: "ee06", graceMinutes: 65), CancellationToken.None);
            clock.Advance(TimeSpan.FromMinutes(66));
            string handleHash = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(IssuerPublicKeyHash, "credential:202:unit");
            Result revoked = await revocations.RevokeAsync(new AnonymousCredentialRevocationRequest(
                Epoch: 202,
                RevocationHandleHash: handleHash,
                RevocationRootHash: RevocationRoot(202, handleHash)), CancellationToken.None);

            Assert.True(rotated.IsSuccess, rotated.Error.Message);
            Assert.True(revoked.IsFailure);
            Assert.Equal("anonymous_credential_root_not_found", revoked.Error.Message);
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    [Fact]
    public void RevocationAccumulator_NonMembershipWitnessRoundTripsAndRevokedHandleFails()
    {
        string revokedHandle = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(IssuerPublicKeyHash, "credential:revoked");
        string clearHandle = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(IssuerPublicKeyHash, "credential:clear");
        string root = RevocationRoot(300, revokedHandle);

        Result<AnonymousCredentialNonMembershipWitness> clearWitness = AnonymousCredentialRevocationAccumulator.CreateNonMembershipWitness(
            300,
            root,
            IssuerPublicKeyHash,
            clearHandle,
            [revokedHandle]);
        Result<AnonymousCredentialNonMembershipWitness> revokedWitness = AnonymousCredentialRevocationAccumulator.CreateNonMembershipWitness(
            300,
            root,
            IssuerPublicKeyHash,
            revokedHandle,
            [revokedHandle]);

        Assert.True(clearWitness.IsSuccess, clearWitness.Error.Message);
        Assert.True(AnonymousCredentialRevocationAccumulator.VerifyNonMembershipWitness(clearWitness.Value!, [revokedHandle]));
        Assert.False(AnonymousCredentialRevocationAccumulator.VerifyNonMembershipWitness(clearWitness.Value! with
        {
            RevocationRootHash = new string('0', 64)
        }, [revokedHandle]));
        Assert.True(revokedWitness.IsFailure);
        Assert.Equal("anonymous_credential_revoked", revokedWitness.Error.Message);
    }

    [Fact]
    public void RevocationAccumulator_ProfileRejectsLegacyAndAllowsCircuitFriendlyProductionReady()
    {
        AnonymousCredentialRevocationAccumulatorProfile legacy = AnonymousCredentialRevocationAccumulator.ResolveProfile(
            AnonymousCredentialRevocationAccumulator.LegacySha256HashTreeAlgorithmId,
            productionZkReady: true);
        AnonymousCredentialRevocationAccumulatorProfile reservedCircuitFriendly = AnonymousCredentialRevocationAccumulator.ResolveProfile(
            AnonymousCredentialRevocationAccumulator.CircuitFriendlyNonMembershipAlgorithmId,
            productionZkReady: true);

        Assert.False(legacy.IsProductionZkCompatible);
        Assert.Equal("legacy_sha256_not_circuit_friendly", legacy.UnavailableReason);
        Assert.True(reservedCircuitFriendly.IsProductionZkCompatible);
        Assert.Equal(string.Empty, reservedCircuitFriendly.UnavailableReason);
    }

    [Fact]
    public async Task RootLifecycle_ConcurrentDuplicateRotationKeepsSingleActiveRoot()
    {
        string dbPath = BuildDbPath("root-lifecycle-concurrent");
        try
        {
            using SqlSugarClient setup = CreateDb(dbPath);
            CreateLifecycleTables(setup);

            await using ServiceProvider provider = BuildProvider(dbPath, new MutableTimeProvider(BaselineNow), Substitute.For<IAnonymousCredentialRootService>());
            var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
            AnonymousCredentialRootRotationRequest request = CreateRotation(epoch: 300, rootHash: "dd04");

            Result<AnonymousCredentialRootRecord>[] results = await Task.WhenAll(
                writer.RotateAsync(request, CancellationToken.None),
                writer.RotateAsync(request, CancellationToken.None));

            Assert.Equal(1, results.Count(static item => item.IsSuccess));
            Assert.Equal(1, results.Count(static item => item.IsFailure && item.Error.Code == ErrorCode.Conflict));

            using SqlSugarClient verifyDb = CreateDb(dbPath);
            Assert.Equal(1, await verifyDb.Queryable<AnonymousCredentialRoot>()
                .Where(static item => item.Status == AnonymousCredentialRootStatuses.Active)
                .CountAsync());
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    private const string LegacyRevocationAccumulatorMetadata =
        "{\"layout\":2,\"revocationAccumulator\":{\"algorithm\":\"legacy-sha256-hash-tree.v1\",\"productionZkReady\":false}}";

    private const string LegacyRevocationAccumulatorMarkedProductionReadyMetadata =
        "{\"layout\":2,\"revocationAccumulator\":{\"algorithm\":\"legacy-sha256-hash-tree.v1\",\"productionZkReady\":true}}";

    private const string CircuitFriendlyRevocationAccumulatorMetadata =
        "{\"layout\":2,\"revocationAccumulator\":{\"algorithm\":\"circuit-friendly-non-membership.v1\",\"productionZkReady\":true,\"hash\":\"mimc7-bn254.v1\",\"tree\":\"sparse-merkle.v1\",\"depth\":128}}";

    private static AnonymousCredentialRootRotationRequest CreateRotation(
        long epoch,
        string rootHash,
        int graceMinutes = 120,
        string? revocationRootHash = null,
        string? circuitMetadata = null)
        => new(
            Epoch: epoch,
            RootHash: rootHash,
            RevocationRootHash: revocationRootHash ?? RevocationRoot(epoch),
            CircuitId: "fsus.anonymous.comment.v1",
            CircuitNumericId: 7,
            VerifyingKeyHash: "vk-sha256",
            PublicInputLayoutVersion: 2,
            ExpiresAtUtc: BaselineNow.AddMinutes(60),
            GraceExpiresAtUtc: BaselineNow.AddMinutes(graceMinutes),
            CircuitMetadata: circuitMetadata ?? "{\"layout\":2}",
            Reason: "unit",
            ActorId: "admin:42",
            IssuerPublicKeyHash: IssuerPublicKeyHash);

    private static string RevocationRoot(long epoch, params string[] revokedHandleHashes)
    {
        Result<string> result = AnonymousCredentialRevocationAccumulator.TryComputeRoot(
            epoch,
            IssuerPublicKeyHash,
            revokedHandleHashes);
        Assert.True(result.IsSuccess, result.Error.Message);
        return result.Value!;
    }

    private static string CircuitFriendlyRevocationRoot(long epoch, params string[] revokedHandleHashes)
    {
        Result<string> result = AnonymousCredentialRevocationAccumulator.TryComputeCircuitFriendlyRoot(
            epoch,
            IssuerPublicKeyHash,
            revokedHandleHashes);
        Assert.True(result.IsSuccess, result.Error.Message);
        return result.Value!;
    }

    private static ServiceProvider BuildProvider(
        string dbPath,
        TimeProvider timeProvider,
        IAnonymousCredentialRootService rootCache)
    {
        var services = new ServiceCollection();
        services.AddSingleton(timeProvider);
        services.AddSingleton(rootCache);
        services.AddSingleton<CapturingAuditEventService>();
        services.AddSingleton<IAuditEventService>(static sp => sp.GetRequiredService<CapturingAuditEventService>());
        services.AddScoped<ISqlSugarClient>(_ => CreateDb(dbPath));
        services.AddSingleton<AnonymousCredentialRootLifecycleService>();
        services.AddSingleton<IAnonymousCredentialRootReader>(static sp => sp.GetRequiredService<AnonymousCredentialRootLifecycleService>());
        services.AddSingleton<IAnonymousCredentialRootWriter>(static sp => sp.GetRequiredService<AnonymousCredentialRootLifecycleService>());
        services.AddSingleton<IAnonymousCredentialRevocationService>(static sp => sp.GetRequiredService<AnonymousCredentialRootLifecycleService>());
        return services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true
        });
    }

    private static string BuildDbPath(string prefix)
        => Path.Combine(Path.GetTempPath(), $"fsus-{prefix}-{Guid.NewGuid():N}.db");

    private static SqlSugarClient CreateDb(string dbPath)
        => new(new ConnectionConfig
        {
            DbType = DbType.Sqlite,
            ConnectionString = $"Data Source={dbPath}",
            InitKeyType = InitKeyType.Attribute,
            IsAutoCloseConnection = true
        });

    private static void CreateLifecycleTables(SqlSugarClient db)
    {
        db.Ado.ExecuteCommand("""
            CREATE TABLE IF NOT EXISTS anonymous_credential_epoch (
                epoch INTEGER PRIMARY KEY,
                status TEXT NOT NULL,
                created_at_utc TEXT NOT NULL,
                activated_at_utc TEXT NULL,
                expires_at_utc TEXT NOT NULL,
                root_grace_expires_at_utc TEXT NOT NULL,
                active_root_hash TEXT NULL,
                reason TEXT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_epoch_epoch ON anonymous_credential_epoch(epoch);
            """);
        db.Ado.ExecuteCommand("""
            CREATE TABLE IF NOT EXISTS anonymous_credential_root (
                epoch INTEGER PRIMARY KEY,
                root_hash TEXT NOT NULL,
                revocation_root_hash TEXT NOT NULL DEFAULT '',
                circuit_id TEXT NOT NULL,
                circuit_numeric_id INTEGER NOT NULL DEFAULT 0,
                verifying_key_hash TEXT NOT NULL,
                issuer_public_key_hash TEXT NOT NULL DEFAULT '',
                public_input_layout_version INTEGER NOT NULL,
                circuit_metadata TEXT NULL,
                created_at_utc TEXT NOT NULL,
                activated_at_utc TEXT NULL,
                expires_at_utc TEXT NOT NULL,
                root_grace_expires_at_utc TEXT NOT NULL,
                revoked_at_utc TEXT NULL,
                updated_at_utc TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                revoke_reason TEXT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_root_hash ON anonymous_credential_root(root_hash);
            CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_root_single_active ON anonymous_credential_root(status) WHERE status = 'active';
            CREATE INDEX IF NOT EXISTS idx_anonymous_credential_root_status_epoch ON anonymous_credential_root(status, epoch);
            """);
        db.Ado.ExecuteCommand("""
            CREATE TABLE IF NOT EXISTS anonymous_credential_revocation (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                epoch INTEGER NOT NULL,
                root_hash TEXT NOT NULL,
                revocation_handle_hash TEXT NOT NULL,
                revocation_root_hash TEXT NOT NULL,
                reason TEXT NULL,
                actor_id TEXT NULL,
                revoked_at_utc TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_revocation_epoch_handle
                ON anonymous_credential_revocation(epoch, revocation_handle_hash);
            """);
    }

    private static void SeedRoot(
        SqlSugarClient db,
        long epoch,
        string rootHash,
        string status,
        int graceMinutes,
        string? circuitMetadata = null)
        => db.Insertable(new AnonymousCredentialRoot
        {
            Epoch = epoch,
            RootHash = rootHash,
            RevocationRootHash = RevocationRoot(epoch),
            CircuitId = "fsus.anonymous.comment.v1",
            CircuitNumericId = 7,
            VerifyingKeyHash = "vk-sha256",
            IssuerPublicKeyHash = IssuerPublicKeyHash,
            PublicInputLayoutVersion = 2,
            CircuitMetadata = circuitMetadata ?? "{\"layout\":2}",
            CreatedAtUtc = BaselineNow.UtcDateTime,
            ActivatedAtUtc = BaselineNow.UtcDateTime,
            ExpiresAtUtc = BaselineNow.AddMinutes(60).UtcDateTime,
            GraceExpiresAtUtc = BaselineNow.AddMinutes(graceMinutes).UtcDateTime,
            UpdatedAtUtc = BaselineNow.UtcDateTime,
            Status = status
        }).ExecuteCommand();

    private static void TryDelete(string dbPath)
    {
        if (File.Exists(dbPath))
        {
            File.Delete(dbPath);
        }
    }

    private sealed class CapturingAuditEventService : IAuditEventService
    {
        public List<AuditEvent> Events { get; } = [];

        public Task RecordAsync(AuditEvent auditEvent, CancellationToken cancellationToken = default)
        {
            Events.Add(auditEvent);
            return Task.CompletedTask;
        }

        public Task RecordHighValueAsync(AuditEvent auditEvent, CancellationToken cancellationToken = default)
        {
            Events.Add(auditEvent with { IsHighValue = true });
            return Task.CompletedTask;
        }
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan interval)
            => _utcNow = _utcNow.Add(interval);
    }
}

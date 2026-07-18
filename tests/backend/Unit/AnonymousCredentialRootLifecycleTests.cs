using System.Reflection;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using NSubstitute;
using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AnonymousCredentialRootLifecycleTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTimeOffset s_baselineNow = DateTimeOffset.Parse("2026-06-19T00:00:00Z");
    private static readonly SemaphoreSlim s_databaseResetLock = new(1, 1);
    private static readonly string s_issuerPublicKeyHash = new('f', 64);
    private static string? s_sharedConnectionString;

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
        Assert.Contains("root_attestation", fingerprint, StringComparison.Ordinal);
        Assert.Contains("root_attestation_key_id", fingerprint, StringComparison.Ordinal);
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
    public void RootSnapshot_RuntimeUsesPreNormalizedLookupForVerifierHotPath()
    {
        PropertyInfo lookup = typeof(AnonymousCredentialRootRuntimeSnapshot)
            .GetProperty(nameof(AnonymousCredentialRootRuntimeSnapshot.AcceptedRootLookup))!;
        Assert.True(lookup.PropertyType.IsGenericType);
        Assert.Equal(typeof(IReadOnlyDictionary<,>), lookup.PropertyType.GetGenericTypeDefinition());
        Type keyType = lookup.PropertyType.GenericTypeArguments[0];
        Assert.Equal(typeof(ValueTuple<long, string, string, string>), keyType);

        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(AnonymousCredentialRootLifecycleService),
            nameof(AnonymousCredentialRootLifecycleService.IsRootAccepted));
        Assert.Contains("get_AcceptedRootLookup", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("TryGetValue", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("NormalizeToken", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("GetEnumerator", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RootLifecycle_RotatesActiveIntoGraceAndExcludesLegacyAccumulatorFromProductionSnapshot()
    {
        string connectionString = await CreateConnectionStringAsync();

        var clock = new MutableTimeProvider(s_baselineNow);
        await using ServiceProvider provider = BuildProvider(connectionString, clock, Substitute.For<IAnonymousCredentialRootService>());
        var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
        var reader = provider.GetRequiredService<IAnonymousCredentialRootReader>();

        Result<AnonymousCredentialRootRecord> first = await writer.RotateAsync(CreateRotation(epoch: 100, rootHash: "aa01", graceMinutes: 70), CancellationToken.None);
        Result<AnonymousCredentialRootRecord> second = await writer.RotateAsync(CreateRotation(epoch: 101, rootHash: "bb02", graceMinutes: 120), CancellationToken.None);
        await reader.RefreshAsync(CancellationToken.None);

        Assert.True(first.IsSuccess, first.Error.Message);
        Assert.True(second.IsSuccess, second.Error.Message);
        Assert.False(reader.IsRootAccepted("aa01", 100));
        Assert.False(reader.IsRootAccepted("aa01", RevocationRoot(100), s_issuerPublicKeyHash, 100));
        Assert.False(reader.IsRootAccepted("aa01", RevocationRoot(101), s_issuerPublicKeyHash, 100));
        Assert.False(reader.IsRootAccepted("aa01", RevocationRoot(100), new string('e', 64), 100));
        Assert.False(reader.IsRootAccepted("bb02", RevocationRoot(101), s_issuerPublicKeyHash, 101));
        Assert.Empty(reader.CurrentSnapshot.AcceptedRoots);

        using SqlSugarClient verifyDb = CreateDb(connectionString);
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
        Assert.False(reader.IsRootAccepted("bb02", RevocationRoot(101), s_issuerPublicKeyHash, 101));
    }

    [Fact]
    public async Task RootLifecycle_RefreshExcludesSeededLegacyRootFromProductionSnapshot()
    {
        string connectionString = await CreateConnectionStringAsync();
        using SqlSugarClient setup = CreateDb(connectionString);
        SeedRoot(setup, epoch: 150, rootHash: "ee05", status: AnonymousCredentialRootStatuses.Active, graceMinutes: 120);

        await using ServiceProvider provider = BuildProvider(connectionString, new MutableTimeProvider(s_baselineNow), Substitute.For<IAnonymousCredentialRootService>());
        var reader = provider.GetRequiredService<IAnonymousCredentialRootReader>();

        await reader.RefreshAsync(CancellationToken.None);

        Assert.False(reader.IsRootAccepted("ee05", RevocationRoot(150), s_issuerPublicKeyHash, 150));
        Assert.Empty(reader.CurrentSnapshot.AcceptedRoots);
    }

    [Fact]
    public async Task RootLifecycle_LegacySha256AccumulatorDoesNotEnterProductionZkSnapshot()
    {
        string connectionString = await CreateConnectionStringAsync();
        using SqlSugarClient setup = CreateDb(connectionString);
        SeedRoot(
            setup,
            epoch: 160,
            rootHash: "ee07",
            status: AnonymousCredentialRootStatuses.Active,
            graceMinutes: 120,
            circuitMetadata: LegacyRevocationAccumulatorMetadata);

        await using ServiceProvider provider = BuildProvider(connectionString, new MutableTimeProvider(s_baselineNow), Substitute.For<IAnonymousCredentialRootService>());
        var reader = provider.GetRequiredService<IAnonymousCredentialRootReader>();

        await reader.RefreshAsync(CancellationToken.None);

        Assert.Empty(reader.CurrentSnapshot.AcceptedRoots);
        Assert.False(reader.IsRootAccepted("ee07", 160));
        Assert.False(reader.IsRootAccepted("ee07", RevocationRoot(160), s_issuerPublicKeyHash, 160));
    }

    [Fact]
    public async Task RootLifecycle_RefreshExcludesProductionRootWithoutTrustedAttestation()
    {
        string connectionString = await CreateConnectionStringAsync();
        using SqlSugarClient setup = CreateDb(connectionString);
        SeedRoot(
            setup,
            epoch: 162,
            rootHash: "ee09",
            status: AnonymousCredentialRootStatuses.Active,
            graceMinutes: 120,
            circuitMetadata: CircuitFriendlyRevocationAccumulatorMetadata);

        await using ServiceProvider provider = BuildProvider(connectionString, new MutableTimeProvider(s_baselineNow), Substitute.For<IAnonymousCredentialRootService>());
        var reader = provider.GetRequiredService<IAnonymousCredentialRootReader>();

        await reader.RefreshAsync(CancellationToken.None);

        Assert.Empty(reader.CurrentSnapshot.AcceptedRoots);
        Assert.False(reader.IsRootAccepted("ee09", CircuitFriendlyRevocationRoot(162), s_issuerPublicKeyHash, 162));
    }

    [Fact]
    public async Task RootStore_ReturnsOnlyAttestedActiveRoot()
    {
        string connectionString = await CreateConnectionStringAsync();
        using SqlSugarClient setup = CreateDb(connectionString);
        SeedRoot(
            setup,
            epoch: 166,
            rootHash: "ee13",
            status: AnonymousCredentialRootStatuses.Active,
            graceMinutes: 120,
            circuitMetadata: CircuitFriendlyRevocationAccumulatorMetadata);
        var store = new AnonymousCredentialRootStore(setup, BuildRootAttestationConfiguration());

        AnonymousCredentialRootRecord? unattested = await store.GetCurrentAsync(s_baselineNow, CancellationToken.None);

        Assert.Null(unattested);

        await using ServiceProvider provider = BuildProvider(connectionString, new MutableTimeProvider(s_baselineNow), Substitute.For<IAnonymousCredentialRootService>());
        var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
        string attestedRevocationRoot = CircuitFriendlyRevocationRoot(167);
        Result<AnonymousCredentialRootRecord> rotated = await writer.RotateAsync(CreateRotation(
            epoch: 167,
            rootHash: "ee14",
            revocationRootHash: attestedRevocationRoot,
            circuitMetadata: CircuitFriendlyRevocationAccumulatorMetadata), CancellationToken.None);

        Assert.True(rotated.IsSuccess, rotated.Error.Message);
        AnonymousCredentialRootRecord? attested = await store.GetCurrentAsync(s_baselineNow, CancellationToken.None);
        Assert.NotNull(attested);
        Assert.Equal(167, attested.Value.CredentialEpoch);
        Assert.Equal("ee14", attested.Value.RootHash);
    }

    [Fact]
    public async Task RootLifecycle_GraceRootExpiresFromProductionSnapshotAfterFreshnessWindow()
    {
        string connectionString = await CreateConnectionStringAsync();

        var clock = new MutableTimeProvider(s_baselineNow);
        await using ServiceProvider provider = BuildProvider(connectionString, clock, Substitute.For<IAnonymousCredentialRootService>());
        var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
        var reader = provider.GetRequiredService<IAnonymousCredentialRootReader>();
        string firstRoot = CircuitFriendlyRevocationRoot(163);
        string secondRoot = CircuitFriendlyRevocationRoot(164);

        Result<AnonymousCredentialRootRecord> first = await writer.RotateAsync(CreateRotation(
            epoch: 163,
            rootHash: "ee10",
            revocationRootHash: firstRoot,
            circuitMetadata: CircuitFriendlyRevocationAccumulatorMetadata), CancellationToken.None);
        clock.Advance(TimeSpan.FromSeconds(10));
        Result<AnonymousCredentialRootRecord> second = await writer.RotateAsync(CreateRotation(
            epoch: 164,
            rootHash: "ee11",
            revocationRootHash: secondRoot,
            circuitMetadata: CircuitFriendlyRevocationAccumulatorMetadata), CancellationToken.None);

        Assert.True(first.IsSuccess, first.Error.Message);
        Assert.True(second.IsSuccess, second.Error.Message);
        Assert.True(reader.IsRootAccepted("ee10", firstRoot, s_issuerPublicKeyHash, 163));
        Assert.True(reader.IsRootAccepted("ee11", secondRoot, s_issuerPublicKeyHash, 164));

        clock.Advance(TimeSpan.FromSeconds(301));
        await reader.RefreshAsync(CancellationToken.None);

        Assert.False(reader.IsRootAccepted("ee10", firstRoot, s_issuerPublicKeyHash, 163));
        Assert.True(reader.IsRootAccepted("ee11", secondRoot, s_issuerPublicKeyHash, 164));
    }

    [Fact]
    public async Task RootLifecycle_RejectsRotationThatMarksLegacyAccumulatorProductionReady()
    {
        string connectionString = await CreateConnectionStringAsync();

        await using ServiceProvider provider = BuildProvider(connectionString, new MutableTimeProvider(s_baselineNow), Substitute.For<IAnonymousCredentialRootService>());
        var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();

        Result<AnonymousCredentialRootRecord> rotated = await writer.RotateAsync(CreateRotation(
            epoch: 161,
            rootHash: "ee08",
            circuitMetadata: LegacyRevocationAccumulatorMarkedProductionReadyMetadata), CancellationToken.None);

        Assert.True(rotated.IsFailure);
        Assert.Equal("anonymous_credential_revocation_accumulator_not_production_ready", rotated.Error.Message);
    }

    [Fact]
    public void CircuitFriendlyAccumulator_CreatesVerifiableSparseMerkleNonMembershipWitness()
    {
        string revokedHandle = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(s_issuerPublicKeyHash, "credential:170:revoked");
        string activeHandle = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(s_issuerPublicKeyHash, "credential:170:active");

        Result<string> root = AnonymousCredentialRevocationAccumulator.TryComputeCircuitFriendlyRoot(
            170,
            s_issuerPublicKeyHash,
            [revokedHandle]);
        Result<AnonymousCredentialNonMembershipWitness> activeWitness =
            AnonymousCredentialRevocationAccumulator.CreateCircuitFriendlyNonMembershipWitness(
                170,
                root.Value!,
                s_issuerPublicKeyHash,
                activeHandle,
                [revokedHandle]);
        Result<AnonymousCredentialNonMembershipWitness> revokedWitness =
            AnonymousCredentialRevocationAccumulator.CreateCircuitFriendlyNonMembershipWitness(
                170,
                root.Value!,
                s_issuerPublicKeyHash,
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
    public void CircuitFriendlyAccumulator_VerifiesWitnessUsingOnlyCircuitPublicInputs()
    {
        string revokedHandle = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(s_issuerPublicKeyHash, "credential:170:circuit-revoked");
        string activeHandle = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(s_issuerPublicKeyHash, "credential:170:circuit-active");
        string root = CircuitFriendlyRevocationRoot(170, revokedHandle);
        AnonymousCredentialNonMembershipWitness witness =
            AnonymousCredentialRevocationAccumulator.CreateCircuitFriendlyNonMembershipWitness(
                170,
                root,
                s_issuerPublicKeyHash,
                activeHandle,
                [revokedHandle]).Value!;

        Assert.True(AnonymousCredentialRevocationAccumulator.VerifyCircuitFriendlyNonMembershipWitness(witness));
        Assert.False(AnonymousCredentialRevocationAccumulator.VerifyCircuitFriendlyNonMembershipWitness(witness with
        {
            LeafKey = new string('0', 32)
        }));

        string[] tamperedSiblings = witness.SiblingHashes!.ToArray();
        tamperedSiblings[7] = new string('a', 64);
        Assert.False(AnonymousCredentialRevocationAccumulator.VerifyCircuitFriendlyNonMembershipWitness(witness with
        {
            SiblingHashes = tamperedSiblings
        }));
    }

    [Fact]
    public async Task RootLifecycle_CircuitFriendlyAccumulatorEntersProductionSnapshotAndRevokesWithCircuitRoot()
    {
        string connectionString = await CreateConnectionStringAsync();

        var rootCache = Substitute.For<IAnonymousCredentialRootService>();
        await using ServiceProvider provider = BuildProvider(connectionString, new MutableTimeProvider(s_baselineNow), rootCache);
        var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
        var reader = provider.GetRequiredService<IAnonymousCredentialRootReader>();
        var revocations = provider.GetRequiredService<IAnonymousCredentialRevocationService>();
        string emptyRoot = CircuitFriendlyRevocationRoot(171);
        string handleHash = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(s_issuerPublicKeyHash, "credential:171:unit");
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
        Assert.Equal(s_issuerPublicKeyHash, accepted.IssuerPublicKeyHash);
        Assert.Equal(AnonymousCredentialRootStatuses.Active, accepted.Status);
        Assert.True(accepted.GraceExpiresAtUtc > s_baselineNow);
        Assert.True(reader.IsRootAccepted("ff01", emptyRoot, s_issuerPublicKeyHash, 171));
        using (SqlSugarClient attestationDb = CreateDb(connectionString))
        {
            AnonymousCredentialRoot storedRoot = await attestationDb.Queryable<AnonymousCredentialRoot>()
                .Where(static item => item.Epoch == 171)
                .FirstAsync();
            Assert.False(string.IsNullOrWhiteSpace(storedRoot.RootAttestation));
            Assert.Equal("local-test-root-attestation", storedRoot.RootAttestationKeyId);
        }

        Result revoked = await revocations.RevokeAsync(new AnonymousCredentialRevocationRequest(
            Epoch: 171,
            RevocationHandleHash: handleHash,
            RevocationRootHash: revokedRoot,
            Reason: "abuse",
            ActorId: "admin:7"), CancellationToken.None);

        Assert.True(revoked.IsSuccess, revoked.Error.Message);
        Assert.True(reader.IsRootAccepted("ff01", revokedRoot, s_issuerPublicKeyHash, 171));
        rootCache.Received(2).Invalidate();

        using SqlSugarClient verifyDb = CreateDb(connectionString);
        AnonymousCredentialRoot root = await verifyDb.Queryable<AnonymousCredentialRoot>()
            .Where(static item => item.Epoch == 171)
            .FirstAsync();
        Assert.Equal(revokedRoot, root.RevocationRootHash);
    }

    [Fact]
    public async Task Revocation_UpdatesAccumulatorAndInvalidatesRootSnapshotCache()
    {
        string connectionString = await CreateConnectionStringAsync();

        var rootCache = Substitute.For<IAnonymousCredentialRootService>();
        await using ServiceProvider provider = BuildProvider(connectionString, new MutableTimeProvider(s_baselineNow), rootCache);
        var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
        var revocations = provider.GetRequiredService<IAnonymousCredentialRevocationService>();
        var audit = provider.GetRequiredService<CapturingAuditEventService>();

        string handleHash = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(s_issuerPublicKeyHash, "credential:200:unit");
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

        using SqlSugarClient verifyDb = CreateDb(connectionString);
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

    [Fact]
    public async Task Revocation_MismatchedAccumulatorRootAndRawUserHandleFailClosed()
    {
        string connectionString = await CreateConnectionStringAsync();

        await using ServiceProvider provider = BuildProvider(connectionString, new MutableTimeProvider(s_baselineNow), Substitute.For<IAnonymousCredentialRootService>());
        var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
        var revocations = provider.GetRequiredService<IAnonymousCredentialRevocationService>();

        Result<AnonymousCredentialRootRecord> rotated = await writer.RotateAsync(CreateRotation(epoch: 201, rootHash: "dd05"), CancellationToken.None);
        string handleHash = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(s_issuerPublicKeyHash, "credential:201:unit");
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

        using SqlSugarClient verifyDb = CreateDb(connectionString);
        Assert.Empty(await verifyDb.Queryable<AnonymousCredentialRevocation>().ToListAsync());
    }

    [Fact]
    public async Task Revocation_GraceExpiredRootFailsClosed()
    {
        string connectionString = await CreateConnectionStringAsync();
        var clock = new MutableTimeProvider(s_baselineNow);

        await using ServiceProvider provider = BuildProvider(connectionString, clock, Substitute.For<IAnonymousCredentialRootService>());
        var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
        var revocations = provider.GetRequiredService<IAnonymousCredentialRevocationService>();

        Result<AnonymousCredentialRootRecord> rotated = await writer.RotateAsync(CreateRotation(epoch: 202, rootHash: "ee06", graceMinutes: 65), CancellationToken.None);
        clock.Advance(TimeSpan.FromMinutes(66));
        string handleHash = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(s_issuerPublicKeyHash, "credential:202:unit");
        Result revoked = await revocations.RevokeAsync(new AnonymousCredentialRevocationRequest(
            Epoch: 202,
            RevocationHandleHash: handleHash,
            RevocationRootHash: RevocationRoot(202, handleHash)), CancellationToken.None);

        Assert.True(rotated.IsSuccess, rotated.Error.Message);
        Assert.True(revoked.IsFailure);
        Assert.Equal("anonymous_credential_root_not_found", revoked.Error.Message);
    }

    [Fact]
    public void RevocationAccumulator_NonMembershipWitnessRoundTripsAndRevokedHandleFails()
    {
        string revokedHandle = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(s_issuerPublicKeyHash, "credential:revoked");
        string clearHandle = AnonymousCredentialRevocationAccumulator.DeriveHandleHash(s_issuerPublicKeyHash, "credential:clear");
        string root = RevocationRoot(300, revokedHandle);

        Result<AnonymousCredentialNonMembershipWitness> clearWitness = AnonymousCredentialRevocationAccumulator.CreateNonMembershipWitness(
            300,
            root,
            s_issuerPublicKeyHash,
            clearHandle,
            [revokedHandle]);
        Result<AnonymousCredentialNonMembershipWitness> revokedWitness = AnonymousCredentialRevocationAccumulator.CreateNonMembershipWitness(
            300,
            root,
            s_issuerPublicKeyHash,
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
        Assert.Equal(128, reservedCircuitFriendly.PathDepth);
        Assert.Equal("mimc7-bn254.v1", reservedCircuitFriendly.HashId);
        Assert.Equal("sparse-merkle.v1", reservedCircuitFriendly.TreeId);
    }

    [Fact]
    public async Task RootLifecycle_RejectsProductionAccumulatorWithPathDepthMismatch()
    {
        string connectionString = await CreateConnectionStringAsync();

        await using ServiceProvider provider = BuildProvider(connectionString, new MutableTimeProvider(s_baselineNow), Substitute.For<IAnonymousCredentialRootService>());
        var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();

        Result<AnonymousCredentialRootRecord> rotated = await writer.RotateAsync(CreateRotation(
            epoch: 165,
            rootHash: "ee12",
            circuitMetadata: CircuitFriendlyWrongDepthRevocationAccumulatorMetadata), CancellationToken.None);

        Assert.True(rotated.IsFailure);
        Assert.Equal("anonymous_credential_revocation_accumulator_not_production_ready", rotated.Error.Message);
    }

    [Fact]
    public async Task RootLifecycle_ConcurrentDuplicateRotationKeepsSingleActiveRoot()
    {
        string connectionString = await CreateConnectionStringAsync();

        await using ServiceProvider provider = BuildProvider(connectionString, new MutableTimeProvider(s_baselineNow), Substitute.For<IAnonymousCredentialRootService>());
        var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
        AnonymousCredentialRootRotationRequest request = CreateRotation(epoch: 300, rootHash: "dd04");

        Result<AnonymousCredentialRootRecord>[] results = await Task.WhenAll(
            writer.RotateAsync(request, CancellationToken.None),
            writer.RotateAsync(request, CancellationToken.None));

        Assert.Equal(1, results.Count(static item => item.IsSuccess));
        Assert.Equal(1, results.Count(static item => item.IsFailure && item.Error.Code == ErrorCode.Conflict));

        using SqlSugarClient verifyDb = CreateDb(connectionString);
        Assert.Equal(1, await verifyDb.Queryable<AnonymousCredentialRoot>()
            .Where(static item => item.Status == AnonymousCredentialRootStatuses.Active)
            .CountAsync());
    }

    private const string LegacyRevocationAccumulatorMetadata =
        "{\"layout\":3,\"revocationAccumulator\":{\"algorithm\":\"legacy-sha256-hash-tree.v1\",\"productionZkReady\":false}}";

    private const string LegacyRevocationAccumulatorMarkedProductionReadyMetadata =
        "{\"layout\":3,\"revocationAccumulator\":{\"algorithm\":\"legacy-sha256-hash-tree.v1\",\"productionZkReady\":true}}";

    private const string CircuitFriendlyRevocationAccumulatorMetadata =
        "{\"layout\":3,\"revocationAccumulator\":{\"algorithm\":\"circuit-friendly-non-membership.v1\",\"productionZkReady\":true,\"hash\":\"mimc7-bn254.v1\",\"tree\":\"sparse-merkle.v1\",\"depth\":128}}";

    private const string CircuitFriendlyWrongDepthRevocationAccumulatorMetadata =
        "{\"layout\":3,\"revocationAccumulator\":{\"algorithm\":\"circuit-friendly-non-membership.v1\",\"productionZkReady\":true,\"hash\":\"mimc7-bn254.v1\",\"tree\":\"sparse-merkle.v1\",\"depth\":64}}";

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
            CircuitId: "fsus.anonymous.comment.v3",
            CircuitNumericId: 7,
            VerifyingKeyHash: "vk-sha256",
            PublicInputLayoutVersion: 4,
            ExpiresAtUtc: s_baselineNow.AddMinutes(60),
            GraceExpiresAtUtc: s_baselineNow.AddMinutes(graceMinutes),
            CircuitMetadata: circuitMetadata ?? "{\"layout\":3}",
            Reason: "unit",
            ActorId: "admin:42",
            IssuerPublicKeyHash: s_issuerPublicKeyHash);

    private static string RevocationRoot(long epoch, params string[] revokedHandleHashes)
    {
        Result<string> result = AnonymousCredentialRevocationAccumulator.TryComputeRoot(
            epoch,
            s_issuerPublicKeyHash,
            revokedHandleHashes);
        Assert.True(result.IsSuccess, result.Error.Message);
        return result.Value!;
    }

    private static string CircuitFriendlyRevocationRoot(long epoch, params string[] revokedHandleHashes)
    {
        Result<string> result = AnonymousCredentialRevocationAccumulator.TryComputeCircuitFriendlyRoot(
            epoch,
            s_issuerPublicKeyHash,
            revokedHandleHashes);
        Assert.True(result.IsSuccess, result.Error.Message);
        return result.Value!;
    }

    private static ServiceProvider BuildProvider(
        string connectionString,
        TimeProvider timeProvider,
        IAnonymousCredentialRootService rootCache)
    {
        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(BuildRootAttestationConfiguration());
        services.AddSingleton(timeProvider);
        services.AddSingleton(rootCache);
        services.AddSingleton<CapturingAuditEventService>();
        services.AddSingleton<IAuditEventService>(static sp => sp.GetRequiredService<CapturingAuditEventService>());
        services.AddScoped<ISqlSugarClient>(_ => CreateDb(connectionString));
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

    private static IConfiguration BuildRootAttestationConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AnonymousCredentialRoot:AttestationKey"] = "unit-test-root-attestation-key-with-at-least-thirty-two-chars",
                ["AnonymousCredentialRoot:AttestationKeyId"] = "local-test-root-attestation"
            })
            .Build();

    private async Task<string> CreateConnectionStringAsync()
    {
        await s_databaseResetLock.WaitAsync();
        try
        {
            string connectionString;
            if (s_sharedConnectionString is null)
            {
                connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
                using SqlSugarClient db = CreateDb(connectionString);
                CreateLifecycleTables(db);
                s_sharedConnectionString = connectionString;
            }
            else
            {
                connectionString = s_sharedConnectionString;
            }

            await fixture.ExecuteAsync(
                connectionString,
                "TRUNCATE TABLE anonymous_credential_revocation, anonymous_credential_root, anonymous_credential_epoch RESTART IDENTITY CASCADE;");
            return connectionString;
        }
        finally
        {
            s_databaseResetLock.Release();
        }
    }

    private static SqlSugarClient CreateDb(string connectionString)
        => PostgresSqlSugarTestClient.Create(connectionString);

    private static void CreateLifecycleTables(SqlSugarClient db)
    {
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(AnonymousCredentialEpoch),
            typeof(AnonymousCredentialRoot),
            typeof(AnonymousCredentialRevocation));
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
            CircuitId = "fsus.anonymous.comment.v3",
            CircuitNumericId = 7,
            VerifyingKeyHash = "vk-sha256",
            IssuerPublicKeyHash = s_issuerPublicKeyHash,
            PublicInputLayoutVersion = 4,
            CircuitMetadata = circuitMetadata ?? "{\"layout\":3}",
            CreatedAtUtc = s_baselineNow.UtcDateTime,
            ActivatedAtUtc = s_baselineNow.UtcDateTime,
            ExpiresAtUtc = s_baselineNow.AddMinutes(60).UtcDateTime,
            GraceExpiresAtUtc = s_baselineNow.AddMinutes(graceMinutes).UtcDateTime,
            UpdatedAtUtc = s_baselineNow.UtcDateTime,
            Status = status
        }).ExecuteCommand();

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
            Events.Add(auditEvent with
            {
                IsHighValue = true
            });
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

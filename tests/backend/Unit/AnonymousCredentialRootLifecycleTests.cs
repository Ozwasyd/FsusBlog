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
    public async Task RootLifecycle_RotatesActiveIntoGraceAndAcceptsActiveAndGraceOnly()
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
            Assert.True(reader.IsRootAccepted("aa01", 100));
            Assert.True(reader.IsRootAccepted("bb02", 101));

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
            Assert.True(reader.IsRootAccepted("bb02", 101));
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    [Fact]
    public async Task RootLifecycle_RefreshLoadsSeededActiveRootSnapshot()
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

            Assert.True(reader.IsRootAccepted("ee05", 150));
            Assert.Contains(reader.CurrentSnapshot.AcceptedRoots, static root =>
                root.Epoch == 150 &&
                root.Status == AnonymousCredentialRootStatuses.Active);
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

            Result<AnonymousCredentialRootRecord> rotated = await writer.RotateAsync(CreateRotation(epoch: 200, rootHash: "cc03"), CancellationToken.None);
            Result revoked = await revocations.RevokeAsync(new AnonymousCredentialRevocationRequest(
                Epoch: 200,
                RevocationHandleHash: "handle-sha256",
                RevocationRootHash: "revocation-root-v2",
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
            Assert.Equal("revocation-root-v2", root.RevocationRootHash);
            Assert.Equal("handle-sha256", row.RevocationHandleHash);
            Assert.Equal(2, audit.Events.Count);
            Assert.All(audit.Events, static item => Assert.True(item.IsHighValue));
            string auditText = string.Join('|', audit.Events.SelectMany(static item =>
                item.Context?.Select(static pair => $"{pair.Key}:{pair.Value}") ?? []));
            Assert.DoesNotContain("secret", auditText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("witness", auditText, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            TryDelete(dbPath);
        }
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

    private static AnonymousCredentialRootRotationRequest CreateRotation(long epoch, string rootHash, int graceMinutes = 120)
        => new(
            Epoch: epoch,
            RootHash: rootHash,
            RevocationRootHash: $"revocation-{rootHash}",
            CircuitId: "fsus.anonymous.comment.v1",
            CircuitNumericId: 7,
            VerifyingKeyHash: "vk-sha256",
            PublicInputLayoutVersion: 2,
            ExpiresAtUtc: BaselineNow.AddMinutes(60),
            GraceExpiresAtUtc: BaselineNow.AddMinutes(graceMinutes),
            CircuitMetadata: "{\"layout\":2}",
            Reason: "unit",
            ActorId: "admin:42");

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

    private static void SeedRoot(SqlSugarClient db, long epoch, string rootHash, string status, int graceMinutes)
        => db.Insertable(new AnonymousCredentialRoot
        {
            Epoch = epoch,
            RootHash = rootHash,
            RevocationRootHash = $"revocation-{rootHash}",
            CircuitId = "fsus.anonymous.comment.v1",
            CircuitNumericId = 7,
            VerifyingKeyHash = "vk-sha256",
            PublicInputLayoutVersion = 2,
            CircuitMetadata = "{\"layout\":2}",
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

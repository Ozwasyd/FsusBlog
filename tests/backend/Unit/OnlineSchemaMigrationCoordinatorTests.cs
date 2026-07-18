using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using FsusBlog.Server.Infrastructure.SchemaMigration;
namespace FsusBlog.Server.Tests.Unit;

public sealed class OnlineSchemaMigrationCoordinatorTests
{
    [Fact]
    public async Task Backfill_ResumesFromDurableTokenAndVerifiesBeforeCompletion()
    {
        ISchemaMigrationDescriptor descriptor = Descriptor(
            "20260712-post-resumable-backfill",
            []);
        OnlineSchemaMigrationMetadata metadata = Metadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Backfill) with
        {
            BatchSize = 100,
            ResumeTokenName = "last_id",
            RollbackMode = OnlineSchemaMigrationRollbackMode.ResumeFromCheckpoint
        };
        var stateStore = new RecordingStateStore(new OnlineSchemaDatabaseSnapshot(
            true,
            "20260712-schema",
            [],
            new Dictionary<string, OnlineSchemaBackfillSnapshot>(StringComparer.Ordinal)
            {
                [descriptor.MigrationId] = new(
                    descriptor.MigrationId,
                    "paused",
                    "100",
                    100,
                    0,
                    DateTimeOffset.Parse("2026-07-12T00:00:00Z"))
            }));
        var handler = new RecordingBackfillHandler(descriptor.MigrationId);
        var migrationLock = new RecordingMigrationLock();
        OnlineSchemaMigrationCoordinator coordinator = CreateCoordinator(
            descriptor,
            metadata,
            stateStore,
            migrationLock,
            handlers: [handler]);

        OnlineSchemaMigrationExecutionResult result = await coordinator.ExecuteAsync(
            phase: OnlineSchemaMigrationPhase.Backfill,
            migrationId: descriptor.MigrationId,
            releaseId: "20260720-current",
            contractEvidence: null,
            dryRun: false,
            cancellationToken: CancellationToken.None);

        Assert.Equal("ok", result.Status);
        Assert.Equal("100", Assert.Single(handler.ResumeTokens));
        Assert.True(handler.Verified);
        Assert.Equal(descriptor.MigrationId, Assert.Single(stateStore.AppliedMigrationIds));
        Assert.Equal("completed", stateStore.BackfillWrites.Last().Status);
        Assert.Equal(1, migrationLock.AcquireCount);
        Assert.Equal(1, migrationLock.DisposeCount);
    }

    [Fact]
    public async Task Contract_IsGatedBeforeAnyDestructiveDescriptorExecutes()
    {
        ISchemaMigrationDescriptor descriptor = Descriptor(
            "20260712-post-drop-legacy-column",
            [new DropColumnStep("article", "legacy_column", DestructiveMigrationProofs.For("20260418-post-content-cleanup"))]);
        OnlineSchemaMigrationMetadata metadata = Metadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Contract) with
        {
            Destructive = true,
            RequiresExclusiveMode = true,
            RollbackMode = OnlineSchemaMigrationRollbackMode.BackupRestore,
            ContractAfterRelease = "20260710-contract-fence",
            MinimumRetentionWindow = TimeSpan.FromDays(7)
        };
        var executor = new RecordingDescriptorExecutor();
        var stateStore = new RecordingStateStore(EmptyDatabase());
        OnlineSchemaMigrationCoordinator coordinator = CreateCoordinator(
            descriptor,
            metadata,
            stateStore,
            new RecordingMigrationLock(),
            executor: executor);
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var incomplete = new OnlineSchemaContractEvidence(
            CurrentReleaseUsesOldSchema: true,
            PreviousRollbackReleaseUsesOldSchema: true,
            BackfillComplete: false,
            BackfillVerified: false,
            ObservationStartedAtUtc: now,
            BackupRestoreVerifiedAtUtc: null,
            SlotSwitchInProgress: true,
            DestructiveChangeConfirmed: false,
            RollbackManifestSealed: false,
            OldWritesDisabled: false,
            ExclusiveModeEnabled: false);

        OnlineSchemaMigrationExecutionResult result = await coordinator.ExecuteAsync(
            phase: OnlineSchemaMigrationPhase.Contract,
            migrationId: null,
            releaseId: "20260720-current",
            contractEvidence: incomplete,
            dryRun: false,
            cancellationToken: CancellationToken.None);

        Assert.Equal("failed", result.Status);
        Assert.Empty(executor.ExecutedMigrationIds);
        Assert.Contains("schema_contract_backfill_incomplete", result.Codes);
        Assert.Contains("schema_contract_slot_switch_in_progress", result.Codes);
        Assert.Contains("schema_contract_confirmation_missing", result.Codes);
    }

    [Fact]
    public async Task Contract_ExecutesOnlyAfterRollbackWindowAndBackupEvidencePass()
    {
        ISchemaMigrationDescriptor descriptor = Descriptor(
            "20260712-post-drop-obsolete-column",
            [new DropColumnStep("article", "obsolete_column", DestructiveMigrationProofs.For("20260418-post-content-cleanup"))]);
        OnlineSchemaMigrationMetadata metadata = Metadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Contract) with
        {
            Destructive = true,
            RequiresExclusiveMode = true,
            RollbackMode = OnlineSchemaMigrationRollbackMode.BackupRestore,
            ContractAfterRelease = "20260710-contract-fence",
            MinimumRetentionWindow = TimeSpan.FromDays(7)
        };
        var executor = new RecordingDescriptorExecutor();
        OnlineSchemaMigrationCoordinator coordinator = CreateCoordinator(
            descriptor,
            metadata,
            new RecordingStateStore(EmptyDatabase()),
            new RecordingMigrationLock(),
            executor: executor);
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var evidence = new OnlineSchemaContractEvidence(
            CurrentReleaseUsesOldSchema: false,
            PreviousRollbackReleaseUsesOldSchema: false,
            BackfillComplete: true,
            BackfillVerified: true,
            ObservationStartedAtUtc: now.AddDays(-8),
            BackupRestoreVerifiedAtUtc: now.AddHours(-1),
            SlotSwitchInProgress: false,
            DestructiveChangeConfirmed: true,
            RollbackManifestSealed: true,
            OldWritesDisabled: true,
            ExclusiveModeEnabled: true);

        OnlineSchemaMigrationExecutionResult result = await coordinator.ExecuteAsync(
            phase: OnlineSchemaMigrationPhase.Contract,
            migrationId: null,
            releaseId: "20260720-current",
            contractEvidence: evidence,
            dryRun: false,
            cancellationToken: CancellationToken.None);

        Assert.Equal("ok", result.Status);
        Assert.Equal(descriptor.MigrationId, Assert.Single(executor.ExecutedMigrationIds));
    }

    [Fact]
    public async Task DryRun_DoesNotAcquireAdvisoryLockOrMutateState()
    {
        ISchemaMigrationDescriptor descriptor = Descriptor(
            "20260712-pre-additive-expand",
            [new EnsureColumnStep("article", "new_nullable_column", "bigint NULL")]);
        OnlineSchemaMigrationMetadata metadata = Metadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Expand);
        var stateStore = new RecordingStateStore(EmptyDatabase());
        var migrationLock = new RecordingMigrationLock();
        var executor = new RecordingDescriptorExecutor();
        OnlineSchemaMigrationCoordinator coordinator = CreateCoordinator(
            descriptor,
            metadata,
            stateStore,
            migrationLock,
            executor: executor);

        OnlineSchemaMigrationExecutionResult result = await coordinator.ExecuteAsync(
            phase: OnlineSchemaMigrationPhase.Expand,
            migrationId: null,
            releaseId: "20260720-current",
            contractEvidence: null,
            dryRun: true,
            cancellationToken: CancellationToken.None);

        Assert.Equal("dry_run", result.Status);
        Assert.Equal(descriptor.MigrationId, Assert.Single(result.MigrationIds));
        Assert.Equal(0, migrationLock.AcquireCount);
        Assert.False(stateStore.EnsureControlTablesCalled);
        Assert.Empty(executor.ExecutedMigrationIds);
    }

    [Fact]
    public async Task ProductionServeRunner_PerformsReadOnlyCheckAndNeverCallsMutation()
    {
        var coordinator = new RecordingCoordinator
        {
            CheckReport = new OnlineSchemaCompatibilityReport(
                "ready",
                null,
                "20260720-current",
                "20260712-schema",
                [])
        };
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["FSUSBLOG_RELEASE_ID"] = "20260720-current"
            })
            .Build();
        var runner = new ServeSchemaCompatibilityRunner(
            coordinator,
            configuration,
            NullLogger<ServeSchemaCompatibilityRunner>.Instance);

        await runner.RunAsync(CancellationToken.None);

        Assert.Equal(1, coordinator.CheckCalls);
        Assert.Equal(0, coordinator.ExecuteCalls);
    }

    [Fact]
    public async Task ProductionServeRunner_PublishesIncompatibilityForReadinessWithoutMutatingOrGuessing()
    {
        var incompatible = new OnlineSchemaCompatibilityReport(
            "not_ready",
            "schema_incompatible",
            "20260720-current",
            "20260801-schema",
            [new OnlineSchemaCompatibilityIssue(
                "schema_release_outside_manifest",
                OnlineSchemaCompatibilitySeverity.Error)]);
        var coordinator = new RecordingCoordinator { CheckReport = incompatible };
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["FSUSBLOG_RELEASE_ID"] = "20260720-current"
            })
            .Build();
        var runtimeState = new OnlineSchemaCompatibilityRuntimeState();
        var runner = new ServeSchemaCompatibilityRunner(
            coordinator,
            configuration,
            NullLogger<ServeSchemaCompatibilityRunner>.Instance,
            runtimeState);

        await runner.RunAsync(CancellationToken.None);

        Assert.Same(incompatible, runtimeState.Current);
        Assert.Equal(1, coordinator.CheckCalls);
        Assert.Equal(0, coordinator.ExecuteCalls);
    }

    private static OnlineSchemaMigrationCoordinator CreateCoordinator(
        ISchemaMigrationDescriptor descriptor,
        OnlineSchemaMigrationMetadata metadata,
        RecordingStateStore stateStore,
        RecordingMigrationLock migrationLock,
        RecordingDescriptorExecutor? executor = null,
        IReadOnlyList<IOnlineSchemaBackfillHandler>? handlers = null)
        => new(
            new FixedRegistry([descriptor]),
            new FixedCatalog(metadata),
            stateStore,
            executor ?? new RecordingDescriptorExecutor(),
            migrationLock,
            new FixedManifestProvider(),
            handlers ?? [],
            Options.Create(new OnlineSchemaMigrationOptions
            {
                MaximumBatchesPerRun = 5,
                DelayBetweenBatchesMs = 0,
                MaximumBackupEvidenceAgeHours = 24
            }),
            TimeProvider.System,
            NullLogger<OnlineSchemaMigrationCoordinator>.Instance);

    private static ISchemaMigrationDescriptor Descriptor(
        string migrationId,
        IReadOnlyList<SchemaMigrationStep> steps)
        => new SchemaMigrationDescriptor(
            migrationId,
            "online coordinator test",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps: steps);

    private static OnlineSchemaMigrationMetadata Metadata(
        string migrationId,
        OnlineSchemaMigrationPhase phase)
        => new(
            migrationId,
            phase,
            new OnlineSchemaReleaseRange("20260701-release", "20260731-release"),
            RequiresExclusiveMode: false,
            Destructive: false,
            RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
            EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
            BatchSize: null,
            ResumeTokenName: null,
            IntroducedAtRelease: "20260701-release",
            ContractAfterRelease: phase == OnlineSchemaMigrationPhase.Contract ? "20260710-contract-fence" : null,
            MinimumRetentionWindow: phase == OnlineSchemaMigrationPhase.Contract ? TimeSpan.FromDays(7) : TimeSpan.Zero,
            Validators: ["test-validator"]);

    private static OnlineSchemaDatabaseSnapshot EmptyDatabase()
        => new(
            true,
            "20260712-schema",
            [],
            new Dictionary<string, OnlineSchemaBackfillSnapshot>(StringComparer.Ordinal));

    private sealed class FixedRegistry(IReadOnlyList<ISchemaMigrationDescriptor> descriptors)
        : ISchemaMigrationRegistry
    {
        public IReadOnlyList<ISchemaMigrationDescriptor> GetDescriptors() => descriptors;
    }

    private sealed class FixedCatalog(OnlineSchemaMigrationMetadata metadata)
        : IOnlineSchemaMigrationCatalog
    {
        public IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> GetMetadata()
            => new Dictionary<string, OnlineSchemaMigrationMetadata>(StringComparer.Ordinal)
            {
                [metadata.MigrationId] = metadata
            };
    }

    private sealed class FixedManifestProvider : IOnlineSchemaReleaseManifestProvider
    {
        public OnlineSchemaReleaseManifest Load(string expectedReleaseId)
            => new(
                expectedReleaseId,
                "20260719-previous",
                new OnlineSchemaReleaseRange("20260701-schema", "20260731-schema"));
    }

    private sealed class RecordingStateStore(OnlineSchemaDatabaseSnapshot snapshot)
        : IOnlineSchemaMigrationStateStore
    {
        public bool EnsureControlTablesCalled
        {
            get; private set;
        }

        public List<OnlineSchemaBackfillSnapshot> BackfillWrites { get; } = [];

        public List<string> AppliedMigrationIds { get; } = [];

        public Task<OnlineSchemaDatabaseSnapshot> ReadAsync(CancellationToken cancellationToken)
            => Task.FromResult(snapshot);

        public Task EnsureControlTablesAsync(CancellationToken cancellationToken)
        {
            EnsureControlTablesCalled = true;
            return Task.CompletedTask;
        }

        public Task SaveBackfillAsync(
            OnlineSchemaBackfillSnapshot value,
            CancellationToken cancellationToken)
        {
            BackfillWrites.Add(value);
            return Task.CompletedTask;
        }

        public Task MarkMigrationAppliedAsync(
            ISchemaMigrationDescriptor descriptor,
            string releaseId,
            CancellationToken cancellationToken)
        {
            AppliedMigrationIds.Add(descriptor.MigrationId);
            return Task.CompletedTask;
        }

        public Task MarkSchemaReleaseAsync(string releaseId, CancellationToken cancellationToken)
            => Task.CompletedTask;
    }

    private sealed class RecordingMigrationLock : ISchemaMigrationLock
    {
        public int AcquireCount
        {
            get; private set;
        }

        public int DisposeCount
        {
            get; private set;
        }

        public Task<IAsyncDisposable> AcquireAsync(CancellationToken cancellationToken)
        {
            AcquireCount++;
            return Task.FromResult<IAsyncDisposable>(new Releaser(this));
        }

        private sealed class Releaser(RecordingMigrationLock owner) : IAsyncDisposable
        {
            public ValueTask DisposeAsync()
            {
                owner.DisposeCount++;
                return ValueTask.CompletedTask;
            }
        }
    }

    private sealed class RecordingDescriptorExecutor : IOnlineSchemaMigrationDescriptorExecutor
    {
        public List<string> ExecutedMigrationIds { get; } = [];

        public Task ExecuteAsync(
            ISchemaMigrationDescriptor descriptor,
            string releaseId,
            CancellationToken cancellationToken)
        {
            ExecutedMigrationIds.Add(descriptor.MigrationId);
            return Task.CompletedTask;
        }
    }

    private sealed class RecordingBackfillHandler(string migrationId) : IOnlineSchemaBackfillHandler
    {
        public string MigrationId => migrationId;

        public List<string?> ResumeTokens { get; } = [];

        public bool Verified
        {
            get; private set;
        }

        public Task<OnlineSchemaBackfillBatchResult> ExecuteBatchAsync(
            string? resumeToken,
            int batchSize,
            CancellationToken cancellationToken)
        {
            ResumeTokens.Add(resumeToken);
            return Task.FromResult(new OnlineSchemaBackfillBatchResult(
                "200",
                RowsProcessed: 100,
                Complete: true,
                RemainingRowsEstimate: 0));
        }

        public Task<bool> VerifyAsync(CancellationToken cancellationToken)
        {
            Verified = true;
            return Task.FromResult(true);
        }
    }

    private sealed class RecordingCoordinator : IOnlineSchemaMigrationCoordinator
    {
        public required OnlineSchemaCompatibilityReport CheckReport
        {
            get; init;
        }

        public int CheckCalls
        {
            get; private set;
        }

        public int ExecuteCalls
        {
            get; private set;
        }

        public Task<OnlineSchemaCompatibilityReport> CheckAsync(
            string releaseId,
            CancellationToken cancellationToken)
        {
            CheckCalls++;
            return Task.FromResult(CheckReport);
        }

        public Task<OnlineSchemaMigrationExecutionResult> ExecuteAsync(
            OnlineSchemaMigrationPhase phase,
            string? migrationId,
            string releaseId,
            OnlineSchemaContractEvidence? contractEvidence,
            bool dryRun,
            CancellationToken cancellationToken)
        {
            ExecuteCalls++;
            throw new InvalidOperationException("Mutation must not be called by serve.");
        }
    }
}

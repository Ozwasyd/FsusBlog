using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.DependencyInjection.Extensions;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public sealed record OnlineSchemaBackfillBatchResult(
    string? ResumeToken,
    int RowsProcessed,
    bool Complete,
    long? RemainingRowsEstimate = null,
    TimeSpan? SuggestedDelay = null);

public interface IOnlineSchemaBackfillHandler
{
    string MigrationId
    {
        get;
    }

    Task<OnlineSchemaBackfillBatchResult> ExecuteBatchAsync(
        string? resumeToken,
        int batchSize,
        CancellationToken cancellationToken);

    Task<bool> VerifyAsync(CancellationToken cancellationToken);
}

public interface IOnlineSchemaMigrationDescriptorExecutor
{
    Task ExecuteAsync(
        ISchemaMigrationDescriptor descriptor,
        string releaseId,
        CancellationToken cancellationToken);
}

public sealed class PostgresOnlineSchemaMigrationDescriptorExecutor(
    ISqlSugarClient db,
    IOnlineSchemaMigrationStateStore stateStore,
    TimeProvider timeProvider) : IOnlineSchemaMigrationDescriptorExecutor
{
    public async Task ExecuteAsync(
        ISchemaMigrationDescriptor descriptor,
        string releaseId,
        CancellationToken cancellationToken)
    {
        DestructiveMigrationProofs.ValidateDescriptor(
            descriptor,
            timeProvider.GetUtcNow(),
            freshBootstrap: false);

        async Task ExecuteCoreAsync()
        {
            foreach (SchemaMigrationStep step in descriptor.Steps)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (step is ClearLegacyPublicArtifactsStep)
                {
                    throw new InvalidOperationException("schema_online_runtime_side_effect_forbidden");
                }

                await step.ExecuteAsync(db, cancellationToken).ConfigureAwait(false);
            }

            await stateStore.MarkMigrationAppliedAsync(
                descriptor,
                ReleaseId.Parse(releaseId),
                cancellationToken).ConfigureAwait(false);
        }

        if (!descriptor.Transactional)
        {
            await ExecuteCoreAsync().ConfigureAwait(false);
            return;
        }

        var result = await db.Ado.UseTranAsync(ExecuteCoreAsync).ConfigureAwait(false);
        if (!result.IsSuccess)
        {
            throw new InvalidOperationException(
                $"schema_online_migration_failed:{descriptor.MigrationId}",
                result.ErrorException);
        }
    }
}

public sealed class OnlineSchemaMigrationOptions
{
    public const string SectionName = "SchemaMigration:Online";

    public int MaximumBatchesPerRun { get; init; } = 100;

    public int DelayBetweenBatchesMs { get; init; } = 50;

    public int MaximumBackupEvidenceAgeHours { get; init; } = 24;
}

public sealed record OnlineSchemaMigrationExecutionResult(
    string Status,
    string ReleaseId,
    OnlineSchemaMigrationPhase? Phase,
    IReadOnlyList<string> MigrationIds,
    IReadOnlyList<string> Codes)
{
    public bool Succeeded => string.Equals(Status, "ok", StringComparison.Ordinal)
        || string.Equals(Status, "paused", StringComparison.Ordinal)
        || string.Equals(Status, "dry_run", StringComparison.Ordinal);
}

public interface IOnlineSchemaMigrationCoordinator
{
    Task<OnlineSchemaCompatibilityReport> CheckAsync(string releaseId, CancellationToken cancellationToken);

    Task<OnlineSchemaMigrationExecutionResult> ExecuteAsync(
        OnlineSchemaMigrationPhase phase,
        string? migrationId,
        string releaseId,
        OnlineSchemaContractEvidence? contractEvidence,
        bool dryRun,
        CancellationToken cancellationToken);
}

public sealed class OnlineSchemaMigrationCoordinator(
    ISchemaMigrationRegistry registry,
    IOnlineSchemaMigrationCatalog catalog,
    IOnlineSchemaMigrationStateStore stateStore,
    IOnlineSchemaMigrationDescriptorExecutor descriptorExecutor,
    ISchemaMigrationLock migrationLock,
    IOnlineSchemaReleaseManifestProvider manifestProvider,
    IEnumerable<IOnlineSchemaBackfillHandler> backfillHandlers,
    Microsoft.Extensions.Options.IOptions<OnlineSchemaMigrationOptions> options,
    TimeProvider timeProvider,
    ILogger<OnlineSchemaMigrationCoordinator> logger) : IOnlineSchemaMigrationCoordinator
{
    private readonly IReadOnlyDictionary<string, IOnlineSchemaBackfillHandler> _backfillHandlers =
        backfillHandlers.ToDictionary(static handler => handler.MigrationId, StringComparer.Ordinal);
    private readonly OnlineSchemaMigrationOptions _options = options.Value;

    public async Task<OnlineSchemaCompatibilityReport> CheckAsync(
        string releaseId,
        CancellationToken cancellationToken)
    {
        OnlineSchemaReleaseManifest manifest = manifestProvider.Load(releaseId);
        OnlineSchemaDatabaseSnapshot database = await stateStore.ReadAsync(cancellationToken).ConfigureAwait(false);
        return OnlineSchemaCompatibilityEvaluator.Evaluate(
            manifest,
            database,
            registry.GetDescriptors(),
            catalog.GetMetadata());
    }

    public async Task<OnlineSchemaMigrationExecutionResult> ExecuteAsync(
        OnlineSchemaMigrationPhase phase,
        string? migrationId,
        string releaseId,
        OnlineSchemaContractEvidence? contractEvidence,
        bool dryRun,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors = registry.GetDescriptors();
        IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> metadata = catalog.GetMetadata();
        OnlineSchemaMigrationPolicyReport policy = OnlineSchemaMigrationPolicy.Validate(descriptors, metadata);
        if (!policy.Valid)
        {
            return Failed(releaseId, phase, policy.Violations.Select(static violation => violation.Code));
        }

        OnlineSchemaReleaseManifest manifest = manifestProvider.Load(releaseId);
        await using IAsyncDisposable schemaLock = dryRun
            ? NoopAsyncDisposable.Instance
            : await migrationLock.AcquireAsync(cancellationToken).ConfigureAwait(false);
        if (!dryRun)
        {
            await stateStore.EnsureControlTablesAsync(cancellationToken).ConfigureAwait(false);
        }

        OnlineSchemaDatabaseSnapshot database = await stateStore.ReadAsync(cancellationToken).ConfigureAwait(false);
        IReadOnlyList<string> baselineErrors = ValidateMutationBaseline(database, descriptors);
        if (baselineErrors.Count > 0)
        {
            return Failed(releaseId, phase, baselineErrors);
        }

        Dictionary<string, ISchemaMigrationDescriptor> descriptorById = descriptors.ToDictionary(
            static descriptor => descriptor.MigrationId,
            StringComparer.Ordinal);
        HashSet<string> applied = database.History
            .Where(static entry => entry.Succeeded)
            .Select(static entry => entry.MigrationId)
            .ToHashSet(StringComparer.Ordinal);
        OnlineSchemaMigrationMetadata[] selected = metadata.Values
            .Where(classification => classification.Phase == phase
                && (migrationId is null || string.Equals(classification.MigrationId, migrationId, StringComparison.Ordinal)))
            .OrderBy(static classification => classification.MigrationId, StringComparer.Ordinal)
            .ToArray();

        if (migrationId is not null && selected.Length == 0)
        {
            return Failed(releaseId, phase, ["schema_migration_not_found_for_phase"]);
        }

        OnlineSchemaMigrationMetadata[] pending = selected
            .Where(classification => !applied.Contains(classification.MigrationId))
            .ToArray();
        string[] legacyPending = metadata.Values
            .Where(classification => classification.LegacyBootstrapOnly
                && !applied.Contains(classification.MigrationId))
            .Select(static classification => classification.MigrationId)
            .ToArray();
        if (legacyPending.Length > 0)
        {
            logger.LogError(
                "Online schema command refused {Count} legacy bootstrap descriptor(s): {MigrationIds}",
                legacyPending.Length,
                string.Join(',', legacyPending));
            return Failed(releaseId, phase, ["schema_legacy_bootstrap_required"]);
        }

        if (phase == OnlineSchemaMigrationPhase.Contract)
        {
            if (contractEvidence is null)
            {
                return Failed(releaseId, phase, ["schema_contract_evidence_missing"]);
            }

            var contractErrors = new List<string>();
            TimeSpan maximumBackupAge = TimeSpan.FromHours(Math.Max(1, _options.MaximumBackupEvidenceAgeHours));
            foreach (OnlineSchemaMigrationMetadata classification in pending)
            {
                contractErrors.AddRange(OnlineSchemaContractGate.Evaluate(
                        classification,
                        contractEvidence,
                        manifest.ReleaseId,
                        manifest.PreviousRollbackReleaseId,
                        timeProvider.GetUtcNow(),
                        maximumBackupAge)
                    .Select(static issue => issue.Code));
            }

            if (contractErrors.Count > 0)
            {
                return Failed(releaseId, phase, contractErrors);
            }
        }

        if (phase == OnlineSchemaMigrationPhase.Backfill)
        {
            if (migrationId is null)
            {
                return Failed(releaseId, phase, ["schema_backfill_id_required"]);
            }

            if (pending.Length > 0 && !_backfillHandlers.ContainsKey(migrationId))
            {
                return Failed(releaseId, phase, ["schema_backfill_handler_missing"]);
            }

            if (dryRun)
            {
                return DryRun(releaseId, phase, pending);
            }

            return await ExecuteBackfillAsync(
                pending.SingleOrDefault(),
                descriptorById,
                database,
                releaseId,
                cancellationToken).ConfigureAwait(false);
        }

        if (dryRun)
        {
            return DryRun(releaseId, phase, pending);
        }

        foreach (OnlineSchemaMigrationMetadata classification in pending)
        {
            ISchemaMigrationDescriptor descriptor = descriptorById[classification.MigrationId];
            if (phase == OnlineSchemaMigrationPhase.Expand
                && OnlineSchemaMigrationPolicy.ContainsDestructiveOperation(descriptor))
            {
                return Failed(releaseId, phase, ["schema_expand_destructive_operation"]);
            }

            logger.LogInformation(
                "Applying online schema migration {MigrationId} phase {Phase} release {ReleaseId}.",
                descriptor.MigrationId,
                phase,
                releaseId);
            await descriptorExecutor.ExecuteAsync(descriptor, releaseId, cancellationToken).ConfigureAwait(false);
        }

        await stateStore.MarkSchemaCompatibilityCoordinateAsync(
            SchemaCompatibilityCoordinate.FromReleaseId(ReleaseId.Parse(releaseId)),
            cancellationToken).ConfigureAwait(false);
        return new OnlineSchemaMigrationExecutionResult(
            "ok",
            releaseId,
            phase,
            pending.Select(static classification => classification.MigrationId).ToArray(),
            []);
    }

    private async Task<OnlineSchemaMigrationExecutionResult> ExecuteBackfillAsync(
        OnlineSchemaMigrationMetadata? classification,
        IReadOnlyDictionary<string, ISchemaMigrationDescriptor> descriptorById,
        OnlineSchemaDatabaseSnapshot database,
        string releaseId,
        CancellationToken cancellationToken)
    {
        if (classification is null)
        {
            return new OnlineSchemaMigrationExecutionResult(
                "ok",
                releaseId,
                OnlineSchemaMigrationPhase.Backfill,
                [],
                []);
        }

        if (!_backfillHandlers.TryGetValue(classification.MigrationId, out IOnlineSchemaBackfillHandler? handler))
        {
            return Failed(releaseId, OnlineSchemaMigrationPhase.Backfill, ["schema_backfill_handler_missing"]);
        }

        int batchSize = classification.BatchSize!.Value;
        database.Backfills.TryGetValue(classification.MigrationId, out OnlineSchemaBackfillSnapshot? existing);
        string? resumeToken = existing?.ResumeToken;
        long rowsProcessed = existing?.RowsProcessed ?? 0;
        long failureCount = existing?.FailureCount ?? 0;
        double? rowsPerSecond = existing?.RowsPerSecond;
        long? remainingRowsEstimate = existing?.RemainingRowsEstimate;
        int maximumBatches = Math.Max(1, _options.MaximumBatchesPerRun);

        for (int batchNumber = 0; batchNumber < maximumBatches; batchNumber++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            OnlineSchemaBackfillBatchResult batch;
            DateTimeOffset batchStartedAt = timeProvider.GetUtcNow();
            try
            {
                batch = await handler.ExecuteBatchAsync(resumeToken, batchSize, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                await stateStore.SaveBackfillAsync(
                    new OnlineSchemaBackfillSnapshot(
                        classification.MigrationId,
                        "failed",
                        resumeToken,
                        rowsProcessed,
                        failureCount + 1,
                        timeProvider.GetUtcNow()),
                    cancellationToken).ConfigureAwait(false);
                throw;
            }

            if (!batch.Complete && batch.RowsProcessed <= 0 && string.Equals(batch.ResumeToken, resumeToken, StringComparison.Ordinal))
            {
                return Failed(releaseId, OnlineSchemaMigrationPhase.Backfill, ["schema_backfill_no_progress"]);
            }

            rowsProcessed += batch.RowsProcessed;
            resumeToken = batch.ResumeToken;
            TimeSpan elapsed = timeProvider.GetUtcNow() - batchStartedAt;
            rowsPerSecond = batch.RowsProcessed <= 0
                ? 0
                : batch.RowsProcessed / Math.Max(0.001, elapsed.TotalSeconds);
            remainingRowsEstimate = batch.RemainingRowsEstimate;
            string status = batch.Complete ? "verifying" : "running";
            await stateStore.SaveBackfillAsync(
                new OnlineSchemaBackfillSnapshot(
                    classification.MigrationId,
                    status,
                    resumeToken,
                    rowsProcessed,
                    failureCount,
                    timeProvider.GetUtcNow(),
                    RowsPerSecond: rowsPerSecond,
                    RemainingRowsEstimate: remainingRowsEstimate),
                cancellationToken).ConfigureAwait(false);

            logger.LogInformation(
                "Schema backfill {MigrationId} batch {BatchNumber} processed {RowsProcessed} row(s); remaining estimate {RemainingRows}.",
                classification.MigrationId,
                batchNumber + 1,
                batch.RowsProcessed,
                batch.RemainingRowsEstimate);

            if (batch.Complete)
            {
                bool verified = await handler.VerifyAsync(cancellationToken).ConfigureAwait(false);
                if (!verified)
                {
                    await stateStore.SaveBackfillAsync(
                        new OnlineSchemaBackfillSnapshot(
                            classification.MigrationId,
                            "verification_failed",
                            resumeToken,
                            rowsProcessed,
                            failureCount + 1,
                            timeProvider.GetUtcNow()),
                        cancellationToken).ConfigureAwait(false);
                    return Failed(releaseId, OnlineSchemaMigrationPhase.Backfill, ["schema_backfill_verification_failed"]);
                }

                DateTimeOffset verifiedAt = timeProvider.GetUtcNow();
                await stateStore.SaveBackfillAsync(
                    new OnlineSchemaBackfillSnapshot(
                        classification.MigrationId,
                        "completed",
                        resumeToken,
                        rowsProcessed,
                        failureCount,
                        verifiedAt,
                        verifiedAt,
                        rowsPerSecond,
                        remainingRowsEstimate),
                    cancellationToken).ConfigureAwait(false);
                await stateStore.MarkMigrationAppliedAsync(
                    descriptorById[classification.MigrationId],
                    ReleaseId.Parse(releaseId),
                    cancellationToken).ConfigureAwait(false);
                await stateStore.MarkSchemaCompatibilityCoordinateAsync(
                    SchemaCompatibilityCoordinate.FromReleaseId(ReleaseId.Parse(releaseId)),
                    cancellationToken).ConfigureAwait(false);
                return new OnlineSchemaMigrationExecutionResult(
                    "ok",
                    releaseId,
                    OnlineSchemaMigrationPhase.Backfill,
                    [classification.MigrationId],
                    []);
            }

            TimeSpan delay = batch.SuggestedDelay
                ?? TimeSpan.FromMilliseconds(Math.Max(0, _options.DelayBetweenBatchesMs));
            if (delay > TimeSpan.Zero)
            {
                await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
            }
        }

        await stateStore.SaveBackfillAsync(
            new OnlineSchemaBackfillSnapshot(
                classification.MigrationId,
                "paused",
                resumeToken,
                rowsProcessed,
                failureCount,
                timeProvider.GetUtcNow(),
                RowsPerSecond: rowsPerSecond,
                RemainingRowsEstimate: remainingRowsEstimate),
            cancellationToken).ConfigureAwait(false);
        return new OnlineSchemaMigrationExecutionResult(
            "paused",
            releaseId,
            OnlineSchemaMigrationPhase.Backfill,
            [classification.MigrationId],
            ["schema_backfill_resume_required"]);
    }

    private static IReadOnlyList<string> ValidateMutationBaseline(
        OnlineSchemaDatabaseSnapshot database,
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors)
    {
        var errors = new List<string>();
        Dictionary<string, ISchemaMigrationDescriptor> descriptorById = descriptors
            .GroupBy(static descriptor => descriptor.MigrationId, StringComparer.Ordinal)
            .Where(static group => group.Count() == 1)
            .ToDictionary(static group => group.Key, static group => group.Single(), StringComparer.Ordinal);

        foreach (IGrouping<string, OnlineSchemaMigrationHistorySnapshot> group in database.History
                     .GroupBy(static entry => entry.MigrationId, StringComparer.Ordinal))
        {
            if (group.Count() != 1)
            {
                errors.Add("schema_history_duplicate");
                continue;
            }

            OnlineSchemaMigrationHistorySnapshot applied = group.Single();
            if (!descriptorById.TryGetValue(applied.MigrationId, out ISchemaMigrationDescriptor? descriptor))
            {
                errors.Add("schema_history_unknown");
            }
            else if (!descriptor.AcceptedChecksums.Contains(applied.Checksum))
            {
                errors.Add("schema_history_checksum_mismatch");
            }

            if (!applied.Succeeded)
            {
                errors.Add("schema_history_failed");
            }
        }

        return errors.Distinct(StringComparer.Ordinal).ToArray();
    }

    private static OnlineSchemaMigrationExecutionResult Failed(
        string releaseId,
        OnlineSchemaMigrationPhase phase,
        IEnumerable<string> codes)
        => new(
            "failed",
            releaseId,
            phase,
            [],
            codes.Distinct(StringComparer.Ordinal).ToArray());

    private static OnlineSchemaMigrationExecutionResult DryRun(
        string releaseId,
        OnlineSchemaMigrationPhase phase,
        IEnumerable<OnlineSchemaMigrationMetadata> pending)
        => new(
            "dry_run",
            releaseId,
            phase,
            pending.Select(static classification => classification.MigrationId).ToArray(),
            []);

    private sealed class NoopAsyncDisposable : IAsyncDisposable
    {
        public static NoopAsyncDisposable Instance { get; } = new();

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

public enum OnlineSchemaMigrationCommandKind
{
    Serve = 0,
    Migrate = 1,
    Check = 2,
    PasskeyProjectionCheck = 3,
    PasskeyProjectionRepair = 4
}

public sealed record OnlineSchemaMigrationCommand(
    OnlineSchemaMigrationCommandKind Kind,
    OnlineSchemaMigrationPhase? Phase,
    string? MigrationId,
    string? ReleaseId,
    string? ReleaseManifestPath,
    string? EnvironmentFilePath,
    string? EvidencePath,
    bool ConfirmDestructive,
    bool DryRun,
    IReadOnlyList<string> HostArguments);

public static class OnlineSchemaMigrationCommandLine
{
    public static OnlineSchemaMigrationCommand Parse(IReadOnlyList<string> args)
    {
        if (args.Count == 0 || args[0].StartsWith("--", StringComparison.Ordinal))
        {
            return Serve(args);
        }

        if (string.Equals(args[0], "serve", StringComparison.OrdinalIgnoreCase))
        {
            return Serve(args.Skip(1).ToArray());
        }

        if (string.Equals(args[0], "passkey-projection", StringComparison.OrdinalIgnoreCase))
        {
            return ParsePasskeyProjection(args);
        }

        if (!string.Equals(args[0], "migrate", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("schema_command_unknown");
        }

        string? phase = null;
        string? migrationId = null;
        string? releaseId = null;
        string? releaseManifestPath = null;
        string? environmentFilePath = null;
        string? evidencePath = null;
        bool check = false;
        bool confirmDestructive = false;
        bool dryRun = false;
        for (int index = 1; index < args.Count; index++)
        {
            string argument = args[index];
            switch (argument)
            {
                case "--check":
                    check = true;
                    break;
                case "--confirm-destructive":
                    confirmDestructive = true;
                    break;
                case "--dry-run":
                    dryRun = true;
                    break;
                case "--phase":
                    phase = ReadValue(args, ref index, argument);
                    break;
                case "--id":
                    migrationId = ReadValue(args, ref index, argument);
                    break;
                case "--release":
                    releaseId = ReadValue(args, ref index, argument);
                    break;
                case "--release-manifest":
                    releaseManifestPath = ReadValue(args, ref index, argument);
                    break;
                case "--env-file":
                    environmentFilePath = ReadValue(args, ref index, argument);
                    break;
                case "--evidence":
                    evidencePath = ReadValue(args, ref index, argument);
                    break;
                default:
                    throw new InvalidOperationException($"schema_command_argument_unknown:{argument}");
            }
        }

        if (check)
        {
            if (phase is not null || migrationId is not null || evidencePath is not null || confirmDestructive || dryRun)
            {
                throw new InvalidOperationException("schema_check_arguments_conflict");
            }

            if (string.IsNullOrWhiteSpace(releaseId) && string.IsNullOrWhiteSpace(releaseManifestPath))
            {
                throw new InvalidOperationException("schema_check_release_required");
            }

            return new OnlineSchemaMigrationCommand(
                OnlineSchemaMigrationCommandKind.Check,
                null,
                null,
                releaseId,
                releaseManifestPath,
                environmentFilePath,
                null,
                false,
                false,
                []);
        }

        OnlineSchemaMigrationPhase parsedPhase = phase?.ToLowerInvariant() switch
        {
            "expand" => OnlineSchemaMigrationPhase.Expand,
            "backfill" or "backfill-resume" => OnlineSchemaMigrationPhase.Backfill,
            "contract" => OnlineSchemaMigrationPhase.Contract,
            _ => throw new InvalidOperationException("schema_migrate_phase_required")
        };
        if (parsedPhase == OnlineSchemaMigrationPhase.Backfill && string.IsNullOrWhiteSpace(migrationId))
        {
            throw new InvalidOperationException("schema_backfill_id_required");
        }

        if (parsedPhase != OnlineSchemaMigrationPhase.Backfill && migrationId is not null)
        {
            throw new InvalidOperationException("schema_migrate_id_only_for_backfill");
        }

        if (parsedPhase == OnlineSchemaMigrationPhase.Contract
            && (string.IsNullOrWhiteSpace(evidencePath) || (!dryRun && !confirmDestructive)))
        {
            throw new InvalidOperationException("schema_contract_evidence_and_confirmation_required");
        }

        return new OnlineSchemaMigrationCommand(
            OnlineSchemaMigrationCommandKind.Migrate,
            parsedPhase,
            migrationId,
            releaseId,
            releaseManifestPath,
            environmentFilePath,
            evidencePath,
            confirmDestructive,
            dryRun,
            []);
    }

    private static OnlineSchemaMigrationCommand Serve(IReadOnlyList<string> hostArguments)
        => new(
            OnlineSchemaMigrationCommandKind.Serve,
            null,
            null,
            null,
            null,
            null,
            null,
            false,
            false,
            hostArguments);

    private static OnlineSchemaMigrationCommand ParsePasskeyProjection(IReadOnlyList<string> args)
    {
        bool check = false;
        bool repair = false;
        bool confirmRepair = false;
        string? environmentFilePath = null;
        for (int index = 1; index < args.Count; index++)
        {
            string argument = args[index];
            switch (argument)
            {
                case "--check":
                    check = true;
                    break;
                case "--repair":
                    repair = true;
                    break;
                case "--confirm-repair":
                    confirmRepair = true;
                    break;
                case "--env-file":
                    environmentFilePath = ReadValue(args, ref index, argument);
                    break;
                default:
                    throw new InvalidOperationException($"passkey_projection_argument_unknown:{argument}");
            }
        }

        if (check == repair)
        {
            throw new InvalidOperationException("passkey_projection_mode_required");
        }

        if (check && confirmRepair)
        {
            throw new InvalidOperationException("passkey_projection_check_confirmation_conflict");
        }

        if (repair && !confirmRepair)
        {
            throw new InvalidOperationException("passkey_projection_repair_confirmation_required");
        }

        return new OnlineSchemaMigrationCommand(
            repair
                ? OnlineSchemaMigrationCommandKind.PasskeyProjectionRepair
                : OnlineSchemaMigrationCommandKind.PasskeyProjectionCheck,
            null,
            null,
            null,
            null,
            environmentFilePath,
            null,
            confirmRepair,
            false,
            []);
    }

    private static string ReadValue(IReadOnlyList<string> args, ref int index, string argument)
    {
        if (++index >= args.Count || args[index].StartsWith("--", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"schema_command_value_missing:{argument}");
        }

        return args[index].Trim();
    }
}

public sealed class OnlineSchemaMigrationCommandHost(
    IOnlineSchemaMigrationCoordinator coordinator,
    IPasskeyProjectionConsistencyService passkeyProjection,
    IConfiguration configuration,
    ILogger<OnlineSchemaMigrationCommandHost> logger)
{
    private static readonly JsonSerializerOptions s_machineJsonOptions = CreateMachineJsonOptions();

    public async Task<int> RunAsync(
        OnlineSchemaMigrationCommand command,
        CancellationToken cancellationToken)
    {
        try
        {
            if (command.Kind is OnlineSchemaMigrationCommandKind.PasskeyProjectionCheck
                or OnlineSchemaMigrationCommandKind.PasskeyProjectionRepair)
            {
                bool repair = command.Kind == OnlineSchemaMigrationCommandKind.PasskeyProjectionRepair;
                PasskeyProjectionConsistencyReport projection = repair
                    ? await passkeyProjection.RepairAsync(cancellationToken).ConfigureAwait(false)
                    : await passkeyProjection.CheckAsync(cancellationToken).ConfigureAwait(false);
                logger.LogInformation(
                    "Passkey projection {Mode} completed. DriftedAccountCount={DriftedAccountCount} RepairedAccountCount={RepairedAccountCount} RemainingDriftedAccountCount={RemainingDriftedAccountCount}",
                    repair ? "repair" : "check",
                    projection.DriftedAccounts,
                    projection.RepairedAccounts,
                    projection.RemainingDriftedAccounts);
                await WriteJsonAsync(new
                {
                    status = projection.IsConsistent ? "ok" : "drift",
                    mode = repair ? "repair" : "check",
                    driftedAccounts = projection.DriftedAccounts,
                    repairedAccounts = projection.RepairedAccounts,
                    remainingDriftedAccounts = projection.RemainingDriftedAccounts
                }, cancellationToken).ConfigureAwait(false);
                return projection.IsConsistent ? 0 : 1;
            }

            string releaseId = command.ReleaseId
                ?? (configuration["FSUSBLOG_RELEASE_ID"] ?? configuration["Release:Id"] ?? string.Empty).Trim();
            if (releaseId.Length == 0)
            {
                releaseId = ReadReleaseIdFromManifest(command.ReleaseManifestPath
                    ?? configuration["FSUSBLOG_RELEASE_MANIFEST_PATH"]
                    ?? configuration["Release:ManifestPath"]);
            }
            if (releaseId.Length == 0)
            {
                throw new InvalidOperationException("schema_command_release_missing");
            }

            if (command.Kind == OnlineSchemaMigrationCommandKind.Check)
            {
                OnlineSchemaCompatibilityReport report = await coordinator.CheckAsync(releaseId, cancellationToken).ConfigureAwait(false);
                logger.LogInformation(
                    "Schema compatibility check completed for release {ReleaseId} with status {Status} and {IssueCount} issue(s).",
                    releaseId,
                    report.Status,
                    report.Issues.Count);
                await WriteJsonAsync(report, cancellationToken).ConfigureAwait(false);
                return report.Ready ? 0 : 1;
            }

            if (command.Kind != OnlineSchemaMigrationCommandKind.Migrate || command.Phase is null)
            {
                throw new InvalidOperationException("schema_command_not_executable");
            }

            OnlineSchemaContractEvidence? evidence = command.EvidencePath is null
                ? null
                : await ReadContractEvidenceAsync(command.EvidencePath, cancellationToken).ConfigureAwait(false);
            if (evidence is not null && command.ConfirmDestructive)
            {
                evidence = evidence with
                {
                    DestructiveChangeConfirmed = true
                };
            }

            logger.LogInformation(
                "Starting schema command phase {Phase} migration {MigrationId} release {ReleaseId}.",
                command.Phase,
                command.MigrationId,
                releaseId);
            OnlineSchemaMigrationExecutionResult result = await coordinator.ExecuteAsync(
                command.Phase.Value,
                command.MigrationId,
                releaseId,
                evidence,
                command.DryRun,
                cancellationToken).ConfigureAwait(false);
            logger.LogInformation(
                "Schema command completed for release {ReleaseId}, phase {Phase}, status {Status}, migrations {MigrationCount}, codes {Codes}.",
                releaseId,
                command.Phase,
                result.Status,
                result.MigrationIds.Count,
                string.Join(',', result.Codes));
            await WriteJsonAsync(result, cancellationToken).ConfigureAwait(false);
            return result.Succeeded ? 0 : 1;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogError(exception, "Maintenance command failed closed.");
            await WriteJsonAsync(
                new
                {
                    status = "failed",
                    code = StableCode(exception.Message)
                },
                cancellationToken).ConfigureAwait(false);
            return 1;
        }
    }

    private static async Task<OnlineSchemaContractEvidence> ReadContractEvidenceAsync(
        string path,
        CancellationToken cancellationToken)
    {
        await using FileStream stream = File.OpenRead(path);
        OnlineSchemaContractEvidence? evidence = await JsonSerializer.DeserializeAsync<OnlineSchemaContractEvidence>(
            stream,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true },
            cancellationToken).ConfigureAwait(false);
        return evidence ?? throw new InvalidOperationException("schema_contract_evidence_invalid");
    }

    private static async Task WriteJsonAsync<T>(T value, CancellationToken cancellationToken)
    {
        string json = JsonSerializer.Serialize(value, s_machineJsonOptions);
        await Console.Out.WriteLineAsync(json.AsMemory(), cancellationToken).ConfigureAwait(false);
    }

    private static JsonSerializerOptions CreateMachineJsonOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
        return options;
    }

    private static string ReadReleaseIdFromManifest(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return string.Empty;
        }

        using FileStream stream = File.OpenRead(path);
        using JsonDocument document = JsonDocument.Parse(stream);
        return document.RootElement.TryGetProperty("releaseId", out JsonElement releaseId)
            && releaseId.ValueKind == JsonValueKind.String
            ? releaseId.GetString()?.Trim() ?? string.Empty
            : string.Empty;
    }

    private static string StableCode(string message)
    {
        string code = message.Split(':', 2, StringSplitOptions.TrimEntries)[0];
        return code.StartsWith("schema_", StringComparison.Ordinal)
            || code.StartsWith("passkey_projection_", StringComparison.Ordinal)
            ? code
            : "schema_command_failed";
    }
}

/// <summary>
/// Replacement registered last for production serve. Lifecycle bootstrap keeps
/// invoking ISchemaMigrationRunner, but this implementation performs a read-only
/// compatibility check and never creates tables or executes descriptor steps.
/// </summary>
public sealed class ServeSchemaCompatibilityRunner(
    IOnlineSchemaMigrationCoordinator coordinator,
    IConfiguration configuration,
    ILogger<ServeSchemaCompatibilityRunner> logger,
    OnlineSchemaCompatibilityRuntimeState? runtimeState = null) : ISchemaMigrationRunner
{
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        string releaseId = (configuration["FSUSBLOG_RELEASE_ID"]
            ?? configuration["Release:Id"]
            ?? string.Empty).Trim();
        if (releaseId.Length == 0)
        {
            throw new InvalidOperationException("schema_serve_release_missing");
        }

        OnlineSchemaCompatibilityReport report = await coordinator.CheckAsync(releaseId, cancellationToken).ConfigureAwait(false);
        runtimeState?.Publish(report);
        foreach (OnlineSchemaCompatibilityIssue issue in report.Issues)
        {
            logger.Log(
                issue.Severity == OnlineSchemaCompatibilitySeverity.Error ? LogLevel.Error : LogLevel.Warning,
                "Schema readiness {Code} migration {MigrationId}: {Detail}",
                issue.Code,
                issue.MigrationId,
                issue.Detail);
        }

        // An incompatible candidate remains live for protected diagnostics.
        // ProductionReadinessProbe maps it to 503/schema_incompatible, so the
        // deployment runtime cannot become Ready and serve still never mutates.
    }
}

public sealed class OnlineSchemaCompatibilityRuntimeState
{
    private OnlineSchemaCompatibilityReport? _current;

    public OnlineSchemaCompatibilityReport? Current => Volatile.Read(ref _current);

    public void Publish(OnlineSchemaCompatibilityReport report)
        => Volatile.Write(ref _current, report);
}

public static class OnlineSchemaMigrationEnvironmentFile
{
    public static IReadOnlyDictionary<string, string?> Read(string path)
    {
        var values = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (string rawLine in File.ReadLines(path))
        {
            string line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }

            if (line.StartsWith("export ", StringComparison.Ordinal))
            {
                line = line[7..].TrimStart();
            }

            int separator = line.IndexOf('=');
            if (separator <= 0)
            {
                throw new InvalidOperationException("schema_env_file_line_invalid");
            }

            string key = line[..separator].Trim();
            if (key.Length == 0
                || !key.All(static character => char.IsAsciiLetterOrDigit(character)
                    || character is '_' or ':' or '-'))
            {
                throw new InvalidOperationException("schema_env_file_key_invalid");
            }

            string value = line[(separator + 1)..].Trim();
            if (value.Length >= 2
                && ((value[0] == '"' && value[^1] == '"')
                    || (value[0] == '\'' && value[^1] == '\'')))
            {
                value = value[1..^1];
            }

            string configurationKey = key.Replace("__", ":", StringComparison.Ordinal);
            if (!values.TryAdd(configurationKey, value))
            {
                throw new InvalidOperationException("schema_env_file_key_duplicate");
            }
        }

        return values;
    }
}

public static class OnlineSchemaMigrationServiceCollectionExtensions
{
    public static IServiceCollection AddOnlineSchemaMigrationControlPlane(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.Configure<OnlineSchemaMigrationOptions>(
            configuration.GetSection(OnlineSchemaMigrationOptions.SectionName));
        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<OnlineSchemaCompatibilityRuntimeState>();
        services.TryAddSingleton<IOnlineSchemaMigrationCatalog, OnlineSchemaMigrationCatalog>();
        services.TryAddSingleton<IOnlineSchemaReleaseManifestProvider, OnlineSchemaReleaseManifestProvider>();
        services.TryAddScoped<IOnlineSchemaMigrationStateStore, PostgresOnlineSchemaMigrationStateStore>();
        services.TryAddScoped<IOnlineSchemaMigrationDescriptorExecutor, PostgresOnlineSchemaMigrationDescriptorExecutor>();
        services.TryAddEnumerable(ServiceDescriptor.Scoped<IOnlineSchemaBackfillHandler, AccountSubjectHashOnlineBackfillHandler>());
        services.TryAddScoped<IOnlineSchemaMigrationCoordinator, OnlineSchemaMigrationCoordinator>();
        services.TryAddScoped<OnlineSchemaMigrationCommandHost>();
        return services;
    }
}

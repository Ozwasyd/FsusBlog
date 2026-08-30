using System.Text.Json;

using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public sealed record OnlineSchemaMigrationHistorySnapshot(
    string MigrationId,
    string Checksum,
    DateTimeOffset AppliedAtUtc,
    string AppliedByRelease,
    bool Succeeded);

public sealed record OnlineSchemaBackfillSnapshot(
    string MigrationId,
    string Status,
    string? ResumeToken,
    long RowsProcessed,
    long FailureCount,
    DateTimeOffset UpdatedAtUtc,
    DateTimeOffset? VerifiedAtUtc = null,
    double? RowsPerSecond = null,
    long? RemainingRowsEstimate = null);

public sealed record OnlineSchemaDatabaseSnapshot(
    bool HistoryAvailable,
    SchemaCompatibilityCoordinate? SchemaCompatibilityCoordinate,
    IReadOnlyList<OnlineSchemaMigrationHistorySnapshot> History,
    IReadOnlyDictionary<string, OnlineSchemaBackfillSnapshot> Backfills);

public sealed record OnlineSchemaReleaseManifest(
    ReleaseId ReleaseId,
    ReleaseId PreviousRollbackReleaseId,
    OnlineSchemaCompatibilityWindow SchemaCompatibility);

public enum OnlineSchemaCompatibilitySeverity
{
    Warning = 0,
    Error = 1
}

public sealed record OnlineSchemaCompatibilityIssue(
    string Code,
    OnlineSchemaCompatibilitySeverity Severity,
    string? MigrationId = null,
    string? Detail = null);

public sealed record OnlineSchemaCompatibilityReport(
    string Status,
    string? PublicErrorCode,
    string ReleaseId,
    string? SchemaCompatibilityCoordinate,
    IReadOnlyList<OnlineSchemaCompatibilityIssue> Issues)
{
    public bool Ready => string.Equals(Status, "ready", StringComparison.Ordinal);

    public int PublicStatusCode => Ready ? StatusCodes.Status200OK : StatusCodes.Status503ServiceUnavailable;

    public IReadOnlyDictionary<string, object?> CreatePublicReport()
        => Ready
            ? new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["status"] = "ready"
            }
            : new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["status"] = "not_ready",
                ["code"] = PublicErrorCode
            };
}

public static class OnlineSchemaCompatibilityEvaluator
{
    public static OnlineSchemaCompatibilityReport Evaluate(
        OnlineSchemaReleaseManifest release,
        OnlineSchemaDatabaseSnapshot database,
        IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> metadata)
    {
        var issues = new List<OnlineSchemaCompatibilityIssue>();

        OnlineSchemaMigrationPolicyReport policy = OnlineSchemaMigrationPolicy.Validate(metadata);
        foreach (OnlineSchemaMigrationPolicyViolation violation in policy.Violations)
        {
            issues.Add(new(
                violation.Code,
                OnlineSchemaCompatibilitySeverity.Error,
                violation.MigrationId,
                violation.Detail));
        }

        if (!database.HistoryAvailable)
        {
            issues.Add(new(
                "schema_history_missing",
                OnlineSchemaCompatibilitySeverity.Error,
                Detail: "Schema history is not available; serve cannot mutate or guess a baseline."));
        }

        var appliedIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (IGrouping<string, OnlineSchemaMigrationHistorySnapshot> group in database.History
                     .GroupBy(static entry => entry.MigrationId, StringComparer.Ordinal))
        {
            if (group.Count() != 1)
            {
                issues.Add(new(
                    "schema_history_duplicate",
                    OnlineSchemaCompatibilitySeverity.Error,
                    group.Key,
                    "The migration history contains duplicate ids."));
                continue;
            }

            OnlineSchemaMigrationHistorySnapshot applied = group.Single();
            appliedIds.Add(applied.MigrationId);
            if (!ReleaseId.TryParse(applied.AppliedByRelease, out _))
            {
                issues.Add(new(
                    "schema_history_release_id_invalid",
                    OnlineSchemaCompatibilitySeverity.Error,
                    applied.MigrationId,
                    "AppliedByRelease must contain a canonical deployable ReleaseId."));
            }
            if (!applied.Succeeded)
            {
                issues.Add(new(
                    "schema_history_failed",
                    OnlineSchemaCompatibilitySeverity.Error,
                    applied.MigrationId,
                    "A recorded migration did not complete successfully."));
            }
        }

        if (database.SchemaCompatibilityCoordinate is null)
        {
            issues.Add(new(
                "schema_coordinate_unknown",
                OnlineSchemaCompatibilitySeverity.Error,
                Detail: "The database schema compatibility coordinate is missing."));
        }
        else if (!release.SchemaCompatibility.Contains(database.SchemaCompatibilityCoordinate.Value))
        {
            issues.Add(new(
                "schema_coordinate_outside_manifest",
                OnlineSchemaCompatibilitySeverity.Error,
                Detail: $"Schema compatibility coordinate {database.SchemaCompatibilityCoordinate} is outside the manifest window."));
        }

        foreach (OnlineSchemaMigrationMetadata classification in metadata.Values)
        {
            bool applied = appliedIds.Contains(classification.MigrationId);
            if (!applied && classification.LegacyBootstrapOnly)
            {
                issues.Add(new(
                    "schema_legacy_bootstrap_pending",
                    OnlineSchemaCompatibilitySeverity.Error,
                    classification.MigrationId,
                    "A legacy non-compensable descriptor is pending and cannot run on serve."));
                continue;
            }

            if (!applied && classification.Phase == OnlineSchemaMigrationPhase.Expand)
            {
                issues.Add(new(
                    "schema_expand_pending",
                    OnlineSchemaCompatibilitySeverity.Error,
                    classification.MigrationId,
                    "Required Expand work must complete before this release can become ready."));
                continue;
            }

            if (!applied && classification.Phase == OnlineSchemaMigrationPhase.Backfill)
            {
                if (!classification.Compatibility.ContainsReleaseId(release.ReleaseId))
                {
                    issues.Add(new(
                        "schema_backfill_incompatible",
                        OnlineSchemaCompatibilitySeverity.Error,
                        classification.MigrationId,
                        "Pending Backfill is outside the release compatibility window."));
                }
                else
                {
                    database.Backfills.TryGetValue(classification.MigrationId, out OnlineSchemaBackfillSnapshot? progress);
                    OnlineSchemaCompatibilitySeverity severity = progress?.FailureCount > 0
                        ? OnlineSchemaCompatibilitySeverity.Error
                        : OnlineSchemaCompatibilitySeverity.Warning;
                    issues.Add(new(
                        progress?.FailureCount > 0 ? "schema_backfill_failed" : "schema_backfill_pending",
                        severity,
                        classification.MigrationId,
                        "Backfill may remain pending only while its compatible read/write bridge is active."));
                }

                continue;
            }

            if (applied
                && classification.Phase == OnlineSchemaMigrationPhase.Contract
                && (!classification.Compatibility.ContainsReleaseId(release.ReleaseId)
                    || !classification.Compatibility.ContainsReleaseId(release.PreviousRollbackReleaseId)))
            {
                issues.Add(new(
                    "schema_contract_incompatible",
                    OnlineSchemaCompatibilitySeverity.Error,
                    classification.MigrationId,
                    "An applied Contract is incompatible with the current or previous rollback release."));
            }
        }

        bool ready = issues.All(static issue => issue.Severity != OnlineSchemaCompatibilitySeverity.Error);
        return new OnlineSchemaCompatibilityReport(
            ready ? "ready" : "not_ready",
            ready ? null : "schema_incompatible",
            release.ReleaseId.Value,
            database.SchemaCompatibilityCoordinate?.ToString(),
            issues);
    }
}

public sealed record OnlineSchemaContractEvidence(
    bool CurrentReleaseUsesOldSchema,
    bool PreviousRollbackReleaseUsesOldSchema,
    bool BackfillComplete,
    bool BackfillVerified,
    DateTimeOffset? ObservationStartedAtUtc,
    DateTimeOffset? BackupRestoreVerifiedAtUtc,
    bool SlotSwitchInProgress,
    bool DestructiveChangeConfirmed,
    bool RollbackManifestSealed,
    bool OldWritesDisabled,
    bool ExclusiveModeEnabled);

public static class OnlineSchemaContractGate
{
    public static IReadOnlyList<OnlineSchemaCompatibilityIssue> Evaluate(
        OnlineSchemaMigrationMetadata metadata,
        OnlineSchemaContractEvidence evidence,
        ReleaseId currentRelease,
        ReleaseId previousRollbackRelease,
        DateTimeOffset now,
        TimeSpan maximumBackupEvidenceAge)
    {
        var issues = new List<OnlineSchemaCompatibilityIssue>();
        AddIf(evidence.CurrentReleaseUsesOldSchema, "schema_contract_current_release_dependency", "Current release still depends on the old schema.");
        AddIf(evidence.PreviousRollbackReleaseUsesOldSchema, "schema_contract_previous_release_dependency", "Previous rollback release still depends on the old schema.");
        AddIf(!evidence.BackfillComplete, "schema_contract_backfill_incomplete", "Backfill has not completed.");
        AddIf(!evidence.BackfillVerified, "schema_contract_backfill_unverified", "Backfill consistency has not been verified.");
        AddIf(evidence.SlotSwitchInProgress, "schema_contract_slot_switch_in_progress", "Blue/green activation or rollback is in progress.");
        AddIf(!evidence.OldWritesDisabled, "schema_contract_old_writes_enabled", "Old-shape writes are still enabled.");
        AddIf(!evidence.RollbackManifestSealed, "schema_contract_rollback_manifest_open", "Release manifest still permits rollback to an old-structure release.");

        if (metadata.ContractAfterCoordinate is SchemaCompatibilityCoordinate contractAfterCoordinate
            && (SchemaCompatibilityCoordinate.FromReleaseId(currentRelease).CompareTo(contractAfterCoordinate) <= 0
                || SchemaCompatibilityCoordinate.FromReleaseId(previousRollbackRelease).CompareTo(contractAfterCoordinate) <= 0))
        {
            Add("schema_contract_release_window_open", "Current and previous rollback releases must both be newer than the Contract fence.");
        }

        if (metadata.Destructive && !evidence.DestructiveChangeConfirmed)
        {
            Add("schema_contract_confirmation_missing", "Destructive Contract requires an explicit confirmation.");
        }

        if (metadata.RequiresExclusiveMode && !evidence.ExclusiveModeEnabled)
        {
            Add("schema_contract_exclusive_mode_missing", "This Contract requires explicit exclusive maintenance mode.");
        }

        if (evidence.ObservationStartedAtUtc is not DateTimeOffset observationStarted
            || now - observationStarted < metadata.MinimumRetentionWindow)
        {
            Add("schema_contract_observation_window", "The required observation/retention window has not elapsed.");
        }

        if (evidence.BackupRestoreVerifiedAtUtc is not DateTimeOffset backupVerified
            || backupVerified > now
            || now - backupVerified > maximumBackupEvidenceAge)
        {
            Add("schema_contract_backup_restore_stale", "Fresh backup and restore-drill evidence is required.");
        }

        return issues;

        void AddIf(bool condition, string code, string detail)
        {
            if (condition)
            {
                Add(code, detail);
            }
        }

        void Add(string code, string detail)
            => issues.Add(new(code, OnlineSchemaCompatibilitySeverity.Error, metadata.MigrationId, detail));
    }
}

public interface IOnlineSchemaReleaseManifestProvider
{
    OnlineSchemaReleaseManifest Load(string expectedReleaseId);
}

public sealed class OnlineSchemaReleaseManifestProvider(IConfiguration configuration)
    : IOnlineSchemaReleaseManifestProvider
{
    public OnlineSchemaReleaseManifest Load(string expectedReleaseId)
    {
        string path = (configuration["FSUSBLOG_RELEASE_MANIFEST_PATH"]
            ?? configuration["Release:ManifestPath"]
            ?? string.Empty).Trim();
        if (path.Length == 0)
        {
            throw new InvalidOperationException("schema_release_manifest_missing");
        }

        using FileStream stream = File.OpenRead(path);
        using JsonDocument document = JsonDocument.Parse(stream);
        JsonElement root = document.RootElement;
        string schema = ReadRequiredString(root, "schema");
        if (!string.Equals(schema, "fsusblog.release-manifest.v2", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("schema_release_manifest_invalid");
        }

        string releaseIdValue = ReadRequiredString(root, "releaseId");
        if (!ReleaseId.TryParse(releaseIdValue, out ReleaseId releaseId))
        {
            throw new InvalidOperationException("schema_release_manifest_release_id_invalid");
        }
        if (!string.Equals(releaseId.Value, expectedReleaseId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("schema_release_manifest_identity_mismatch");
        }

        if (!root.TryGetProperty("schemaCompatibility", out JsonElement compatibility)
            || compatibility.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException("schema_release_manifest_compatibility_missing");
        }

        string previousRollbackRelease = (configuration["FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE"]
            ?? configuration["SchemaMigration:PreviousRollbackRelease"]
            ?? string.Empty).Trim();
        if (previousRollbackRelease.Length == 0)
        {
            throw new InvalidOperationException("schema_previous_rollback_release_missing");
        }

        if (string.Equals(previousRollbackRelease, releaseId.Value, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("schema_previous_rollback_release_not_distinct");
        }

        if (!ReleaseId.TryParse(previousRollbackRelease, out ReleaseId previousRollbackReleaseId))
        {
            throw new InvalidOperationException("schema_previous_rollback_release_invalid");
        }

        var compatibilityWindow = new OnlineSchemaCompatibilityWindow(
            SchemaCompatibilityCoordinate.ParseManifest(ReadRequiredString(compatibility, "minimumCoordinate")),
            SchemaCompatibilityCoordinate.ParseManifest(ReadRequiredString(compatibility, "maximumCoordinate")));
        if (compatibilityWindow.MinimumCoordinate.CompareTo(compatibilityWindow.MaximumCoordinate) > 0)
        {
            throw new InvalidOperationException("schema_release_manifest_compatibility_invalid");
        }

        return new OnlineSchemaReleaseManifest(
            releaseId,
            previousRollbackReleaseId,
            compatibilityWindow);
    }

    private static string ReadRequiredString(JsonElement value, string propertyName)
    {
        if (!value.TryGetProperty(propertyName, out JsonElement property)
            || property.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(property.GetString()))
        {
            throw new InvalidOperationException($"schema_release_manifest_{propertyName}_missing");
        }

        return property.GetString()!.Trim();
    }
}
